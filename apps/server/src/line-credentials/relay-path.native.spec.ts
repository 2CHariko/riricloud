import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ForbiddenException } from '@nestjs/common';
import { PrismaClient, type Prisma } from '@prisma/client';
import { PrismaClient as TelemetryPrismaClient } from '@prisma/telemetry-client';
import { parseDocument } from 'yaml';
import { AgentService } from '../agent-gateway/agent-gateway.service';
import type { ConfigSyncData } from '../agent-gateway/agent-message';
import { ClientKernelsService, type ResolvedClientKernel } from '../client-kernels/client-kernels.service';
import { KernelExecutionError, ManagedKernelProcess } from '../client-kernels/kernel-process';
import { LinesService } from '../lines/lines.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TelemetryPrismaService } from '../prisma/telemetry-prisma.service';
import { KernelReadiness } from '../probe/executors/kernel-readiness';
import { proxyHttpDelay, reserveLoopbackPort, waitForKernel } from '../probe/executors/proxy-http';
import { SubscriptionService } from '../subscription/subscription.service';
import { LineCredentialsService } from './line-credentials.service';
import { revealRelayCredential } from './line-credential.types';

const native = process.env.RUN_NATIVE_CLIENT_TESTS === '1' ? describe : describe.skip;
const LOOPBACK = '127.0.0.1';
type Mode = 'PROTOCOL_PROXY' | 'TARGET_LINE';
type Pair = { entry: ConfigSyncData; landing: ConfigSyncData };
type Singbox = { child: ChildProcess; stop: () => Promise<void> };
const records = (value: unknown) => value as Array<Record<string, unknown>>;

async function removed(directory: string): Promise<void> {
  await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
}
async function released(port: number): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const available = await new Promise<boolean>((done, reject) => {
      const server = createTcpServer();
      server.once('error', error => (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? done(false) : reject(error));
      server.listen(port, LOOPBACK, () => server.close(error => error ? reject(error) : done(true)));
    });
    if (available) return;
    await sleep(50);
  }
  throw new Error('NATIVE_RELAY_LISTENER_NOT_RELEASED');
}

class RelayPathFixture {
  readonly relayId = randomUUID();
  readonly otherId = randomUUID();
  readonly entryId = randomUUID();
  readonly landingId = randomUUID();
  readonly targetId = randomUUID();
  readonly entryControlId = randomUUID();
  readonly landingControlId = randomUUID();
  private readonly kernels = new ClientKernelsService();
  private readonly ports = new Set<number>();
  private readonly sockets = new Set<Socket>();
  private readonly requests = new Map<string, number>();
  private directory?: string;
  private target?: Server;
  private targetPort = 0;
  private entryPort = 0;
  private landingPort = 0;
  private singbox!: ResolvedClientKernel;
  private mihomo!: ResolvedClientKernel;
  private proxies: Array<Record<string, unknown>> = [];
  private token = '';
  prisma!: PrismaClient;
  private telemetry?: TelemetryPrismaClient;
  credentials!: LineCredentialsService;
  private gateway!: AgentService;
  private subscriptions!: SubscriptionService;
  constructor(private readonly mode: Mode) {}

