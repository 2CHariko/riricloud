import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { validationResources: resources } = JSON.parse(await fs.readFile(path.join(root, 'scripts/client-kernel-assets.json'), 'utf8'));
const maxFileSize = 64 * 1024 * 1024;
const allowedPaths = new Set(['Country.mmdb', 'geoip.dat', 'geosite.dat', 'ASN.mmdb']);

function validateManifest() {
  if (!resources || !/^[0-9a-f]{40}$/.test(resources.version) || !resources.source || !resources.license || !Array.isArray(resources.files)) throw new Error('Invalid validation resource manifest');
  const paths = new Set();
  for (const file of resources.files) {
    if (!allowedPaths.has(file.path) || paths.has(file.path) || !/^[0-9a-f]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > maxFileSize) throw new Error('Invalid validation resource file');
    const prefix = `https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/${resources.version}/`;
    if (!file.url.startsWith(prefix) || !/^[A-Za-z0-9.-]+$/.test(file.url.slice(prefix.length))) throw new Error('Validation resource URL must use the locked upstream commit');
    paths.add(file.path);
  }
  for (const name of ['Country.mmdb', 'geoip.dat', 'geosite.dat']) if (!paths.has(name)) throw new Error(`Missing validation resource: ${name}`);
}

// 流水线保留背压，临时文件与目标同目录，校验成功才原子发布。
export async function writeVerifiedResource(source, destination, spec) {
  const temporary = `${destination}.tmp-${randomUUID()}`;
  const hash = createHash('sha256');
  let size = 0;
  try {
    await pipeline(source, new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > spec.size || size > maxFileSize) return callback(new Error('Validation resource exceeds size limit'));
        hash.update(chunk);
        callback(null, chunk);
      },
    }), createWriteStream(temporary, { flags: 'wx', mode: 0o644 }));
    if (size !== spec.size) throw new Error('Validation resource size mismatch');
    if (hash.digest('hex') !== spec.sha256) throw new Error('Validation resource SHA-256 mismatch');
    await fs.rename(temporary, destination);
  } finally { await fs.rm(temporary, { force: true }); }
}

async function cachedFileMatches(destination, spec) {
  try {
    const stat = await fs.lstat(destination);
    if (!stat.isFile() || stat.size !== spec.size) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(destination)) hash.update(chunk);
    return hash.digest('hex') === spec.sha256;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function download(spec) {
  const response = await fetch(spec.url, { signal: AbortSignal.timeout(120000), redirect: 'error' });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Validation resource download HTTP ${response.status}`);
  }
  if (Number(response.headers.get('content-length')) > spec.size) {
    await response.body.cancel();
    throw new Error('Validation resource exceeds size limit');
  }
  return response.body;
}

export async function prepareValidationResources({ outputRoot, offlineDir } = {}) {
  validateManifest();
  const destination = path.resolve(outputRoot || path.join(root, 'artifacts/validation-resources'));
  await fs.mkdir(destination, { recursive: true });
  for (const spec of resources.files) {
    const file = path.join(destination, spec.path);
    if (await cachedFileMatches(file, spec)) continue;
    // 离线导入不读取外部 manifest，不允许覆写锁定哈希，也不回退网络。
    let source;
    if (offlineDir !== undefined) {
      const input = path.resolve(offlineDir, spec.path);
      const stat = await fs.lstat(input);
      if (!stat.isFile() || stat.size !== spec.size) throw new Error(`Validation resource size/type mismatch: ${spec.path}`);
      source = createReadStream(input);
    } else source = await download(spec);
    await writeVerifiedResource(source, file, spec);
  }
  const manifest = { schemaVersion: 1, version: resources.version, files: resources.files.map(({ path, sha256, size }) => ({ path, sha256, size })) };
  const temporary = path.join(destination, `manifest.json.tmp-${randomUUID()}`);
  try {
    await fs.writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    await fs.rename(temporary, path.join(destination, 'manifest.json'));
  } finally { await fs.rm(temporary, { force: true }); }
  return { destination, manifest };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      const name = { '--output-root': 'outputRoot', '--offline-dir': 'offlineDir' }[args[i]];
      if (!name || !args[i + 1] || args[i + 1].startsWith('--') || options[name] !== undefined) throw new Error('Usage: prepare-validation-resources.mjs [--output-root DIR] [--offline-dir DIR]');
      options[name] = args[i + 1];
    }
    console.log((await prepareValidationResources(options)).destination);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
