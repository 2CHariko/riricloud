'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertUpstreamUpgradeSafe } = require('../apps/server/prisma/upstream-upgrade-preflight');

function reader({ tables = ['UpstreamSubscription', 'UpstreamNode', 'Line'], applied = false, subs = 0, nodes = 0, lines = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async $queryRawUnsafe(sql) {
      calls.push(sql);
      if (sql.includes('sqlite_master')) return [...tables, '_prisma_migrations'].map((name) => ({ name }));
      if (sql.includes('_prisma_migrations')) return applied ? [{ migration_name: '20260930190000_upstream_breaking_refactor' }] : [];
      if (sql.includes('PRAGMA table_info')) return [{ name: 'upstreamNodeId' }, { name: 'relayMode' }];
      if (sql.includes('FROM "UpstreamSubscription"')) return [{ count: BigInt(subs) }];
      if (sql.includes('FROM "UpstreamNode"')) return [{ count: BigInt(nodes) }];
      if (sql.includes('FROM "Line"')) return [{ count: BigInt(lines) }];
      throw new Error('unexpected query');
    }
  };
}

test('新库没有上游表时允许迁移，不执行写 SQL', async () => {
  const client = reader({ tables: [] });
  await assertUpstreamUpgradeSafe(client);
  assert.ok(client.calls.every((sql) => /^(SELECT|PRAGMA)/.test(sql)));
});
test('旧上游域为空时允许迁移，普通线路不阻断', async () => {
  await assertUpstreamUpgradeSafe(reader());
});
for (const state of [{ subs: 1 }, { nodes: 1 }, { lines: 1 }]) {
  test(`旧上游域有记录 ${JSON.stringify(state)} 时提前阻止且不清理`, async () => {
    const client = reader(state);
    await assert.rejects(assertUpstreamUpgradeSafe(client), /backup.*upstream/i);
    assert.ok(client.calls.every((sql) => /^(SELECT|PRAGMA)/.test(sql)));
  });
}
test('已成功应用新版迁移的数据库允许重启并保留新上游数据', async () => {
  const client = reader({ applied: true, subs: 5, nodes: 8, lines: 4 });
  await assertUpstreamUpgradeSafe(client);
  assert.equal(client.calls.length, 2);
});
