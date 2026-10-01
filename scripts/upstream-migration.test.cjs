'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { UPSTREAM_MIGRATION, assertUpstreamUpgradeSafe } = require('../apps/server/prisma/upstream-upgrade-preflight');
const migrations = path.resolve(__dirname, '../apps/server/prisma/migrations');
function oldDb() {
  const db = new DatabaseSync(':memory:');
  for (const dir of fs.readdirSync(migrations).filter((name) => name < UPSTREAM_MIGRATION).sort()) {
    const file = path.join(migrations, dir, 'migration.sql');
    if (fs.existsSync(file)) db.exec(fs.readFileSync(file, 'utf8'));
  }
  return db;
}
const sql = fs.readFileSync(path.join(migrations, UPSTREAM_MIGRATION, 'migration.sql'), 'utf8');
const cols = (db, table) => db.prepare(`PRAGMA table_info("${table}")`).all();

test('新迁移删除旧字段并允许 EXTERNAL 空入口，普通业务记录无损保留', () => {
  const db = oldDb();
  try {
    db.exec("INSERT INTO Node (id,name,serverHost,agentToken,updatedAt) VALUES ('node','test','example.com','token',CURRENT_TIMESTAMP)");
    db.exec("INSERT INTO Line (id,name,entryNodeId,entryPort,updatedAt) VALUES ('line','direct','node',24443,CURRENT_TIMESTAMP)");
    db.exec(sql);
    assert.equal(db.prepare('SELECT entryPort FROM Line WHERE id=?').get('line').entryPort, 24443);
    const nodeCols = cols(db, 'UpstreamNode').map((row) => row.name);
    assert.ok(!nodeCols.includes('isDirectSub'));
    assert.ok(!nodeCols.includes('fingerprint'));
    for (const name of ['sourceKey', 'connectionHash', 'configHash', 'presenceStatus', 'missingSince']) assert.ok(nodeCols.includes(name));
    assert.equal(cols(db, 'Line').find((row) => row.name === 'entryNodeId').notnull, 0);
    db.exec("INSERT INTO Line (id,name,type,updatedAt) VALUES ('external','external','EXTERNAL',CURRENT_TIMESTAMP)");
    assert.equal(db.prepare('SELECT entryNodeId FROM Line WHERE id=?').get('external').entryNodeId, null);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('旧上游数据阻止 SQL 迁移，持久 schema 与记录不改变', async () => {
  const db = oldDb();
  try {
    db.exec("INSERT INTO UpstreamSubscription (id,name,updatedAt) VALUES ('old','legacy',CURRENT_TIMESTAMP)");
    const before = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
    await assert.rejects(assertUpstreamUpgradeSafe({ $queryRawUnsafe: async (query) => db.prepare(query).all() }), /Backup/);
    assert.throws(() => db.exec(sql), /backup_and_remove_legacy_upstream_before_upgrade/);
    assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' ORDER BY name").all(), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM UpstreamSubscription').get().n, 1);
  } finally { db.close(); }
});
