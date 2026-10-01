import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const assetManifest = JSON.parse(await fs.readFile(path.join(root, 'scripts/client-kernel-assets.json'), 'utf8'));
export function verifyKernelHeader(body, target) {
  const [os, arch] = target.split('-');
  if (body.length < 64) throw new Error('Client kernel binary is truncated');
  let actual;
  if (os === 'linux') {
    if (body.subarray(0, 4).toString('hex') !== '7f454c46') throw new Error('Client kernel is not ELF');
    actual = body[5] === 1 ? body.readUInt16LE(18) : body.readUInt16BE(18);
    if (actual !== (arch === 'amd64' ? 62 : 183)) throw new Error('Client kernel architecture mismatch');
  } else if (os === 'windows') {
    if (body.subarray(0, 2).toString() !== 'MZ') throw new Error('Client kernel is not PE');
    const at = body.readUInt32LE(60);
    if (at + 6 > body.length || body.subarray(at, at + 4).toString('hex') !== '50450000' || body.readUInt16LE(at + 4) !== 0x8664) throw new Error('Client kernel PE architecture mismatch');
  } else if (os === 'darwin') {
    if (body.readUInt32LE(0) !== 0xfeedfacf || body.readUInt32LE(4) !== (arch === 'amd64' ? 0x01000007 : 0x0100000c)) throw new Error('Client kernel Mach-O architecture mismatch');
  } else throw new Error('Unsupported client kernel platform');
}
export async function prepareClientKernel({ target, outputRoot, archiveFile }) {
  const spec = assetManifest.mihomo.assets[target];
  if (!spec) throw new Error(`Unsupported client kernel target: ${target}`);
  const output = path.resolve(outputRoot || path.join(root, 'artifacts/binaries/mihomo'));
  const dir = path.join(output, assetManifest.mihomo.version, target);
  if (!archiveFile) {
    try {
      const cached = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
      const body = await fs.readFile(path.join(dir, spec.binary));
      if (cached.version === assetManifest.mihomo.version && cached.target === target && cached.archiveSha256 === spec.sha256 && createHash('sha256').update(body).digest('hex') === cached.sha256) {
        verifyKernelHeader(body, target);
        return { destination: path.join(dir, spec.binary), profile: cached };
      }
    } catch { /* 缓存缺失或不完整时重新准备固定资产 */ }
  }
  let archive;
  if (archiveFile) archive = await fs.readFile(path.resolve(archiveFile));
  else {
    const response = await fetch(assetManifest.mihomo.releaseBaseUrl + spec.file, { signal: AbortSignal.timeout(120000), redirect: 'follow' });
    if (!response.ok) throw new Error(`Client kernel download HTTP ${response.status}`);
    if (Number(response.headers.get('content-length')) > 100 * 1024 * 1024) throw new Error('Client kernel archive exceeds limit');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 100 * 1024 * 1024) throw new Error('Client kernel archive exceeds limit'); chunks.push(chunk); }
    archive = Buffer.concat(chunks);
  }
  if (createHash('sha256').update(archive).digest('hex') !== spec.sha256) throw new Error('Client kernel archive SHA-256 mismatch');
  let binary;
  if (spec.file.endsWith('.gz')) binary = gunzipSync(archive, { maxOutputLength: 150 * 1024 * 1024 });
  else {
    const require = createRequire(path.join(root, 'apps/server/package.json'));
    const AdmZip = require('adm-zip');
    const entries = new AdmZip(archive).getEntries().filter((entry) => !entry.isDirectory && /\.exe$/i.test(entry.entryName));
    if (entries.length !== 1 || entries[0].header.size > 150 * 1024 * 1024) throw new Error('Client kernel ZIP must contain one executable');
    binary = entries[0].getData();
  }
  verifyKernelHeader(binary, target);
  await fs.mkdir(dir, { recursive: true });
  const destination = path.join(dir, spec.binary);
  const temp = destination + `.tmp-${process.pid}`;
  try { await fs.writeFile(temp, binary, { mode: 0o755 }); await fs.rename(temp, destination); } finally { await fs.rm(temp, { force: true }); }
  const profile = { engine: 'MIHOMO', version: assetManifest.mihomo.version, target, path: `${assetManifest.mihomo.version}/${target}/${spec.binary}`, sha256: createHash('sha256').update(binary).digest('hex'), archiveSha256: spec.sha256 };
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(profile, null, 2) + '\n');
  return { destination, profile };
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const args = process.argv.slice(2);
    const option = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
    const target = option('--target') || `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`;
    if (args.includes('--field')) {
      const field = option('--field'); const spec = assetManifest.mihomo.assets[target];
      if (!spec) throw new Error('Unsupported client kernel target');
      const value = field === 'version' ? assetManifest.mihomo.version : field === 'url' ? assetManifest.mihomo.releaseBaseUrl + spec.file : spec[field];
      if (typeof value !== 'string') throw new Error('Invalid client kernel field');
      console.log(value);
    } else {
      const result = await prepareClientKernel({ target, outputRoot: option('--output-root'), archiveFile: option('--archive') });
      console.log(result.destination);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
