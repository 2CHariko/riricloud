'use strict';
// 代理池隔离联调：正式schema临时库、真实入站/中继/gRPC统计，不操作既有服务。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { queryStats } = require('./proxy-pool-stats.cjs');
const root = path.resolve(__dirname, '..');
const serverRoot = path.join(root, 'apps/server');
const r = createRequire(path.join(serverRoot, 'package.json'));
r('ts-node').register({ project: path.join(serverRoot, 'tsconfig.json') }); r('reflect-metadata');
const load = f => require(path.join(serverRoot, 'src', f));
const { PrismaClient } = r('@prisma/client');
const { Test } = r('@nestjs/testing');
const { ValidationPipe } = r('@nestjs/common');
const { Reflector } = r('@nestjs/core');
const { JwtService } = r('@nestjs/jwt');
const { JwtStrategy } = load('auth/jwt.strategy');
const { JwtAuthGuard } = load('common/jwt-auth.guard');
const { PrismaService } = load('prisma/prisma.service');
const { ProxyPoolAccessService } = load('proxy-pool-access/proxy-pool-access.service');
const { ProxyPoolService } = load('proxy-pool/proxy-pool.service');
const { UserProxyPoolController } = load('proxy-pool/user-proxy-pool.controller');
const { AdminProxyPoolController } = load('proxy-pool/admin-proxy-pool.controller');
const { LinesService } = load('lines/lines.service');
const { LinesController } = load('lines/lines.controller');
const { ProbeTaskService } = load('probe/probe-task.service');
const { AgentService } = load('agent-gateway/agent-gateway.service');
const { encryptSecret } = load('common/secret-crypto');
const { formatProxyLineUsername } = load('proxy-pool/proxy-key.util');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function freePort() { const server = net.createServer(); const p = await listen(server); await new Promise(resolve => server.close(resolve)); return p; }
async function main() {
  const dir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'proxy-pool-integration-'));
  const dbPath = path.join(dir, 'main.db'); const db = new DatabaseSync(dbPath);
  for (const name of fs.readdirSync(path.join(serverRoot, 'prisma/migrations')).sort()) { const f = path.join(serverRoot, 'prisma/migrations', name, 'migration.sql'); if (fs.existsSync(f)) db.exec(fs.readFileSync(f, 'utf8')); } db.close();
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex'); process.env.NODE_ENV = 'test';
  const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath.replaceAll('\\', '/')}` } } });
  const state = { publicLinesEnabled: true, enforceEmailVerification: false, deviceLimitEnabled: false, configSyncDebounceMs: 1, systemTimezone: 'Asia/Shanghai' };
  const settings = { getSettings: async () => state, onSettingsChange: () => {} };
  const access = new ProxyPoolAccessService(prisma, settings);
  const agent = new AgentService(prisma, settings, undefined, undefined, access);
  let notifications = 0; const pushConfig = agent.pushConfigToAll.bind(agent); agent.pushConfigToAll = async () => { notifications++; return pushConfig(); };
  const pool = new ProxyPoolService(prisma, access, agent);
  const lines = new LinesService(prisma, agent, settings);
  const sockets = new Set(); const target = http.createServer((_req, res) => { res.writeHead(200); res.end('proxy-pool-real-payload-'.repeat(512)); });
  target.on('connection', s => { sockets.add(s); s.once('close', () => sockets.delete(s)); });
  const binary = process.env.SINGBOX_BINARY_PATH || path.join(root, 'artifacts/binaries/singbox', process.platform === 'win32' ? 'windows-amd64/sing-box.exe' : '1.14.0-r2/linux-amd64/sing-box');
  let app, upstreamChild, entryChild;
  const start = async (name, config, port) => {
    const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    const check = spawnSync(binary, ['check', '-c', file], { encoding: 'utf8', timeout: 10000 }); assert.equal(check.status, 0, `${name} config rejected`);
    const child = spawn(binary, ['run', '-c', file], { stdio: ['ignore', 'ignore', 'ignore'] });
    for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw Error('Fixture kernel stopped'); const up = await new Promise(resolve => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => { s.destroy(); resolve(false); }); }); if (up) { await sleep(80); return child; } await sleep(50); }
    child.kill(); throw Error('Fixture startup deadline');
  };
  const stop = async child => { if (!child) return; if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); } };
  try {
    assert.ok(fs.existsSync(binary), 'Actual Sing-box delivery binary required');
    const targetPort = await listen(target); const statsPort = await freePort(); const upstreamPort = await freePort();
    const admin = await prisma.user.create({ data: { email: 'admin@pool.invalid', passwordHash: 'fixture', role: 'ADMIN' } });
    const user = await prisma.user.create({ data: { email: 'user@pool.invalid', passwordHash: 'fixture', trafficLimitBytes: 10000000n } });
    const other = await prisma.user.create({ data: { email: 'other@pool.invalid', passwordHash: 'fixture', trafficLimitBytes: 10000000n } });
    const plan = await prisma.plan.create({ data: { name: 'Pool', durationDays: 1, trafficLimitBytes: 10000000n, lineMatchMode: 'EXPLICIT', lineIdsJson: '[]' } });
    const otherPlan = await prisma.plan.create({ data: { name: 'No Pool', durationDays: 1, trafficLimitBytes: 10000000n, lineMatchMode: 'EXPLICIT', lineIdsJson: '[]' } });
    const sub = await prisma.subscription.create({ data: { userId: user.id, planId: plan.id, trafficLimitBytes: 10000000n, expireAt: new Date(Date.now() + 86400000) } });
    await prisma.subscription.create({ data: { userId: other.id, planId: otherPlan.id, trafficLimitBytes: 10000000n, expireAt: new Date(Date.now() + 86400000) } });
    const agentToken = crypto.randomBytes(32).toString('hex');
    const node = await prisma.node.create({ data: { name: 'Entry', serverHost: '127.0.0.1', status: 'ONLINE', agentToken: encryptSecret(agentToken), agentTokenHash: crypto.createHash('sha256').update(agentToken).digest('hex'), configOverride: JSON.stringify({ experimental: { v2ray_api: { listen: `127.0.0.1:${statsPort}` } } }) } });
    const source = await prisma.upstreamSubscription.create({ data: { name: 'Up', sourceType: 'TEXT', content: encryptSecret('fixture'), customHeadersJson: encryptSecret('{}'), autoUpdate: false } });
    const upstream = await prisma.upstreamNode.create({ data: { subscriptionId: source.id, name: 'Up', protocolType: 'HTTP', serverHost: '127.0.0.1', serverPort: upstreamPort, paramsJson: encryptSecret('{"username":"upstream","password":"fixture-password"}'), rawConfigJson: encryptSecret('{}'), configHash: 'c', connectionHash: 'c' } });
    const module = await Test.createTestingModule({ controllers: [UserProxyPoolController, AdminProxyPoolController, LinesController], providers: [JwtStrategy, { provide: PrismaService, useValue: prisma }, { provide: ProxyPoolService, useValue: pool }, { provide: LinesService, useValue: lines }, { provide: ProbeTaskService, useValue: {} }] }).compile();
    app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('api/v1'); app.useGlobalGuards(new JwtAuthGuard(app.get(Reflector))); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })); await app.listen(0, '127.0.0.1');
    const base = await app.getUrl(); const jwt = new JwtService({ secret: process.env.JWT_SECRET });
    const tokens = Object.fromEntries([admin, user, other].map(u => [u.id, jwt.sign({ sub: u.id, sessionVersion: 0 })]));
    async function api(method, route, body, who = user, status = 200) { const response = await fetch(`${base}/api/v1${route}`, { method, signal: AbortSignal.timeout(10000), headers: { ...(who ? { Authorization: `Bearer ${tokens[who.id]}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await response.text(); assert.equal(response.status, status, `${method} ${route}: ${text.slice(0, 400)}`); return { data: (() => { try { return JSON.parse(text); } catch { return text; } })(), headers: response.headers }; }
    await api('GET', '/user/proxy-pool/nodes', undefined, null, 401); await api('GET', '/admin/proxy-pool/overview', undefined, user, 403);
    const directPort = await freePort(), relayPort = await freePort();
    const direct = (await api('POST', '/admin/lines', { name: 'Direct', type: 'DIRECT', protocolType: 'MIXED', proxyPoolEnabled: true, entryNodeId: node.id, entryPort: directPort, trafficRate: 1, params: { usersEnabled: false } }, admin, 201)).data.line;
    const relay = (await api('POST', '/admin/lines', { name: 'Relay', type: 'RELAY', relayMode: 'UPSTREAM_NODE', protocolType: 'MIXED', proxyPoolEnabled: true, entryNodeId: node.id, entryPort: relayPort, upstreamNodeId: upstream.id, trafficRate: 2, params: { usersEnabled: true }, isPublic: false }, admin, 201)).data.line;
    await prisma.line.create({ data: { name: 'First unrelated', protocolType: 'VLESS', entryNodeId: node.id, entryPort: await freePort(), sortOrder: -999, trafficRate: 99, paramsJson: '{"tls":{"enabled":false,"mode":"none"}}' } });
    await prisma.plan.update({ where: { id: plan.id }, data: { lineIdsJson: JSON.stringify([direct.id]) } });
    await prisma.userLineGrant.create({ data: { userId: user.id, lineId: relay.id } });
    const keyResponse = await api('POST', '/user/proxy-pool/keys', { name: 'Fixture' }, user, 201); assert.equal(keyResponse.headers.get('cache-control'), 'no-store'); const key = keyResponse.data.key;
    const otherKey = (await api('POST', '/user/proxy-pool/keys', { name: 'Other' }, other, 201)).data.key;
    const keyFor = endpoint => `${formatProxyLineUsername(key.username, endpoint.id)}:${key.password}`;
    const endpoints = (await api('GET', `/user/proxy-pool/nodes?keyId=${key.id}`)).data.endpoints;
    assert.deepEqual(endpoints.map(e => e.lineId).sort(), [direct.id, relay.id].sort()); assert.ok(!JSON.stringify(endpoints).includes(key.password));
    assert.equal((await api('GET', `/user/proxy-pool/nodes?keyId=${otherKey.id}`, undefined, other)).data.endpoints.length, 0);
    await api('GET', `/user/proxy-pool/nodes?keyId=${otherKey.id}`, undefined, user, 404); await api('GET', '/user/proxy-pool/nodes?lineIds=', undefined, user, 400);
    const exported = (await api('GET', `/user/proxy-pool/export?keyId=${key.id}&format=json`)).data; assert.equal(exported.version, 2); assert.equal(exported.proxies.length, 2); assert.notEqual(exported.proxies[0].username, exported.proxies[1].username);
    const byToken = (await api('GET', `/user/proxy-pool/export?token=${key.exportToken}&format=json`, undefined, null)).data; assert.deepEqual(byToken.proxies.map(p => p.username), exported.proxies.map(p => p.username));
    await api('GET', `/user/proxy-pool/export?keyId=${otherKey.id}&format=json&lineIds=${relay.id}`, undefined, other, 409);
    upstreamChild = await start('upstream.json', { log: { disabled: true }, inbounds: [{ type: 'http', listen: '127.0.0.1', listen_port: upstreamPort, users: [{ username: 'upstream', password: 'fixture-password' }] }], outbounds: [{ type: 'direct' }] }, upstreamPort);
    const restart = async () => { await stop(entryChild); const config = (await agent.buildConfigSync(node.id)).singboxConfig; entryChild = await start('entry.json', config, directPort); return config; };
    const requestProxy = async (line, scheme, credentials, expected) => {
      const outcome = await new Promise((resolve, reject) => { const curl = spawn('curl', ['--silent', '--max-time', '3', '--noproxy', '', '--proxy', `${scheme}://127.0.0.1:${line.entryPort}`, '--proxy-user', credentials, ...(scheme === 'http' ? ['--proxytunnel'] : []), '--output', process.platform === 'win32' ? 'NUL' : '/dev/null', '--write-out', '%{http_code}', `http://127.0.0.1:${targetPort}/payload`]); let text = ''; curl.stdout.on('data', c => text += c); curl.once('error', reject); curl.once('close', code => resolve({ code, status: text })); });
      if (expected) { assert.equal(outcome.code, 0); assert.equal(outcome.status, '200'); } else assert.notEqual(outcome.status, '200');
    };
    let config = await restart();
    for (const line of [direct, relay]) for (const scheme of ['http', 'socks5h']) await requestProxy(line, scheme, keyFor(line), true);
    await requestProxy(relay, 'http', `${key.username}:${key.password}`, false);
    await requestProxy(relay, 'socks5h', `${formatProxyLineUsername(otherKey.username, relay.id)}:${otherKey.password}`, false);
    await requestProxy(relay, 'http', `${formatProxyLineUsername(key.username, relay.id)}:wrong`, false);
    const snapshots = await queryStats(statsPort); const logins = new Set(exported.proxies.map(p => p.username)); const actual = snapshots.filter(s => logins.has(s.userUuid)); assert.equal(actual.length, 2);
    const expected = actual.reduce((n, s) => n + (BigInt(s.uploadTotal) + BigInt(s.downloadTotal)) * (s.userUuid === formatProxyLineUsername(key.username, relay.id) ? 2n : 1n), 0n); assert.ok(expected > 0n);
    await agent.handleHeartbeat(node.id, { protocolVersion: 2, cpuUsage: 0, memoryUsage: 0, bandwidthRate: 0, trafficSnapshots: actual });
    assert.equal((await prisma.proxyKey.findUnique({ where: { id: key.id } })).trafficUsedBytes, expected);
    assert.equal((await prisma.user.findUnique({ where: { id: user.id } })).trafficUsedBytes, expected);
    assert.equal((await prisma.subscription.findUnique({ where: { id: sub.id } })).trafficUsedBytes, expected);
    assert.deepEqual(agent.getBufferedTrafficHourlyMetrics().filter(m => m.proxyKeyId === key.id).map(m => m.lineId).sort(), [direct.id, relay.id].sort());
    await agent.handleHeartbeat(node.id, { protocolVersion: 2, cpuUsage: 0, memoryUsage: 0, bandwidthRate: 0, trafficSnapshots: actual }); assert.equal((await prisma.proxyKey.findUnique({ where: { id: key.id } })).trafficUsedBytes, expected);
    console.log('PASS: real HTTP/SOCKS direct/relay, per-user grants, per-line usernames, old/wrong/unauthorized rejection and actual gRPC/multiplier accounting');
    await api('PATCH', `/user/proxy-pool/keys/${key.id}`, { whitelistIps: '192.0.2.1' }); config = await restart();
    assert.equal(config.route.rules[0].action, 'reject'); await requestProxy(relay, 'http', keyFor(relay), false); await requestProxy(relay, 'socks5h', keyFor(relay), false);
    await api('PATCH', `/user/proxy-pool/keys/${key.id}`, { whitelistIps: '127.0.0.1/32' }); await restart(); await requestProxy(relay, 'http', keyFor(relay), true);
    console.log('PASS: source-IP allow/deny applies before relay routing for HTTP/SOCKS');
    await prisma.upstreamSubscription.update({ where: { id: source.id }, data: { status: 'DISABLED' } });
    assert.deepEqual((await api('GET', `/user/proxy-pool/nodes?keyId=${key.id}`)).data.endpoints.map(e => e.lineId), [direct.id]); await api('GET', `/user/proxy-pool/export?keyId=${key.id}&format=json&lineIds=${relay.id}`, undefined, user, 409);
    config = await restart(); assert.ok(!config.inbounds.some(i => i.listen_port === relayPort));
    await prisma.upstreamSubscription.update({ where: { id: source.id }, data: { status: 'ACTIVE' } });
    for (const change of [{ presenceStatus: 'MISSING' }, { status: 'DISABLED' }]) { await prisma.upstreamNode.update({ where: { id: upstream.id }, data: change }); assert.equal((await access.getNodeBindings(node.id)).some(b => b.lineId === relay.id), false); await prisma.upstreamNode.update({ where: { id: upstream.id }, data: { status: 'ACTIVE', presenceStatus: 'PRESENT' } }); }
    for (const change of [{ userInfoExpireAt: new Date(0) }, { userInfoUsedBytes: 10n, userInfoTotalBytes: 10n }]) { await prisma.upstreamSubscription.update({ where: { id: source.id }, data: change }); assert.equal((await access.getNodeBindings(node.id)).some(b => b.lineId === relay.id), false); await prisma.upstreamSubscription.update({ where: { id: source.id }, data: { userInfoExpireAt: null, userInfoUsedBytes: null, userInfoTotalBytes: null } }); }
    const oldPassword = key.password; key.password = (await api('POST', `/user/proxy-pool/keys/${key.id}/rotate-password`, {}, user, 201)).data.key.password; await restart(); await requestProxy(relay, 'http', `${formatProxyLineUsername(key.username, relay.id)}:${oldPassword}`, false); await requestProxy(relay, 'http', keyFor(relay), true);
    await prisma.userLineGrant.deleteMany({ where: { userId: user.id, lineId: relay.id } }); assert.equal((await access.getNodeBindings(node.id)).some(b => b.lineId === relay.id), false); await prisma.userLineGrant.create({ data: { userId: user.id, lineId: relay.id } });
    await api('PATCH', `/user/proxy-pool/keys/${key.id}`, { isActive: false }); config = await restart(); assert.ok(!config.inbounds.flatMap(i => i.users || []).some(u => typeof u.username === 'string' && u.username.startsWith('pk_line_'))); await api('GET', `/user/proxy-pool/export?token=${key.exportToken}&format=json`, undefined, null, 401);
    await api('PATCH', `/user/proxy-pool/keys/${key.id}`, { isActive: true });
    for (const change of [{ expireAt: new Date(0) }, { trafficUsedBytes: 10000000n }]) { await prisma.subscription.update({ where: { id: sub.id }, data: change }); await api('GET', `/user/proxy-pool/export?token=${key.exportToken}&format=json`, undefined, null, 403); assert.equal((await access.getNodeBindings(node.id)).length, 0); await prisma.subscription.update({ where: { id: sub.id }, data: { expireAt: new Date(Date.now() + 86400000), trafficUsedBytes: expected } }); }
    state.publicLinesEnabled = false; assert.equal((await access.getNodeBindings(node.id)).length, 0); state.publicLinesEnabled = true;
    const frames = []; await agent.register(node.id, { send: text => frames.push(JSON.parse(text)), close: () => {} });
    await api('PATCH', `/user/proxy-pool/keys/${key.id}`, { isActive: false }); await agent.pushConfigToAll();
    assert.ok(!frames.at(-1).data.singboxConfig.inbounds.flatMap(i => i.users || []).some(u => typeof u.username === 'string' && u.username.startsWith('pk_line_')));
    await api('PATCH', `/user/proxy-pool/keys/${key.id}`, { isActive: true }); await agent.pushConfigToAll();
    const pollData = { protocolVersion: 2, cpuUsage: 0, memoryUsage: 0, bandwidthRate: 0, trafficSnapshots: [], appliedConfigVersion: 0 };
    const poll = await agent.poll(agentToken, pollData); assert.equal(poll.needUpdate, true); assert.ok(poll.singboxConfig.inbounds.flatMap(i => i.users || []).some(u => typeof u.username === 'string' && u.username.startsWith('pk_line_')));
    await api('PATCH', `/user/proxy-pool/keys/${key.id}`, { isActive: false }); await agent.pushConfigToAll();
    const revokedPoll = await agent.poll(agentToken, { ...pollData, appliedConfigVersion: poll.version }); assert.equal(revokedPoll.needUpdate, true); assert.ok(!revokedPoll.singboxConfig.inbounds.flatMap(i => i.users || []).some(u => typeof u.username === 'string' && u.username.startsWith('pk_line_')));
    await api('PATCH', `/user/proxy-pool/keys/${key.id}`, { isActive: true }); await agent.pushConfigToAll();
    const oldToken = key.exportToken; key.exportToken = (await api('POST', `/user/proxy-pool/keys/${key.id}/rotate-token`, {}, user, 201)).data.key.exportToken;
    await api('GET', `/user/proxy-pool/export?token=${oldToken}&format=json`, undefined, null, 401); await api('GET', `/user/proxy-pool/export?token=${key.exportToken}&format=json`, undefined, null);
    await prisma.subscription.update({ where: { id: sub.id }, data: { trafficLimitBytes: expected + 1n } });
    const pushesBefore = notifications; const bumped = actual.map(s => ({ ...s, uploadTotal: String(BigInt(s.uploadTotal) + 10n) }));
    await agent.handleHeartbeat(node.id, { ...pollData, trafficSnapshots: bumped }); assert.ok(notifications > pushesBefore); assert.equal((await access.getNodeBindings(node.id)).length, 0);
    await agent.pushConfigToAll(); config = await restart(); await requestProxy(relay, 'http', keyFor(relay), false);
    console.log('PASS: actual WS refresh, HTTP poll cache invalidation, token rotation and measured quota-triggered revocation');
    console.log('PASS: key rotation/disable, source/presence/expiry/quota/grant revocation, refreshed Agent config and token authorization');
    assert.ok(notifications > 0);
  } finally {
    await stop(entryChild); await stop(upstreamChild); for (const s of sockets) s.destroy(); await new Promise(resolve => target.close(resolve)); if (app) await app.close(); await agent.onModuleDestroy(); await prisma.$disconnect(); fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
