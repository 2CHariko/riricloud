'use strict';
// 独立隔离联调：正式迁移 + Nest HTTP API + 真实固定内核，不读取/修改用户数据库或服务。
// 用法：SINGBOX_BINARY_PATH=<1.14.0 定制内核> node scripts/line-egress-integration.cjs
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { queryStats } = require('./proxy-pool-stats.cjs');
const { DOMAIN, sleep, freePort, createFixtures, httpRequest, socksRequest, udpRequest, vlessRequest, selfTest } = require('./line-egress-fixtures.cjs');
const root = path.resolve(__dirname, '..'), serverRoot = path.join(root, 'apps/server');
const r = createRequire(path.join(serverRoot, 'package.json'));
function binaryPath() {
  if (process.env.SINGBOX_BINARY_PATH) return path.resolve(process.env.SINGBOX_BINARY_PATH);
  const platform = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`;
  const name = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
  const candidates = [path.join(root, 'artifacts/binaries/singbox/1.14.0-r2', platform, name), path.join(root, 'artifacts/binaries/singbox', platform, name), ...(process.env.PI_SCRATCH_DIR ? [path.join(process.env.PI_SCRATCH_DIR, process.platform === 'win32' ? 'line-egress-sing-box.exe' : 'line-egress-sing-box')] : [])];
  const found = candidates.find(f => fs.existsSync(f));
  assert.ok(found, 'Sing-box 1.14.0 delivery binary missing; set SINGBOX_BINARY_PATH (no auto-download/version fallback)'); return found;
}
function assertSafe(value, secrets) {
  const text = JSON.stringify(value);
  assert.ok(!text.includes('enc:v1:') && !text.includes('egressProxyJson'), 'API leaked ciphertext');
  for (const secret of secrets) assert.ok(!text.includes(secret), 'API leaked egress password');
  const visit = v => { if (!v || typeof v !== 'object') return; for (const [key, child] of Object.entries(v)) { if (key === 'egressProxy' || key === 'proxy' && child?.protocol && child?.serverHost) assert.ok(!Object.hasOwn(child || {}, 'password'), 'API includes egress password property'); visit(child); } };
  visit(value);
}
async function main() {
  await selfTest(); if (process.argv.includes('--fixtures-only')) return;
  const binary = binaryPath(), version = spawnSync(binary, ['version'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(version.status, 0, 'Sing-box executable unavailable'); assert.match(version.stdout, /sing-box version 1\.14\.0(?:\s|$)/);
  assert.ok(version.stdout.includes('with_v2ray_api'), 'Delivery kernel must support actual gRPC statistics');
  r('ts-node').register({ project: path.join(serverRoot, 'tsconfig.json') }); r('reflect-metadata');
  const load = f => require(path.join(serverRoot, 'src', f));
  const { PrismaClient, Prisma } = r('@prisma/client');
  assert.ok(Prisma.dmmf.datamodel.models.find(m => m.name === 'Line').fields.some(f => f.name === 'egressProxyJson'), 'Backend not ready: regenerate Prisma client for nullable Line.egressProxyJson');
  const { Test } = r('@nestjs/testing'), { ValidationPipe } = r('@nestjs/common'), { Reflector } = r('@nestjs/core'), { JwtService } = r('@nestjs/jwt');
  const { JwtStrategy } = load('auth/jwt.strategy'), { JwtAuthGuard } = load('common/jwt-auth.guard'), { PrismaService } = load('prisma/prisma.service');
  const { ProxyPoolAccessService } = load('proxy-pool-access/proxy-pool-access.service'), { ProxyPoolService } = load('proxy-pool/proxy-pool.service');
  const { UserProxyPoolController } = load('proxy-pool/user-proxy-pool.controller'), { AdminProxyPoolController } = load('proxy-pool/admin-proxy-pool.controller');
  const { LinesService } = load('lines/lines.service'), { LinesController } = load('lines/lines.controller'), { ProbeTaskService } = load('probe/probe-task.service');
  const { AgentService } = load('agent-gateway/agent-gateway.service'), { encryptSecret, decryptSecret } = load('common/secret-crypto');
  const { formatProxyLineUsername } = load('proxy-pool/proxy-key.util');
  const scratch = process.env.PI_SCRATCH_DIR || os.tmpdir(), dir = fs.mkdtempSync(path.join(scratch, 'line-egress-integration-'));
  fs.chmodSync(dir, 0o700);
  const dbPath = path.join(dir, 'main.db'), db = new DatabaseSync(dbPath);
  try { for (const name of fs.readdirSync(path.join(serverRoot, 'prisma/migrations')).sort()) { const file = path.join(serverRoot, 'prisma/migrations', name, 'migration.sql'); if (fs.existsSync(file)) db.exec(fs.readFileSync(file, 'utf8')); } } catch (error) { db.close(); fs.rmSync(dir, { recursive: true, force: true }); throw error; } finally { if (db.isOpen) db.close(); }
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex'); process.env.RIRICLOUD_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex'); process.env.NODE_ENV = 'test';
  const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath.replaceAll('\\', '/')}` } } });
  const state = { publicLinesEnabled: true, enforceEmailVerification: false, deviceLimitEnabled: false, configSyncDebounceMs: 1, systemTimezone: 'Asia/Shanghai' };
  const settings = { getSettings: async () => state, onSettingsChange: () => {} }, access = new ProxyPoolAccessService(prisma, settings);
  const agent = new AgentService(prisma, settings, undefined, undefined, access), pool = new ProxyPoolService(prisma, access, agent), lines = new LinesService(prisma, agent, settings);
  const children = new Set(); let app, fixture, cleanupPromise, stage = 'bootstrap';
  const stop = async child => {
    if (!child) return;
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 2500); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill();
      });
    }
    children.delete(child);
  };
  const cleanup = () => cleanupPromise ||= (async () => {
    try {
      await Promise.allSettled([...children].map(stop));
      const results = await Promise.allSettled([fixture?.close(), app?.close()]);
      await agent.onModuleDestroy(); await prisma.$disconnect();
      const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
    } finally { await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  })();
  const signalHandler = () => { cleanup().then(() => process.exit(130), () => process.exit(1)); };
  process.once('SIGINT', signalHandler); process.once('SIGTERM', signalHandler);
  const start = async (name, config, ports) => {
    const file = path.join(dir, `${name}.json`); fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    const check = spawnSync(binary, ['check', '-c', file], { encoding: 'utf8', timeout: 10000 }); assert.equal(check.status, 0, `${name}: generated config rejected (secrets withheld)`);
    const child = spawn(binary, ['run', '-c', file], { stdio: 'ignore' }); children.add(child); let error; child.once('error', e => { error = e; });
    for (let i = 0; i < 100; i++) {
      if (error || child.exitCode !== null || child.signalCode !== null) throw Error(`${name}: fixture kernel stopped`);
      const ready = await Promise.all(ports.map(port => new Promise(resolve => { const s = net.connect(port, '127.0.0.1'); s.setTimeout(100); s.once('connect', () => { s.destroy(); resolve(true); }); const fail = () => { s.destroy(); resolve(false); }; s.once('error', fail); s.once('timeout', fail); })));
      if (ready.every(Boolean)) { await sleep(100); return child; } await sleep(50);
    }
    throw Error(`${name}: startup deadline`);
  };
  try {
    const admin = await prisma.user.create({ data: { email: 'admin@egress.invalid', passwordHash: 'fixture', role: 'ADMIN' } });
    const user = await prisma.user.create({ data: { email: 'user@egress.invalid', passwordHash: 'fixture', trafficLimitBytes: 100000000n } });
    const other = await prisma.user.create({ data: { email: 'other@egress.invalid', passwordHash: 'fixture' } });
    const plan = await prisma.plan.create({ data: { name: 'Egress', durationDays: 1, trafficLimitBytes: 100000000n, lineMatchMode: 'ALL' } });
    const subscription = await prisma.subscription.create({ data: { userId: user.id, planId: plan.id, trafficLimitBytes: 100000000n, expireAt: new Date(Date.now() + 86400000) } });
    const statsPorts = [await freePort(), await freePort()];
    const nodes = [];
    for (const [i, name] of ['Entry', 'Landing'].entries()) {
      const token = crypto.randomBytes(32).toString('hex');
      nodes.push(await prisma.node.create({ data: { name, serverHost: '127.0.0.1', status: 'ONLINE', agentToken: encryptSecret(token), agentTokenHash: crypto.createHash('sha256').update(token).digest('hex'), configOverride: JSON.stringify({ experimental: { v2ray_api: { listen: `127.0.0.1:${statsPorts[i]}` } } }) } }));
    }
    const module = await Test.createTestingModule({ controllers: [LinesController, UserProxyPoolController, AdminProxyPoolController], providers: [JwtStrategy, { provide: PrismaService, useValue: prisma }, { provide: LinesService, useValue: lines }, { provide: ProxyPoolService, useValue: pool }, { provide: ProbeTaskService, useValue: {} }] }).compile();
    app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('api/v1'); app.useGlobalGuards(new JwtAuthGuard(app.get(Reflector))); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })); await app.listen(0, '127.0.0.1');
    const base = await app.getUrl(), jwt = new JwtService({ secret: process.env.JWT_SECRET });
    const tokens = Object.fromEntries([admin, user, other].map(u => [u.id, jwt.sign({ sub: u.id, sessionVersion: 0 })]));
    const secrets = [];
    async function api(method, route, body, who = admin, expected = 200, safe = true) {
      const response = await fetch(`${base}/api/v1${route}`, { method, signal: AbortSignal.timeout(10000), headers: { ...(who ? { Authorization: `Bearer ${tokens[who.id]}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text(); assert.equal(response.status, expected, `${stage}: ${method} ${route} unexpected status (body withheld)`);
      const result = JSON.parse(text); if (safe) assertSafe(result, secrets); return result;
    }
    await api('GET', '/admin/lines', undefined, null, 401); await api('GET', '/admin/lines', undefined, user, 403);
    const create = async (name, extra = {}) => (await api('POST', '/admin/lines', { name, type: 'DIRECT', protocolType: 'VLESS', entryNodeId: nodes[0].id, entryPort: await freePort(), listen: '127.0.0.1', params: { tls: { enabled: false, mode: 'none' } }, ...extra }, admin, 201)).line;
    const direct = await create('Direct');
    const target = await create('Bridge target', { entryNodeId: nodes[1].id });
    const blind = await create('Blind', { type: 'RELAY', relayMode: 'BLIND_FORWARD', landingNodeId: nodes[1].id, landingPort: await freePort() });
    const protocol = await create('Protocol', { type: 'RELAY', relayMode: 'PROTOCOL_PROXY', landingNodeId: nodes[1].id, landingPort: await freePort() });
    const bridge = await create('Bridge', { type: 'RELAY', relayMode: 'TARGET_LINE', targetLineId: target.id });
    const mixed = await create('Pool', { protocolType: 'MIXED', proxyPoolEnabled: true, trafficRate: 2, params: { usersEnabled: true } });
    const key = (await api('POST', '/user/proxy-pool/keys', { name: 'Egress fixture' }, user, 201, false)).key;
    const keyUsername = formatProxyLineUsername(key.username, mixed.id);
    const keyData = (await api('GET', `/user/proxy-pool/nodes?keyId=${key.id}`, undefined, user)).endpoints;
    assert.deepEqual(keyData.map(e => e.lineId), [mixed.id]); assert.ok(!JSON.stringify(keyData).includes(key.password));
    const otherKey = (await api('POST', '/user/proxy-pool/keys', { name: 'No entitlement' }, other, 201, false)).key;
    const patchedLines = [direct, target, blind, protocol, mixed];
    let kernels = [], configs;
    const restart = async () => {
      await Promise.all(kernels.map(stop)); kernels = [];
      configs = await Promise.all(nodes.map(async node => (await agent.buildConfigSync(node.id)).singboxConfig));
      kernels.push(await start('landing', configs[1], [target.entryPort, blind.landingPort, protocol.landingPort]));
      kernels.push(await start('entry', configs[0], [direct.entryPort, blind.entryPort, protocol.entryPort, bridge.entryPort, mixed.entryPort])); return configs;
    };
    const request = (line, host = DOMAIN) => vlessRequest(line.entryPort, host, fixture.targetPort, user.uuid);
    const assertRoutes = () => {
      for (const [line, index, port] of [[direct, 0, direct.entryPort], [mixed, 0, mixed.entryPort], [target, 1, target.entryPort], [blind, 1, blind.landingPort], [protocol, 1, protocol.landingPort]]) {
        const config = configs[index], tag = config.inbounds.find(i => i.listen_port === port && i.type !== 'shadowtls')?.tag;
        assert.ok(tag, 'Actual business inbound missing'); assert.ok(config.outbounds.some(o => o.tag === `egress-out-${line.id}`));
        assert.ok(config.route.rules.some(rule => rule.inbound?.includes(tag) && rule.outbound === `egress-out-${line.id}`), 'Egress must route actual business inbound');
      }
      for (const line of [blind, protocol, bridge]) assert.ok(!configs[0].outbounds.some(o => o.tag === `egress-out-${line.id}`), 'Relay entry must not execute egress');
      assert.ok(!configs[1].outbounds.some(o => o.tag === `egress-out-${bridge.id}`), 'TARGET_LINE must inherit target egress');
    };
    for (const egressProtocol of ['HTTP', 'SOCKS5']) {
      stage = `${egressProtocol} topology`; fixture = await createFixtures(); secrets.push(fixture.password);
      const proxy = { protocol: egressProtocol, serverHost: '127.0.0.1', serverPort: egressProtocol === 'HTTP' ? fixture.httpPort : fixture.socksPort, authEnabled: true, username: fixture.username, password: fixture.password };
      const createdWithEgress = await create('Create with encrypted egress', { egressProxy: proxy, status: 'DISABLED' });
      assert.ok(JSON.parse(decryptSecret((await prisma.line.findUnique({ where: { id: createdWithEgress.id } })).egressProxyJson)).password === fixture.password, 'POST must encrypt complete egress configuration');
      for (const line of patchedLines) await api('PATCH', `/admin/lines/${line.id}`, { egressProxy: proxy });
      const saved = await prisma.line.findUnique({ where: { id: direct.id } }); assert.ok(saved.egressProxyJson.startsWith('enc:v1:') && !saved.egressProxyJson.includes(fixture.password), 'Whole JSON must be encrypted');
      const decrypted = JSON.parse(decryptSecret(saved.egressProxyJson)); assert.ok(decrypted.password === fixture.password, 'Stored password mismatch'); assert.equal(decrypted.udpEnabled, false); assert.equal(decrypted.serverHost, proxy.serverHost);
      await api('PATCH', `/admin/lines/${direct.id}`, { name: `Direct ${egressProtocol}` }); assert.ok((await prisma.line.findUnique({ where: { id: direct.id } })).egressProxyJson === saved.egressProxyJson, 'Omitted egress must preserve ciphertext');
      const { password: _password, ...withoutPassword } = proxy; await api('PATCH', `/admin/lines/${direct.id}`, { egressProxy: withoutPassword }); assert.ok(JSON.parse(decryptSecret((await prisma.line.findUnique({ where: { id: direct.id } })).egressProxyJson)).password === fixture.password, 'Omitted password must be retained');
      const detail = await api('GET', `/admin/lines/${bridge.id}`); assert.equal(detail.line.effectiveEgress.inherited, true); assert.equal(detail.line.effectiveEgress.sourceLineId, target.id); assert.equal(detail.line.effectiveEgress.nodeId, nodes[1].id);
      await api('GET', '/admin/lines');
      await api('PATCH', `/admin/lines/${bridge.id}`, { egressProxy: proxy }, admin, 400);
      for (const invalid of [{ ...proxy, protocol: 'HTTPS' }, { ...proxy, serverPort: 0 }, { ...proxy, tls: {} }, { ...proxy, password: null }, ...(egressProtocol === 'HTTP' ? [{ ...proxy, udpEnabled: true }] : [])]) await api('PATCH', `/admin/lines/${direct.id}`, { egressProxy: invalid }, admin, 400);
      const copy = (await api('POST', `/admin/lines/${direct.id}/duplicate`, {}, admin, 201)).line; assert.equal(copy.status, 'DISABLED'); assert.ok(JSON.parse(decryptSecret((await prisma.line.findUnique({ where: { id: copy.id } })).egressProxyJson)).password === fixture.password, 'Duplicate must retain encrypted password');
      await restart(); assertRoutes();
      for (const line of [direct, blind, protocol, bridge]) {
        const count = fixture.events.length, hits = fixture.hits.tcp; await request(line);
        const event = fixture.events.slice(count).find(e => e.protocol === egressProtocol && e.command === 'CONNECT' && e.host === DOMAIN && e.authenticated);
        assert.ok(event, `${line.name}: real traffic did not traverse egress`); if (egressProtocol === 'SOCKS5') assert.equal(event.atyp, 3, 'Proxy must resolve original domain'); assert.equal(fixture.hits.tcp, hits + 1);
      }
      await httpRequest(mixed.entryPort, DOMAIN, fixture.targetPort, keyUsername, key.password); await socksRequest(mixed.entryPort, DOMAIN, fixture.targetPort, keyUsername, key.password);
      const beforeAuth = fixture.hits.tcp;
      await assert.rejects(httpRequest(mixed.entryPort, '127.0.0.1', fixture.targetPort, keyUsername, 'wrong'));
      await assert.rejects(socksRequest(mixed.entryPort, '127.0.0.1', fixture.targetPort, formatProxyLineUsername(otherKey.username, mixed.id), otherKey.password));
      assert.equal(fixture.hits.tcp, beforeAuth);
      stage = `${egressProtocol} UDP default reject`;
      const udpBefore = fixture.hits.udp, eventsBefore = fixture.events.length;
      await assert.rejects(udpRequest(mixed.entryPort, '127.0.0.1', fixture.udpTargetPort, keyUsername, key.password));
      assert.equal(fixture.hits.udp, udpBefore); assert.ok(!fixture.events.slice(eventsBefore).some(e => e.command === 'UDP_ASSOCIATE'));
      const mixedTag = configs[0].inbounds.find(i => i.listen_port === mixed.entryPort).tag;
      assert.ok(configs[0].route.rules.some(rule => rule.inbound?.includes(mixedTag) && rule.network === 'udp' && rule.action === 'reject'));
      if (egressProtocol === 'SOCKS5') {
        stage = 'SOCKS5 UDP enabled'; await api('PATCH', `/admin/lines/${mixed.id}`, { egressProxy: { ...proxy, udpEnabled: true } }); await restart();
        const udpEvents = fixture.events.length; await udpRequest(mixed.entryPort, DOMAIN, fixture.udpTargetPort, keyUsername, key.password);
        assert.equal(fixture.hits.udp, udpBefore + 1); assert.ok(fixture.events.slice(udpEvents).some(e => e.command === 'UDP_ASSOCIATE')); assert.ok(fixture.events.slice(udpEvents).some(e => e.command === 'UDP' && e.atyp === 3 && e.host === DOMAIN));
        await httpRequest(mixed.entryPort, DOMAIN, fixture.targetPort, keyUsername, key.password);
      }
      stage = `${egressProtocol} measured stats`;
      await sleep(100); const actual = (await queryStats(statsPorts[0])).filter(s => s.userUuid === keyUsername); assert.equal(actual.length, 1);
      const delta = actual.reduce((n, s) => n + (BigInt(s.uploadTotal) + BigInt(s.downloadTotal)) * 2n, 0n); assert.ok(delta > 0n);
      const keyBefore = (await prisma.proxyKey.findUnique({ where: { id: key.id } })).trafficUsedBytes;
      await agent.handleHeartbeat(nodes[0].id, { protocolVersion: 2, cpuUsage: 0, memoryUsage: 0, bandwidthRate: 0, trafficSnapshots: actual });
      assert.equal((await prisma.proxyKey.findUnique({ where: { id: key.id } })).trafficUsedBytes, keyBefore + delta);
      assert.equal((await prisma.user.findUnique({ where: { id: user.id } })).trafficUsedBytes, keyBefore + delta); assert.equal((await prisma.subscription.findUnique({ where: { id: subscription.id } })).trafficUsedBytes, keyBefore + delta);
      assert.ok(agent.getBufferedTrafficHourlyMetrics().some(m => m.proxyKeyId === key.id && m.lineId === mixed.id));
      // 进程重启后累计游标归零，下一轮统计前删除本隔离节点游标，不改变任何实际用户状态。
      await prisma.trafficCursor.deleteMany({ where: { nodeId: nodes[0].id } });
      stage = `${egressProtocol} whitelist`;
      await api('PATCH', `/user/proxy-pool/keys/${key.id}`, { whitelistIps: '192.0.2.1' }, user); await restart();
      const beforeWhitelist = fixture.hits.tcp; await assert.rejects(httpRequest(mixed.entryPort, '127.0.0.1', fixture.targetPort, keyUsername, key.password)); await assert.rejects(socksRequest(mixed.entryPort, '127.0.0.1', fixture.targetPort, keyUsername, key.password)); assert.equal(fixture.hits.tcp, beforeWhitelist);
      await api('PATCH', `/user/proxy-pool/keys/${key.id}`, { whitelistIps: '127.0.0.1/32' }, user); await restart(); await httpRequest(mixed.entryPort, DOMAIN, fixture.targetPort, keyUsername, key.password);
      stage = `${egressProtocol} wrong egress password fail-closed`;
      const wrong = crypto.randomBytes(18).toString('hex'); secrets.push(wrong);
      for (const line of patchedLines) await api('PATCH', `/admin/lines/${line.id}`, { egressProxy: { ...proxy, password: wrong, ...(egressProtocol === 'SOCKS5' ? { udpEnabled: true } : {}) } }); await restart();
      let before = fixture.hits.tcp;
      for (const line of [direct, blind, protocol, bridge]) await assert.rejects(request(line, '127.0.0.1'));
      await assert.rejects(httpRequest(mixed.entryPort, '127.0.0.1', fixture.targetPort, keyUsername, key.password)); assert.equal(fixture.hits.tcp, before, 'Wrong proxy password fell back to directly reachable target');
      if (egressProtocol === 'SOCKS5') { const beforeUdp = fixture.hits.udp; await assert.rejects(udpRequest(mixed.entryPort, '127.0.0.1', fixture.udpTargetPort, keyUsername, key.password)); assert.equal(fixture.hits.udp, beforeUdp, 'Wrong password must not bypass UDP egress'); }
      for (const line of patchedLines) await api('PATCH', `/admin/lines/${line.id}`, { egressProxy: { ...proxy, ...(egressProtocol === 'SOCKS5' ? { udpEnabled: true } : {}) } }); await restart();
      stage = `${egressProtocol} stopped proxy fail-closed`; await fixture.stopProxy(egressProtocol); before = fixture.hits.tcp;
      for (const line of [direct, blind, protocol, bridge]) await assert.rejects(request(line, '127.0.0.1'));
      await assert.rejects(socksRequest(mixed.entryPort, '127.0.0.1', fixture.targetPort, keyUsername, key.password)); assert.equal(fixture.hits.tcp, before, 'Stopped proxy fell back to directly reachable target');
      if (egressProtocol === 'SOCKS5') { const beforeUdp = fixture.hits.udp; await assert.rejects(udpRequest(mixed.entryPort, '127.0.0.1', fixture.udpTargetPort, keyUsername, key.password)); assert.equal(fixture.hits.udp, beforeUdp, 'Stopped proxy must not bypass UDP egress'); }
      // 清除后 IP 目标可直连，证明断路测试的目标本身仍在线而非夹具被停止。
      await api('PATCH', `/admin/lines/${direct.id}`, { egressProxy: null }); assert.equal((await prisma.line.findUnique({ where: { id: direct.id } })).egressProxyJson, null); await restart(); await request(direct, '127.0.0.1');
      await Promise.all(kernels.map(stop)); kernels = []; await fixture.close(); fixture = undefined;
      console.log(`PASS: ${egressProtocol} DIRECT/blind/protocol/bridge, remote DNS, UDP policy, pool auth/whitelist/stats, wrong-password/stopped-proxy fail-closed and PATCH clear`);
    }
    stage = 'unsupported topology';
    const source = await prisma.upstreamSubscription.create({ data: { name: 'Fixture source', sourceType: 'TEXT', content: encryptSecret('fixture'), customHeadersJson: encryptSecret('{}'), autoUpdate: false } });
    const upstream = await prisma.upstreamNode.create({ data: { subscriptionId: source.id, name: 'Fixture upstream', protocolType: 'HTTP', serverHost: '127.0.0.1', serverPort: await freePort(), paramsJson: encryptSecret('{}'), rawConfigJson: encryptSecret('{}'), configHash: 'fixture', connectionHash: 'fixture' } });
    const rejectedProxy = { protocol: 'HTTP', serverHost: '127.0.0.1', serverPort: await freePort(), authEnabled: false };
    for (const body of [{ name: 'External rejected', type: 'EXTERNAL', upstreamNodeId: upstream.id }, { name: 'Upstream rejected', type: 'RELAY', relayMode: 'UPSTREAM_NODE', protocolType: 'MIXED', entryNodeId: nodes[0].id, entryPort: await freePort(), upstreamNodeId: upstream.id, params: { usersEnabled: true } }]) await api('POST', '/admin/lines', { ...body, egressProxy: rejectedProxy }, admin, 400);
    console.log('PASS: API authorization, encrypted whole JSON, secret-free detail/list/copy/inheritance, PATCH retain/null and unsupported topology rejection');
  } catch (error) { throw Error(`${stage}: ${error.message}`, { cause: error }); }
  finally { process.removeListener('SIGINT', signalHandler); process.removeListener('SIGTERM', signalHandler); await cleanup(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
