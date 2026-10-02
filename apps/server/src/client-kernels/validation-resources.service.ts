import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { proxyObject } from '../common/proxy-connection';
import type { KernelResourceRequirement } from '../probe/probe.types';
import type { ConfigResource } from './config-resources';

const MAX_FILE = 32 * 1024 * 1024;
const MAX_SNAPSHOT = 80 * 1024 * 1024;
const MAX_DETAILS = 50;
interface Asset { path: string; size: number; sha256: string }
interface Snapshot { file: string; body: Buffer }
export interface ValidationResources {
  requirements: KernelResourceRequirement[];
  truncated: number;
  blocked: boolean;
  prepare: (directory: string) => Promise<void>;
}
class ResourceError extends Error {
  constructor(readonly state: KernelResourceRequirement['state']) { super('Validation resource unavailable'); }
}
export function safeResourcePath(file: string): boolean {
  return file.length <= 240 && !isAbsolute(file) && /^[a-zA-Z0-9_./-]+$/.test(file)
    && file.split('/').every((part) => part !== '.' && part !== '..' && part.length > 0 && !/[. ]$/.test(part))
    && !['manifest.json', 'config.json'].includes(file.toLowerCase());
}
function applicationRoots(): string[] {
  const roots: string[] = [];
  let current = __dirname;
  for (let i = 0; i < 7; i++) {
    if (existsSync(join(current, 'package.json'))) roots.push(current);
    current = dirname(current);
  }
  return roots;
}
function defaultRoot(): string {
  const candidates = applicationRoots().flatMap((root) => [join(root, 'binaries/validation-resources'), join(root, 'artifacts/validation-resources')]);
  return candidates.find((path) => existsSync(join(path, 'manifest.json'))) ?? candidates[0] ?? join(__dirname, 'validation-resources');
}
// 与可覆盖的资源目录分离，固定地理库必须是应用清单中已实测的字节。
let trustedGeoAssets: Promise<Asset[]> | undefined;
function canonicalGeoAssets(): Promise<Asset[]> {
  return trustedGeoAssets ??= (async () => {
    const path = applicationRoots().map((root) => join(root, 'scripts/client-kernel-assets.json')).find(existsSync);
    if (!path) throw new ResourceError('INVALID');
    const manifest = JSON.parse((await readSafe(dirname(path), 'client-kernel-assets.json', 256 * 1024)).toString()) as { validationResources?: { files?: Asset[] } };
    const files = manifest.validationResources?.files;
    if (!Array.isArray(files) || files.length !== 4) throw new ResourceError('INVALID');
    return files;
  })();
}
async function readSafe(root: string, file: string, limit: number): Promise<Buffer> {
  // 每个路径分量拒绝符号链接；资源目录仅供受信任部署者写入。
  let path = root;
  for (const part of file.split('/')) {
    path = join(path, part);
    if ((await lstat(path)).isSymbolicLink()) throw new ResourceError('INVALID');
  }
  const actual = await realpath(path);
  const rel = relative(await realpath(root), actual);
  if (isAbsolute(rel) || rel.startsWith('..')) throw new ResourceError('INVALID');
  const handle = await open(actual, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > limit) throw new ResourceError('INVALID');
    // 有界读取避免检查后文件增长导致内存无限膨胀。
    const body = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < body.length) {
      const result = await handle.read(body, size, body.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size !== info.size) throw new ResourceError('INVALID');
    return body.subarray(0, size);
  } finally { await handle.close(); }
}
function stateOf(error: unknown): KernelResourceRequirement['state'] {
  if (error instanceof ResourceError) return error.state;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' ? 'MISSING' : code === 'EACCES' || code === 'EPERM' ? 'UNREADABLE' : 'INVALID';
}
function validRuleFile(body: Buffer, format: string): boolean {
  let rules: unknown;
  if (format.includes('-yaml-')) {
    const doc = parseDocument(body.toString('utf8'), { uniqueKeys: true });
    if (doc.errors.length) return false;
    rules = proxyObject(doc.toJS({ maxAliasCount: 50 })).payload;
  } else rules = body.toString('utf8').split(/\r?\n/).map((row) => row.trim()).filter((row) => row && !row.startsWith('#'));
  return Array.isArray(rules) && rules.length <= 100_000 && rules.every((rule) => typeof rule === 'string' && rule.length <= 512 && !/[\r\n,()]/.test(rule));
}

