'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { fail, EXIT } = require('./maintenance-errors');
const { assertNoLinks } = require('./maintenance-paths');
const REQUEST = 'riricloud-maintenance-request';
const GRANT = 'riricloud-maintenance-grant';
const CLOSED = 'riricloud-maintenance-closed';
const STOP = 'riricloud-maintenance-stop';
function readOwners(paths, lease) {
  if (!lease || !Number.isSafeInteger(lease.parentPid) || lease.parentPid !== process.ppid || !/^[a-f0-9]{64}$/.test(lease.token || '')) fail('INVALID_LEASE', 'Maintenance lease is not from the direct parent.', EXIT.LOCKED);
  for (const directory of paths) {
    const file = path.join(directory, 'owner.json');
    assertNoLinks(file);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) fail('INVALID_LEASE', 'Invalid maintenance owner record.', EXIT.LOCKED);
    let owner;
    try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('INVALID_LEASE', 'Invalid maintenance owner record.', EXIT.LOCKED); }
    if (owner.token !== lease.token || owner.pid !== lease.parentPid || owner.role !== 'startup') fail('INVALID_LEASE', 'Inherited maintenance lock does not match.', EXIT.LOCKED);
  }
}
function attachParentLease(child, owner, paths) {
  let granted = false;
  const state = { closed: false };
  const receive = message => {
    if (!message || message.pid !== child.pid || message.token !== owner.token) return;
    if (message.type === REQUEST && !granted && /^[a-f0-9]{64}$/.test(message.challenge || '') && JSON.stringify(message.paths) === JSON.stringify(paths)) {
      granted = true;
      child.send({ type: GRANT, challenge: message.challenge, parentPid: process.pid }, () => {});
    } else if (message.type === CLOSED && granted && !state.closed) {
      state.closed = true;
      state.closeReason = message.reason;
    }
  };
  child.on('message', receive);
  state.requestShutdown = () => {
    if (!granted || !child.connected) return false;
    child.send({ type: STOP, token: owner.token, parentPid: process.pid }, () => {});
    return true;
  };
  state.detach = () => child.removeListener('message', receive);
  return state;
}
async function inheritParentLease(paths) {
  let lease;
  try { lease = JSON.parse(process.env.RIRICLOUD_MAINTENANCE_LEASE); } catch { fail('INVALID_LEASE', 'Invalid inherited maintenance lease.', EXIT.LOCKED); }
  delete process.env.RIRICLOUD_MAINTENANCE_LEASE;
  if (!process.connected || typeof process.send !== 'function') fail('INVALID_LEASE', 'Maintenance inheritance requires a private parent IPC channel.', EXIT.LOCKED);
  readOwners(paths, lease);
  const challenge = randomBytes(32).toString('hex');
  await new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); process.removeListener('message', receive); process.removeListener('disconnect', disconnected); };
    const denied = () => { cleanup(); try { fail('INVALID_LEASE', 'Parent did not authorize this startup process.', EXIT.LOCKED); } catch (error) { reject(error); } };
    const receive = message => { if (message?.type === GRANT && message.challenge === challenge && message.parentPid === process.ppid) { cleanup(); resolve(); } };
    const disconnected = () => denied();
    const timer = setTimeout(denied, 5000);
    process.on('message', receive); process.once('disconnect', disconnected);
    process.send({ type: REQUEST, challenge, token: lease.token, pid: process.pid, paths }, error => { if (error) denied(); });
  });
  readOwners(paths, lease);
  // 父进程意外退出时子服务也须停机，但不得删除仍待人工检查的父锁。
  let parentLost = () => process.exit(1);
  const disconnected = () => parentLost();
  const stop = message => { if (message?.type === STOP && message.token === lease.token && message.parentPid === lease.parentPid) parentLost(); };
  process.on('message', stop);
  process.once('disconnect', disconnected);
  if (!process.connected) queueMicrotask(disconnected);
  return {
    inherited: true,
    onParentLost(handler) { parentLost = handler; },
    async release(reason) {
      if (!process.connected) return;
      await new Promise(resolve => process.send({ type: CLOSED, token: lease.token, pid: process.pid, reason }, () => resolve()));
      process.removeListener('disconnect', disconnected);
      process.removeListener('message', stop);
    }
  };
}
module.exports = { attachParentLease, inheritParentLease };
