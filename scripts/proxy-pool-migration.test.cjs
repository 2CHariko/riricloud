'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '../apps/server/prisma/migrations');
const migration = '20261001020000_proxy_pool_line_access';
test('代理池开关迁移只回填旧有效公开直连Mixed，保留Key/余额/游标', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const name of fs.readdirSync(root).filter((n) => n < migration).sort()) { const file = path.join(root, name, 'migration.sql'); if (fs.existsSync(file)) db.exec(fs.readFileSync(file, 'utf8')); }
    db.exec("INSERT INTO User(id,email,passwordHash,uuid,subscriptionToken,balance,updatedAt) VALUES('u','fixture@invalid','hash','uuid','token',123,CURRENT_TIMESTAMP)");
    db.exec("INSERT INTO Node(id,name,serverHost,agentToken,updatedAt) VALUES('n','node','example.com','encrypted',CURRENT_TIMESTAMP)");
    db.exec("INSERT INTO ProxyKey(id,userId,name,username,password,exportToken,trafficUsedBytes,updatedAt) VALUES('k','u','key','pk_0123456789abcdef01234567','secret','export-token',77,CURRENT_TIMESTAMP)");
    db.exec("INSERT INTO TrafficCursor(id,nodeId,credential,uploadTotal,downloadTotal,updatedAt) VALUES('c','n','pk_0123456789abcdef01234567',10,20,CURRENT_TIMESTAMP)");
    const put = db.prepare("INSERT INTO Line(id,name,type,protocolType,status,isPublic,entryNodeId,entryPort,updatedAt) VALUES(?,?,?,?,?,?,?, ?,CURRENT_TIMESTAMP)");
    for (const [id,type,protocol,status,public_,node,port] of [['ok','DIRECT','MIXED','ACTIVE',1,'n',1234],['private','DIRECT','MIXED','ACTIVE',0,'n',1235],['disabled','DIRECT','MIXED','DISABLED',1,'n',1236],['relay','RELAY','MIXED','ACTIVE',1,'n',1237],['http','DIRECT','HTTP','ACTIVE',1,'n',1238],['no-entry','DIRECT','MIXED','ACTIVE',1,null,null]]) put.run(id,id,type,protocol,status,public_,node,port);
    db.exec(fs.readFileSync(path.join(root, migration, 'migration.sql'), 'utf8'));
    const rows = db.prepare('SELECT id,proxyPoolEnabled FROM Line ORDER BY id').all();
    assert.deepEqual(rows.map(r => [r.id,r.proxyPoolEnabled]), [['disabled',0],['http',0],['no-entry',0],['ok',1],['private',0],['relay',0]]);
    assert.equal(db.prepare('SELECT balance FROM User').get().balance,123);
    assert.deepEqual({...db.prepare('SELECT username,password,exportToken,trafficUsedBytes FROM ProxyKey').get()}, {username:'pk_0123456789abcdef01234567',password:'secret',exportToken:'export-token',trafficUsedBytes:77});
    assert.deepEqual({...db.prepare('SELECT uploadTotal,downloadTotal FROM TrafficCursor').get()}, {uploadTotal:10,downloadTotal:20});
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});
