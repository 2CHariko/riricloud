import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { PrismaClient, type Prisma, type LineCredentialRotation } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { TelemetryPrismaService } from '../prisma/telemetry-prisma.service';
import { AgentService } from '../agent-gateway/agent-gateway.service';
import type { AgentLogItem, ConfigSyncData, HeartbeatData } from '../agent-gateway/agent-message';
import { SystemLogsService } from '../system-logs/system-logs.service';
import { SSEHubService } from '../system-logs/sse-hub.service';
import { LinesService } from '../lines/lines.service';
import { LineCredentialsService } from './line-credentials.service';
import { inboundUsesCredential } from './line-credential-config-proof';
import { revealRelayCredential } from './line-credential.types';

// 独立审查：真实 SQLite 迁移、状态机、网关编译及日志脱敏；不启动网络服务或生产数据库。
const RELAY = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TARGET = '33333333-3333-4333-8333-333333333333';
const heartbeat = (version: number): HeartbeatData => ({ protocolVersion: 2, cpuUsage: 0, memoryUsage: 0, bandwidthRate: 0, trafficSnapshots: [], appliedConfigVersion: version, kernelRunning: true });
const inbounds = (payload: ConfigSyncData) => payload.singboxConfig.inbounds as Record<string, unknown>[];
const entryTag = 'line-' + RELAY + '-entry';

