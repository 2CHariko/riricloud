'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { fixture, KEY } = require('./maintenance-test-fixture');
const { acquireLock, lockPaths, RESTORE_MARKER } = require('./maintenance-lock');
const { createBackup } = require('./maintenance-backup');
const { serverRoot } = require('./maintenance-config');
function useFixture(t) { const f = fixture(); t.after(() => f.cleanup()); return f; }
function environment(config) {
  return { ...process.env, RIRICLOUD_ENCRYPTION_KEY: KEY, JWT_SECRET: 'fixture-strong-jwt-signing-secret-key-1234567890', DATABASE_URL: `file:${config.main.split(path.sep).join('/')}`, TELEMETRY_DATABASE_URL: `file:${config.telemetry.split(path.sep).join('/')}`, RIRICLOUD_DATA_DIR: config.dataDir };
}
function cli(args, env = process.env, entry = 'maintenance-cli.js') {
  const child = spawnSync(process.execPath, [path.join(__dirname, entry), ...args], { cwd: serverRoot, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(child.error, undefined);
  return { ...child, result: JSON.parse(child.stdout.trim()) };
}
test('CLI 稳定 JSON 及退出码；源码/Docker 共用，不把密钥或输入值写入诊断', async (t) => {
  const f = useFixture(t);
  const unknown = cli(['not-a-command', '--password', 'must-not-echo']);
  assert.equal(unknown.status, 2); assert.equal(unknown.result.code, 'INVALID_COMMAND');
  assert.equal(unknown.stdout.includes('must-not-echo'), false);
  const env = environment(f.config);
  const created = cli(['backup:create', '--destination', f.backup], env);
  assert.equal(created.status, 0, created.stdout); assert.equal(created.result.code, 'BACKUP_CREATED');
  assert.equal(created.stdout.includes(KEY), false);
  const wrongKey = cli(['backup:verify', '--backup', f.backup], { ...env, RIRICLOUD_ENCRYPTION_KEY: 'wrong-fixture-key' });
  assert.equal(wrongKey.status, 6); assert.equal(wrongKey.result.code, 'KEY_MISMATCH');
  const restored = cli(['backup:restore', '--backup', f.backup, '--destination', f.restore], env);
  assert.equal(restored.status, 0, restored.stdout); assert.equal(restored.result.isolated, true);
  const docker = spawnSync(process.execPath, [path.resolve(__dirname, '../../..', 'scripts/docker-entrypoint.js'), 'backup:verify', '--backup', f.backup], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(docker.status, 0, docker.stderr);
  assert.equal(JSON.parse(docker.stdout).code, 'BACKUP_VERIFIED');
});
test('跨进程锁和父子租约：仅直接子进程可继承，子退出不释放父锁', async (t) => {
  const f = useFixture(t);
  const env = environment(f.config);
  const owner = acquireLock(f.config, { role: 'startup' });
  t.after(() => owner.release());
  const locked = cli(['backup:create', '--destination', f.backup], env);
  assert.equal(locked.status, 3); assert.equal(locked.result.code, 'MAINTENANCE_LOCKED');
  const code = "const { resolveConfig } = require('./maintenance-config'); require('./maintenance-lock').acquireStartupLock(resolveConfig()).then(async lease => { if (!lease.inherited) process.exit(22); await lease.release(); process.disconnect(); }).catch(() => process.exit(3));";
  const inherited = spawn(process.execPath, ['-e', code], { cwd: __dirname, env: { ...env, RIRICLOUD_MAINTENANCE_LEASE: owner.childEnvironment.RIRICLOUD_MAINTENANCE_LEASE }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const session = owner.bindChild(inherited);
  const [codeResult] = await once(inherited, 'exit'); session.detach();
  assert.equal(codeResult, 0); assert.equal(session.closed, true);
  assert.ok(lockPaths(f.config).every((file) => fs.existsSync(file)));
  const forged = spawnSync(process.execPath, ['-e', code], { cwd: __dirname, env: { ...env, RIRICLOUD_MAINTENANCE_LEASE: JSON.stringify({ parentPid: -1, token: 'forged' }) }, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(forged.status, 0);
});
async function dockerSandbox(f, beforeStep) {
  const calls = [];
  const entry = path.resolve(__dirname, '../../../scripts/docker-entrypoint.js');
  const mockProcess = {
    ...process, argv: [process.execPath, entry],
    env: { ...environment(f.config), MASTER_DATA_DIR: f.config.dataDir, MASTER_TMP_DIR: f.config.dataDir, AUTO_SEED: 'false', NODE_ENV: 'development' },
    on() {}, exit(code) { throw new Error(`Unexpected exit ${code}`); }, exitCode: undefined
  };
  const childProcesses = {
    spawnSync(_command, args) { beforeStep(); calls.push(args); return { status: 0 }; },
    spawn() {
      beforeStep(); calls.push(['master']);
      const child = new EventEmitter(); child.pid = 123456; child.exitCode = null; child.kill = () => {};
      child.send = message => { if (message.type === 'riricloud-maintenance-grant') setImmediate(() => { const owner = JSON.parse(fs.readFileSync(path.join(lockPaths(f.config)[0], 'owner.json'))); child.emit('message', { type: 'riricloud-maintenance-closed', token: owner.token, pid: child.pid }); child.emit('exit', 0); }); };
      setImmediate(() => { const owner = JSON.parse(fs.readFileSync(path.join(lockPaths(f.config)[0], 'owner.json'))); child.emit('message', { type: 'riricloud-maintenance-request', token: owner.token, pid: child.pid, challenge: 'b'.repeat(64), paths: lockPaths(f.config) }); });
      return child;
    }
  };
  const errors = [];
  const context = { process: mockProcess, __dirname: path.dirname(entry), Buffer, setTimeout, clearTimeout,
    console: { log() {}, error(message) { errors.push(message); } },
    require(id) { return id === 'node:child_process' ? childProcesses : require(id); }
  };
  await vm.runInNewContext(fs.readFileSync(entry, 'utf8'), context);
  return { calls, errors, status: mockProcess.exitCode };
}
test('Docker 从首次迁移到 Master 退出全程持锁；被锁时不执行任何迁移', async (t) => {
  const f = useFixture(t);
  const first = await dockerSandbox(f, () => assert.ok(lockPaths(f.config).every((file) => fs.existsSync(file))));
  assert.equal(first.errors.length, 0, first.errors.join('\n'));
  assert.equal(first.status, 0);
  assert.ok(first.calls.some((args) => args.includes('deploy')));
  assert.ok(first.calls.some((args) => args.includes('master')));
  assert.equal(lockPaths(f.config).some((file) => fs.existsSync(file)), false);
  const owner = acquireLock(f.config); t.after(() => owner.release());
  const blocked = await dockerSandbox(f, () => assert.fail('Migration executed under maintenance lock'));
  assert.equal(blocked.calls.length, 0); assert.equal(blocked.status, 1);
});
test('恢复隔离在迁移前阻断，入口不会加载 Nest 应用/邮件/Agent', (t) => {
  const f = useFixture(t);
  fs.writeFileSync(path.join(f.config.dataDir, RESTORE_MARKER), JSON.stringify({ status: 'ready', isolated: true }));
  const env = environment(f.config);
  const startup = spawnSync(process.execPath, [path.join(__dirname, 'maintenance-start.js')], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(startup.status, 9, startup.stderr); assert.match(startup.stderr, /RESTORE_ISOLATED/);
  const guardedMain = `const Module = require('node:module'); const original = Module._load; Module._load = function (id, ...args) { if (id === './app.module') { process.stderr.write('APPLICATION_LOADED'); throw new Error('blocked test network surface'); } return original.call(this, id, ...args); }; require('ts-node').register({ transpileOnly: true, project: './tsconfig.json' }); require('./src/main.ts');`;
  const isolated = spawnSync(process.execPath, ['-e', guardedMain], { cwd: serverRoot, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(isolated.status, 1, isolated.stderr);
  assert.equal(isolated.stderr.includes('APPLICATION_LOADED'), false);
  assert.equal(lockPaths(f.config).some((file) => fs.existsSync(file)), false);
});
test('CLI 校验始终离线：禁止网络访问的子进程仍可校验并恢复', async (t) => {
  const f = useFixture(t); await createBackup(f.config, f.backup);
  const script = `for (const name of ['node:net','node:tls','node:http','node:https','node:dgram']) { const api = require(name); for (const method of ['connect','createConnection','createServer','request','get','createSocket']) if (api[method]) api[method] = () => { throw new Error('network-forbidden-fixture'); }; } global.fetch = () => { throw new Error('network-forbidden-fixture'); }; require('./maintenance-cli').run(['backup:restore','--backup',process.argv[1],'--destination',process.argv[2]]).then(r => { console.log(JSON.stringify(r)); process.exitCode = r.exitCode || 0; });`;
  const result = spawnSync(process.execPath, ['-e', script, f.backup, f.restore], { cwd: __dirname, env: environment(f.config), encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).code, 'RESTORE_READY');
});
test('发行包目录布局复用相同 CLI，不依赖仓库根目录或 TypeScript 运行时', async (t) => {
  const f = useFixture(t); await createBackup(f.config, f.backup);
  const bundle = path.join(f.root, 'bundle');
  const prisma = path.join(bundle, 'prisma'); fs.mkdirSync(prisma, { recursive: true });
  for (const file of fs.readdirSync(__dirname)) {
    if ((file.startsWith('maintenance-') && file.endsWith('.js') && !file.endsWith('.test.js') && file !== 'maintenance-test-fixture.js') || ['secret-crypto.js', 'sqlite-url.js'].includes(file)) fs.copyFileSync(path.join(__dirname, file), path.join(prisma, file));
  }
  for (const directory of ['migrations', 'telemetry/migrations']) fs.cpSync(path.join(__dirname, directory), path.join(prisma, directory), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'package.json'), JSON.stringify({ name: 'riricloud-master', version: require('./maintenance-config').applicationVersion() }));
  fs.symlinkSync(path.join(serverRoot, 'node_modules'), path.join(bundle, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = spawnSync(process.execPath, [path.join(prisma, 'maintenance-cli.js'), 'backup:verify', '--backup', f.backup], { cwd: bundle, env: environment(f.config), encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).code, 'BACKUP_VERIFIED');
});
test('Master 优雅停机先关闭应用再解锁；关闭失败必须保留锁', () => {
  const code = `require('ts-node').register({ transpileOnly: true, project: './tsconfig.json' }); const { registerMaintenanceShutdown } = require('./src/common/maintenance-startup'); registerMaintenanceShutdown({ async close() { console.log('application-closed'); if (process.env.FIXTURE_CLOSE_FAIL) throw new Error('fixture'); } }, { release() { console.log('lock-released'); } }); process.emit('SIGTERM');`;
  const normal = spawnSync(process.execPath, ['-e', code], { cwd: serverRoot, env: process.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(normal.status, 0, normal.stderr);
  assert.deepEqual(normal.stdout.trim().split(/\r?\n/), ['application-closed', 'lock-released']);
  const failed = spawnSync(process.execPath, ['-e', code], { cwd: serverRoot, env: { ...process.env, FIXTURE_CLOSE_FAIL: '1' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(failed.status, 1); assert.equal(failed.stdout.includes('lock-released'), false);
});
test('受锁启动只以独占方式建立缺失双库文件，保留已有库并拒绝符号链接', (t) => {
  const f = useFixture(t);
  const { prepareDatabaseFiles } = require('./maintenance-start');
  const config = { main: path.join(f.root, 'new/riri.db'), telemetry: path.join(f.root, 'new/telemetry.db'), dataDir: path.join(f.root, 'new') };
  const lease = acquireLock(config, { role: 'startup' });
  t.after(() => lease.release());
  prepareDatabaseFiles(config);
  assert.equal(fs.statSync(config.main).size, 0); assert.equal(fs.statSync(config.telemetry).size, 0);
  fs.writeFileSync(config.main, 'existing-database-do-not-overwrite');
  prepareDatabaseFiles(config);
  assert.equal(fs.readFileSync(config.main, 'utf8'), 'existing-database-do-not-overwrite');
  const link = path.join(f.root, 'linked-database-directory');
  fs.symlinkSync(path.dirname(config.main), link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareDatabaseFiles({ ...config, main: path.join(link, 'riri.db') }), { code: 'UNSAFE_PATH' });
});


test('锁拒绝数据库硬链接别名，换 dataDir 不能绕过同一物理库', (t) => {
  const f = useFixture(t);
  const alias = path.join(f.root, 'database-alias.db');
  fs.linkSync(f.config.main, alias);
  assert.throws(() => acquireLock({ ...f.config, main: alias, dataDir: path.join(f.root, 'other-data') }), { code: 'UNSAFE_DATABASE_FILE' });
});
test('锁拒绝数据库符号链接别名，不允许隔离标记通过另一个路径绕过', (t) => {
  const f = useFixture(t);
  const alias = path.join(f.root, 'database-alias.db');
  try { fs.symlinkSync(f.config.main, alias); } catch (error) { if (error.code === 'EPERM') return t.skip('Host cannot create file symlinks'); throw error; }
  assert.throws(() => acquireLock({ ...f.config, main: alias, dataDir: path.join(f.root, 'other-data') }), { code: 'UNSAFE_PATH' });
});
test('受保护源码启动不能在子进程异常退出后释放可能仍由后代使用的锁', async (t) => {
  const f = useFixture(t);
  const source = fs.readFileSync(path.join(__dirname, 'maintenance-start.js'), 'utf8');
  const fakeProcess = { ...process, env: environment(f.config), on() {}, removeListener() {}, chdir() {} };
  const context = { process: fakeProcess, __dirname, module: { exports: {} }, console, setInterval, clearInterval, require(id) {
    if (id === 'node:child_process') return { spawn() { const child = new EventEmitter(); child.exitCode = null; child.kill = () => {}; setImmediate(() => child.emit('exit', null, 'SIGTERM')); return child; } };
    if (id === './maintenance-config') return { ...require(id), loadEnvironment() {}, resolveConfig() { return f.config; }, configureDatabaseEnvironment() {} };
    return require(id);
  } };
  const build = path.join(f.root, 'build'); fs.mkdirSync(build); fs.writeFileSync(path.join(build, 'main.js'), '// fixture');
  context.build = build;
  await vm.runInNewContext(source + '\nmodule.exports.start({ buildDir: build });', context).catch(() => {});
  assert.ok(lockPaths(f.config).every(file => fs.existsSync(file)), 'abnormal child exit must retain the lease');
});

test('只复制真实父进程租约环境不能继承：必须完成本次子进程的IPC握手', (t) => {
  const f = useFixture(t); const owner = acquireLock(f.config, { role: 'startup' }); t.after(() => owner.release());
  const code = "const m = require('./maintenance-lock'); const c = require('./maintenance-config'); Promise.resolve(m.acquireStartupLock ? m.acquireStartupLock(c.resolveConfig()) : m.acquireLock(c.resolveConfig(), { inherit: true })).then(() => process.exit(0)).catch(() => process.exit(3));";
  const forged = spawnSync(process.execPath, ['-e', code], { cwd: __dirname, env: { ...environment(f.config), RIRICLOUD_MAINTENANCE_LEASE: owner.childEnvironment.RIRICLOUD_MAINTENANCE_LEASE }, encoding: 'utf8', timeout: 10000 });
  assert.equal(forged.status, 3, 'environment-only lease must not be sufficient');
});

test('发行包装配清理Prisma内部运行数据库、锁和测试，保留SQL迁移及源码', (t) => {
  const f = useFixture(t);
  const output = path.join(f.root, 'bundle'); const prisma = path.join(output, 'prisma');
  fs.mkdirSync(path.join(prisma, 'telemetry', 'existing.db.maintenance.lock'), { recursive: true });
  fs.mkdirSync(path.join(prisma, 'migrations', 'fixture'), { recursive: true });
  for (const name of ['dev.db', 'dev.db-wal', 'secret.env', 'maintenance-backup.test.js', 'maintenance-test-fixture.js', 'migrations/fixture/migration.sql']) fs.writeFileSync(path.join(prisma, name), 'fixture');
  fs.writeFileSync(path.join(prisma, 'telemetry/existing.db.maintenance.lock/owner.json'), 'fixture');
  assert.ok(fs.readFileSync(path.resolve(__dirname, '../../../scripts/bundle-master.sh'), 'utf8').includes('/prisma/maintenance-package.js'));
  const { sanitizePrismaPackage } = require('./maintenance-package');
  sanitizePrismaPackage(output);
  assert.deepEqual(fs.readdirSync(prisma).sort(), ['migrations', 'telemetry']);
  assert.equal(fs.existsSync(path.join(prisma, 'migrations/fixture/migration.sql')), true);
  assert.equal(fs.existsSync(f.config.main), true);
  assert.throws(() => sanitizePrismaPackage(serverRoot), { code: 'UNSAFE_PACKAGE_TARGET' });
});

test('父进程中途消失时继承服务退出并保留锁', async (t) => {
  const f = useFixture(t);
  const proof = path.join(f.root, 'parent-lost.json');
  const childCode = "const { resolveConfig }=require('./maintenance-config'); require('./maintenance-lock').acquireStartupLock(resolveConfig()).then(lease => { require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, ready: true })); lease.onParentLost(() => { require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, parentLost: true })); process.exit(27); }); setInterval(() => {}, 1000); console.log('LEASE_READY'); }).catch(() => process.exit(3));";
  const parentCode = "const {spawn}=require('node:child_process');const {resolveConfig}=require('./maintenance-config');const lock=require('./maintenance-lock').acquireLock(resolveConfig(),{role:'startup'});const child=spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{env:lock.childEnvironment,stdio:['ignore','pipe','ignore','ipc']});lock.bindChild(child);child.stdout.once('data',()=>process.exit(0));";
  const parent = spawn(process.execPath, ['-e', parentCode, childCode, proof], { cwd: __dirname, env: environment(f.config), stdio: ['ignore', 'ignore', 'pipe'] });
  const [code] = await once(parent, 'exit'); assert.equal(code, 0);
  let exited = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fs.existsSync(proof)) {
      const observed = JSON.parse(fs.readFileSync(proof)); assert.ok(observed.ready || observed.parentLost);
      try { process.kill(observed.pid, 0); } catch (error) { if (error.code === 'ESRCH') { exited = true; break; } throw error; }
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(exited, true, 'inherited child must exit after parent disconnects');
  assert.ok(lockPaths(f.config).every(file => fs.existsSync(file)));
});
test('有真实token和IPC但父进程未授权的子进程超时拒绝', async (t) => {
  const f = useFixture(t); const owner = acquireLock(f.config, { role: 'startup' }); t.after(() => owner.release());
  const code = "require('./maintenance-lock').acquireStartupLock(require('./maintenance-config').resolveConfig()).then(() => process.exit(0)).catch(() => process.exit(3));";
  const rogue = spawn(process.execPath, ['-e', code], { cwd: __dirname, env: { ...environment(f.config), RIRICLOUD_MAINTENANCE_LEASE: owner.childEnvironment.RIRICLOUD_MAINTENANCE_LEASE }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const [rejected] = await once(rogue, 'exit'); assert.equal(rejected, 3);
  assert.ok(lockPaths(f.config).every(file => fs.existsSync(file)));
});
test('源码保护入口在迁移前拒绝已有锁；切换dataDir仍不执行编译入口', (t) => {
  const f = useFixture(t); const owner = acquireLock(f.config, { role: 'startup' }); t.after(() => owner.release());
  const result = spawnSync(process.execPath, [path.join(__dirname, 'maintenance-start.js')], { env: { ...environment(f.config), RIRICLOUD_DATA_DIR: path.join(f.root,'other-data') }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 3); assert.match(result.stderr, /MAINTENANCE_LOCKED/);
  assert.ok(lockPaths(f.config).every(file => fs.existsSync(file)));
});

test('Docker恢复隔离在任何迁移和服务拉起前拒绝', async (t) => {
  const f = useFixture(t);
  fs.writeFileSync(path.join(f.config.dataDir, RESTORE_MARKER), JSON.stringify({ status: 'ready', isolated: true }));
  const result = await dockerSandbox(f, () => assert.fail('Isolated restore started a process'));
  assert.equal(result.calls.length, 0); assert.equal(result.status, 1);
  assert.ok(result.errors.some(message => message.includes('isolated')));
  assert.equal(lockPaths(f.config).some(file => fs.existsSync(file)), false);
});

test('应用退出码为零但没有关闭确认仍失败并保留锁', async (t) => {
  const f = useFixture(t); const build = path.join(f.root, 'build'); fs.mkdirSync(build); fs.writeFileSync(path.join(build, 'main.js'), '// fixture');
  let count = 0;
  const fakeProcess = { ...process, env: environment(f.config), on() {}, removeListener() {}, chdir() {} };
  const context = { build, process: fakeProcess, __dirname, module: { exports: {} }, console, setInterval, clearInterval, require(id) {
    if (id === 'node:child_process') return { spawn() { count++; const child = new EventEmitter(); child.exitCode = null; child.kill = () => {}; setImmediate(() => child.emit('exit', 0)); return child; } };
    if (id === './maintenance-config') return { ...require(id), loadEnvironment() {}, resolveConfig() { return f.config; }, configureDatabaseEnvironment() {} };
    return require(id);
  } };
  await assert.rejects(vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'maintenance-start.js'), 'utf8') + '\nmodule.exports.start({ buildDir: build });', context), { code: 'START_FAILED' });
  assert.equal(count, 3); assert.ok(lockPaths(f.config).every(file => fs.existsSync(file)));
});

test('父IPC主动断开触发子服务关闭处理且不释放父锁', async (t) => {
  const f = useFixture(t); const owner = acquireLock(f.config, { role: 'startup' }); t.after(() => owner.release());
  const code = "require('./maintenance-lock').acquireStartupLock(require('./maintenance-config').resolveConfig()).then(lease => { lease.onParentLost(() => { console.log('PARENT_LOST_SHUTDOWN'); process.exit(27); }); setInterval(() => {}, 1000); console.log('READY'); }).catch(() => process.exit(3));";
  const child = spawn(process.execPath, ['-e', code], { cwd: __dirname, env: { ...environment(f.config), RIRICLOUD_MAINTENANCE_LEASE: owner.childEnvironment.RIRICLOUD_MAINTENANCE_LEASE }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const session = owner.bindChild(child); let output = ''; child.stdout.on('data', chunk => output += chunk);
  await once(child.stdout, 'data'); child.disconnect();
  const [exit] = await once(child, 'exit'); session.detach();
  assert.equal(exit, 27); assert.match(output, /PARENT_LOST_SHUTDOWN/);
  assert.equal(session.closed, false); assert.ok(lockPaths(f.config).every(file => fs.existsSync(file)));
});

test('父租约IPC主动停机请求等待应用关闭确认，正常清理不使用强杀', async (t) => {
  const f = useFixture(t); const owner = acquireLock(f.config, { role: 'startup' }); t.after(() => owner.release());
  const code = "require('./maintenance-lock').acquireStartupLock(require('./maintenance-config').resolveConfig()).then(lease => { lease.onParentLost(async () => { console.log('APPLICATION_CLOSED'); await lease.release(); process.exit(0); }); setInterval(() => {}, 1000); console.log('READY'); }).catch(() => process.exit(3));";
  const child = spawn(process.execPath, ['-e', code], { cwd: __dirname, env: { ...environment(f.config), RIRICLOUD_MAINTENANCE_LEASE: owner.childEnvironment.RIRICLOUD_MAINTENANCE_LEASE }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const session = owner.bindChild(child); let output = ''; child.stdout.on('data', chunk => output += chunk);
  await once(child.stdout, 'data');
  assert.equal(typeof session.requestShutdown, 'function');
  assert.equal(session.requestShutdown(), true);
  const [exit] = await once(child, 'exit'); session.detach();
  assert.equal(exit, 0); assert.match(output, /APPLICATION_CLOSED/); assert.equal(session.closed, true);
});