@Injectable()
export class ValidationResourcesService {
  async resolve(resources: ConfigResource[]): Promise<ValidationResources> {
    const root = process.env.CLIENT_VALIDATION_RESOURCES_DIR !== undefined ? resolve(process.env.CLIENT_VALIDATION_RESOURCES_DIR) : defaultRoot();
    let manifest: Map<string, Asset> | undefined;
    let manifestError: unknown;
    const snapshots: Snapshot[] = [];
    const copied = new Set<string>();
    let total = 0;
    if (resources.some((resource) => resource.file)) {
      try {
        const data = JSON.parse((await readSafe(root, 'manifest.json', 256 * 1024)).toString()) as { schemaVersion?: number; files?: Asset[] };
        if (data.schemaVersion !== 1 || !Array.isArray(data.files) || data.files.length > 256) throw new ResourceError('INVALID');
        manifest = new Map();
        for (const asset of data.files) {
          if (!asset || typeof asset.path !== 'string' || !safeResourcePath(asset.path) || !Number.isInteger(asset.size) || asset.size <= 0 || asset.size > MAX_FILE || !/^[a-f0-9]{64}$/.test(asset.sha256) || manifest.has(asset.path)) throw new ResourceError('INVALID');
          manifest.set(asset.path, asset);
        }
      } catch (error) { manifestError = error; }
    }
    for (const resource of resources) {
      const requirement = resource.requirement;
      if (!resource.file) continue;
      try {
        if (!safeResourcePath(resource.file)) throw new ResourceError('INVALID');
        if (manifestError) throw manifestError;
        const asset = manifest?.get(resource.file);
        if (!asset) throw new ResourceError('MISSING');
        if (requirement.kind === 'GEOIP' || requirement.kind === 'GEOSITE') {
          const fixed = (await canonicalGeoAssets()).find((entry) => entry.path === asset.path);
          if (!fixed || fixed.sha256 !== asset.sha256 || fixed.size !== asset.size) throw new ResourceError('INVALID');
        }
        const body = await readSafe(root, asset.path, MAX_FILE);
        if (body.length !== asset.size || createHash('sha256').update(body).digest('hex') !== asset.sha256) throw new ResourceError('INVALID');
        if (resource.format && !validRuleFile(body, resource.format)) throw new ResourceError('INVALID');
        if (!copied.has(asset.path)) {
          total += body.length;
          if (total > MAX_SNAPSHOT) throw new ResourceError('INVALID');
          copied.add(asset.path);
          snapshots.push({ file: asset.path, body });
        }
        requirement.state = 'AVAILABLE'; requirement.reasonCode = 'RESOURCE_AVAILABLE'; requirement.actionCode = 'NONE';
      } catch (error) {
        requirement.state = stateOf(error); requirement.reasonCode = `RESOURCE_${requirement.state}`;
        requirement.actionCode = requirement.state === 'MISSING' ? 'PREPARE_RESOURCE' : 'FIX_RESOURCE';
      }
    }
    const requirements = resources.map(({ requirement }) => requirement);
    return { requirements: requirements.slice(0, MAX_DETAILS), truncated: Math.max(0, requirements.length - MAX_DETAILS),
      blocked: requirements.some((item) => item.state !== 'AVAILABLE'),
      prepare: async (directory) => {
        for (const snapshot of snapshots) {
          const destination = join(directory, snapshot.file);
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          await writeFile(destination, snapshot.body, { mode: 0o600, flag: 'wx' });
        }
      } };
  }
}
