import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { resolveE2eStorage } from './dev-e2e-storage.mjs';

test('同一规范化双库重复启动复用固定实例和数据目录，端口变化不改变目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'riri-e2e-storage-'));
  try {
    const input = { root, databaseUrl: 'file:./fixture.db', telemetryDatabaseUrl: 'file:./metrics.db' };
    const first = resolveE2eStorage(input);
    const absolute = resolveE2eStorage({ ...input, databaseUrl: `file:${join(root, 'apps/server/prisma/fixture.db').split(sep).join('/')}`, telemetryDatabaseUrl: `file:${join(root, 'apps/server/prisma/telemetry/metrics.db').split(sep).join('/')}` });
    assert.deepEqual(first, absolute);
    assert.deepEqual(resolveE2eStorage(input), first);
    assert.equal(first.dataDir, join(first.instanceDir, 'data').split(sep).join('/'));
    assert.notEqual(first.dataDir, join(root, 'apps/server/data').split(sep).join('/'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('业务库或观测库不同的实例不会共享运行资源与端口标记', () => {
  const input = { root: resolve('.'), databaseUrl: 'file:./one.db', telemetryDatabaseUrl: 'file:./metrics.db' };
  const first = resolveE2eStorage(input);
  assert.notEqual(first.instanceDir, resolveE2eStorage({ ...input, databaseUrl: 'file:./two.db' }).instanceDir);
  assert.notEqual(first.instanceDir, resolveE2eStorage({ ...input, telemetryDatabaseUrl: 'file:./other-metrics.db' }).instanceDir);
  assert.notEqual(first.instanceDir, resolveE2eStorage({ ...input, dataRoot: '.cache/alternate-e2e-root' }).instanceDir);
});
test('非SQLite地址与同一物理双库拒绝，路径选择不读取实际数据库', () => {
  const root = resolve('.');
  assert.throws(() => resolveE2eStorage({ root, databaseUrl: 'postgres://invalid', telemetryDatabaseUrl: 'file:./metrics.db' }));
  const same = `file:${join(root, 'not-created.db').split(sep).join('/')}`;
  assert.throws(() => resolveE2eStorage({ root, databaseUrl: same, telemetryDatabaseUrl: same }));
});
test('E2E导出独立数据目录、按实例保存标记，复用要求数据库与数据目录共同匹配', async () => {
  const script = await readFile(resolve('scripts/dev-e2e.sh'), 'utf8');
  assert.match(script, /dev-e2e-storage\.mjs/);
  assert.match(script, /export RIRICLOUD_DATA_DIR="\$E2E_INSTANCE_DIR\/data"/);
  assert.match(script, /E2E_PORT_FILE="\$E2E_INSTANCE_DIR\/server-port"/);
  assert.match(script, /\[ "\$RECORDED_DATA_DIR" = "\$RIRICLOUD_DATA_DIR" \]/);
  assert.match(script, /printf '%s' "\$RIRICLOUD_DATA_DIR" >"\$E2E_DATA_MARKER_FILE"/);
  assert.doesNotMatch(script, /E2E_PORT_FILE="\$ROOT\/\.cache\/dev-e2e-server-port"/);
});
test('真实 Bash 复用判定要求记录的数据目录匹配；拒绝误复用其他实例', async () => {
  const { execFileSync } = await import('node:child_process');
  const { writeFile } = await import('node:fs/promises');
  const script = await readFile(resolve('scripts/dev-e2e.sh'), 'utf8');
  const selection = script.slice(script.indexOf('SERVER_REUSE_ALLOWED=0'), script.indexOf('# 终止整棵进程树'));
  const root = await mkdtemp(join(tmpdir(), 'riri-e2e-reuse-'));
  try {
    const storage = resolveE2eStorage({ root, databaseUrl: 'file:./fixture.db', telemetryDatabaseUrl: 'file:./metrics.db' });
    const db = 'file:fixture';
    const port = join(root, 'port'); const database = join(root, 'db'); const data = join(root, 'data');
    await writeFile(port, '30821'); await writeFile(database, db);
    const run = () => execFileSync('bash', ['-c', [
      'E2E_PORT_FILE="$1"', 'E2E_DATABASE_MARKER_FILE="$2"', 'E2E_DATA_MARKER_FILE="$3"',
      'E2E_DATABASE_URL="$4"', 'RIRICLOUD_DATA_DIR="$5"', 'SERVER_PORT_OVERRIDE=""', 'SERVER_URL_OVERRIDE=""',
      'curl() { return 0; }', 'say() { :; }', selection, 'printf "%s" "$SERVER_REUSE_ALLOWED"'
    ].join('\n'), '--', ...[port, database, data].map(file => file.split(sep).join('/')), db, storage.dataDir], { encoding: 'utf8' }).trim();
    await writeFile(data, storage.dataDir); assert.equal(run(), '1');
    await writeFile(data, `${storage.dataDir}/other`); assert.equal(run(), '0');
    await writeFile(data, storage.dataDir); await writeFile(database, 'file:other'); assert.equal(run(), '0');
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('E2E所有迁移和种子只经过连续持锁入口，启动前不再直接调用Prisma', async () => {
  const script = await readFile(resolve('scripts/dev-e2e.sh'), 'utf8');
  for (const command of ['prisma migrate deploy', 'prisma db seed', 'node apps/server/prisma/upstream-upgrade-preflight.js', 'node apps/server/prisma/migrate-telemetry-data.js']) assert.equal(script.includes(command), false, command);
  assert.ok(script.includes('node apps/server/prisma/maintenance-start.js --build-dir'));
  assert.match(script, /--seed-if-missing/);
});

test('E2E清理先请求本次隔离服务优雅关闭，超时强杀保留异常锁', async () => {
  const script = await readFile(resolve('scripts/dev-e2e.sh'), 'utf8');
  assert.ok(script.includes('--stop-file "$SERVER_TSCONFIG.stop"'));
  const cleanup = script.slice(script.indexOf('cleanup() {'), script.indexOf('trap cleanup'));
  assert.ok(cleanup.includes('stop_owned_server'));
  assert.ok(script.includes("printf 'stop\\n'"));
});
