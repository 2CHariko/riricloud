import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect, createServer as tcpServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { bindable } from './dev-e2e-readiness.mjs';
import { readAdminCookie } from './dev-e2e-sync-resource.mjs';

const host = '127.0.0.1';
const api = '/api/v1';
const name = 'Local E2E Shadowsocks';
function assert(ok, label) { if (!ok) throw new Error(label); }
function listen(server) { return new Promise((done, fail) => {
  server.once('error', fail);
  server.listen(0, host, () => done(server.address().port));
}); }
async function port({ udp = false } = {}) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const server = tcpServer();
    const value = await listen(server);
    await new Promise(done => server.close(done));
    if (!udp || await bindable(value, true)) return value;
  }
  throw new Error('port-allocation');
}

async function request(base, path, { cookie, method, body, status = 200, label } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body) headers['Content-Type'] = 'application/json';
  let result;
  try {
    result = await fetch(base + api + path, {
      method, headers, body: body && JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(5000)
    });
  } catch { throw new Error(label + ' (network)'); }
  assert(result.status === status, label + ' (HTTP ' + result.status + ')');
  return result;
}

async function prepare(base, scratch) {
  const admin = await readAdminCookie();
  await request(base, '/admin/nodes', { status: 401, label: 'anonymous-management' });
  const nodes = await (await request(base, '/admin/nodes', { cookie: admin, label: 'admin-cookie-via-web' })).json();
  const node = nodes.find(item => item.isLocal);
  assert(node?.id, 'local-node-bootstrap');
  const lines = await (await request(base, '/admin/lines?page=1&pageSize=100', { cookie: admin, label: 'demo-lines' })).json();
  // 演示线路默认监听所有网卡；隔离验收只让回环测试线路上线。
  for (const line of lines.data) {
    await request(base, '/admin/lines/' + line.id, { method: 'PATCH', cookie: admin, body: { status: 'DISABLED' }, label: 'disable-seed-line' });
  }
  const entryPort = await port({ udp: true });
  await request(base, '/admin/lines', {
    method: 'POST', status: 201, cookie: admin, label: 'create-shadowsocks-line',
    body: {
      name, type: 'DIRECT', protocolType: 'SHADOWSOCKS', status: 'ACTIVE', isPublic: true, listen: host,
      entryNodeId: node.id, entryPort, allowLanAccess: true,
      params: { mode: 'single', method: 'aes-128-gcm', password: randomBytes(24).toString('hex') }
    }
  });
  await writeFile(join(scratch, 'fixture.json'), JSON.stringify({ nodeId: node.id, entryPort }), { mode: 0o600 });
  console.log(entryPort);
}

async function getOutbound(base, entryPort) {
  const login = await request(base, '/auth/login', {
    method: 'POST', label: 'ordinary-user-login',
    body: { email: process.env.SEED_USER_EMAIL, password: process.env.SEED_USER_PASSWORD }
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert(cookie?.startsWith('riricloud_access='), 'ordinary-user-cookie');
  const view = await (await request(base, '/user/subscription', { cookie, label: 'ordinary-user-subscription' })).json();
  const token = view.subscription?.subscriptionToken;
  assert(typeof token === 'string' && /^[a-f0-9-]{36}$/i.test(token) && view.subscription.status === 'ACTIVE', 'active-subscription');
  const subscription = await request(base, '/sub/' + token + '?type=singbox', { label: 'download-singbox-subscription' });
  const document = await subscription.json();
  assert(subscription.headers.has('subscription-userinfo'), 'subscription-usage-header');
  const outbound = document.outbounds?.find(item => item.type === 'shadowsocks' && item.server === host && item.server_port === entryPort);
  assert(outbound?.password && outbound?.tag && !outbound.plugin, 'subscription-shadowsocks-outbound');
  return outbound;
}

function udpBind(socket) {
  return new Promise((done, fail) => {
    socket.once('error', fail);
    socket.bind(0, host, () => done(socket.address().port));
  });
}

async function verifyUdp(clientPort, targetPort, nonce) {
  const control = connect(clientPort, host);
  const udp = createSocket('udp4');
  control.setTimeout(4000, () => control.destroy(new Error('udp-control-timeout')));
  // 预先消费错误，读取方用 once 等待时仍可收到拒绝。
  control.on('error', () => {});
  async function read(length) {
    for (;;) {
      const data = control.read(length);
      if (data) return data;
      if (control.destroyed || control.readableEnded) throw new Error('udp-control-closed');
      await once(control, 'readable', { signal: AbortSignal.timeout(4000) });
    }
  }
  try {
    await once(control, 'connect', { signal: AbortSignal.timeout(4000) });
    await udpBind(udp);
    control.write(Buffer.from([5, 1, 0]));
    assert((await read(2)).equals(Buffer.from([5, 0])), 'udp-socks-handshake');
    control.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0]));
    const reply = await read(10);
    assert(reply[0] === 5 && reply[1] === 0 && reply[3] === 1 && reply.readUInt16BE(8) !== 0, 'udp-socks-associate');
    const header = Buffer.from([0, 0, 0, 1, 127, 0, 0, 1, targetPort >> 8, targetPort & 255]);
    const result = once(udp, 'message', { signal: AbortSignal.timeout(4000) });
    udp.send(Buffer.concat([header, nonce]), reply.readUInt16BE(8), host);
    const [packet] = await result;
    assert(packet.subarray(0, 10).equals(header) && packet.subarray(10).equals(nonce), 'udp-echo');
  } finally {
    control.destroy();
    try { udp.close(); } catch { /* 未绑定 */ }
  }
}

