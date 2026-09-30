'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { normalizeSqliteUrl } = require('../apps/server/prisma/sqlite-url');
const { runUpstreamUpgradePreflight } = require('../apps/server/prisma/upstream-upgrade-preflight');

test('相对 URL 固定使用 schema 目录，不依赖 cwd 或生成客户端目录', () => {
  const base = path.resolve('apps/server/prisma');
  const expected = `file:${path.join(base, 'dev-e2e.db').split(path.sep).join('/')}`;
  assert.equal(normalizeSqliteUrl('file:./dev-e2e.db', base), expected);
  assert.equal(normalizeSqliteUrl('file:dev-e2e.db', base), expected);
  assert.equal(normalizeSqliteUrl('file:./dev-e2e.db?connection_limit=1', base), `${expected}?connection_limit=1`);
  assert.equal(normalizeSqliteUrl(expected, base), expected);
  assert.throws(() => normalizeSqliteUrl('postgres://bad', base), /SQLite/);
});
test('预检存在判断和 Prisma 客户端使用同一绝对 URL', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'preflight-path-'));
  fs.writeFileSync(path.join(dir, 'dev-e2e.db'), 'fixture');
  let actual;
  let disconnected = false;
  try {
    await assert.rejects(runUpstreamUpgradePreflight('file:./dev-e2e.db', { schemaDir: dir, createClient: (url) => {
      actual = url;
      return { $queryRawUnsafe: async (sql) => sql.includes('sqlite_master') ? [{ name: 'UpstreamSubscription' }] : [{ count: 1n }], $disconnect: async () => { disconnected = true; } };
    } }), /Backup/);
    assert.equal(actual, normalizeSqliteUrl('file:./dev-e2e.db', dir));
    assert.equal(disconnected, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