describe('Independent relay credential security review', () => {
  jest.setTimeout(120_000);
  let directory: string;
  let prisma: PrismaClient;
  let credentials: LineCredentialsService;
  let gateway: AgentService;
  let logs: SystemLogsService;
  let hub: SSEHubService;
  const dispatch = jest.fn(async () => undefined);
  const persisted = jest.fn(async () => ({ count: 1 }));

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'riricloud-credential-review-'));
    const url = 'file:' + join(directory, 'review.db').replaceAll('\\', '/');
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    await prisma.$executeRawUnsafe('PRAGMA user_version = 0');
    await prisma.$disconnect();
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', resolve('prisma/schema.prisma')], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
    await prisma.$connect();
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    dispatch.mockClear(); persisted.mockClear();
    await prisma.lineCredentialRotation.deleteMany();
    await prisma.lineCredential.deleteMany();
    await prisma.line.deleteMany();
    await prisma.node.deleteMany();
    await prisma.subscription.deleteMany();
    await prisma.user.deleteMany();
    await prisma.plan.deleteMany();
    await prisma.node.createMany({ data: ['entry', 'landing', 'new-entry', 'new-landing'].map(id => ({ id, name: id, serverHost: id + '.fixture.example', agentToken: id + '-review-fixture', status: 'ONLINE' })) });
    await prisma.line.create({ data: { id: RELAY, name: 'Review relay', type: 'RELAY', relayMode: 'PROTOCOL_PROXY', protocolType: 'VMESS', paramsJson: JSON.stringify({ tls: { enabled: false, mode: 'none' } }), entryNodeId: 'entry', landingNodeId: 'landing', entryPort: 24101, landingPort: 25101 } });
    await prisma.user.create({ data: { id: 'review-user', email: 'review@fixture.example', passwordHash: 'non-login-fixture' } });
    await prisma.plan.create({ data: { id: 'review-plan', name: 'Review plan', durationDays: 30, trafficLimitBytes: 1_000_000n } });
    await prisma.subscription.create({ data: { id: 'review-subscription', userId: 'review-user', planId: 'review-plan', trafficLimitBytes: 1_000_000n } });
    hub = new SSEHubService();
    logs = new SystemLogsService({ systemLog: { createMany: persisted } } as unknown as TelemetryPrismaService, prisma as PrismaService, hub);
    credentials = new LineCredentialsService(prisma as PrismaService, logs);
    gateway = new AgentService(prisma as PrismaService, undefined, logs, undefined, undefined, undefined, credentials);
    credentials.setDispatcher(dispatch);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await credentials?.onModuleDestroy();
    await gateway?.onModuleDestroy();
    await logs?.onModuleDestroy();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    const child = directory && relative(tmpdir(), directory);
    if (child && !child.startsWith('..') && child.startsWith('riricloud-credential-review-')) await rm(directory, { recursive: true, force: true });
  });

  const row = (lineId = RELAY) => prisma.lineCredentialRotation.findUniqueOrThrow({ where: { lineId } });
  async function generated(nodeId: string) {
    const payload = await gateway.buildConfigSync(nodeId);
    expect(await credentials.capture(nodeId, payload)).not.toBe(false);
    return payload;
  }
  async function apply(nodeId: string) {
    const payload = await generated(nodeId);
    await credentials.accepted(nodeId, { version: payload.version, success: true, message: 'accepted' });
    await credentials.heartbeat(nodeId, heartbeat(payload.version));
    return payload;
  }
  async function complete() {
    await apply('entry'); await apply('landing'); await apply('entry');
    expect((await row()).stage).toBe('CONFIRMED');
  }
  async function material(version: number, lineId = RELAY) {
    return revealRelayCredential(await prisma.lineCredential.findUniqueOrThrow({ where: { lineId_version: { lineId, version } } }));
  }

  it('control: repeated rotate retains the accepted version and the deadline', async () => {
    credentials.setDispatcher(async ids => { for (const id of ids) await gateway.pushConfig(id); });
    await credentials.rotate(RELAY, 'operator');
    const initial = await row();
    const version = Number(initial.expectedConfigVersion);
    await credentials.accepted('entry', { version, success: true, message: 'accepted' });
    await credentials.rotate(RELAY, 'operator');
    const repeated = await row();
    expect(repeated.expectedConfigVersion).toBe(initial.expectedConfigVersion);
    expect(repeated.accepted).toBe(true);
    expect(repeated.deadlineAt).toEqual(initial.deadlineAt);
    await credentials.heartbeat('entry', heartbeat(version));
    expect((await row()).stage).toBe('APPLYING_LANDING');
  });

  it('[P1] retry must not reinstall the superseded landing identity after the replacement was applied', async () => {
    await complete();
    const old = await material(1);
    await credentials.rotate(RELAY, 'operator');
    await apply('entry');
    const replacement = await apply('landing');
    expect(inbounds(replacement).some(inbound => inboundUsesCredential(inbound, old))).toBe(false);
    const restoring = await generated('entry');
    await credentials.accepted('entry', { version: restoring.version, success: false, message: 'entry rejected replacement' });
    expect((await row()).stage).toBe('FAILED');
    const operationId = (await row()).operationId;
    await credentials.rotate(RELAY, 'operator');
    expect(await row()).toMatchObject({ stage: 'STOPPING_ENTRY', operationId, targetVersion: 2 });
    // 落地重连/同节点另一线路更新会在入口重停确认前请求整份配置。
    const afterRetry = await generated('landing');
    expect(inbounds(afterRetry).some(inbound => inboundUsesCredential(inbound, old))).toBe(false);
  });

  it('[P1] topology migration must not deploy the retired identity onto the new landing', async () => {
    await complete();
    const old = await material(1);
    const lines = new LinesService(prisma as PrismaService, { pushConfigToAll: async () => 0 } as unknown as AgentService, undefined, undefined, credentials);
    await lines.update(RELAY, { entryNodeId: 'new-entry', landingNodeId: 'new-landing' });
    await generated('new-entry');
    await apply('entry');
    expect((await row()).stage).toBe('RETIRING_PREVIOUS_LANDING');
    const retired = await apply('landing');
    expect(inbounds(retired).some(inbound => inboundUsesCredential(inbound, old))).toBe(false);
    expect((await row()).stage).toBe('STOPPING_ENTRY');
    const newLanding = await generated('new-landing');
    expect(inbounds(newLanding).some(inbound => inboundUsesCredential(inbound, old))).toBe(false);
  });

  it('control: capture must not publish a restoring entry after a failure wins its registration CAS', async () => {
    await complete();
    await credentials.rotate(RELAY, 'operator');
    await apply('entry'); await apply('landing');
    const earlier = await generated('entry');
    const realRecord = credentials.recordConfig.bind(credentials);
    jest.spyOn(credentials, 'recordConfig').mockImplementationOnce(async (...args) => {
      // 最终配置证明已完成，旧版本失败回执在新版本登记前先成功落库。
      await credentials.accepted('entry', { version: earlier.version, success: false, message: 'late rejection' });
      expect((await row()).stage).toBe('FAILED');
      return realRecord(...args);
    });
    const sent: ConfigSyncData[] = [];
    await gateway.register('entry', { send: (raw: string | Buffer) => { const frame = JSON.parse(String(raw)) as { type: string; data: ConfigSyncData }; if (frame.type === 'config_sync') sent.push(frame.data); }, close: () => undefined });
    await gateway.pushConfig('entry');
    expect((await row()).stage).toBe('FAILED');
    expect(sent).toHaveLength(1);
    expect(inbounds(sent[0]).some(inbound => inbound.tag === entryTag)).toBe(false);
  });

  it.each(['entry-stopped', 'old-revoked'] as const)('[P1] ordinary log delivery must retain secret masking at %s', async phase => {
    // 使用有真实密码的协议，避免通用 UUID mask 掩盖历史密码泄漏。
    await prisma.line.update({ where: { id: RELAY }, data: { protocolType: 'TROJAN', paramsJson: JSON.stringify({ tls: { enabled: true, mode: 'tls', serverName: 'landing.fixture.example' } }) } });
    await complete();
    const old = await material(1);
    await credentials.rotate(RELAY, 'operator');
    await apply('entry');
    if (phase === 'old-revoked') { await apply('landing'); await apply('entry'); }
    expect((await prisma.lineCredential.findUniqueOrThrow({ where: { lineId_version: { lineId: RELAY, version: 1 } } })).status).toBe(phase === 'old-revoked' ? 'REVOKED' : 'ACTIVE');
    const broadcast = jest.spyOn(hub, 'publish');
    await gateway.handleLogReport(phase === 'old-revoked' ? 'landing' : 'entry', { logs: [{ source: 'SINGBOX', level: 'ERROR', module: 'Kernel', message: 'authentication failed for ' + old.credential, metadata: { detail: old.credential } }] });
    await logs.flush();
    expect(broadcast).toHaveBeenCalled();
    expect(persisted).toHaveBeenCalled();
    const output = JSON.stringify({ broadcasts: broadcast.mock.calls, writes: persisted.mock.calls });
    expect(output.includes(old.credential)).toBe(false);
  });

  it('[P2] losing a late failure CAS must not resend and discard the newer accepted configuration', async () => {
    credentials.setDispatcher(async ids => { for (const id of ids) await gateway.pushConfig(id); });
    const initial = await generated('entry');
    let newVersion = 0;
    const delegate = prisma.lineCredentialRotation as unknown as { findMany: (args?: Prisma.LineCredentialRotationFindManyArgs) => Promise<LineCredentialRotation[]> };
    const realFind = delegate.findMany.bind(delegate);
    jest.spyOn(delegate, 'findMany').mockImplementationOnce(async args => {
      const stale = await realFind(args);
      // 迟到失败已读到旧行，此时另一次合法配置生成/回执先完成。
      const newer = await generated('entry');
      newVersion = newer.version;
      await credentials.accepted('entry', { version: newVersion, success: true, message: 'accepted' });
      expect((await row()).accepted).toBe(true);
      return stale;
    });
    await credentials.accepted('entry', { version: initial.version, success: false, message: 'late rejection' });
    const current = await row();
    expect(current.stage).toBe('STOPPING_ENTRY');
    expect(current).toMatchObject({ expectedConfigVersion: BigInt(newVersion), accepted: true });
  });

  it('control: a stale confirmed preparation is rejected when a newer maintenance task exists', async () => {
    await complete();
    const obsolete = await gateway.buildConfigSync('entry');
    await credentials.rotate(RELAY, 'operator');
    expect(await credentials.capture('entry', obsolete)).toBe(false);
    expect((await row()).stage).toBe('STOPPING_ENTRY');
  });

  it('control: configuration overrides cannot replace managed auth or routing', async () => {
    for (const key of ['inbounds', 'outbounds', 'route', 'dns']) {
      await prisma.node.update({ where: { id: 'entry' }, data: { configOverride: JSON.stringify({ [key]: {} }) } });
      await expect(gateway.buildConfigSync('entry')).rejects.toThrow('LINE_CREDENTIAL_CONFIG_OVERRIDE');
    }
    await prisma.node.update({ where: { id: 'entry' }, data: { configOverride: JSON.stringify({ log: { level: 'warn' } }) } });
    await complete();
  });

  it('relay landing rejection counts use the captured node/version/tag and never persist supplied identity text', async () => {
    await complete();
    const payload = await generated('landing');
    const entryPayload = await generated('entry');
    const tag = (await row()).landingTag;
    const identity = await material(1);
    const rejected: AgentLogItem = { source: 'SINGBOX', level: 'ERROR', module: 'Singbox', message: 'inbound/vmess[' + tag + ']: process connection from 127.0.0.1:40000: bad request', metadata: { configVersion: payload.version }, sequence: 1, agentInstanceId: 'counter-fixture' };
    const broadcast = jest.spyOn(hub, 'publish');
    await gateway.handleLogReport('entry', { logs: [{ ...rejected, metadata: { configVersion: entryPayload.version } }] });
    await gateway.handleLogReport('landing', { logs: [{ ...rejected, source: 'AGENT' }, { ...rejected, metadata: { configVersion: payload.version + 999 } }, { ...rejected, sequence: undefined, agentInstanceId: undefined }] });
    await gateway.handleLogReport('landing', { logs: [rejected, rejected, { ...rejected, sequence: 2 }] });
    await credentials.onModuleDestroy();
    await logs.flush();
    const calls = persisted.mock.calls as unknown as Array<[{ data: Array<{ module: string; message: string; metadata: string }> }]>;
    const writes = calls.flatMap(([call]) => call.data);
    const counters = writes.filter(log => log.module === 'LineCredentialAuth');
    expect(counters.length).toBeGreaterThan(0);
    expect(counters.reduce((total, log) => total + Number(JSON.parse(log.metadata).count), 0)).toBe(2);
    for (const log of counters) {
      expect(JSON.parse(log.metadata)).toMatchObject({ lineId: RELAY, port: 25101, protocol: 'vmess', configVersion: payload.version });
      expect(log.message).toBe('Relay landing authentication rejected');
    }
    const output = JSON.stringify({ counters, broadcasts: broadcast.mock.calls });
    expect(output).not.toContain(identity.credential);
    expect(JSON.stringify(counters)).not.toContain('40000');
  });

  it('control: shared target keeps another source and its users while one source rotates', async () => {
    await prisma.line.create({ data: { id: TARGET, name: 'Shared target', type: 'DIRECT', protocolType: 'VMESS', entryNodeId: 'landing', entryPort: 25111, paramsJson: '{}' } });
    await prisma.line.update({ where: { id: RELAY }, data: { relayMode: 'TARGET_LINE', landingNodeId: null, landingPort: null, targetLineId: TARGET } });
    await prisma.line.create({ data: { id: OTHER, name: 'Other relay', type: 'RELAY', relayMode: 'TARGET_LINE', protocolType: 'VMESS', entryNodeId: 'entry', entryPort: 24112, targetLineId: TARGET, paramsJson: '{}' } });
    await complete();
    expect((await row(OTHER)).stage).toBe('CONFIRMED');
    const other = await material(1, OTHER);
    const old = await material(1);
    await credentials.rotate(RELAY, 'operator'); await apply('entry');
    const landing = await apply('landing');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: 'review-user' } });
    expect(inbounds(landing).some(inbound => inboundUsesCredential(inbound, other))).toBe(true);
    expect(inbounds(landing).some(inbound => inboundUsesCredential(inbound, old))).toBe(false);
    expect(JSON.stringify(landing.singboxConfig)).toContain(user.uuid);
    await apply('entry');
    expect((await row()).stage).toBe('CONFIRMED');
  });
});
