import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('Linux 离线导出在未定义 HOST_UNAME 时生成双镜像校验与清单', { skip: process.platform !== 'linux' }, () => {
  const scratch = mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || tmpdir(), 'docker-export-test-'));
  try {
    const bin = path.join(scratch, 'bin'); mkdirSync(bin);
    writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\ncase "$1" in\ninfo) echo linux;;\nimage) echo validation;;\nsave) printf "isolated-image-archive";;\n*) exit 1;;\nesac\n', { mode: 0o755 });
    const output = path.join(scratch, 'output');
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NODE_BIN: process.execPath, DOCKER_PLATFORM: 'linux/amd64', DOCKER_EXPORT_DIR: output };
    delete env.HOST_UNAME;
    const result = spawnSync('bash', ['scripts/docker-build.sh', 'export'], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const version = JSON.parse(readFileSync(path.join(root, 'package.json'))).version;
    const manifest = JSON.parse(readFileSync(path.join(output, `riricloud-docker-images_${version}_linux_amd64.manifest.json`)));
    assert.equal(manifest.images.length, 2);
    for (const image of manifest.images) {
      assert.equal(image.tags.length, 2);
      assert.equal(createHash('sha256').update(readFileSync(path.join(output, image.archive))).digest('hex'), image.sha256);
    }
    assert.match(readFileSync(path.join(output, `riricloud-docker-images_${version}_linux_amd64.sha256`), 'utf8'), /riricloud-master/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
