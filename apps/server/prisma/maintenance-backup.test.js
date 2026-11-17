'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, KEY, DatabaseSync, LINE_CREDENTIAL } = require('./maintenance-test-fixture');
const { createBackup, verifyBackup } = require('./maintenance-backup');
const { restoreBackup } = require('./maintenance-restore');
const { acquireLock, lockPaths, assertStartAllowed, RESTORE_MARKER } = require('./maintenance-lock');
const { signManifest, readManifest } = require('./maintenance-manifest');
const { decryptSecret } = require('./secret-crypto');

function useFixture(t) { const f = fixture(); t.after(() => { process.env.RIRICLOUD_ENCRYPTION_KEY = KEY; f.cleanup(); }); return f; }
function editManifest(f, change) {
  const file = path.join(f.backup, 'manifest.json');
  const { keyVerification: _, ...metadata } = JSON.parse(fs.readFileSync(file));
  change(metadata);
  fs.writeFileSync(file, JSON.stringify(signManifest(metadata)));
}
test('双库和二进制完整恢复；余额/订阅/游标/证书/中继凭据保留，演练保持隔离', async (t) => {
  const f = useFixture(t);
  const result = await createBackup(f.config, f.backup);
  assert.equal(result.code, 'BACKUP_CREATED');
  const manifest = await verifyBackup(f.backup);
  assert.equal(JSON.stringify(manifest).includes(KEY), false);
  assert.equal(manifest.files.some((file) => /\.env|\.part|\.lock/.test(file.path)), false);
  assert.equal(manifest.files.some((file) => file.path === 'binaries/manifest.json'), true);
  assert.equal((await restoreBackup(f.backup, f.restore)).code, 'RESTORE_READY');
  const db = new DatabaseSync(path.join(f.restore, 'riri.db'));
  try {
    assert.equal(db.prepare('SELECT balance FROM User').get().balance, 12345);
    assert.equal(db.prepare('SELECT trafficUsedBytes FROM Subscription').get().trafficUsedBytes, 789);
    assert.deepEqual({ ...db.prepare('SELECT uploadTotal,downloadTotal FROM TrafficCursor').get() }, { uploadTotal: 123, downloadTotal: 456 });
    assert.equal(decryptSecret(db.prepare('SELECT agentToken FROM Node').get().agentToken), 'fixture-agent-credential');
    assert.equal(decryptSecret(db.prepare('SELECT privateKeyPem FROM Certificate').get().privateKeyPem), 'fixture-private-key');
    const credential = db.prepare('SELECT version,status,encryptedPayload FROM LineCredential').get();
    assert.equal(credential.version, 3); assert.equal(credential.status, 'ACTIVE');
    assert.deepEqual(JSON.parse(decryptSecret(credential.encryptedPayload)), LINE_CREDENTIAL);
    assert.deepEqual({ ...db.prepare('SELECT operationId,targetVersion,stage,failedStage,errorCode,expectedConfigVersion,entryStopConfirmed FROM LineCredentialRotation').get() }, { operationId: 'fixture-operation', targetVersion: 3, stage: 'FAILED', failedStage: 'APPLYING_LANDING', errorCode: 'NODE_OFFLINE', expectedConfigVersion: 1234567890123, entryStopConfirmed: 1 });
    assert.deepEqual({ ...db.prepare('SELECT * FROM LineCredentialRotation').get() }, f.rotationSnapshot);
    assert.equal(decryptSecret(db.prepare('SELECT egressProxyJson FROM Line').get().egressProxyJson), '{"password":"fixture-relay-credential"}');
  } finally { db.close(); }
  const telemetry = new DatabaseSync(path.join(f.restore, 'telemetry.db'));
  try { assert.equal(telemetry.prepare('SELECT message FROM SystemLog').get().message, 'restore fixture'); } finally { telemetry.close(); }
  assert.deepEqual(fs.readFileSync(path.join(f.restore, 'binaries/resources/fixture/riri-agent')), fs.readFileSync(path.join(f.config.binaries, 'resources/fixture/riri-agent')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.restore, RESTORE_MARKER))).status, 'ready');
  const restoredConfig = { main: path.join(f.restore, 'riri.db'), telemetry: path.join(f.restore, 'telemetry.db'), dataDir: f.restore };
  assert.equal(lockPaths(restoredConfig).some((file) => fs.existsSync(file)), false);
  assert.equal(fs.existsSync(path.join(f.restore, 'binaries/obsolete.lock')), false);
  assert.throws(() => assertStartAllowed({ main: path.join(f.restore, 'riri.db'), telemetry: path.join(f.restore, 'telemetry.db'), dataDir: f.restore }), { code: 'RESTORE_ISOLATED' });
});
test('运行中与残留维护锁均拒绝备份，不抢占、不删除他人锁', async (t) => {
  const f = useFixture(t);
  const lock = acquireLock(f.config, { role: 'startup' });
  await assert.rejects(createBackup(f.config, f.backup), { code: 'MAINTENANCE_LOCKED' });
  assert.equal(fs.existsSync(f.backup), false);
  lock.release();
  const stale = lockPaths(f.config)[0];
  fs.mkdirSync(stale);
  fs.writeFileSync(path.join(stale, 'owner.json'), '{"pid":99999999,"role":"startup"}');
  await assert.rejects(createBackup(f.config, f.backup), { code: 'MAINTENANCE_LOCKED' });
  assert.equal(fs.existsSync(stale), true);
});
test('损坏备份与错误密钥失败，原备份不会被校验写入', async (t) => {
  const f = useFixture(t);
  await createBackup(f.config, f.backup);
  const original = fs.readFileSync(path.join(f.backup, 'databases/main.db'));
  process.env.RIRICLOUD_ENCRYPTION_KEY = 'wrong-fixture-key';
  await assert.rejects(verifyBackup(f.backup), { code: 'KEY_MISMATCH' });
  process.env.RIRICLOUD_ENCRYPTION_KEY = KEY;
  await verifyBackup(f.backup);
  assert.deepEqual(fs.readFileSync(path.join(f.backup, 'databases/main.db')), original);
  fs.appendFileSync(path.join(f.backup, 'databases/main.db'), 'damaged');
  await assert.rejects(restoreBackup(f.backup, f.restore), { code: 'HASH_MISMATCH' });
  assert.equal(fs.existsSync(f.restore), false);
});
test('同版本同迁移严格匹配；伪造元数据即使文件不变也拒绝', async (t) => {
  const f = useFixture(t);
  await createBackup(f.config, f.backup);
  const file = path.join(f.backup, 'manifest.json');
  const pristine = fs.readFileSync(file);
  editManifest(f, (manifest) => { manifest.applicationVersion = '0.0.1'; });
  await assert.rejects(verifyBackup(f.backup), { code: 'BACKUP_VERSION_MISMATCH' });
  fs.writeFileSync(file, pristine);
  editManifest(f, (manifest) => { manifest.migrations.main.pop(); });
  await assert.rejects(verifyBackup(f.backup), { code: 'BACKUP_VERSION_MISMATCH' });
  fs.writeFileSync(file, pristine);
  const altered = JSON.parse(pristine); altered.createdAt = 'tampered';
  fs.writeFileSync(file, JSON.stringify(altered));
  assert.throws(() => readManifest(f.backup), { code: 'MANIFEST_AUTH_FAILED' });
});
test('目录越界、未登记文件、非空恢复目录均拒绝', async (t) => {
  const f = useFixture(t);
  await createBackup(f.config, f.backup);
  const file = path.join(f.backup, 'manifest.json');
  const pristine = fs.readFileSync(file);
  editManifest(f, (manifest) => { manifest.files[0].path = '../outside'; });
  await assert.rejects(verifyBackup(f.backup), { code: 'UNSAFE_PATH' });
  fs.writeFileSync(file, pristine);
  fs.writeFileSync(path.join(f.backup, 'unlisted'), 'x');
  await assert.rejects(verifyBackup(f.backup), { code: 'UNLISTED_FILE' });
  fs.unlinkSync(path.join(f.backup, 'unlisted'));
  fs.mkdirSync(f.restore); fs.writeFileSync(path.join(f.restore, 'riri.db'), 'existing-user-data');
  await assert.rejects(restoreBackup(f.backup, f.restore), { code: 'DESTINATION_NOT_EMPTY' });
  assert.equal(fs.readFileSync(path.join(f.restore, 'riri.db'), 'utf8'), 'existing-user-data');
});
test('中途写入失败不会留下 ready，锁释放后允许备份重试', async (t) => {
  const f = useFixture(t);
  const original = fs.createWriteStream;
  t.mock.method(fs, 'createWriteStream', function (file, options) {
    if (String(file).endsWith(`${path.sep}telemetry.db`)) throw new Error('fixture write interruption');
    return original.call(fs, file, options);
  });
  await assert.rejects(createBackup(f.config, f.backup));
  assert.equal(fs.existsSync(f.backup), false);
  assert.equal(lockPaths(f.config).some((file) => fs.existsSync(file)), false);
  t.mock.restoreAll();
  await createBackup(f.config, f.backup);
  t.mock.method(fs, 'createWriteStream', function (file, options) {
    if (String(file).startsWith(f.restore) && String(file).endsWith(`${path.sep}telemetry.db`)) throw new Error('fixture restore interruption');
    return original.call(fs, file, options);
  });
  await assert.rejects(restoreBackup(f.backup, f.restore));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.restore, RESTORE_MARKER))).status, 'incomplete');
  assert.throws(() => assertStartAllowed({ ...f.config, main: path.join(f.restore, 'riri.db'), dataDir: f.restore }), { code: 'RESTORE_NOT_READY' });
});
test('SQLite 页面损坏和未完成的迁移均不发布有效备份', async (t) => {
  const f = useFixture(t);
  const db = new DatabaseSync(f.config.main);
  db.exec('UPDATE _prisma_migrations SET finished_at = NULL WHERE rowid = 1'); db.close();
  await assert.rejects(createBackup(f.config, f.backup), { code: 'DATABASE_MIGRATIONS_MISMATCH' });
  assert.equal(fs.existsSync(f.backup), false);
  fs.writeFileSync(f.config.main, 'invalid-sqlite');
  await assert.rejects(createBackup(f.config, f.backup), { code: 'SQLITE_VALIDATION_FAILED' });
  assert.equal(fs.existsSync(f.backup), false);
});
test('非空 WAL 冷备在进程停止后保留已提交业务数据，原备份校验前后逐字节一致', async (t) => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const f = useFixture(t);
  const child = spawn(process.execPath, ['-e', `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE User SET balance=998877;'); process.stdout.write('ready'); setInterval(() => {}, 1000);`, f.config.main], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await once(child.stdout, 'data');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  assert.ok(fs.statSync(`${f.config.main}-wal`).size > 32);
  await createBackup(f.config, f.backup);
  const manifest = readManifest(f.backup);
  assert.ok(manifest.files.some((file) => file.path === 'databases/main.db-wal'));
  const bytes = ['main.db', 'main.db-wal', 'main.db-shm'].map((name) => fs.readFileSync(path.join(f.backup, 'databases', name)));
  await verifyBackup(f.backup);
  ['main.db', 'main.db-wal', 'main.db-shm'].forEach((name, index) => assert.deepEqual(fs.readFileSync(path.join(f.backup, 'databases', name)), bytes[index]));
  await restoreBackup(f.backup, f.restore);
  const restored = new DatabaseSync(path.join(f.restore, 'riri.db'));
  try { assert.equal(restored.prepare('SELECT balance FROM User').get().balance, 998877); } finally { restored.close(); }
});
test('源资源与备份均拒绝符号链接/目录联接和硬链接', async (t) => {
  const f = useFixture(t);
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret'), 'never-copy');
  const link = path.join(f.config.binaries, 'escape');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createBackup(f.config, f.backup), { code: 'UNSAFE_PATH' });
  fs.unlinkSync(link);
  await createBackup(f.config, f.backup);
  fs.symlinkSync(outside, path.join(f.backup, 'binaries/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyBackup(f.backup), { code: 'UNSAFE_PATH' });
  fs.unlinkSync(path.join(f.backup, 'binaries/escape'));
  const binary = path.join(f.backup, 'binaries/resources/fixture/riri-agent');
  fs.linkSync(binary, path.join(outside, 'hardlink'));
  await assert.rejects(verifyBackup(f.backup), { code: 'UNLISTED_FILE' });
});
test('锁共享任一数据库即互斥，释放部分已获取锁但保留冲突锁', (t) => {
  const f = useFixture(t);
  const lock = acquireLock(f.config, { role: 'startup' });
  t.after(() => lock.release());
  const other = { ...f.config, main: path.join(f.root, 'other-main.db'), dataDir: path.join(f.root, 'other-data') };
  assert.throws(() => acquireLock(other), { code: 'MAINTENANCE_LOCKED' });
  assert.equal(fs.existsSync(`${other.main}.maintenance.lock`), false);
  assert.ok(lockPaths(f.config).every((file) => fs.existsSync(file)));
});
test('创建备份也必须核验库内密文，不能用错误密钥给不可解密数据库签发新清单', async (t) => {
  const f = useFixture(t);
  process.env.RIRICLOUD_ENCRYPTION_KEY = 'wrong-key-at-create';
  await assert.rejects(createBackup(f.config, f.backup), { code: 'KEY_MISMATCH' });
  assert.equal(fs.existsSync(f.backup), false);
});
test('普通业务文本中的 enc:v1 示例不当作真实密文，避免误拒绝备份', async (t) => {
  const f = useFixture(t);
  const db = new DatabaseSync(f.config.main);
  db.exec("UPDATE User SET nickname='enc:v1:ordinary-user-label'"); db.close();
  await createBackup(f.config, f.backup);
  assert.equal((await verifyBackup(f.backup)).formatVersion, 1);
});

test('LineCredential.encryptedPayload 单独损坏时拒绝备份，不被其他可解密字段掩盖', async (t) => {
  const f = useFixture(t);
  const db = new DatabaseSync(f.config.main);
  db.exec("UPDATE LineCredential SET encryptedPayload='enc:v1:invalid-payload'"); db.close();
  await assert.rejects(createBackup(f.config, f.backup), { code: 'KEY_MISMATCH' });
  assert.equal(fs.existsSync(f.backup), false);
});
