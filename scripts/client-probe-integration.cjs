'use strict';
// 仅临时库/回环 fixture；测试策略显式注入，不提供生产私网绕过环境开关。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '..');
const serverRoot = path.join(root, 'apps/server');
const r = createRequire(path.join(serverRoot, 'package.json'));
r('ts-node').register({ project: path.join(serverRoot, 'tsconfig.json') });
r('reflect-metadata');
const load = (file) => require(path.join(serverRoot, 'src', file));
const { PrismaClient } = r('@prisma/client');
const { Test } = r('@nestjs/testing');
const { Reflector } = r('@nestjs/core');
const { ValidationPipe } = r('@nestjs/common');
const { JwtService } = r('@nestjs/jwt');
const { ClientKernelsService } = load('client-kernels/client-kernels.service');
const { ProbeService } = load('probe/probe.service');
const { ProbeTaskService } = load('probe/probe-task.service');
const { ProbeResourceService } = load('probe/probe-resource.service');
const { ProbeController } = load('probe/probe.controller');
const { UpstreamController } = load('upstream/upstream.controller');
const { UpstreamService } = load('upstream/upstream.service');
const { UpstreamParserService } = load('upstream/upstream-parser.service');
const { PrismaService } = load('prisma/prisma.service');
const { JwtStrategy } = load('auth/jwt.strategy');
const { JwtAuthGuard } = load('common/jwt-auth.guard');
const { encryptSecret } = load('common/secret-crypto');
const { TemplatesController } = load('subscription-templates/templates.controller');
const { TemplatesService } = load('subscription-templates/templates.service');
async function listen(server) { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  const directory = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'client-probe-integration-'));
  const dbFile = path.join(directory, 'main.db');
  const db = new DatabaseSync(dbFile);
  const migrations = path.join(serverRoot, 'prisma/migrations');
  for (const name of fs.readdirSync(migrations).sort()) { const file = path.join(migrations, name, 'migration.sql'); if (fs.existsSync(file)) db.exec(fs.readFileSync(file, 'utf8')); }
  db.close();
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'isolated-probe-integration-random-test-key-only';
  process.env.RIRICLOUD_ENCRYPTION_KEY = 'isolated-probe-integration-encryption-test-key';
  const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbFile.split(path.sep).join('/')}` } } });
  const kernels = new ClientKernelsService();
  const engine = new ProbeService(kernels);
  const resources = new ProbeResourceService(prisma);
  const fixtureSockets = new Set();
  const target = http.createServer((req, res) => { if (req.url === '/slow') return; if (req.url === '/redirect') { res.writeHead(302, { Location: '/204' }); return res.end(); } res.writeHead(req.url === '/500' ? 500 : req.url === '/200' ? 200 : 204); res.end(); });
  const proxy = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  let tlsTarget;
  let app;
  let tasks;
  const manage = (socket) => { fixtureSockets.add(socket); socket.once('close', () => fixtureSockets.delete(socket)); };
  target.on('connection', manage); proxy.on('connection', manage);
  proxy.on('connect', (req, socket, head) => {
    if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('fixture:password').toString('base64')}`) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'); return; }
    const at = req.url.lastIndexOf(':'); const port = Number(req.url.slice(at + 1));
    const host = req.url.slice(0, at).replace(/^\[|\]$/g, '');
    if (host !== '127.0.0.1') { socket.destroy(); return; }
    const upstream = net.connect(port, host, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
    manage(upstream); upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy()); socket.on('error', () => upstream.destroy());
  });
  try {
    const targetPort = await listen(target), proxyPort = await listen(proxy);
    // 固定测试策略，真实内核与 HTTP/TLS 仍执行；生产策略仍拒绝任意私网目标。
    engine.targetPolicy.target = async (value) => ({ id: value.id, url: new URL(value.url), address: '127.0.0.1', expectedStatus: value.expectedStatus });
    engine.targetPolicy.connection = async (value) => value;
    const baseConnection = { protocolType: 'HTTP', serverHost: '127.0.0.1', serverPort: proxyPort, params: { username: 'fixture', password: 'password' } };
    const request = (connection = baseConnection) => ({ subjectType: 'LINE', subjectId: 'fixture', connection, configHash: 'fixture-v1', routeKind: 'MANAGED_DIRECT', allowPrivateEndpoint: true });
    const profile = await kernels.resolve('MIHOMO'); assert.ok(profile, 'Fixed Mihomo kernel must be available'); assert.equal(profile.version, '1.19.30');
    const dial = async (pathname, connection = baseConnection, signal) => (await engine.executeBatch([request(connection)], { id: pathname, url: `http://127.0.0.1:${targetPort}${pathname}`, expectedStatus: 204 }, 800, 'MIHOMO_ONLY', signal))[0];
    const good = await dial('/204'); assert.equal(good.status, 'SUCCESS'); assert.equal(good.engine, 'MIHOMO'); assert.ok(good.latencyMs > 0);
    for (const pathname of ['/500', '/200', '/redirect']) { const result = await dial(pathname); assert.equal(result.status, 'ERROR', pathname); assert.equal(result.errorCode, 'UNEXPECTED_HTTP_STATUS'); }
    assert.notEqual((await dial('/204', { ...baseConnection, params: { username: 'fixture', password: 'wrong' } })).status, 'SUCCESS');
    assert.equal((await dial('/slow')).status, 'TIMEOUT');
    const abort = new AbortController(); setTimeout(() => abort.abort(), 250); assert.equal((await dial('/slow', baseConnection, abort.signal)).status, 'CANCELED');
    console.log('PASS: actual Mihomo HTTP 204, unexpected 200/500/redirect rejection, wrong credentials, timeout and cancellation');
    const tlsDir = path.join(process.env.PI_SCRATCH_DIR || directory, 'probe-tls');
    if (fs.existsSync(path.join(tlsDir, 'server.pem'))) {
      tlsTarget = https.createServer({ key: fs.readFileSync(path.join(tlsDir, 'server-key.pem')), cert: fs.readFileSync(path.join(tlsDir, 'server.pem')) }, (req, res) => { res.writeHead(204); res.end(); }); tlsTarget.on('connection', manage);
      const tlsPort = await listen(tlsTarget);
      const tlsDial = async (host) => (await engine.executeBatch([request()], { id: 'tls', url: `https://${host}:${tlsPort}/204`, expectedStatus: 204 }, 1500, 'MIHOMO_ONLY'))[0];
      if (process.env.NODE_EXTRA_CA_CERTS) { assert.equal((await tlsDial('localhost')).status, 'SUCCESS'); console.log('PASS: trusted HTTPS target through real Mihomo'); }
      assert.notEqual((await tlsDial('wrong-certificate.invalid')).status, 'SUCCESS'); console.log('PASS: target certificate hostname mismatch rejected');
    } else console.log('NOT EXECUTED: HTTPS fixture unavailable');
    const settingsState = { lineSpeedtestTargetUrl: `http://127.0.0.1:${targetPort}/204`, lineSpeedtestTimeoutMs: 800, probeSingboxFallbackEnabled: true };
    tasks = new ProbeTaskService(resources, engine, { getSettings: async () => settingsState });
    const upstream = new UpstreamService(prisma, new UpstreamParserService(), { pushConfigToAll: async () => 0 });
    const module = await Test.createTestingModule({ controllers: [ProbeController, UpstreamController, TemplatesController], providers: [{ provide: PrismaService, useValue: prisma }, { provide: ProbeTaskService, useValue: tasks }, { provide: ClientKernelsService, useValue: kernels }, { provide: UpstreamService, useValue: upstream }, TemplatesService, JwtStrategy] }).compile();
    app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('api/v1'); app.useGlobalGuards(new JwtAuthGuard(app.get(Reflector))); app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })); await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    const admin = await prisma.user.create({ data: { email: 'admin@probe.invalid', passwordHash: 'fixture-hash', role: 'ADMIN' } });
    const user = await prisma.user.create({ data: { email: 'user@probe.invalid', passwordHash: 'fixture-hash' } });
    const jwt = new JwtService({ secret: process.env.JWT_SECRET }); const adminToken = jwt.sign({ sub: admin.id, sessionVersion: 0 }), userToken = jwt.sign({ sub: user.id, sessionVersion: 0 });
    async function api(method, route, body, token = adminToken, expected = 200) { const response = await fetch(`${url}/api/v1${route}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await response.text(); assert.equal(response.status, expected, `${method} ${route}`); return JSON.parse(text); }
    const previewRoute = '/admin/subscription-templates/preview';
    const geoPreview = { format: 'clash', template: { customInjectYaml: 'dns: {enable: false}\nrules:\n  - GEOIP,CN,DIRECT\n  - MATCH,DIRECT\n' } };
    await api('POST', previewRoute, geoPreview, null, 401);
    await api('POST', previewRoute, geoPreview, userToken, 403);
    const preview = await api('POST', previewRoute, geoPreview, adminToken, 201);
    assert.equal(preview.kernelCheck.status, 'PASSED'); assert.equal(preview.kernelCheck.executed, true); assert.equal(preview.kernelCheck.scope, 'FULL');
    assert.ok(preview.kernelCheck.resourceRequirements.some(r => r.kind === 'GEOIP' && r.state === 'AVAILABLE'));
    assert.ok(preview.content.includes('GEOIP,CN,DIRECT')); assert.ok(preview.stats); assert.ok(Array.isArray(preview.warnings));
    const remotePreview = await api('POST', previewRoute, { format: 'clash', template: { customInjectYaml: 'rule-providers:\n  private-fixture:\n    type: http\n    behavior: domain\n    url: https://example.com/secret-token\n' } }, adminToken, 201);
    assert.equal(remotePreview.kernelCheck.status, 'EXTERNAL_RESOURCES_REQUIRED'); assert.equal(remotePreview.kernelCheck.executed, false);
    assert.ok(remotePreview.kernelCheck.resourceRequirements.some(r => r.kind === 'RULE_PROVIDER' && r.state === 'REMOTE_DISABLED'));
    assert.ok(!JSON.stringify(remotePreview.kernelCheck).includes('secret-token'));
    console.log('PASS: preview HTTP auth, native GeoIP check, original content, structured offline resource rejection');
    const source = await prisma.upstreamSubscription.create({ data: { name: 'fixture', sourceType: 'TEXT', content: encryptSecret('fixture'), customHeadersJson: encryptSecret('{}'), autoUpdate: false } });
    const node = await prisma.upstreamNode.create({ data: { subscriptionId: source.id, name: 'node', protocolType: 'HTTP', serverHost: '127.0.0.1', serverPort: proxyPort, paramsJson: encryptSecret(JSON.stringify(baseConnection.params)), rawConfigJson: encryptSecret('{}'), connectionHash: 'c1', configHash: 'v1' } });
    await api('GET', '/admin/client-kernels/status', undefined, null, 401); await api('GET', '/admin/client-kernels/status', undefined, userToken, 403);
    const receipt = await api('POST', `/admin/upstream/nodes/${node.id}/probe`, { policy: 'MIHOMO_ONLY' }, adminToken, 202); assert.equal(receipt.total, 1);
    async function completed(id) { for (let i = 0; i < 150; i++) { const summary = await api('GET', `/admin/probe-tasks/${id}`); if (['COMPLETED', 'FAILED', 'CANCELED'].includes(summary.state)) return summary; await sleep(100); } throw new Error('Task did not finish'); }
    assert.equal((await completed(receipt.taskId)).success, 1);
    const results = await api('GET', `/admin/probe-tasks/${receipt.taskId}/results?page=1&pageSize=20`); assert.equal(results.data[0].engine, 'MIHOMO'); assert.equal(results.data[0].applied, true); assert.ok(!JSON.stringify(results).includes('password'));
    assert.equal(JSON.parse((await prisma.upstreamNode.findUnique({ where: { id: node.id } })).lastProbeJson).measurement, 'PROXY_HTTP_DELAY');
    settingsState.lineSpeedtestTargetUrl = `http://127.0.0.1:${targetPort}/slow`;
    const staleTask = await api('POST', `/admin/upstream/nodes/${node.id}/probe`, {}, adminToken, 202); await sleep(150); await prisma.upstreamNode.update({ where: { id: node.id }, data: { configHash: 'v2' } }); await completed(staleTask.taskId);
    const stale = (await api('GET', `/admin/probe-tasks/${staleTask.taskId}/results`)).data[0]; assert.equal(stale.status, 'STALE'); assert.equal(stale.applied, false);
    const cancelTask = await api('POST', `/admin/upstream/nodes/${node.id}/probe`, {}, adminToken, 202); await api('DELETE', `/admin/probe-tasks/${cancelTask.taskId}`); assert.equal((await completed(cancelTask.taskId)).state, 'CANCELED');
    console.log('PASS: real HTTP JWT/RBAC, async202 task, safe results, conditional stale write and cancel');
  } finally {
    if (app) await app.close(); else if (tasks) await tasks.onModuleDestroy();
    await kernels.onModuleDestroy();
    for (const socket of fixtureSockets) socket.destroy();
    await Promise.all([target, proxy, tlsTarget].filter(Boolean).map((server) => new Promise((resolve) => server.close(resolve))));
    await prisma.$disconnect(); fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
