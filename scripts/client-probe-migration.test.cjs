'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const migrationName = '20261001010000_client_probe_metadata';
const root = path.resolve(__dirname, '../apps/server/prisma/migrations');

test('测量迁移只失效旧快照，保留上游、线路、账号和金额', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const dir of fs.readdirSync(root).filter((name) => name < migrationName).sort()) {
      const file = path.join(root, dir, 'migration.sql'); if (fs.existsSync(file)) db.exec(fs.readFileSync(file, 'utf8'));
    }
    db.exec("INSERT INTO User (id,email,passwordHash,uuid,subscriptionToken,balance,updatedAt) VALUES ('u','test@example.com','hash','uuid','token',123,CURRENT_TIMESTAMP)");
    db.exec("INSERT INTO UpstreamSubscription (id,name,updatedAt) VALUES ('s','source',CURRENT_TIMESTAMP)");
    db.exec("INSERT INTO UpstreamNode (id,name,subscriptionId,protocolType,serverHost,serverPort,paramsJson,rawConfigJson,connectionHash,configHash,latencyMs,lastTestStatus,updatedAt) VALUES ('n','node','s','TROJAN','example.com',443,'encrypted','encrypted','connection','config',20,'SUCCESS',CURRENT_TIMESTAMP)");
    db.exec("INSERT INTO Line (id,name,type,upstreamNodeId,lastLatencyMs,lastTestStatus,updatedAt) VALUES ('l','external','EXTERNAL','n',30,'SUCCESS',CURRENT_TIMESTAMP)");
    db.exec(fs.readFileSync(path.join(root, migrationName, 'migration.sql'), 'utf8'));
    assert.equal(db.prepare('SELECT balance FROM User WHERE id=?').get('u').balance, 123);
    const line = db.prepare('SELECT upstreamNodeId,lastLatencyMs,lastTestStatus,lastProbeJson FROM Line').get();
    assert.equal(line.upstreamNodeId, 'n'); assert.equal(line.lastLatencyMs, null); assert.equal(line.lastTestStatus, null); assert.equal(line.lastProbeJson, null);
    const node = db.prepare('SELECT configHash,latencyMs,lastTestStatus,lastProbeJson FROM UpstreamNode').get();
    assert.equal(node.configHash, 'config'); assert.equal(node.latencyMs, null); assert.equal(node.lastTestStatus, null); assert.equal(node.lastProbeJson, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM UpstreamSubscription').get().n, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});