async function traffic(base, scratch) {
  const fixture = JSON.parse(await readFile(join(scratch, 'fixture.json'), 'utf8'));
  const serverConfig = JSON.parse(await readFile(join(scratch, 'agent/config.json'), 'utf8'));
  assert(serverConfig.inbounds?.some(item => item.type === 'shadowsocks' && item.listen === host && item.listen_port === fixture.entryPort), 'agent-config-applied');
  const admin = await readAdminCookie();
  let online = false;
  for (let attempt = 0; attempt < 30 && !online; attempt++) {
    const nodes = await (await request(base, '/admin/nodes', { cookie: admin, label: 'agent-online' })).json();
    online = nodes.some(item => item.id === fixture.nodeId && item.status === 'ONLINE');
    if (!online) await delay(500);
  }
  assert(online, 'agent-online');
  const outbound = await getOutbound(base, fixture.entryPort);
  const nonce = randomBytes(20);
  const http = createServer((_req, res) => res.end(nonce.toString('hex')));
  const udp = createSocket('udp4');
  udp.on('message', (data, sender) => udp.send(data, sender.port, sender.address));
  const path = join(scratch, 'client.json');
  let stage = 'loopback-fixtures';
  let client, ended, tcpPort, udpPort, clientPort;
  try {
    tcpPort = await listen(http);
    udpPort = await udpBind(udp);
    clientPort = await port();
    stage = 'subscription-client-start';
    await writeFile(path, JSON.stringify({
      inbounds: [{ type: 'mixed', listen: host, listen_port: clientPort }],
      outbounds: [outbound], route: { final: outbound.tag }
    }), { mode: 0o600 });
    client = spawn(process.env.SINGBOX_BINARY_PATH, ['run', '-c', path], { stdio: 'ignore', windowsHide: true });
    ended = new Promise(resolve => { client.once('error', resolve); client.once('close', resolve); });
    let tcp = false;
    stage = 'tcp-http-echo';
    for (let attempt = 0; attempt < 20 && !tcp && client.exitCode === null; attempt++) {
      try {
        const result = await promisify(execFile)('curl', ['-fsS', '--max-time', '2', '--noproxy', '', '--socks5-hostname', host + ':' + clientPort, 'http://' + host + ':' + tcpPort], { timeout: 3000, windowsHide: true });
        tcp = result.stdout === nonce.toString('hex');
      } catch { await delay(200); }
    }
    assert(tcp, stage);
    stage = 'udp-echo';
    await verifyUdp(clientPort, udpPort, nonce);
    console.log('[dev-e2e] 订阅客户端已通过真实 TCP HTTP 与 UDP 回显');
  } catch {
    throw new Error(stage);
  } finally {
    if (client) {
      client.kill();
      if (!await Promise.race([ended.then(() => true), delay(4000, false, { ref: false })])) {
        client.kill('SIGKILL');
        await ended;
      }
    }
    await rm(path, { force: true });
    http.closeAllConnections();
    await Promise.all([
      new Promise(done => http.close(done)),
      new Promise(done => { try { udp.close(done); } catch { done(); } })
    ]);
    for (const [value, datagram] of [[tcpPort, false], [clientPort, false], [udpPort, true]]) {
      if (value) assert(await bindable(value, datagram), 'client-and-fixture-cleanup');
    }
  }
}

const [command, base, scratch] = process.argv.slice(2);
if (command === 'managed-ports') {
  const config = await readFile(base, 'utf8').then(JSON.parse).catch(() => ({}));
  for (const endpoint of [config.experimental?.v2ray_api?.listen, config.experimental?.clash_api?.external_controller]) {
    if (typeof endpoint === 'string' && /:\d+$/.test(endpoint)) console.log(endpoint.split(':').at(-1));
  }
} else {
  try {
    const url = new URL(base);
    assert(url.protocol === 'http:' && url.hostname === host && url.origin === base, 'loopback-only');
    if (command === 'prepare') await prepare(base, scratch);
    else if (command === 'traffic') await traffic(base, scratch);
    else throw new Error('unknown-stage');
  } catch (error) {
    const label = error instanceof Error && /^[a-z0-9-]+( \((HTTP \d+|network)\))?$/.test(error.message) ? error.message : 'unexpected';
    console.error('[dev-e2e] 验收阶段 %s 失败：%s', command, label);
    process.exitCode = 1;
  }
}
