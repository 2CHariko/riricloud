// 仅冒烟子进程加载：限制监听和网络到回环，并提供 Windows 可用的优雅退出控制。
// 不替换 Nest Provider、数据库、配置生成、鉴权或维护锁实现。
import net from 'node:net';
import cp from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
const children = new Set();
const originalSpawn = cp.spawn;
cp.spawn = function (...args) {
  const child = originalSpawn.apply(this, args);
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
};
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const first = args[0];
  if (first && typeof first === 'object' && 'port' in first) args[0] = { ...first, host: '127.0.0.1' };
  else if (typeof first === 'number' || typeof first === 'string' && /^\d+$/.test(first)) {
    if (typeof args[1] === 'string') args[1] = '127.0.0.1';
    else args.splice(1, 0, '127.0.0.1');
  }
  this.once('listening', () => {
    const address = this.address();
    if (address && typeof address === 'object') {
      if (address.address !== '127.0.0.1') throw new Error('SMOKE_NON_LOOPBACK_LISTENER');
      process.stdout.write('__RIRI_SMOKE_LISTEN__' + JSON.stringify({ pid: process.pid, port: address.port, address: address.address, entry: path.basename(process.argv[1] || '') }) + '\n');
    }
  });
  return originalListen.apply(this, args);
};
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // Node HTTP、undici 与 TLS 既可能传普通参数，也可能传已 normalize 的数组。
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  const host = typeof first === 'object' ? first.host || first.hostname : typeof normalized[1] === 'string' ? normalized[1] : undefined;
  const socketPath = first && typeof first === 'object' && first.path;
  if (!socketPath && host && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('SMOKE_EXTERNAL_NETWORK_DENIED');
  return originalConnect.apply(this, args);
};
process.on('message', message => {
  if (message?.type !== 'riricloud-smoke-shutdown') return;
  if (path.basename(process.argv[1] || '') === 'main.js') process.emit('SIGTERM');
  else for (const child of children) if (child.connected) child.send(message, () => {});
});
process.channel?.unref();
