'use strict';
// 隔离联调：只操作 scratch 新库与回环端口，不启动生产 Master/Agent。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '..');
const serverRoot = path.join(root, 'apps/server');
const requireServer = createRequire(path.join(serverRoot, 'package.json'));
requireServer('ts-node').register({ project: path.join(serverRoot, 'tsconfig.json') });
requireServer('reflect-metadata');
const load = (file) => require(path.join(serverRoot, 'src', file));
const { Test } = requireServer('@nestjs/testing');
const { ValidationPipe } = requireServer('@nestjs/common');
const { Reflector } = requireServer('@nestjs/core');
const { JwtService } = requireServer('@nestjs/jwt');
const { PrismaClient } = requireServer('@prisma/client');
const { PrismaService } = load('prisma/prisma.service');
const { UpstreamService } = load('upstream/upstream.service');
const { UpstreamParserService } = load('upstream/upstream-parser.service');
const { UpstreamController } = load('upstream/upstream.controller');
const { LinesService } = load('lines/lines.service');
const { LinesController } = load('lines/lines.controller');
const { LineSpeedtestService } = load('lines/line-speedtest.service');
const { SubscriptionService } = load('subscription/subscription.service');
const { SubscriptionController } = load('subscription/subscription.controller');
const { UserSubscriptionController } = load('subscription/user-subscription.controller');
const { JwtAuthGuard } = load('common/jwt-auth.guard');
const { JwtStrategy } = load('auth/jwt.strategy');
const { AgentGatewayService } = load('agent-gateway/agent-gateway.service');
const { encryptSecret } = load('common/secret-crypto');
const { UsersService } = load('users/users.service');
const { UsersController } = load('users/users.controller');
const { PlansService } = load('plans/plans.service');
const { PlansController } = load('plans/plans.controller');

