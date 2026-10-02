import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { assetManifest } from './prepare-client-kernels.mjs';
import { prepareValidationResources, writeVerifiedResource } from './prepare-validation-resources.mjs';

const temporary = () => fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'validation-resources-'));
const body = Buffer.from('locked-resource');
const spec = { path: 'geoip.dat', size: body.length, sha256: createHash('sha256').update(body).digest('hex') };

test('固定地理资产包含四种文件、不可变提交 URL 与大小', () => {
  const resources = assetManifest.validationResources;
  assert.match(resources.version, /^[0-9a-f]{40}$/);
  assert.ok(resources.source && resources.license);
  assert.deepEqual(resources.files.map((file) => file.path).sort(), ['ASN.mmdb', 'Country.mmdb', 'geoip.dat', 'geosite.dat']);
  for (const file of resources.files) {
    assert.ok(file.url.startsWith(`https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/${resources.version}/`));
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.ok(file.size > 0 && file.size <= 64 * 1024 * 1024);
  }
});

test('流式校验后原子替换；超限、截断、错误哈希和中断均保留旧文件且清理临时文件', async () => {
  const dir = await temporary();
  const destination = path.join(dir, spec.path);
  try {
    await writeVerifiedResource(Readable.from([body.subarray(0, 3), body.subarray(3)]), destination, spec);
    assert.deepEqual(await fs.readFile(destination), body);
    for (const [stream, pattern] of [
      [Readable.from([Buffer.alloc(spec.size + 1)]), /limit/],
      [Readable.from([body.subarray(1)]), /size/],
      [Readable.from([Buffer.alloc(spec.size)]), /SHA-256/],
      [Readable.from((async function* () { yield body.subarray(0, 2); throw new Error('interrupted'); })()), /interrupted/],
    ]) {
      await assert.rejects(writeVerifiedResource(stream, destination, spec), pattern);
      assert.deepEqual(await fs.readFile(destination), body);
      assert.deepEqual(await fs.readdir(dir), [spec.path]);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('离线缺失或异版本字节拒绝，绝不联网或提前更新 manifest', async (t) => {
  const dir = await temporary();
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Network forbidden'); });
  try {
    const outputRoot = path.join(dir, 'output');
    await fs.mkdir(outputRoot);
    await fs.writeFile(path.join(outputRoot, 'manifest.json'), 'previous');
    await assert.rejects(prepareValidationResources({ outputRoot, offlineDir: dir }), /ENOENT/);
    await fs.writeFile(path.join(dir, 'Country.mmdb'), 'wrong-version');
    await assert.rejects(prepareValidationResources({ outputRoot, offlineDir: dir }), /size/);
    assert.equal(await fs.readFile(path.join(outputRoot, 'manifest.json'), 'utf8'), 'previous');
    assert.deepEqual(await fs.readdir(outputRoot), ['manifest.json']);
    assert.equal(globalThis.fetch.mock.callCount(), 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('在线仅请求锁定地址，响应大小超限即失败且不发布 manifest', async (t) => {
  const dir = await temporary();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, assetManifest.validationResources.files[0].url);
    assert.equal(options.redirect, 'error');
    return new Response('x', { headers: { 'content-length': String(100 * 1024 * 1024) } });
  });
  try {
    await assert.rejects(prepareValidationResources({ outputRoot: dir }), /limit/);
    assert.deepEqual(await fs.readdir(dir), []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('真实锁定字节离线导入、缓存命中不联网、损坏缓存修复', { skip: !process.env.VALIDATION_RESOURCE_FIXTURE_DIR }, async (t) => {
  const dir = await temporary();
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Network forbidden'); });
  try {
    const options = { outputRoot: dir, offlineDir: process.env.VALIDATION_RESOURCE_FIXTURE_DIR };
    await prepareValidationResources(options);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest, { schemaVersion: 1, version: assetManifest.validationResources.version, files: assetManifest.validationResources.files.map(({ path, sha256, size }) => ({ path, sha256, size })) });
    await prepareValidationResources({ outputRoot: dir });
    await fs.writeFile(path.join(dir, 'Country.mmdb'), 'bad-cache');
    await prepareValidationResources(options);
    for (const file of manifest.files) {
      const content = await fs.readFile(path.join(dir, file.path));
      assert.equal(content.length, file.size);
      assert.equal(createHash('sha256').update(content).digest('hex'), file.sha256);
    }
    assert.equal(globalThis.fetch.mock.callCount(), 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Docker、发行包与 E2E 均准备相同资源并保留非 root 可读布局', async () => {
  const read = (name) => fs.readFile(new URL(`../${name}`, import.meta.url), 'utf8');
  const docker = await read('Dockerfile');
  assert.match(docker, /node scripts\/prepare-validation-resources\.mjs --output-root \/validation-cache/);
  assert.match(docker, /chmod 0644 \/validation-resources\/\*/);
  assert.match(docker, /COPY --from=mihomo-fetch --chown=65532:65532 \/validation-resources\/ \/app\/binaries\/validation-resources\//);
  assert.match(docker, /COPY scripts\/client-kernel-assets\.json \/app\/scripts\/client-kernel-assets\.json/);
  const bundle = await read('scripts/bundle-master.sh');
  assert.match(bundle, /prepare-validation-resources\.mjs.*--offline-dir.*MASTER_DIR\/binaries\/validation-resources/);
  assert.match(bundle, /cp "\$RIRI_ROOT\/scripts\/client-kernel-assets\.json" "\$MASTER_DIR\/scripts\/client-kernel-assets\.json"/);
  assert.match(await read('scripts/dev-e2e.sh'), /node scripts\/prepare-validation-resources\.mjs \|\| die/);
});
