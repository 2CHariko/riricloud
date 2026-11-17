import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { assertNativeTarget, hostTarget, parseNativeBuildSpec, downloadPinnedArtifact, repository } from './prepare-native-kernels.mjs';

const docker = await fs.readFile(path.join(repository, 'Dockerfile'), 'utf8');
const agent = await fs.readFile(path.join(repository, 'Dockerfile.agent'), 'utf8');
test('五平台严格匹配运行宿主，不允许交叉编译冒充原生验收', () => {
  for (const target of ['linux-amd64', 'linux-arm64', 'windows-amd64', 'darwin-amd64', 'darwin-arm64']) assert.doesNotThrow(() => assertNativeTarget(target, target));
  assert.equal(hostTarget('win32', 'x64'), 'windows-amd64');
  assert.equal(hostTarget('darwin', 'arm64'), 'darwin-arm64');
  assert.throws(() => assertNativeTarget('linux-arm64', 'linux-amd64'), /Native target mismatch/);
  assert.throws(() => assertNativeTarget('linux-mips', 'linux-mips'), /Unsupported/);
});
test('定制内核与发行包使用同一版本、固定哈希和补丁标签', () => {
  const pins = parseNativeBuildSpec(docker, agent);
  assert.equal(pins.SINGBOX_VERSION, '1.14.0');
  assert.equal(pins.SINGBOX_REVISION, '2');
  for (const key of ['SINGBOX_SHA256', 'CRONET_SHA256_AMD64', 'CRONET_SHA256_ARM64']) assert.match(pins[key], /^[a-f0-9]{64}$/);
  assert.ok(pins.tags.includes('with_naive_outbound'));
  assert.throws(() => parseNativeBuildSpec(docker, agent.replaceAll('ARG SINGBOX_VERSION=1.14.0', 'ARG SINGBOX_VERSION=1.14.1')), /disagree/);
  assert.throws(() => parseNativeBuildSpec(docker.replace(/^ARG SINGBOX_SHA256=.*$/m, ''), agent), /Missing/);
});
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'riri-native-assets-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const content = Buffer.from('pinned-artifact');
  return { directory, content, options: { url: 'https://example.invalid/pinned', destination: path.join(directory, 'asset'), sha256: createHash('sha256').update(content).digest('hex') } };
}
test('固定下载校验成功才发布，缓存命中仍核验固定哈希', async t => {
  const { content, options } = await fixture(t); let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(content); };
  await downloadPinnedArtifact({ ...options, fetchImpl });
  await downloadPinnedArtifact({ ...options, fetchImpl });
  assert.equal(calls, 1);
  await fs.writeFile(options.destination, 'corrupt');
  await assert.rejects(downloadPinnedArtifact({ ...options, fetchImpl }), /Cached artifact SHA-256/);
  assert.equal(calls, 1);
});
test('哈希不符或超过下载上限时失败并清除半成品', async t => {
  const { directory, options } = await fixture(t);
  await assert.rejects(downloadPinnedArtifact({ ...options, fetchImpl: async () => new Response('wrong') }), /SHA-256 mismatch/);
  assert.deepEqual(await fs.readdir(directory), []);
  await assert.rejects(downloadPinnedArtifact({ ...options, maxBytes: 3, fetchImpl: async () => new Response('oversized') }), /size limit/);
  assert.deepEqual(await fs.readdir(directory), []);
});
test('资源不存在、HTTP 错误或无固定哈希均失败', async t => {
  const { options } = await fixture(t);
  await assert.rejects(downloadPinnedArtifact({ ...options, fetchImpl: async () => new Response(null, { status: 404 }) }), /HTTP 404/);
  await assert.rejects(downloadPinnedArtifact({ ...options, sha256: '', fetchImpl: async () => { throw Error('must not download'); } }), /pinned HTTPS/);
});