async function port() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const result = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return result;
}
async function listen(server) { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function waitPort(value, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Test kernel exited before becoming ready');
    const up = await new Promise((resolve) => { const s = net.connect(value, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => { s.destroy(); resolve(false); }); });
    if (up) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Test kernel startup timed out');
}
async function main() {
  const scratch = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'upstream-integration-'));
  const dbFile = path.join(scratch, 'main.db');
  const db = new DatabaseSync(dbFile);
  const migrations = path.join(serverRoot, 'prisma/migrations');
  for (const dir of fs.readdirSync(migrations).sort()) { const file = path.join(migrations, dir, 'migration.sql'); if (fs.existsSync(file)) db.exec(fs.readFileSync(file, 'utf8')); }
  db.close();
  process.env.JWT_SECRET = 'isolated-upstream-integration-jwt-secret-32chars';
  process.env.RIRICLOUD_ENCRYPTION_KEY = 'isolated-upstream-integration-aes-secret-32chars';
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = `file:${dbFile.split(path.sep).join('/')}`;
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const settingsState = { publicLinesEnabled: true, enforceEmailVerification: false, configSyncDebounceMs: 1, includeUsageHeaders: true };
  const settings = { getSettings: async () => settingsState, onSettingsChange: () => undefined };
  const gateway = new AgentGatewayService(prisma, settings);
  let notifications = 0;
  const notification = { pushConfigToAll: async () => { notifications++; return gateway.pushConfigToAll(); } };
  const upstream = new UpstreamService(prisma, new UpstreamParserService(), notification);
  const lines = new LinesService(prisma, notification, settings);
  const subscription = new SubscriptionService(prisma, lines, undefined, settings);
  const users = new UsersService(prisma, settings, notification, lines);
  const plans = new PlansService(prisma, lines);
  const children = [];
  const servers = [];
  let app;
  function configFile(name, config) { const file = path.join(scratch, name); fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config)); return file; }
  try {
    const module = await Test.createTestingModule({
      controllers: [UpstreamController, LinesController, SubscriptionController, UserSubscriptionController, UsersController, PlansController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: UpstreamService, useValue: upstream },
        { provide: LinesService, useValue: lines },
        { provide: SubscriptionService, useValue: subscription },
        { provide: UsersService, useValue: users },
        { provide: PlansService, useValue: plans },
        { provide: LineSpeedtestService, useValue: { testLine: async () => { throw new Error('Use native isolated checks'); }, testAllActiveLines: async () => ({ total: 0 }) } },
        JwtStrategy
      ]
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalGuards(new JwtAuthGuard(app.get(Reflector)));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const expiry = new Date(Date.now() + 86400000);
    const admin = await prisma.user.create({ data: { email: 'admin@integration.invalid', passwordHash: 'not-a-production-password', role: 'ADMIN', expireAt: expiry, trafficLimitBytes: 1000000n } });
    const user = await prisma.user.create({ data: { email: 'user@integration.invalid', passwordHash: 'not-a-production-password', emailVerifiedAt: new Date(), expireAt: expiry, trafficLimitBytes: 1000000n } });
    const jwt = new JwtService({ secret: process.env.JWT_SECRET });
    const adminToken = jwt.sign({ sub: admin.id, sessionVersion: 0 });
    const userToken = jwt.sign({ sub: user.id, sessionVersion: 0 });
    async function request(method, route, body, auth = adminToken, expected = 200) {
      const response = await fetch(`${base}/api/v1${route}`, { method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      assert.equal(response.status, expected, `${method} ${route}: unexpected HTTP status (${response.status})`);
      return { text, json: () => JSON.parse(text), headers: response.headers };
    }
    await request('GET', '/admin/upstream', undefined, null, 401);
    await request('GET', '/admin/upstream', undefined, userToken, 403);
    const native = process.env.UPSTREAM_SINGBOX || path.join(root, 'artifacts/binaries/singbox', process.platform === 'win32' ? 'windows-amd64/sing-box.exe' : `${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}/sing-box`);
    const sourcePort = await port();
    const externalUuid = '11111111-2222-4333-8444-555555555555';
    const uri = (suffix = '/one') => `vless://${externalUuid}@127.0.0.1:${sourcePort}?security=none&type=ws&path=${encodeURIComponent(suffix)}#local-upstream`;
    const created = (await request('POST', '/admin/upstream', { name: 'isolated', sourceType: 'TEXT', content: uri(), autoUpdate: false, status: 'ACTIVE' }, adminToken, 201)).json();
    const sourceId = created.subscription.id;
    const sync = (await request('POST', `/admin/upstream/${sourceId}/sync`, {}, adminToken, 201)).json();
    assert.equal(sync.nodeCount, 1);
    const pool = (await request('GET', `/admin/upstream/nodes?subscriptionId=${sourceId}`)).json();
    const nodeId = pool.data[0].id;
    assert.ok(!Object.hasOwn(pool.data[0], 'params'));
    const stored = await prisma.upstreamNode.findUnique({ where: { id: nodeId } });
    assert.ok(stored.paramsJson.startsWith('enc:v1:'));
    assert.ok(stored.rawConfigJson.startsWith('enc:v1:'));
    assert.ok((await prisma.upstreamSubscription.findUnique({ where: { id: sourceId } })).content.startsWith('enc:v1:'));
    await request('PUT', `/admin/upstream/nodes/${nodeId}/direct-sub`, { isDirectSub: true }, adminToken, 404);
    await request('GET', '/admin/upstream/nodes?isDirectSub=true', undefined, adminToken, 400);
    await request('POST', '/admin/upstream', { name: 'bad', sourceType: 'TEXT', content: uri(), isDirectSub: true }, adminToken, 400);
    await request('PUT', `/admin/upstream/${sourceId}`, { name: 'renamed' });
    assert.equal((await request('GET', `/admin/upstream/${sourceId}`)).json().subscription.content, uri());
    const ext = (await request('POST', '/admin/lines', { name: 'external', type: 'EXTERNAL', upstreamNodeId: nodeId, tags: ['TEST'] }, adminToken, 201)).json().line;
    assert.equal(ext.entryNodeId, null); assert.equal(ext.entryPort, null); assert.equal(ext.status, 'DISABLED'); assert.equal(ext.isPublic, false);
    assert.equal(ext.upstreamSummary.id, nodeId); assert.ok(!Object.hasOwn(ext, 'upstreamNode'));
    await request('PATCH', `/admin/lines/${ext.id}`, { status: 'ACTIVE', isPublic: true });
    const statsPort = await port(), clashPort = await port();
    const entry = await prisma.node.create({ data: { name: 'entry', serverHost: '127.0.0.1', status: 'ONLINE', agentToken: encryptSecret('isolated-entry-token'), configOverride: JSON.stringify({ experimental: { v2ray_api: { listen: `127.0.0.1:${statsPort}` }, clash_api: { external_controller: `127.0.0.1:${clashPort}` } } }) } });
    const entryPort = await port();
    const relay = (await request('POST', '/admin/lines', { name: 'relay', type: 'RELAY', relayMode: 'UPSTREAM_NODE', upstreamNodeId: nodeId, entryNodeId: entry.id, entryPort, protocolType: 'VLESS', params: { tls: { enabled: false, mode: 'none' } }, trafficRate: 2, tags: ['TEST'] }, adminToken, 201)).json().line;
    const template = await prisma.subscriptionTemplate.create({ data: { name: 'offline-integration', customInjectYaml: 'dns:\n  fallback-filter:\n    geoip: false\n' } });
    const plan = await prisma.plan.create({ data: { name: 'test-plan', durationDays: 1, templateId: template.id, trafficLimitBytes: 1000000n, lineMatchMode: 'EXPLICIT', lineIdsJson: JSON.stringify([ext.id, relay.id]) } });
    const sub = await prisma.subscription.create({ data: { userId: user.id, planId: plan.id, trafficLimitBytes: 1000000n, expireAt: expiry } });
    const detail = (await request('GET', '/user/subscription', undefined, userToken)).json();
    assert.equal(detail.lines.length, 2);
    const detailText = JSON.stringify(detail.lines);
    assert.ok(!detailText.includes(externalUuid)); assert.ok(!detailText.includes('paramsJson')); assert.ok(!detailText.includes('rawConfigJson'));
    for (const route of ['/user/lines', '/user/nodes', '/user/dashboard']) {
      const result = (await request('GET', route, undefined, userToken)).json();
      assert.equal(result.lines.length, 2); assert.ok(!JSON.stringify(result.lines).includes(externalUuid)); assert.ok(!JSON.stringify(result.lines).includes('externalConnection'));
    }
    assert.ok(!(await request('GET', `/admin/plans/${plan.id}/lines`)).text.includes('externalConnection'));
    const exported = {};
    for (const format of ['singbox', 'clash', 'base64']) exported[format] = (await request('GET', `/sub/${sub.subscriptionToken}?type=${format}`, undefined, null)).text;
    const client = JSON.parse(exported.singbox);
    assert.ok(client.outbounds.some((outbound) => outbound.uuid === externalUuid));
    assert.ok(client.outbounds.some((outbound) => outbound.uuid === user.uuid));
    assert.ok(exported.clash.includes(externalUuid));
    assert.ok(Buffer.from(exported.base64, 'base64').toString().includes(externalUuid));
    await prisma.plan.update({ where: { id: plan.id }, data: { lineIdsJson: '[]' } });
    assert.equal((await request('GET', '/user/subscription', undefined, userToken)).json().lines.length, 0);
    await prisma.userLineGrant.create({ data: { userId: user.id, lineId: ext.id } });
    assert.equal((await request('GET', '/user/subscription', undefined, userToken)).json().lines.length, 1);
    await prisma.plan.update({ where: { id: plan.id }, data: { lineMatchMode: 'TAGS', lineTagsJson: '["TEST"]' } });
    assert.equal((await request('GET', '/user/subscription', undefined, userToken)).json().lines.length, 2);
    await prisma.plan.update({ where: { id: plan.id }, data: { lineMatchMode: 'ALL' } });
    await prisma.subscription.update({ where: { id: sub.id }, data: { expireAt: new Date(0) } });
    assert.equal((await request('GET', '/user/subscription', undefined, userToken)).json().lines.length, 0);
    assert.equal((await request('GET', '/user/lines', undefined, userToken)).json().lines.length, 0);
    await request('GET', `/sub/${sub.subscriptionToken}?type=singbox`, undefined, null, 403);
    await prisma.subscription.update({ where: { id: sub.id }, data: { expireAt: expiry, trafficUsedBytes: 1000000n } });
    assert.equal((await request('GET', '/user/subscription', undefined, userToken)).json().lines.length, 0);
    await prisma.subscription.update({ where: { id: sub.id }, data: { trafficUsedBytes: 0n } });
    settingsState.enforceEmailVerification = true;
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: null } });
    assert.equal((await request('GET', '/user/subscription', undefined, userToken)).json().lines.length, 0);
    settingsState.enforceEmailVerification = false;
    const beforeConfig = await gateway.buildConfigSync(entry.id);
    const frames = [];
    await gateway.register(entry.id, { send: (text) => frames.push(JSON.parse(text)), close: () => undefined });
    const cachedBefore = await gateway.getDesiredConfigSync(entry.id);
    assert.ok(cachedBefore.singboxConfig.outbounds.some((outbound) => outbound.uuid === externalUuid));
    assert.ok(beforeConfig.singboxConfig.outbounds.some((outbound) => outbound.uuid === externalUuid));
    await request('PUT', `/admin/upstream/${sourceId}`, { status: 'DISABLED' });
    assert.equal((await request('GET', '/user/subscription', undefined, userToken)).json().lines.length, 0);
    const disabledConfig = await gateway.buildConfigSync(entry.id);
    assert.ok(!disabledConfig.singboxConfig.outbounds.some((outbound) => outbound.uuid === externalUuid));
    await gateway.pushConfigToAll();
    assert.ok(!frames.at(-1).data.singboxConfig.outbounds.some((outbound) => outbound.uuid === externalUuid));
    assert.ok(!(await gateway.getDesiredConfigSync(entry.id)).singboxConfig.outbounds.some((outbound) => outbound.uuid === externalUuid));
    await request('PUT', `/admin/upstream/${sourceId}`, { status: 'ACTIVE', content: uri('/two') });
    await request('POST', `/admin/upstream/${sourceId}/sync`, {}, adminToken, 201);
    const changed = await gateway.buildConfigSync(entry.id);
    assert.ok(changed.singboxConfig.outbounds.some((outbound) => outbound.transport?.path === '/two'));
    await gateway.pushConfigToAll();
    assert.ok(frames.at(-1).data.singboxConfig.outbounds.some((outbound) => outbound.transport?.path === '/two'));
    assert.ok((await gateway.getDesiredConfigSync(entry.id)).singboxConfig.outbounds.some((outbound) => outbound.transport?.path === '/two'));
    assert.equal((await prisma.upstreamNode.findUnique({ where: { id: nodeId } })).id, nodeId);
    await request('PUT', `/admin/upstream/${sourceId}`, { content: uri() });
    await request('POST', `/admin/upstream/${sourceId}/sync`, {}, adminToken, 201);
    const httpPort = await port();
    await request('POST', '/admin/lines', { name: 'http-relay', type: 'RELAY', relayMode: 'UPSTREAM_NODE', upstreamNodeId: nodeId, entryNodeId: entry.id, entryPort: httpPort, protocolType: 'HTTP', params: { usersEnabled: true, tls: { enabled: false, mode: 'none' } }, tags: ['TEST'] }, adminToken, 201);
    await request('POST', '/admin/lines', { name: 'bad-shared-ss', type: 'RELAY', relayMode: 'UPSTREAM_NODE', upstreamNodeId: nodeId, entryNodeId: entry.id, protocolType: 'SHADOWSOCKS', params: { method: '2022-blake3-aes-128-gcm', mode: 'shared' } }, adminToken, 400);
    const finalClient = JSON.parse((await request('GET', `/sub/${sub.subscriptionToken}?type=singbox`, undefined, null)).text);
    const httpOutbound = finalClient.outbounds.find((item) => item.type === 'http');
    assert.ok(httpOutbound); assert.ok(!httpOutbound.username.includes(':'));
    console.log('PASS: HTTP JWT/RBAC, schema, encrypted storage, two line types, authorization, safe summaries, three formats, source disable and parameter sync');
    if (!fs.existsSync(native)) throw new Error('Native Sing-box binary unavailable; HTTP checks passed but native verification blocked');
    function check(name, config) { const file = configFile(name, config); const checked = spawnSync(native, ['check', '-c', file], { encoding: 'utf8', timeout: 15000, env: { ...process.env, ENABLE_DEPRECATED_SPECIAL_OUTBOUNDS: 'true' } }); assert.equal(checked.status, 0, `${name}: ${checked.stderr}`); return file; }
    const serverConfig = { log: { level: 'error' }, inbounds: [{ type: 'vless', tag: 'external-in', listen: '127.0.0.1', listen_port: sourcePort, users: [{ uuid: externalUuid }], transport: { type: 'ws', path: '/one' } }], outbounds: [{ type: 'direct', tag: 'direct' }] };
    const serverFile = check('upstream-server.json', serverConfig);
    const relayFile = check('relay-agent.json', (await gateway.buildConfigSync(entry.id)).singboxConfig);
    const singularFile = check('subscription-client.json', client);
    const mihomo = process.env.UPSTREAM_MIHOMO || path.join(root, 'artifacts/binaries/mihomo/windows-amd64/mihomo.exe');
    if (fs.existsSync(mihomo)) { const result = spawnSync(mihomo, ['-t', '-f', configFile('subscription-clash.yaml', exported.clash), '-d', scratch], { encoding: 'utf8', timeout: 15000 }); assert.equal(result.status, 0, `Mihomo validation: ${result.stderr || result.stdout}`); console.log('PASS: Mihomo full subscription validation'); }
    else console.log('BLOCKED: Mihomo binary unavailable');
    function start(file) { const child = spawn(native, ['run', '-c', file], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ENABLE_DEPRECATED_SPECIAL_OUTBOUNDS: 'true' } }); child.stderr.on('data', (chunk) => { if (String(chunk).includes('FATAL')) console.error(`Test kernel ${path.basename(file)}: ${String(chunk).replaceAll(externalUuid, '[redacted]')}`); }); children.push(child); return child; }
    await waitPort(sourcePort, start(serverFile));
    await waitPort(entryPort, start(relayFile));
    await waitPort(httpPort, children.at(-1));
    const target = http.createServer((req, res) => { res.writeHead(204); res.end(); }); servers.push(target); const targetPort = await listen(target);
    for (const name of ['external', 'relay', 'http-relay']) {
      const proxyPort = await port();
      const outbound = name === 'http-relay' ? httpOutbound : client.outbounds.find((item) => item.uuid === (name === 'external' ? externalUuid : user.uuid));
      assert.ok(outbound, `client output missing ${name}`);
      const file = check(`client-${name}.json`, { log: { level: 'error' }, inbounds: [{ type: 'mixed', tag: 'proxy', listen: '127.0.0.1', listen_port: proxyPort }], outbounds: [{ ...outbound, tag: 'target' }], route: { final: 'target' } });
      await waitPort(proxyPort, start(file));
      const code = await new Promise((resolve, reject) => { const curl = spawn('curl', ['--silent', '--show-error', '--max-time', '10', '--noproxy', '', '--proxy', `http://127.0.0.1:${proxyPort}`, '--output', process.platform === 'win32' ? 'NUL' : '/dev/null', '--write-out', '%{http_code}', `http://127.0.0.1:${targetPort}/generate_204`]); let output = ''; curl.stdout.on('data', (chunk) => output += chunk); curl.on('error', reject); curl.on('close', (status) => status === 0 ? resolve(output) : reject(new Error(`curl failed for ${name}`))); });
      assert.equal(code, '204');
      console.log(`PASS: native ${name} proxy request HTTP 204`);
    }
    assert.ok(notifications > 0);
    assert.ok(singularFile);
    console.log('PASS: native Sing-box checks and isolated direct/relay data paths');
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve))));
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
    if (app) await app.close();
    await gateway.onModuleDestroy();
    await prisma.$disconnect();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
