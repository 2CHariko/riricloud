import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assetManifest, prepareClientKernel, verifyKernelHeader } from './prepare-client-kernels.mjs';

test('五平台资产均固定版本和真实 SHA-256，架构不允许任意字符串', () => {
  assert.equal(assetManifest.mihomo.version, '1.19.30');
  assert.deepEqual(Object.keys(assetManifest.mihomo.assets).sort(), ['darwin-amd64', 'darwin-arm64', 'linux-amd64', 'linux-arm64', 'windows-amd64']);
  for (const spec of Object.values(assetManifest.mihomo.assets)) assert.match(spec.sha256, /^[0-9a-f]{64}$/);
  const elf = Buffer.alloc(64); Buffer.from('7f454c46', 'hex').copy(elf); elf[5] = 1; elf.writeUInt16LE(62, 18);
  assert.doesNotThrow(() => verifyKernelHeader(elf, 'linux-amd64'));
  assert.throws(() => verifyKernelHeader(elf, 'linux-arm64'), /architecture/);
  assert.throws(() => verifyKernelHeader(elf, 'windows-amd64'), /PE/);
});
test('损坏归档在生成任何可执行文件前被拒绝', async () => {
  const dir = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'client-kernel-test-'));
  try {
    const file = path.join(dir, 'bad.gz'); await fs.writeFile(file, 'not-the-official-archive');
    await assert.rejects(prepareClientKernel({ target: 'linux-amd64', outputRoot: dir, archiveFile: file }), /SHA-256/);
    assert.deepEqual(await fs.readdir(dir), ['bad.gz']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('新增地理资源不改变二进制 prepare CLI 的单行路径输出', async () => {
  const dir = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'kernel-stdout-'));
  try {
    const target = 'linux-amd64';
    const version = assetManifest.mihomo.version;
    const binaryDir = path.join(dir, version, target);
    await fs.mkdir(binaryDir, { recursive: true });
    const body = Buffer.alloc(64); Buffer.from('7f454c46', 'hex').copy(body); body[5] = 1; body.writeUInt16LE(62, 18);
    await fs.writeFile(path.join(binaryDir, 'mihomo'), body);
    await fs.writeFile(path.join(binaryDir, 'manifest.json'), JSON.stringify({ version, target, archiveSha256: assetManifest.mihomo.assets[target].sha256, sha256: createHash('sha256').update(body).digest('hex') }));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./prepare-client-kernels.mjs', import.meta.url)), '--target', target, '--output-root', dir], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${path.join(binaryDir, 'mihomo')}\n`);
    assert.equal(result.stderr, '');
    assert.deepEqual(await fs.readdir(dir), [version]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
