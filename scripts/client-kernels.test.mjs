import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
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
