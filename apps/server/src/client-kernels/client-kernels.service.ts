import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { access, stat } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { parseDocument } from 'yaml';
import type { KernelCheckResult, ProbeEngine } from '../probe/probe.types';
import { KernelExecutionError, ResourceSemaphore, runKernelCommand, shutdownKernelProcesses } from './kernel-process';
import { analyzeConfigResources } from './config-resources';
import { ValidationResourcesService } from './validation-resources.service';

const validationSlots = new ResourceSemaphore(2);

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
  constructor(private readonly resources: ValidationResourcesService = new ValidationResourcesService()) {}
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
    let release: (() => void) | undefined;
    try {
      release = await validationSlots.acquire(signal);
      return await this.validateConfig(engine, content, scope, signal);
    } catch {
      return { engine, engineVersion: null, status: 'UNAVAILABLE', executed: false, scope, diagnostics: [signal?.aborted ? 'KERNEL_CANCELED' : 'KERNEL_EXECUTION_UNAVAILABLE'] };
    } finally { release?.(); }
  }
  private async validateConfig(engine: ProbeEngine, content: string, scope: 'FULL' | 'PARTIAL', signal?: AbortSignal): Promise<KernelCheckResult> {
    const result: KernelCheckResult = { engine, engineVersion: null, status: 'UNAVAILABLE', executed: false, scope, diagnostics: [] };
    let config: Record<string, unknown>;
    try {
      if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new Error();
      const document = engine === 'MIHOMO' ? parseDocument(content, { uniqueKeys: true }) : undefined;
      if (document?.errors.length) throw new Error();
      const parsed: unknown = document ? document.toJS({ maxAliasCount: 50 }) : JSON.parse(content);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      config = parsed as Record<string, unknown>;
    } catch { return { ...result, status: 'FAILED', diagnostics: ['INVALID_CONFIG'] }; }
    const dependencies = await this.resources.resolve(analyzeConfigResources(engine, config));
    result.resourceRequirements = dependencies.requirements;
    result.resourceRequirementsTruncated = dependencies.truncated;
    const kernel = await this.resolve(engine);
    result.engineVersion = kernel?.version ?? null;
    if (!kernel) return { ...result, diagnostics: ['KERNEL_UNAVAILABLE'] };
    if (dependencies.blocked) return { ...result, status: 'EXTERNAL_RESOURCES_REQUIRED', diagnostics: ['EXTERNAL_RESOURCES_REQUIRED'] };
    try {
      const native = await runKernelCommand(kernel.path, (file, directory) => engine === 'MIHOMO' ? ['-t', '-d', directory, '-f', file] : ['check', '-D', directory, '-c', file], JSON.stringify(config), 5_000, signal, false, dependencies.prepare);
      result.executed = native.executed ?? true;
      if (native.reason || native.code === null) return { ...result, diagnostics: [native.reason === 'TIMEOUT' ? 'KERNEL_TIMEOUT' : native.reason === 'CANCELED' ? 'KERNEL_CANCELED' : 'KERNEL_EXECUTION_UNAVAILABLE'] };
      return { ...result, status: native.code === 0 ? 'PASSED' : 'FAILED', diagnostics: native.code === 0 ? [] : ['NATIVE_CONFIG_CHECK_FAILED'] };
    } catch (error) {
      return { ...result, diagnostics: [signal?.aborted ? 'KERNEL_CANCELED' : error instanceof KernelExecutionError && error.code === 'RESOURCE_PREPARATION_FAILED' ? 'RESOURCE_PREPARATION_FAILED' : 'KERNEL_EXECUTION_UNAVAILABLE'] };
    }
  }
  async onModuleDestroy(): Promise<void> { await shutdownKernelProcesses(); }
}
