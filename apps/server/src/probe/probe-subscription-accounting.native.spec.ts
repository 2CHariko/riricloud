import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { PrismaClient, type User } from '@prisma/client';
import { PrismaClient as TelemetryPrismaClient } from '@prisma/telemetry-client';
import { hash } from 'bcryptjs';
import { AgentService } from '../agent-gateway/agent-gateway.service';
import { ClientKernelsService } from '../client-kernels/client-kernels.service';
import { parseTrafficCredential } from '../common/inbound';
import type { PrismaService } from '../prisma/prisma.service';
import type { TelemetryPrismaService } from '../prisma/telemetry-prisma.service';
import { SettingsService } from '../system/settings.service';
import { ProbeResourceService } from './probe-resource.service';
import { ProbeService } from './probe.service';
import { ProbeTaskService } from './probe-task.service';

const native = process.env.RUN_NATIVE_CLIENT_TESTS === '1' ? describe : describe.skip;
// 使用全量迁移后的临时双库与真实 Mihomo；代理夹具只接受固定回环目标，绝不复用 dev-e2e 数据库。
native('专用订阅拨测的隔离原生流量归属', () => {
  jest.setTimeout(120_000);
  let directory: string;
  let prisma: PrismaClient;
  let telemetry: TelemetryPrismaClient;
  let settings: SettingsService;
  let gateway: AgentService;
  let resources: ProbeResourceService;
  let engine: ProbeService;
  let tasks: ProbeTaskService;
  let target: Server;
  let proxy: Server;
  let first: User;
  let second: User;
  let targetPort: number;
  let proxyPort: number;
  const nodeId = randomUUID(), lineId = randomUUID();
  const kernels = new ClientKernelsService();
  const sockets = new Set<Socket>();
  const allowedUsers = new Map<string, string>();
  const counters = new Map<string, { upload: bigint; download: bigint }>();
  const targetMethods: string[] = [];
  const targetUrl = () => 'http://probe-target.invalid:' + targetPort + '/generate_204';
  const track = (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
  const listen = (server: Server): Promise<number> => new Promise((done, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port));
  });

  beforeAll(async () => {
    const kernel = await kernels.resolve('MIHOMO');
    expect(kernel?.version).toBe('1.19.30');
    directory = await mkdtemp(join(await realpath(tmpdir()), 'riri-probe-accounting-'));
    const url = (name: string) => 'file:' + join(directory, name).split(String.fromCharCode(92)).join('/');
    const databaseUrl = url('main.db'), telemetryUrl = url('telemetry.db');
    // 预建夹具空库，wx 保证只创建新文件；随后仍执行全部正式迁移。
    await Promise.all(['main.db', 'telemetry.db'].map((name) => writeFile(join(directory, name), '', { flag: 'wx' })));
    const serverRoot = resolve(__dirname, '../..');
    const migrated = await Promise.allSettled(['prisma/schema.prisma', 'prisma/telemetry/schema.prisma'].map((schema) => promisify(execFile)(process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', schema],
      { cwd: serverRoot, windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, DATABASE_URL: databaseUrl, TELEMETRY_DATABASE_URL: telemetryUrl } })));
    for (const migration of migrated) if (migration.status === 'rejected') {
      const error = migration.reason as { stdout?: string; stderr?: string; message?: string };
      throw new Error('Isolated migration failed: ' + (error.stdout ?? '') + (error.stderr ?? error.message ?? 'unknown error'));
    }
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    telemetry = new TelemetryPrismaClient({ datasources: { db: { url: telemetryUrl } } });
    await Promise.all([prisma.$connect(), telemetry.$connect()]);
    await startLoopbackFixture();
    await seedAccounts();
    settings = new SettingsService(prisma as PrismaService);
    await settings.updateSettings({ lineSpeedtestUserId: first.id, enforceEmailVerification: true, lineSpeedtestEnabled: false, lineSpeedtestTargetUrl: targetUrl() });
    gateway = new AgentService(prisma as PrismaService, settings, undefined, telemetry as TelemetryPrismaService);
    const config = await gateway.buildConfigSync(nodeId);
    const inbound = (config.singboxConfig.inbounds as Array<{ listen_port: number; users?: Array<{ username: string; password: string }> }>).find((row) => row.listen_port === proxyPort);
    expect(inbound?.users).toHaveLength(2);
    for (const user of inbound!.users!) allowedUsers.set(user.username, user.password);
    resources = new ProbeResourceService(prisma as PrismaService);
    engine = new ProbeService(kernels);
    // 只在此实例注入唯一夹具目标；端点策略、执行器、任务、持久化及账务均使用真实实现。
    jest.spyOn(engine.targetPolicy, 'target').mockImplementation(async (targetRequest) => {
      if (targetRequest.url !== targetUrl()) throw new Error('Unexpected isolated target');
      return { id: targetRequest.id, url: new URL(targetUrl()), address: '127.0.0.1', expectedStatus: 204 };
    });
    tasks = new ProbeTaskService(resources, engine, settings);
  });

  async function startLoopbackFixture() {
    target = createServer((request, response) => {
      targetMethods.push(request.method ?? '');
      setTimeout(() => { response.writeHead(204); response.end(); }, 25);
    });
    proxy = createServer((_request, response) => { response.writeHead(403); response.end(); });
    const crlf = String.fromCharCode(13, 10);
    proxy.on('connect', (request, socket, head) => {
      const header = request.headers['proxy-authorization'];
      const login = typeof header === 'string' && header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString() : '';
      const split = login.indexOf(':'); const username = login.slice(0, split), password = login.slice(split + 1);
      if (split < 0 || allowedUsers.get(username) !== password) {
        socket.end(['HTTP/1.1 407 Proxy Authentication Required', 'Content-Length: 0', '', ''].join(crlf)); return;
      }
      if (request.url !== 'probe-target.invalid:' + targetPort) { socket.destroy(); return; }
      const observed = counters.get(username) ?? { upload: 0n, download: 0n }; counters.set(username, observed);
      const upstream = connect(targetPort, '127.0.0.1', () => {
        socket.write(['HTTP/1.1 200 Connection Established', '', ''].join(crlf));
        if (head.length) { observed.upload += BigInt(head.length); upstream.write(head); }
        socket.on('data', (data: Buffer) => { observed.upload += BigInt(data.length); });
        upstream.on('data', (data: Buffer) => { observed.download += BigInt(data.length); });
        socket.pipe(upstream); upstream.pipe(socket);
      });
      track(upstream); upstream.once('error', () => socket.destroy()); socket.once('error', () => upstream.destroy());
      socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy());
    });
    target.on('connection', track); proxy.on('connection', track);
    targetPort = await listen(target); proxyPort = await listen(proxy);
  }
  async function seedAccounts() {
    const quota = 100_000_000n;
    const plan = await prisma.plan.create({ data: { name: 'Isolated probe plan', durationDays: 30, trafficLimitBytes: quota, lineMatchMode: 'EXPLICIT', lineIdsJson: JSON.stringify([lineId]) } });
    const createAccount = async (label: string) => {
      const password = randomBytes(24).toString('hex');
      return prisma.user.create({ data: { email: label + '@probe.invalid', nickname: label, passwordHash: await hash(password, 10), password,
        isActive: true, emailVerifiedAt: new Date(), trafficLimitBytes: quota,
        subscription: { create: { planId: plan.id, status: 'ACTIVE', trafficLimitBytes: quota, expireAt: new Date(Date.now() + 86400000) } } } });
    };
    first = await createAccount('selected'); second = await createAccount('other');
    await prisma.node.create({ data: { id: nodeId, name: 'Isolated loopback entry', serverHost: '127.0.0.1', status: 'ONLINE', isLocal: true, agentToken: randomBytes(32).toString('hex') } });
    await prisma.line.create({ data: { id: lineId, name: 'Isolated authenticated HTTP', type: 'DIRECT', protocolType: 'HTTP', entryNodeId: nodeId, entryPort: proxyPort,
      listen: '127.0.0.1', trafficRate: 2, paramsJson: JSON.stringify({ usersEnabled: true, tls: { mode: 'none', enabled: false } }) } });
  }
  async function probe() {
    const receipt = await tasks.start('isolated-admin', 'LINE', { id: lineId });
    expect(receipt).toMatchObject({ state: 'QUEUED', total: 1 });
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (tasks.summary(receipt.taskId).state === 'COMPLETED') return tasks.results(receipt.taskId).data[0];
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error('Isolated probe task did not complete');
  }
  const trafficSnapshots = () => [...counters].map(([userUuid, value]) => ({ userUuid, uploadTotal: value.upload.toString(), downloadTotal: value.download.toString() }));
  async function billObservedTraffic() {
    await gateway.handleHeartbeat(nodeId, { protocolVersion: 2, cpuUsage: 0, memoryUsage: 0, bandwidthRate: 0, kernelRunning: true, trafficSnapshots: trafficSnapshots() });
    await gateway.flushTrafficHourlyMetrics();
  }
  async function usage(userId: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { userId } });
    return { user: user.trafficUsedBytes, subscription: subscription.trafficUsedBytes };
  }
  function observedFor(user: User) {
    const entry = [...counters].find(([credential]) => parseTrafficCredential(credential).rawCredential === user.email);
    expect(entry).toBeDefined();
    return { credential: entry![0], ...entry![1], billed: (entry![1].upload + entry![1].download) * 2n };
  }

  beforeEach(async () => {
    targetMethods.length = 0; counters.clear();
    await gateway.flushTrafficHourlyMetrics();
    await telemetry.trafficHourlyMetric.deleteMany();
    await prisma.trafficCursor.deleteMany();
    await prisma.user.updateMany({ data: { trafficUsedBytes: 0n } });
    await prisma.subscription.updateMany({ data: { status: 'ACTIVE', trafficUsedBytes: 0n } });
    await settings.updateSettings({ lineSpeedtestUserId: first.id });
  });

  it('真实 Mihomo 请求按所选账号、订阅和线路倍率入账，重复心跳不重复扣费', async () => {
    const result = await probe();
    expect(result).toMatchObject({ status: 'SUCCESS', measurement: 'MIHOMO_URL_TEST', perspective: 'MASTER', engine: 'MIHOMO', engineVersion: '1.19.30', applied: true });
    expect(targetMethods).toEqual(['HEAD', 'HEAD']);
    const observed = observedFor(first);
    expect(observed.upload).toBeGreaterThan(0n); expect(observed.download).toBeGreaterThan(0n);
    expect(parseTrafficCredential(observed.credential)).toEqual({ rawCredential: first.email, lineId });
    await billObservedTraffic();
    expect(await usage(first.id)).toEqual({ user: observed.billed, subscription: observed.billed });
    expect(await usage(second.id)).toEqual({ user: 0n, subscription: 0n });
    const cursor = await prisma.trafficCursor.findUniqueOrThrow({ where: { nodeId_credential: { nodeId, credential: observed.credential } } });
    expect(cursor).toMatchObject({ uploadTotal: observed.upload, downloadTotal: observed.download });
    const metrics = await telemetry.trafficHourlyMetric.findMany({ where: { nodeId } });
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ userId: first.id, lineId, upload: observed.upload, download: observed.download, billedBytes: observed.billed });
    await billObservedTraffic();
    expect(await usage(first.id)).toEqual({ user: observed.billed, subscription: observed.billed });
    const stored = (await prisma.line.findUniqueOrThrow({ where: { id: lineId } })).lastProbeJson!;
    for (const secret of [first.email, first.password!, first.uuid, observed.credential]) expect(stored).not.toContain(secret);
    expect(await settings.getPublicSettings()).not.toHaveProperty('lineSpeedtestUserId');
  });
  it('错误认证不能到达目标，也不能产生可入账流量', async () => {
    const snapshot = (await resources.snapshot('LINE', lineId, 1))!;
    const beforeHits = targetMethods.length, before = trafficSnapshots();
    const wrong = { ...snapshot.request, connection: { ...snapshot.request.connection, params: { ...snapshot.request.connection.params, password: randomBytes(24).toString('hex') } } };
    const [result] = await engine.executeBatch([wrong], { id: 'wrong-credential', url: targetUrl(), expectedStatus: 204 }, 1000);
    expect(result.status).not.toBe('SUCCESS'); expect(result.latencyMs).toBeNull();
    expect(targetMethods).toHaveLength(beforeHits); expect(trafficSnapshots()).toEqual(before);
    const beforeUsage = await usage(first.id); await billObservedTraffic(); expect(await usage(first.id)).toEqual(beforeUsage);
  });
  it('显式切换账号后仅新账号增加流量，旧账号和其他订阅不被混记', async () => {
    expect((await probe()).status).toBe('SUCCESS'); await billObservedTraffic();
    const firstUsage = await usage(first.id);
    expect(firstUsage.user).toBeGreaterThan(0n);
    await settings.updateSettings({ lineSpeedtestUserId: second.id });
    expect((await probe()).status).toBe('SUCCESS');
    const observed = observedFor(second);
    expect(parseTrafficCredential(observed.credential)).toEqual({ rawCredential: second.email, lineId });
    await billObservedTraffic();
    expect(await usage(first.id)).toEqual(firstUsage);
    expect(await usage(second.id)).toEqual({ user: observed.billed, subscription: observed.billed });
    const metrics = await telemetry.trafficHourlyMetric.findMany({ where: { nodeId, userId: second.id } });
    expect(metrics).toHaveLength(1); expect(metrics[0]).toMatchObject({ lineId, billedBytes: observed.billed });
    expect(await prisma.user.count()).toBe(2); expect(await prisma.subscription.count()).toBe(2);
  });
  it('撤销订阅后任务明确跳过，目标和账务均不增加', async () => {
    await settings.updateSettings({ lineSpeedtestUserId: second.id });
    const before = trafficSnapshots(), beforeUsage = await usage(second.id), beforeHits = targetMethods.length;
    await prisma.subscription.update({ where: { userId: second.id }, data: { status: 'REVOKED' } });
    expect(await probe()).toMatchObject({ status: 'SKIPPED', errorCode: 'SPEEDTEST_USER_UNAVAILABLE', applied: false, latencyMs: null });
    expect(targetMethods).toHaveLength(beforeHits); expect(trafficSnapshots()).toEqual(before);
    await billObservedTraffic(); expect(await usage(second.id)).toEqual(beforeUsage);
  });

  afterAll(async () => {
    tasks?.onModuleDestroy();
    await kernels.onModuleDestroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all([target, proxy].filter(Boolean).map((server) => new Promise<void>((done) => server.close(() => done()))));
    await gateway?.onModuleDestroy();
    await Promise.all([prisma?.$disconnect(), telemetry?.$disconnect()]);
    jest.restoreAllMocks();
    if (directory) {
      const actual = await realpath(directory);
      if (dirname(actual) !== await realpath(tmpdir()) || !basename(actual).startsWith('riri-probe-accounting-')) throw new Error('Refusing to remove unexpected test directory');
      await rm(actual, { recursive: true, force: true });
    }
  });
});
