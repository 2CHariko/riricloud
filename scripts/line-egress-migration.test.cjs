'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const prismaRoot = path.resolve(__dirname, '../apps/server/prisma');
const migrations = path.join(prismaRoot, 'migrations');
function findMigration() {
  const names = fs.readdirSync(migrations).sort().filter(name => {
    const file = path.join(migrations, name, 'migration.sql');
    return fs.existsSync(file) && /ADD\s+COLUMN\s+["`\[]?egressProxyJson\b/i.test(fs.readFileSync(file, 'utf8'));
  });
  assert.equal(names.length, 1, 'Exactly one additive egressProxyJson migration required');
  return names[0];
}
test('线路出站迁移新增可空字段，旧线路与用户/Key/订阅/流量完整保留', () => {
  const migration = findMigration(), db = new DatabaseSync(':memory:');
  try {
    for (const name of fs.readdirSync(migrations).sort().filter(name => name < migration)) {
      const file = path.join(migrations, name, 'migration.sql'); if (fs.existsSync(file)) db.exec(fs.readFileSync(file, 'utf8'));
    }
    db.exec('PRAGMA foreign_keys=ON');
    assert.ok(!db.prepare('PRAGMA table_info("Line")').all().some(c => c.name === 'egressProxyJson'));
    db.exec(`
      INSERT INTO User(id,email,passwordHash,uuid,subscriptionToken,balance,trafficUsedBytes,updatedAt) VALUES('u','fixture@invalid','hash','uuid','token',123,77,CURRENT_TIMESTAMP);
      INSERT INTO Node(id,name,serverHost,agentToken,updatedAt) VALUES('n','node','127.0.0.1','encrypted',CURRENT_TIMESTAMP);
      INSERT INTO Plan(id,name,durationDays,trafficLimitBytes,updatedAt) VALUES('p','plan',30,1000000,CURRENT_TIMESTAMP);
      INSERT INTO Subscription(id,userId,planId,subscriptionToken,trafficLimitBytes,trafficUsedBytes,updatedAt) VALUES('s','u','p','sub-token',1000000,77,CURRENT_TIMESTAMP);
      INSERT INTO ProxyKey(id,userId,name,username,password,exportToken,whitelistIps,trafficUsedBytes,updatedAt) VALUES('k','u','key','pk_0123456789abcdef01234567','secret','export-token','127.0.0.1/32',77,CURRENT_TIMESTAMP);
      INSERT INTO TrafficCursor(id,nodeId,credential,uploadTotal,downloadTotal,updatedAt) VALUES('c','n','pk_0123456789abcdef01234567',10,20,CURRENT_TIMESTAMP);
    `);
    const put = db.prepare('INSERT INTO Line(id,name,type,relayMode,protocolType,status,isPublic,proxyPoolEnabled,entryNodeId,entryPort,paramsJson,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)');
    for (const [id, type, mode, protocol, status, public_, pool] of [
      ['direct', 'DIRECT', null, 'VLESS', 'ACTIVE', 1, 0],
      ['pool', 'DIRECT', null, 'MIXED', 'ACTIVE', 1, 1],
      ['private', 'DIRECT', null, 'SOCKS', 'DISABLED', 0, 0],
      ['blind', 'RELAY', 'BLIND_FORWARD', 'VLESS', 'ACTIVE', 1, 0],
      ['protocol', 'RELAY', 'PROTOCOL_PROXY', 'VLESS', 'ACTIVE', 1, 0],
      ['bridge', 'RELAY', 'TARGET_LINE', 'VLESS', 'ACTIVE', 1, 0],
      ['upstream', 'RELAY', 'UPSTREAM_NODE', 'MIXED', 'ACTIVE', 1, 1],
      ['external', 'EXTERNAL', null, 'HTTP', 'ACTIVE', 1, 0]
    ]) put.run(id, id, type, mode, protocol, status, public_, pool, 'n', 20000 + Number(db.prepare('SELECT COUNT(*) AS n FROM Line').get().n), '{"fixture":true}');
    db.exec(`INSERT INTO TrafficLog(id,nodeId,userId,lineId,proxyKeyId,upload,download) VALUES('t','n','u','pool','k',10,20);
      INSERT INTO UserLineGrant(id,userId,lineId) VALUES('g','u','private');`);
    const tables = ['User', 'Node', 'Plan', 'Subscription', 'ProxyKey', 'TrafficCursor', 'TrafficLog', 'UserLineGrant', 'Line'];
    const snapshot = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY id`).all().map(row => { const copy = { ...row }; delete copy.egressProxyJson; return copy; })]));
    const before = snapshot(), oldColumns = db.prepare('PRAGMA table_info("Line")').all();
    db.exec(fs.readFileSync(path.join(migrations, migration, 'migration.sql'), 'utf8'));
    assert.deepEqual(snapshot(), before, 'Migration must preserve every existing row/column');
    const columns = db.prepare('PRAGMA table_info("Line")').all();
    assert.deepEqual(columns.filter(c => c.name !== 'egressProxyJson'), oldColumns);
    const added = columns.find(c => c.name === 'egressProxyJson'); assert.equal(added.type, 'TEXT'); assert.equal(added.notnull, 0); assert.equal(added.dflt_value, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM Line WHERE egressProxyJson IS NULL').get().n, 8);
    db.exec("INSERT INTO Line(id,name,updatedAt) VALUES('new','new',CURRENT_TIMESTAMP)");
    assert.equal(db.prepare("SELECT egressProxyJson FROM Line WHERE id='new'").get().egressProxyJson, null);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.match(fs.readFileSync(path.join(prismaRoot, 'schema.prisma'), 'utf8'), /\begressProxyJson\s+String\?/);
  } finally { db.close(); }
});