  private async port(): Promise<number> {
    let port: number;
    do { port = await reserveLoopbackPort(); } while (this.ports.has(port));
    this.ports.add(port);
    return port;
  }
  async open(): Promise<void> {
    const [singbox, mihomo] = await Promise.all([this.kernels.resolve('SINGBOX'), this.kernels.resolve('MIHOMO')]);
    if (!singbox || !mihomo) throw new Error('NATIVE_RELAY_FIXED_KERNEL_UNAVAILABLE');
    this.singbox = singbox; this.mihomo = mihomo;
    this.directory = await mkdtemp(join(tmpdir(), 'riri-relay-path-native-'));
    await chmod(this.directory, 0o700);
    const url = (name: string) => 'file:' + join(this.directory!, name).replaceAll('\\', '/');
    const databaseUrl = url('main.db'), telemetryUrl = url('telemetry.db');
    await Promise.all(['main.db', 'telemetry.db'].map(name => writeFile(join(this.directory!, name), '', { flag: 'wx', mode: 0o600 })));
    const migrations = await Promise.allSettled(['prisma/schema.prisma', 'prisma/telemetry/schema.prisma'].map(schema => promisify(execFile)(process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', schema],
      { cwd: resolve(__dirname, '../..'), windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, DATABASE_URL: databaseUrl, TELEMETRY_DATABASE_URL: telemetryUrl } })));
    for (const migration of migrations) if (migration.status === 'rejected') throw new Error('NATIVE_RELAY_ISOLATED_MIGRATION_FAILED', { cause: migration.reason });
    this.prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    this.telemetry = new TelemetryPrismaClient({ datasources: { db: { url: telemetryUrl } } });
    await Promise.all([this.prisma.$connect(), this.telemetry.$connect()]);
    this.target = createServer((req, res) => {
      const path = req.url ?? '';
      this.requests.set(path, (this.requests.get(path) ?? 0) + 1);
      res.writeHead(path.startsWith('/204/') ? 204 : 404); res.end();
    });
    this.target.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); });
    await new Promise<void>((done, reject) => {
      this.target!.once('error', reject);
      this.target!.listen(0, LOOPBACK, () => { this.targetPort = (this.target!.address() as { port: number }).port; done(); });
    });
    this.ports.add(this.targetPort);
    this.entryPort = await this.port(); this.landingPort = await this.port();
    await this.seed();
    this.credentials = new LineCredentialsService(this.prisma as PrismaService);
    this.gateway = new AgentService(this.prisma as PrismaService, undefined, undefined, this.telemetry as TelemetryPrismaService, undefined, undefined, this.credentials);
    const lines = new LinesService(this.prisma as PrismaService, this.gateway, undefined, undefined, this.credentials);
    this.subscriptions = new SubscriptionService(this.prisma as PrismaService, lines, this.gateway);
    await this.confirm(this.relayId);
    const subject = await this.subscriptionProxies(this.token);
    const control = await this.prisma.subscription.findUniqueOrThrow({ where: { id: 'control-sub' } });
    const controls = await this.subscriptionProxies(control.subscriptionToken);
    this.proxies = [this.named(subject, 'business'), this.named(controls, 'entry-readiness'), this.named(controls, 'landing-readiness')]
      .map((proxy, index) => ({ ...proxy, name: 'path-' + index }));
  }
  private async seed(): Promise<void> {
    await this.prisma.node.createMany({ data: [this.entryId, this.landingId].map(id => ({ id, name: id, serverHost: LOOPBACK, agentToken: randomUUID(), status: 'ONLINE' })) });
    const direct = async (id: string, nodeId: string, name: string, port: number) => this.prisma.line.create({ data: {
      id, name, type: 'DIRECT', protocolType: 'VMESS', listen: LOOPBACK, entryNodeId: nodeId, entryPort: port, paramsJson: '{}'
    } });
    await direct(this.entryControlId, this.entryId, 'entry-readiness', await this.port());
    await direct(this.landingControlId, this.landingId, 'landing-readiness', await this.port());
    if (this.mode === 'TARGET_LINE') await direct(this.targetId, this.landingId, 'target-line', this.landingPort);
    await this.prisma.line.create({ data: this.relay(this.relayId) });
    for (const [id, ids] of [['subject', [this.relayId, this.otherId]], ['control', [this.entryControlId, this.landingControlId, this.relayId, this.otherId]]] as const) {
      await this.prisma.user.create({ data: { id, email: id + '@relay-path.invalid', passwordHash: 'non-login-native-fixture' } });
      await this.prisma.plan.create({ data: { id, name: id, durationDays: 30, trafficLimitBytes: 1_000_000n, lineMatchMode: 'EXPLICIT', lineIdsJson: JSON.stringify(ids) } });
      const subscription = await this.prisma.subscription.create({ data: { id: id + '-sub', userId: id, planId: id, trafficLimitBytes: 1_000_000n } });
      if (id === 'subject') this.token = subscription.subscriptionToken;
    }
  }
  private relay(id: string): Prisma.LineUncheckedCreateInput {
    return { id, name: 'business', type: 'RELAY', relayMode: this.mode, protocolType: 'VMESS', listen: LOOPBACK,
      entryNodeId: this.entryId, entryPort: this.entryPort, paramsJson: '{}',
      ...(this.mode === 'TARGET_LINE' ? { targetLineId: this.targetId } : { landingNodeId: this.landingId, landingPort: this.landingPort }) };
  }
  private async subscriptionProxies(token: string): Promise<Array<Record<string, unknown>>> {
    const document = parseDocument((await this.subscriptions.getSubscription(token, { type: 'clash' })).body);
    if (document.errors.length) throw new Error('NATIVE_RELAY_SUBSCRIPTION_INVALID');
    return (document.toJS() as { proxies: Array<Record<string, unknown>> }).proxies;
  }
  private named(proxies: Array<Record<string, unknown>>, name: string): Record<string, unknown> {
    const found = proxies.find(proxy => proxy.name === name);
    if (!found || found.server !== LOOPBACK || found.type !== 'vmess') throw new Error('NATIVE_RELAY_SUBSCRIPTION_PROXY_MISSING');
    return found;
  }
  private async apply(nodeId: string): Promise<void> {
    const payload = await this.gateway.buildConfigSync(nodeId);
    expect(await this.credentials.capture(nodeId, payload)).not.toBe(false);
    // 只模拟 Agent 的配置回执；最终配置随后交给真实内核运行。
    await this.credentials.accepted(nodeId, { version: payload.version, success: true, message: 'accepted' });
    await this.credentials.heartbeat(nodeId, { protocolVersion: 2, cpuUsage: 0, memoryUsage: 0, bandwidthRate: 0, trafficSnapshots: [], appliedConfigVersion: payload.version, kernelRunning: true });
  }
  async confirm(lineId: string): Promise<void> {
    await this.apply(this.entryId); await this.apply(this.landingId); await this.apply(this.entryId);
    expect((await this.prisma.lineCredentialRotation.findUniqueOrThrow({ where: { lineId } })).stage).toBe('CONFIRMED');
  }
  async pair(lineId = this.relayId): Promise<Pair> {
    const entry = await this.gateway.buildConfigSync(this.entryId), landing = await this.gateway.buildConfigSync(this.landingId);
    const rotation = await this.prisma.lineCredentialRotation.findUniqueOrThrow({ where: { lineId } });
    const credential = revealRelayCredential(await this.prisma.lineCredential.findUniqueOrThrow({ where: { lineId_version: { lineId, version: rotation.targetVersion } } }));
    const outbound = records(entry.singboxConfig.outbounds).find(row => row.tag === 'relay-out-' + lineId);
    const inbound = records(landing.singboxConfig.inbounds).find(row => row.listen_port === this.landingPort);
    expect(outbound?.uuid === credential.uuid && outbound.server === LOOPBACK && outbound.server_port === this.landingPort).toBe(true);
    expect(records(inbound?.users).some(user => user.uuid === credential.uuid)).toBe(true);
    return { entry, landing };
  }
  async withoutEntitlement(): Promise<Pair> {
    await this.prisma.subscription.update({ where: { id: 'subject-sub' }, data: { trafficUsedBytes: 1_000_000n } });
    try {
      await expect(this.subscriptions.getSubscription(this.token, { type: 'clash' })).rejects.toBeInstanceOf(ForbiddenException);
      const pair = await this.pair();
      // 对照用户仍有权益，业务 listener 必须存活；拒绝发生在入口认证。
      expect(records(pair.entry.singboxConfig.inbounds).some(inbound => inbound.listen_port === this.entryPort)).toBe(true);
      return pair;
    } finally { await this.prisma.subscription.update({ where: { id: 'subject-sub' }, data: { trafficUsedBytes: 0n } }); }
  }
  async otherPair(): Promise<Pair> {
    await this.prisma.line.update({ where: { id: this.relayId }, data: { status: 'DISABLED' } });
    try {
      await this.prisma.line.create({ data: this.relay(this.otherId) });
      await this.confirm(this.otherId);
      return await this.pair(this.otherId);
    } finally {
      await this.prisma.line.updateMany({ where: { id: this.otherId }, data: { status: 'DISABLED' } });
      await this.prisma.line.update({ where: { id: this.relayId }, data: { status: 'ACTIVE' } });
    }
  }
  private async isolated(payload: ConfigSyncData): Promise<Record<string, unknown>> {
    const config = structuredClone(payload.singboxConfig);
    const experimental = config.experimental as { v2ray_api: { listen: string } };
    // 唯一运行期替换是统计 API 随机端口；认证和 route 保留网关原样。
    experimental.v2ray_api.listen = LOOPBACK + ':' + await this.port();
    const check = await this.kernels.validate('SINGBOX', JSON.stringify(config));
    expect({ status: check.status, executed: check.executed }).toEqual({ status: 'PASSED', executed: true });
    return config;
  }
  private async startServer(config: Record<string, unknown>): Promise<Singbox> {
    // 探测池上限为二；两台服务独立受管，池内只运行一个 Mihomo 客户端。
    const directory = await mkdtemp(join(this.directory!, 'singbox-'));
    await chmod(directory, 0o700);
    const file = join(directory, 'config.json');
    await writeFile(file, JSON.stringify(config), { mode: 0o600 });
    const child = spawn(this.singbox.path, ['run', '-D', directory, '-c', file], { cwd: directory, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '' } });
    const exited = new Promise<void>(done => { child.once('error', () => done()); child.once('close', () => done()); });
    let stopping: Promise<void> | undefined;
    const stop = () => stopping ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
      try { await exited; } finally { clearTimeout(force); }
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      await removed(directory);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    })();
    return { child, stop };
  }
  async run(pair: Pair, accepted: boolean): Promise<void> {
    const readiness = new KernelReadiness();
    const servers: Singbox[] = [];
    let client: ManagedKernelProcess | undefined;
    const before = [...this.requests.values()].reduce((total, count) => total + count, 0);
    const clientPorts = [await this.port(), await this.port(), await this.port()];
    const configs = [await this.isolated(pair.entry), await this.isolated(pair.landing)];
    const listening = configs.flatMap(config => [...records(config.inbounds).map(inbound => Number(inbound.listen_port)), Number((config.experimental as { v2ray_api: { listen: string } }).v2ray_api.listen.split(':').at(-1))]);
    const content = JSON.stringify({ 'allow-lan': false, 'bind-address': LOOPBACK, mode: 'rule', 'log-level': 'silent',
      'geodata-mode': false, 'geo-auto-update': false, tun: { enable: false }, dns: { enable: false }, proxies: this.proxies,
      listeners: clientPorts.map((port, index) => ({ name: 'path-in-' + index, type: 'mixed', listen: LOOPBACK, port, udp: false, proxy: 'path-' + index })),
      rules: ['MATCH,REJECT'] });
    const check = await this.kernels.validate('MIHOMO', content);
    expect({ status: check.status, executed: check.executed }).toEqual({ status: 'PASSED', executed: true });
    let runError: unknown;
    let cleanupErrors: unknown[] = [];
    try {
      await readiness.listen();
      for (const config of configs) servers.push(await this.startServer(config));
      client = await ManagedKernelProcess.start(this.mihomo.path, (file, directory) => ['-d', directory, '-f', file], content, undefined, 45_000);
      const ready = async () => {
        if (servers.some(server => server.child.exitCode !== null || server.child.signalCode !== null)) throw new Error('NATIVE_RELAY_SERVER_EXITED');
        return await readiness.ready(clientPorts[1]) && await readiness.ready(clientPorts[2]);
      };
      // 两台服务各自经真实订阅用户代理到 HTTP 自检目标，TCP listen 不构成 ready。
      await waitForKernel(client, ready);
      const path = '/204/' + randomUUID();
      let status = 'HTTP_204';
      try { await proxyHttpDelay(clientPorts[0], { id: 'relay-path', url: new URL('http://' + LOOPBACK + ':' + this.targetPort + path), address: LOOPBACK, expectedStatus: 204 }, 2_000); }
      catch (error) { if (!(error instanceof KernelExecutionError)) throw error; status = error.code; }
      if (accepted) expect(status).toBe('HTTP_204');
      else expect(['DIAL_FAILED', 'NETWORK_TIMEOUT']).toContain(status);
      expect(this.requests.get(path) ?? 0).toBe(accepted ? 1 : 0);
      expect(await ready()).toBe(true);
    } catch (error) {
      runError = error;
    } finally {
      const cleanup = await Promise.allSettled([
        (async () => { if (client) { await client.stop(); await client.exited; await removed(client.directory); expect(client.child.exitCode !== null || client.child.signalCode !== null).toBe(true); } })(),
        ...servers.map(server => server.stop()), readiness.close()
      ]);
      cleanupErrors = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
      try { await Promise.all([...new Set([...clientPorts, ...listening])].map(released)); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (runError !== undefined || cleanupErrors.length) throw new AggregateError([...cleanupErrors, ...(runError === undefined ? [] : [runError])], 'NATIVE_RELAY_EXECUTION_OR_CLEANUP_FAILED');
    // 客户端及两台服务彻底退出后复核，捕获超时后的迟到直出请求。
    expect([...this.requests.values()].reduce((total, count) => total + count, 0) - before).toBe(accepted ? 1 : 0);
  }
  async close(): Promise<void> {
    const cleanup = await Promise.allSettled([
      this.gateway?.onModuleDestroy(), this.credentials?.onModuleDestroy(),
      (async () => { if (this.target) { this.target.closeAllConnections(); for (const socket of this.sockets) socket.destroy(); await new Promise<void>((done, reject) => this.target!.close(error => error ? reject(error) : done())); await released(this.targetPort); } })()
    ]);
    await Promise.all([this.prisma?.$disconnect(), this.telemetry?.$disconnect()]);
    this.subscriptions?.onModuleDestroy();
    if (this.directory) {
      const child = relative(tmpdir(), this.directory);
      if (isAbsolute(child) || !child.startsWith('riri-relay-path-native-') || child.includes('..')) throw new Error('NATIVE_RELAY_UNSAFE_CLEANUP_PATH');
      await rm(this.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      await removed(this.directory);
    }
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'NATIVE_RELAY_FIXTURE_CLEANUP_FAILED');
  }
}

// VMESS 代表真实两跳；其它协议的独立落地认证由 relay-credentials 原生套件覆盖。
native.each<Mode>(['PROTOCOL_PROXY', 'TARGET_LINE'])('real VMESS entry → landing path: %s', mode => {
  jest.setTimeout(120_000);
  const fixture = new RelayPathFixture(mode);
  beforeAll(() => fixture.open());
  afterAll(() => fixture.close());

  it('ordinary subscription → entry → managed random credential → landing → HTTP 204', async () => {
    await fixture.run(await fixture.pair(), true);
  });
  it('entry rejects a subscriber without entitlement while both kernels remain HTTP ready', async () => {
    await fixture.run(await fixture.withoutEntitlement(), false);
    await fixture.run(await fixture.pair(), true);
  });
  it('another line works with its own landing but cannot authenticate against this landing or fall back to direct', async () => {
    const own = await fixture.pair(), other = await fixture.otherPair();
    await fixture.run(other, true);
    await fixture.run({ entry: other.entry, landing: own.landing }, false);
    await fixture.run(own, true);
  });
  it('rotation makes the new random mapping work and rejects the old entry against the new landing without direct fallback', async () => {
    const previous = await fixture.pair();
    const old = await fixture.prisma.lineCredential.findUniqueOrThrow({ where: { lineId_version: { lineId: fixture.relayId, version: 1 } } });
    await fixture.credentials.rotate(fixture.relayId, 'native-operator');
    await fixture.confirm(fixture.relayId);
    const current = await fixture.pair();
    const replacement = await fixture.prisma.lineCredential.findUniqueOrThrow({ where: { lineId_version: { lineId: fixture.relayId, version: 2 } } });
    expect(replacement.uuidHash !== old.uuidHash && replacement.nameHash !== old.nameHash).toBe(true);
    await fixture.run({ entry: previous.entry, landing: current.landing }, false);
    await fixture.run(current, true);
  });
});
