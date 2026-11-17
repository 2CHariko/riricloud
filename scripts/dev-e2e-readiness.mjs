import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import storage from '../apps/server/prisma/maintenance-config.js';
import locks from '../apps/server/prisma/maintenance-lock.js';

const header = 'x-riricloud-e2e-instance';
const versionPath = '/api/v1/system/version';

export async function webReady(web, master, owned = false) {
  const get = url => fetch(url, { signal: AbortSignal.timeout(1500), redirect: 'error' });
  try {
    const [home, direct, proxy] = await Promise.all([get(web), get(master + versionPath), get(web + versionPath)]);
    if (!home.ok || !direct.ok || !proxy.ok || !home.headers.get('content-type')?.includes('text/html')) return false;
    const identity = direct.headers.get(header);
    if (identity ? identity !== proxy.headers.get(header) : !owned) return false;
    const a = await direct.json();
    const b = await proxy.json();
    return typeof a.version === 'string' && a.version === b.version;
  } catch { return false; }
}

export function storageLocks() {
  return locks.lockPaths(storage.resolveConfig()).filter(existsSync);
}

export function bindable(port, udp = false) {
  return new Promise(resolve => {
    const listener = udp ? createSocket('udp4') : createServer();
    listener.once('error', () => { if (udp) listener.close(); resolve(false); });
    const done = () => listener.close(() => resolve(true));
    if (udp) listener.bind(port, '127.0.0.1', done);
    else listener.listen(port, '127.0.0.1', done);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'web') process.exitCode = await webReady(args[0], args[1], args[2] === 'owned') ? 0 : 1;
  else if (command === 'locks') {
    for (const path of storageLocks()) console.error('[dev-e2e] 已存在的存储锁：%s', JSON.stringify(path));
  } else if (command === 'released') {
    let free = false;
    for (let attempt = 0; attempt < 30 && !free; attempt++) {
      const results = await Promise.all(args.filter(Boolean).map(value => bindable(Number(value.split(':')[0]), value.endsWith(':udp'))));
      free = results.every(Boolean) && storageLocks().length === 0;
      if (!free) await new Promise(resolve => setTimeout(resolve, 200));
    }
    process.exitCode = free ? 0 : 1;
  } else process.exitCode = 2;
}
