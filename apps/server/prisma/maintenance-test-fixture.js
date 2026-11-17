'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { migrationSet } = require('./maintenance-database');
const { encryptSecret } = require('./secret-crypto');
const { resolveConfig } = require('./maintenance-config');
const KEY = 'maintenance-fixture-encryption-key-not-production-000001';
const LINE_CREDENTIAL = { uuid: '3a05d854-72f6-4592-82b5-36fe2419fa10', email: 'relay-' + 'a'.repeat(48), credential: Buffer.alloc(32, 0x11).toString('base64url') };
function prepareDatabase(file, directory) {
  const db = new DatabaseSync(file);
  try {
    for (const migration of migrationSet(directory)) db.exec(fs.readFileSync(path.join(directory, migration.name, 'migration.sql'), 'utf8'));
    db.exec('CREATE TABLE _prisma_migrations(id TEXT PRIMARY KEY, checksum TEXT NOT NULL, migration_name TEXT NOT NULL, finished_at DATETIME, rolled_back_at DATETIME)');
    const insert = db.prepare('INSERT INTO _prisma_migrations VALUES (?, ?, ?, ?, NULL)');
    for (const migration of migrationSet(directory)) insert.run(migration.name, migration.sha256, migration.name, Date.now());
  } finally { db.close(); }
}
function fixture() {
  process.env.RIRICLOUD_ENCRYPTION_KEY = KEY;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'riri-maintenance-test-'));
  const data = path.join(root, 'source');
  fs.mkdirSync(data);
  const main = path.join(data, 'riri.db');
  const telemetry = path.join(data, 'telemetry.db');
  prepareDatabase(main, path.join(__dirname, 'migrations'));
  prepareDatabase(telemetry, path.join(__dirname, 'telemetry/migrations'));
  const db = new DatabaseSync(main);
  let rotationSnapshot;
  try {
    db.exec("INSERT INTO User(id,email,passwordHash,uuid,subscriptionToken,balance,updatedAt) VALUES('u','fixture@invalid','hash','fixture-user','token',12345,CURRENT_TIMESTAMP)");
    db.exec("INSERT INTO Plan(id,name,durationDays,trafficLimitBytes,updatedAt) VALUES('p','plan',30,1000000,CURRENT_TIMESTAMP)");
    db.exec("INSERT INTO Subscription(id,userId,planId,trafficLimitBytes,trafficUsedBytes,subscriptionToken,updatedAt) VALUES('s','u','p',1000000,789,'sub-token',CURRENT_TIMESTAMP)");
    db.prepare("INSERT INTO Node(id,name,serverHost,agentToken,updatedAt) VALUES('n','fixture','example.invalid',?,CURRENT_TIMESTAMP)").run(encryptSecret('fixture-agent-credential'));
    db.exec("INSERT INTO TrafficCursor(id,nodeId,credential,uploadTotal,downloadTotal,updatedAt) VALUES('c','n','fixture-user',123,456,CURRENT_TIMESTAMP)");
    db.prepare("INSERT INTO Certificate(id,name,certificatePem,privateKeyPem,subject,issuer,serialNumber,validFrom,validTo,updatedAt) VALUES('cert','fixture','fixture-certificate',?,'subject','issuer','serial',0,4102444800000,CURRENT_TIMESTAMP)").run(encryptSecret('fixture-private-key'));
    db.prepare("INSERT INTO Line(id,name,type,protocolType,entryNodeId,entryPort,egressProxyJson,updatedAt) VALUES('l','fixture','DIRECT','MIXED','n',12345,?,CURRENT_TIMESTAMP)").run(encryptSecret('{"password":"fixture-relay-credential"}'));
    db.prepare("INSERT INTO LineCredential(id,lineId,version,encryptedPayload,uuidHash,nameHash,status) VALUES('lc','l',3,?,'fixture-uuid-hash','fixture-name-hash','ACTIVE')").run(encryptSecret(JSON.stringify(LINE_CREDENTIAL)));
    const rotationValues = { id: 'rotation', operationId: 'fixture-operation', lineId: 'l', fromVersion: 2, targetVersion: 3, landingCredentialVersion: 3, stage: 'FAILED', failedStage: 'APPLYING_LANDING', errorCode: 'NODE_OFFLINE', entryNodeId: 'n', landingNodeId: 'n', entryTag: 'line-l', landingTag: 'landing-l', expectedNodeId: 'n', expectedConfigVersion: 1234567890123, accepted: 1, entryStopConfirmed: 1, deadlineAt: 4102444800000, updatedAt: Date.now() };
    // 以真实迁移表结构构造夹具；新必填字段缺少有意义的值时明确失败，不伪造默认值。
    const columns = db.prepare('PRAGMA table_info("LineCredentialRotation")').all();
    const missing = columns.filter(column => column.notnull && column.dflt_value === null && !Object.hasOwn(rotationValues, column.name));
    if (missing.length) throw new Error('Maintenance rotation fixture needs values for: ' + missing.map(column => column.name).join(', '));
    const fields = columns.map(column => column.name).filter(name => Object.hasOwn(rotationValues, name));
    db.prepare('INSERT INTO LineCredentialRotation (' + fields.map(name => '"' + name + '"').join(',') + ') VALUES (' + fields.map(() => '?').join(',') + ')').run(...fields.map(name => rotationValues[name]));
    rotationSnapshot = { ...db.prepare('SELECT * FROM LineCredentialRotation').get() };
  } finally { db.close(); }
  const metrics = new DatabaseSync(telemetry);
  try { metrics.exec("INSERT INTO SystemLog(id,source,level,module,message) VALUES('log','SERVER','INFO','fixture','restore fixture')"); } finally { metrics.close(); }
  fs.mkdirSync(path.join(data, 'binaries/resources/fixture'), { recursive: true });
  fs.writeFileSync(path.join(data, 'binaries/resources/fixture/riri-agent'), Buffer.alloc(1024 * 128, 0x7a));
  fs.writeFileSync(path.join(data, 'binaries/manifest.json'), '{"schemaVersion":1,"resources":[]}');
  fs.writeFileSync(path.join(data, '.env'), 'DO_NOT_BACKUP=private-secret');
  fs.writeFileSync(path.join(data, 'binaries/.env.private'), 'DO_NOT_BACKUP=private-secret');
  fs.writeFileSync(path.join(data, 'binaries/download.part'), 'partial-download');
  fs.mkdirSync(path.join(data, 'binaries/obsolete.lock'));
  fs.writeFileSync(path.join(data, 'binaries/obsolete.lock/owner.json'), '{"pid":9999999}');
  const config = resolveConfig({ database: `file:${main.split(path.sep).join('/')}`, telemetryDatabase: `file:${telemetry.split(path.sep).join('/')}`, dataDir: data });
  return { root, config, rotationSnapshot, backup: path.join(root, 'backup'), restore: path.join(root, 'restored'), cleanup() {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('riri-maintenance-test-')) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  } };
}
module.exports = { fixture, KEY, DatabaseSync, LINE_CREDENTIAL };
