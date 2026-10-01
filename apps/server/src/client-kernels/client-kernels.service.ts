import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { access, stat } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { parseDocument } from 'yaml';
import { proxyObject } from '../common/proxy-connection';
import type { KernelCheckResult, ProbeEngine } from '../probe/probe.types';
import { runKernelCommand, shutdownKernelProcesses } from './kernel-process';

export const MIHOMO_VERSION = '1.19.30';
export interface ResolvedClientKernel { path: string; version: string }
export interface ClientKernelProfile { engine: ProbeEngine; available: boolean; version: string | null; executable: boolean; reason: string | null; naiveAvailable: boolean }
function roots(): string[] {
  const found = new Set<string>();
  let current = __dirname;
  for (let i = 0; i < 7; i++) {
    if (existsSync(join(current, 'package.json'))) found.add(current);
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  return [...found];
}
const platform = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`;

@Injectable()
export class ClientKernelsService implements OnModuleDestroy {
  private readonly versions = new Map<string, { stamp: number; kernel: ResolvedClientKernel; naive: boolean }>();
  private candidates(engine: ProbeEngine): string[] {
    const executable = `${engine === 'MIHOMO' ? 'mihomo' : 'sing-box'}${process.platform === 'win32' ? '.exe' : ''}`;
    const name = engine === 'MIHOMO' ? 'mihomo' : 'singbox';
    const version = engine === 'MIHOMO' ? MIHOMO_VERSION : '1.14.0-r2';
    const bundled = roots().flatMap((root) => [join(root, 'binaries', name, version, platform, executable), join(root, 'binaries', name, platform, executable), join(root, 'binaries', name, executable)]);
    const system = process.platform === 'win32' ? [] : [`/usr/local/bin/${executable}`, `/usr/bin/${executable}`, `/opt/riri/bin/${executable}`];
    const artifacts = roots().flatMap((root) => [join(root, 'artifacts/binaries', name, version, platform, executable), join(root, 'artifacts/binaries', name, platform, executable)]);
    return [...bundled, ...system, ...artifacts];
  }
  async resolve(engine: ProbeEngine): Promise<ResolvedClientKernel | null> {
    const explicit = process.env[engine === 'MIHOMO' ? 'MIHOMO_BINARY_PATH' : 'SINGBOX_BINARY_PATH'];
    // 显式覆盖是故障边界：路径错误、平台错误或版本错误时绝不尝试其他文件。
    const candidates = explicit !== undefined ? [isAbsolute(explicit) ? explicit : resolve(roots().at(-1) ?? __dirname, explicit)] : this.candidates(engine);
    for (const path of candidates) {
      try {
        await access(path, constants.X_OK);
        const info = await stat(path);
        if (!info.isFile()) continue;
        const cached = this.versions.get(path);
        if (cached?.stamp === info.mtimeMs) return cached.kernel;
        const result = await runKernelCommand(path, () => [engine === 'MIHOMO' ? '-v' : 'version']);
        const match = engine === 'MIHOMO' ? /Mihomo Meta v(\d+\.\d+\.\d+)/.exec(result.output) : /sing-box version (\d+\.\d+\.\d+)/.exec(result.output);
        if (result.code !== 0 || !match || (engine === 'MIHOMO' && match[1] !== MIHOMO_VERSION)) { if (explicit !== undefined) return null; continue; }
        const kernel = { path, version: match[1] };
        this.versions.set(path, { stamp: info.mtimeMs, kernel, naive: result.output.includes('with_naive_outbound') });
        return kernel;
      } catch { if (explicit !== undefined) return null; }
    }
    return null;
  }
  async supportsNaive(kernel: ResolvedClientKernel): Promise<boolean> {
    // Cronet 的实际加载由最小配置原生 check 确认；编译标签缺失则提前报环境错误。
    if (this.versions.get(kernel.path)?.naive !== true) return false;
    const check = await this.validate('SINGBOX', JSON.stringify({ log: { disabled: true }, outbounds: [{ type: 'naive', tag: 'naive-check', server: '1.1.1.1', server_port: 443, username: 'check', password: 'check', tls: { enabled: true, server_name: 'example.com' } }] }));
    return check.status === 'PASSED';
  }
  async status(): Promise<ClientKernelProfile[]> {
    return Promise.all((['MIHOMO', 'SINGBOX'] as const).map(async (engine) => {
      const kernel = await this.resolve(engine);
      return { engine, available: kernel !== null, executable: kernel !== null, version: kernel?.version ?? null, reason: kernel ? null : 'KERNEL_UNAVAILABLE', naiveAvailable: kernel && engine === 'SINGBOX' ? await this.supportsNaive(kernel) : false };
    }));
  }
  async validate(engine: ProbeEngine, content: string, scope: 'FULL' | 'PARTIAL' = 'FULL', signal?: AbortSignal): Promise<KernelCheckResult> {
    const kernel = await this.resolve(engine);
    const result: KernelCheckResult = { engine, engineVersion: kernel?.version ?? null, status: 'UNAVAILABLE', executed: false, scope, diagnostics: [] };
    if (!kernel) return { ...result, diagnostics: ['KERNEL_UNAVAILABLE'] };
    let config: Record<string, unknown>;
    try {
      const parsed: unknown = engine === 'MIHOMO' ? parseDocument(content, { uniqueKeys: true }).toJS() : JSON.parse(content);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      config = parsed as Record<string, unknown>;
    } catch { return { ...result, status: 'FAILED', diagnostics: ['INVALID_CONFIG'] }; }
    if (requiresExternalResources(engine, config)) return { ...result, status: 'EXTERNAL_RESOURCES_REQUIRED', diagnostics: ['EXTERNAL_RESOURCES_REQUIRED'] };
    try {
      const native = await runKernelCommand(kernel.path, (file, directory) => engine === 'MIHOMO' ? ['-t', '-d', directory, '-f', file] : ['check', '-D', directory, '-c', file], JSON.stringify(config), 5_000, signal, false);
      return { ...result, status: native.code === 0 ? 'PASSED' : 'FAILED', executed: true, diagnostics: native.code === 0 ? [] : ['NATIVE_CONFIG_CHECK_FAILED'] };
    } catch { return { ...result, diagnostics: ['KERNEL_EXECUTION_UNAVAILABLE'] }; }
  }
  async onModuleDestroy(): Promise<void> { await shutdownKernelProcesses(); }
}

function requiresExternalResources(engine: ProbeEngine, config: Record<string, unknown>): boolean {
  if (engine === 'MIHOMO') {
    if (Object.keys(proxyObject(config['rule-providers'])).length || Object.keys(proxyObject(config['proxy-providers'])).length) return true;
    const rules = Array.isArray(config.rules) ? config.rules : [];
    if (rules.some((rule: unknown) => typeof rule === 'string' && ['GEOIP', 'GEOSITE', 'RULE-SET'].includes(rule.split(',')[0].toUpperCase()))) return true;
  }
  const walk = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(walk);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, v]) => (['certificate_path', 'key_path', 'certificate-path', 'private-key-path', 'geosite', 'geoip', 'rule_set'].includes(key) && v !== undefined) || (key === 'type' && (v === 'remote' || v === 'local')) || walk(v));
  };
  return walk(config);
}
