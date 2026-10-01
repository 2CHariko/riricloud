'use strict';
// 仅使用标准库实现真实协议；.invalid 域名仅由夹具映射，禁止系统 DNS/直连掩盖出口失效。
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const DOMAIN = 'only-egress-fixture.invalid';
const PAYLOAD = 'line-egress-real-target-'.repeat(512);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function bind(socket) {
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve); });
  return socket.address().port;
}
async function freePort() { const s = net.createServer(); const port = await listen(s); await new Promise(resolve => s.close(resolve)); return port; }
function track(server, sockets) {
  server.on('connection', s => { sockets.add(s); s.on('error', () => {}); s.once('close', () => sockets.delete(s)); });
}
function reader(socket, timeout = 4000) {
  let data = Buffer.alloc(0), ended = false, wake;
  const onData = chunk => { data = Buffer.concat([data, chunk]); if (wake) wake(); };
  const onEnd = () => { ended = true; if (wake) wake(); };
  socket.on('data', onData); socket.on('close', onEnd); socket.on('error', onEnd);
  const take = async n => {
    const deadline = Date.now() + timeout;
    while (data.length < n) {
      if (ended) throw Error('Fixture stream closed');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Error('Fixture stream deadline');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { wake = undefined; reject(Error('Fixture stream deadline')); }, remaining);
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
    }
    const result = data.subarray(0, n); data = data.subarray(n); return result;
  };
  return { take, detach() { socket.pause(); socket.removeListener('data', onData); socket.removeListener('close', onEnd); socket.removeListener('error', onEnd); if (data.length) socket.unshift(data); } };
}
async function connect(port) {
  const socket = net.connect(port, '127.0.0.1'); socket.on('error', () => {});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(Error('Fixture connect deadline')); }, 4000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); }); socket.once('error', e => { clearTimeout(timer); reject(e); });
  });
  return socket;
}
function address(host, port) {
  const p = Buffer.alloc(2); p.writeUInt16BE(port);
  if (net.isIPv4(host)) return Buffer.concat([Buffer.from([1, ...host.split('.').map(Number)]), p]);
  const h = Buffer.from(host); assert.ok(h.length < 256); return Buffer.concat([Buffer.from([3, h.length]), h, p]);
}
async function readAddress(r) {
  const atyp = (await r.take(1))[0]; let host;
  if (atyp === 1) host = [...await r.take(4)].join('.');
  else if (atyp === 3) host = (await r.take((await r.take(1))[0])).toString();
  else if (atyp === 4) { const b = await r.take(16); host = Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2).toString(16)).join(':'); }
  else throw Error('Unsupported SOCKS ATYP');
  return { atyp, host, port: (await r.take(2)).readUInt16BE() };
}
function parseDatagram(message) {
  if (message.length < 7 || message[0] || message[1] || message[2]) throw Error('Invalid SOCKS UDP header/FRAG');
  const atyp = message[3]; let host, offset;
  if (atyp === 1) { host = [...message.subarray(4, 8)].join('.'); offset = 8; }
  else if (atyp === 3) { offset = 5 + message[4]; host = message.subarray(5, offset).toString(); }
  else throw Error('Unsupported UDP ATYP');
  if (message.length < offset + 2) throw Error('Truncated UDP frame');
  return { atyp, host, port: message.readUInt16BE(offset), payload: message.subarray(offset + 2), header: message.subarray(0, offset + 2) };
}
async function createFixtures() {
  const sockets = new Set(), udpSockets = new Set(), events = [], hits = { tcp: 0, udp: 0 };
  const username = `fixture_${crypto.randomBytes(6).toString('hex')}`, password = crypto.randomBytes(18).toString('hex');
  const target = http.createServer((_req, res) => { hits.tcp++; res.writeHead(200, { 'Content-Length': Buffer.byteLength(PAYLOAD) }); res.end(PAYLOAD); });
  track(target, sockets); const targetPort = await listen(target);
  const udpTarget = dgram.createSocket('udp4'); udpSockets.add(udpTarget);
  udpTarget.on('message', (message, peer) => { hits.udp++; udpTarget.send(message, peer.port, peer.address); });
  const udpTargetPort = await bind(udpTarget);
  const resolveTarget = (host, port, udp = false) => {
    assert.ok(host === DOMAIN || host === '127.0.0.1', 'Fixture accepts only its own target');
    assert.equal(port, udp ? udpTargetPort : targetPort, 'Fixture target port');
    return '127.0.0.1';
  };
  const httpProxy = http.createServer((_req, res) => { res.writeHead(405); res.end(); }); track(httpProxy, sockets);
  httpProxy.on('connect', (req, client, head) => {
    const match = /^([^:]+):(\d+)$/.exec(req.url || '');
    const ok = req.headers['proxy-authorization'] === `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    events.push({ protocol: 'HTTP', command: 'CONNECT', host: match?.[1], port: Number(match?.[2]), authenticated: ok });
    if (!ok) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fixture"\r\nContent-Length: 0\r\n\r\n'); return; }
    try {
      assert.ok(match); const host = resolveTarget(match[1], Number(match[2]));
      const upstream = net.connect(Number(match[2]), host); sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
      upstream.once('error', () => client.destroy()); client.once('close', () => upstream.destroy());
      upstream.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream).pipe(client); });
    } catch { client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); }
  });
  const httpPort = await listen(httpProxy);
  const socksProxy = net.createServer(client => {
    const r = reader(client);
    (async () => {
      assert.equal((await r.take(1))[0], 5); const methods = await r.take((await r.take(1))[0]);
      if (!methods.includes(2)) { client.end(Buffer.from([5, 255])); return; }
      client.write(Buffer.from([5, 2])); assert.equal((await r.take(1))[0], 1);
      const u = (await r.take((await r.take(1))[0])).toString(), p = (await r.take((await r.take(1))[0])).toString();
      const ok = u === username && p === password; client.write(Buffer.from([1, ok ? 0 : 1]));
      if (!ok) { events.push({ protocol: 'SOCKS5', command: 'AUTH', authenticated: false }); client.end(); return; }
      const header = await r.take(3); assert.equal(header[0], 5); assert.equal(header[2], 0); const dest = await readAddress(r);
      events.push({ protocol: 'SOCKS5', command: header[1] === 3 ? 'UDP_ASSOCIATE' : 'CONNECT', ...dest, authenticated: true });
      if (header[1] === 1) {
        const host = resolveTarget(dest.host, dest.port); const upstream = await connect(dest.port); assert.equal(host, '127.0.0.1');
        sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream)); upstream.on('error', () => client.destroy()); client.once('close', () => upstream.destroy());
        client.write(Buffer.concat([Buffer.from([5, 0, 0]), address('127.0.0.1', upstream.localPort)])); r.detach(); client.pipe(upstream).pipe(client); client.resume();
      } else if (header[1] === 3) {
        const relay = dgram.createSocket('udp4'); udpSockets.add(relay); const relayPort = await bind(relay); let peer, replyHeader;
        relay.on('error', () => client.destroy());
        relay.on('message', (message, remote) => {
          if (remote.port === udpTargetPort && remote.address === '127.0.0.1') {
            if (peer) relay.send(Buffer.concat([replyHeader, message]), peer.port, peer.address); return;
          }
          try {
            const packet = parseDatagram(message); const host = resolveTarget(packet.host, packet.port, true);
            events.push({ protocol: 'SOCKS5', command: 'UDP', atyp: packet.atyp, host: packet.host, port: packet.port });
            peer = remote; replyHeader = packet.header; relay.send(packet.payload, packet.port, host);
          } catch { /* 非夹具目标和分片包拒绝转发。 */ }
        });
        client.once('close', () => { if (udpSockets.delete(relay)) relay.close(); });
        client.write(Buffer.concat([Buffer.from([5, 0, 0]), address('127.0.0.1', relayPort)])); r.detach(); client.resume();
      } else client.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]));
    })().catch(() => client.destroy());
  }); track(socksProxy, sockets); const socksPort = await listen(socksProxy);
  const closeServer = async s => { if (s.listening) await new Promise(resolve => s.close(resolve)); };
  return {
    username, password, targetPort, udpTargetPort, httpPort, socksPort, events, hits,
    async stopProxy(protocol) { for (const s of sockets) s.destroy(); await closeServer(protocol === 'HTTP' ? httpProxy : socksProxy); },
    async close() { for (const s of sockets) s.destroy(); for (const s of udpSockets) { try { s.close(); } catch {} } udpSockets.clear(); await Promise.all([target, httpProxy, socksProxy].map(closeServer)); }
  };
}
async function response(socket, prefix) {
  return new Promise((resolve, reject) => {
    let text = ''; const timer = setTimeout(() => { socket.destroy(); reject(Error('Target response deadline')); }, 3500);
    socket.on('data', b => text += b.toString()); socket.once('error', fail); socket.once('end', finish); socket.once('close', finish);
    function fail(e) { clearTimeout(timer); reject(e); }
    function finish() { clearTimeout(timer); socket.destroy(); if (/^HTTP\/1\.[01] 200\b/.test(text) && text.endsWith(PAYLOAD)) resolve(true); else reject(Error('Target response contract failed')); }
    socket.write(prefix);
  });
}
function getRequest(host) { return `GET /payload HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`; }
async function httpRequest(port, host, targetPort, username, password) {
  const socket = await connect(port), r = reader(socket); try {
    socket.write(`CONNECT ${host}:${targetPort} HTTP/1.1\r\nHost: ${host}:${targetPort}\r\nProxy-Authorization: Basic ${Buffer.from(`${username}:${password}`).toString('base64')}\r\n\r\n`);
    let header = ''; while (!header.endsWith('\r\n\r\n')) { header += (await r.take(1)).toString(); if (header.length > 8192) throw Error('Oversized CONNECT response'); }
    assert.match(header, /^HTTP\/1\.[01] 200\b/); r.detach(); const result = response(socket, getRequest(host)); socket.resume(); return await result;
  } finally { socket.destroy(); }
}
async function socksSession(port, username, password, command, host, targetPort) {
  const socket = await connect(port), r = reader(socket);
  try {
    socket.write(Buffer.from([5, 1, 2])); assert.deepEqual(await r.take(2), Buffer.from([5, 2]));
    const u = Buffer.from(username), p = Buffer.from(password); socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
    assert.deepEqual(await r.take(2), Buffer.from([1, 0])); socket.write(Buffer.concat([Buffer.from([5, command, 0]), address(host, targetPort)]));
    assert.deepEqual(await r.take(3), Buffer.from([5, 0, 0])); const dest = await readAddress(r); r.detach(); return { socket, dest };
  } catch (e) { socket.destroy(); throw e; }
}
async function socksRequest(port, host, targetPort, username, password) {
  const { socket } = await socksSession(port, username, password, 1, host, targetPort);
  try { const result = response(socket, getRequest(host)); socket.resume(); return await result; } finally { socket.destroy(); }
}
async function udpRequest(port, host, targetPort, username, password) {
  const { socket, dest } = await socksSession(port, username, password, 3, '0.0.0.0', 0); const udp = dgram.createSocket('udp4');
  try {
    await bind(udp); const payload = crypto.randomBytes(32);
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('UDP target deadline')), 1500);
      udp.once('message', message => { clearTimeout(timer); try { assert.deepEqual(parseDatagram(message).payload, payload); resolve(true); } catch (e) { reject(e); } });
      udp.once('error', e => { clearTimeout(timer); reject(e); });
    });
    udp.send(Buffer.concat([Buffer.from([0, 0, 0]), address(host, targetPort), payload]), dest.port, dest.host === '0.0.0.0' ? '127.0.0.1' : dest.host);
    return await result;
  } finally { udp.close(); socket.destroy(); }
}
// VLESS 无 TLS 的标准握手，以真实用户 UUID 穿过实际业务入站（不用替换路由或模拟后端）。
async function vlessRequest(port, host, targetPort, uuid) {
  const socket = await connect(port), r = reader(socket); try {
    const h = Buffer.from(host), p = Buffer.alloc(2); p.writeUInt16BE(targetPort);
    const dest = net.isIPv4(host) ? Buffer.from([1, ...host.split('.').map(Number)]) : Buffer.concat([Buffer.from([2, h.length]), h]);
    socket.write(Buffer.concat([Buffer.from([0]), Buffer.from(uuid.replaceAll('-', ''), 'hex'), Buffer.from([0, 1]), p, dest, Buffer.from(getRequest(host))]));
    const header = await r.take(2); assert.equal(header[0], 0); if (header[1]) await r.take(header[1]); r.detach(); const result = response(socket, Buffer.alloc(0)); socket.resume(); return await result;
  } finally { socket.destroy(); }
}
async function selfTest() {
  const f = await createFixtures(); try {
    for (const request of [httpRequest, socksRequest]) { const port = request === httpRequest ? f.httpPort : f.socksPort; await request(port, DOMAIN, f.targetPort, f.username, f.password); await assert.rejects(request(port, DOMAIN, f.targetPort, f.username, 'wrong')); }
    await udpRequest(f.socksPort, DOMAIN, f.udpTargetPort, f.username, f.password);
    assert.ok(f.events.some(e => e.command === 'CONNECT' && e.atyp === 3 && e.host === DOMAIN)); assert.ok(f.events.some(e => e.command === 'UDP_ASSOCIATE')); assert.ok(f.events.some(e => e.command === 'UDP' && e.atyp === 3));
    assert.equal(f.hits.tcp, 2); assert.equal(f.hits.udp, 1);
    console.log('PASS: standard-library CONNECT, SOCKS5 domain ATYP, bad authentication, UDP ASSOCIATE and UDP echo fixtures');
  } finally { await f.close(); }
}
module.exports = { DOMAIN, PAYLOAD, sleep, freePort, createFixtures, httpRequest, socksRequest, udpRequest, vlessRequest, selfTest };
if (require.main === module) selfTest().catch(() => { console.error('FAIL: line-egress fixture self-test'); process.exitCode = 1; });
