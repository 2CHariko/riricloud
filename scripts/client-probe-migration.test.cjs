'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const migrationName = '20261001010000_client_probe_metadata';
const isolationMigrationName = '20261003010000_probe_measurement_isolation';
const root = path.resolve(__dirname, '../apps/server/prisma/migrations');

// 永远只迁移 scratch 夹具，不读取 DATABASE_URL 或真实开发/E2E 数据库。
function withFixture(run) {
  const dir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'client-probe-migration-'));
  const db = new DatabaseSync(path.join(dir, 'fixture.db'));
  try { run(db); } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
function migrateBefore(db, name) {
  for (const dir of fs.readdirSync(root).filter((entry) => entry < name).sort()) {
    const file = path.join(root, dir, 'migration.sql'); if (fs.existsSync(file)) db.exec(fs.readFileSync(file, 'utf8'));
  }
}

test('测量迁移只失效旧快照，保留上游、线路、账号和金额', () => withFixture((db) => {
  migrateBefore(db, migrationName);
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
}));

test('普通延迟迁移原样保留全部旧 JSON，清空当前摘要且不改变其它业务数据', () => withFixture((db) => {
  migrateBefore(db, isolationMigrationName);
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(`
    INSERT INTO User(id,email,passwordHash,uuid,subscriptionToken,balance,trafficUsedBytes,updatedAt) VALUES('u','fixture@invalid','hash','uuid','token',123,77,CURRENT_TIMESTAMP);
    INSERT INTO Node(id,name,serverHost,agentToken,updatedAt) VALUES('n','node','127.0.0.1','encrypted',CURRENT_TIMESTAMP);
    INSERT INTO Plan(id,name,durationDays,trafficLimitBytes,updatedAt) VALUES('p','plan',30,1000000,CURRENT_TIMESTAMP);
    INSERT INTO Subscription(id,userId,planId,subscriptionToken,trafficLimitBytes,trafficUsedBytes,updatedAt) VALUES('s','u','p','sub-token',1000000,77,CURRENT_TIMESTAMP);
    INSERT INTO ProxyKey(id,userId,name,username,password,exportToken,whitelistIps,trafficUsedBytes,updatedAt) VALUES('k','u','key','pk_0123456789abcdef01234567','secret','export-token','127.0.0.1/32',77,CURRENT_TIMESTAMP);
    INSERT INTO TrafficCursor(id,nodeId,credential,uploadTotal,downloadTotal,updatedAt) VALUES('c','n','pk_0123456789abcdef01234567',10,20,CURRENT_TIMESTAMP);
    INSERT INTO UpstreamSubscription(id,name,updatedAt) VALUES('source','source',CURRENT_TIMESTAMP);
  `);
  const histories = [JSON.stringify({ schemaVersion: 1, measurement: 'PROXY_HTTP_DELAY', latencyMs: 20 }), '{"status":"SUCCESS","latencyMs":30}', null, 'unrecognized-history'];
  const putNode = db.prepare('INSERT INTO UpstreamNode(id,name,subscriptionId,protocolType,serverHost,serverPort,paramsJson,rawConfigJson,connectionHash,configHash,lastProbeJson,latencyMs,lastTestedAt,lastTestStatus,lastTestMessage,status,updatedAt) VALUES(?,?,\'source\',\'TROJAN\',\'example.com\',443,\'encrypted\',\'raw-encrypted\',?,?,?,20,CURRENT_TIMESTAMP,\'SUCCESS\',\'old-node\',?,CURRENT_TIMESTAMP)');
  const putLine = db.prepare('INSERT INTO Line(id,name,type,upstreamNodeId,lastProbeJson,lastLatencyMs,lastTestedAt,lastTestStatus,lastTestMessage,status,egressProxyJson,updatedAt) VALUES(?,?,\'EXTERNAL\',?,?,30,CURRENT_TIMESTAMP,\'SUCCESS\',\'old-line\',?,\'encrypted-egress\',CURRENT_TIMESTAMP)');
  for (const [i, history] of histories.entries()) {
    const status = i % 2 ? 'DISABLED' : 'ACTIVE';
    putNode.run(`upstream-${i}`, `upstream-${i}`, `connection-${i}`, `config-${i}`, history, status);
    putLine.run(`line-${i}`, `line-${i}`, `upstream-${i}`, history, status);
  }
  db.exec(`INSERT INTO TrafficLog(id,nodeId,userId,lineId,proxyKeyId,upload,download) VALUES('t','n','u','line-0','k',10,20);
    INSERT INTO UserLineGrant(id,userId,lineId) VALUES('g','u','line-1');`);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const mutable = ['lastProbeJson', 'lastDebugProbeJson', 'lastLatencyMs', 'latencyMs', 'lastTestedAt', 'lastTestStatus', 'lastTestMessage'];
  const snapshot = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all().map(row => {
    const copy = { ...row }; if (['Line', 'UpstreamNode'].includes(table)) for (const field of mutable) delete copy[field]; return copy;
  })]));
  const before = snapshot();
  const oldColumns = Object.fromEntries(['Line', 'UpstreamNode'].map(table => [table, db.prepare(`PRAGMA table_info("${table}")`).all()]));
  db.exec(fs.readFileSync(path.join(root, isolationMigrationName, 'migration.sql'), 'utf8'));
  assert.deepEqual(snapshot(), before, 'Only measurement columns may change; preserve secrets, config, statuses, relations, balances and traffic');
  for (const table of ['Line', 'UpstreamNode']) {
    const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY id`).all();
    assert.equal(rows.length, histories.length);
    for (const [i, row] of rows.entries()) {
      assert.equal(row.lastDebugProbeJson, histories[i], 'Preserve old JSON byte-for-byte, including null and unknown formats');
      for (const field of mutable.filter(field => field !== 'lastDebugProbeJson')) if (field in row) assert.equal(row[field], null, `Clear ${table}.${field}`);
    }
    const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
    assert.deepEqual(columns.filter(column => column.name !== 'lastDebugProbeJson'), oldColumns[table]);
    const added = columns.find(column => column.name === 'lastDebugProbeJson');
    assert.equal(added.type, 'TEXT'); assert.equal(added.notnull, 0); assert.equal(added.dflt_value, null);
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
}));
