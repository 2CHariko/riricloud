'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { EXIT, fail } = require('./maintenance-errors');
const { assertNoLinks } = require('./maintenance-paths');
const { attachParentLease, inheritParentLease } = require('./maintenance-lease');
const RESTORE_MARKER = '.riricloud-restore.json';

function lockPaths(config) {
  return [...new Set([`${config.main}.maintenance.lock`, `${config.telemetry}.maintenance.lock`, path.join(config.dataDir, '.riricloud-maintenance.lock')])].sort();
}
function assertStartAllowed(config) {
  for (const directory of new Set([path.dirname(config.main), path.dirname(config.telemetry), config.dataDir])) {
    const marker = path.join(directory, RESTORE_MARKER);
    if (!fs.existsSync(marker)) continue;
    assertNoLinks(marker);
    let info;
    try { info = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { fail('RESTORE_NOT_READY', 'Restored storage has no valid ready marker.', EXIT.ISOLATED); }
    if (info.status !== 'ready') fail('RESTORE_NOT_READY', 'Restored storage has not passed verification.', EXIT.ISOLATED);
    // 演练不能加载邮件巡检或监听 Agent；正式切换需维护者显式解除隔离。
    if (info.isolated !== false) fail('RESTORE_ISOLATED', 'Restored storage is isolated. Review the offline result before explicitly removing the isolation marker for deployment.', EXIT.ISOLATED);
  }
}
function assertStoragePaths(config) {
  const files = [config.main, config.telemetry];
  for (const file of files) {
    assertNoLinks(file, true);
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const current = file + suffix;
      assertNoLinks(current, true);
      try { const stat = fs.lstatSync(current); if (!stat.isFile() || stat.nlink !== 1) fail('UNSAFE_DATABASE_FILE', 'Database paths must be ordinary non-linked files.', EXIT.DATABASE); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const identity = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  if (identity(files[0]) === identity(files[1])) fail('DATABASE_PATH_COLLISION', 'Business and telemetry databases must be distinct.', EXIT.USAGE);
  assertNoLinks(config.dataDir, true);
}
async function acquireStartupLock(config) {
  assertStoragePaths(config);
  if (!process.env.RIRICLOUD_MAINTENANCE_LEASE) return acquireLock(config, { role: 'startup' });
  return inheritParentLease(lockPaths(config));
}
function acquireLock(config, options = {}) {
  const paths = lockPaths(config);
  // 数据库本身也必须校验；仅校验旁边的锁不能阻止链接别名绕过。
  assertStoragePaths(config);
  if (options.inherit && process.env.RIRICLOUD_MAINTENANCE_LEASE) fail('INVALID_LEASE', 'Inherited startup requires the private parent IPC channel.', EXIT.LOCKED);
  const owner = { formatVersion: 1, pid: process.pid, role: options.role || 'maintenance', token: randomBytes(32).toString('hex'), createdAt: new Date().toISOString() };
  const acquired = [];
  let released;
  function release() {
    if (released !== undefined) return released;
    released = true;
    for (const lock of [...acquired].reverse()) {
      // 外部修改过的锁不属于本次操作，保留供维护者检查。
      try {
        const actual = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
        if (actual.token !== owner.token) { released = false; continue; }
        fs.unlinkSync(path.join(lock, 'owner.json'));
        fs.rmdirSync(lock);
      } catch { released = false; /* 禁止自动抢占异常锁。 */ }
    }
    return released;
  }
  try {
    for (const lock of paths) {
      assertNoLinks(lock, true);
      fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
      try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error) {
        if (error.code === 'EEXIST') fail('MAINTENANCE_LOCKED', 'Master or maintenance owns the storage, or a stale lock remains. Stop the owner and inspect the lock; automatic takeover is disabled.', EXIT.LOCKED);
        throw error;
      }
      try { fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
      catch (error) { fs.rmdirSync(lock); throw error; }
      acquired.push(lock);
    }
  } catch (error) { release(); throw error; }
  return { release, inherited: false, bindChild: (child) => attachParentLease(child, owner, paths), childEnvironment: { ...process.env, RIRICLOUD_MAINTENANCE_LEASE: JSON.stringify({ parentPid: process.pid, token: owner.token }) } };
}
module.exports = { acquireStartupLock, assertStoragePaths, acquireLock, lockPaths, assertStartAllowed, RESTORE_MARKER };
