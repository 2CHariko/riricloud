import { ConflictException, BadRequestException, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AgentService } from '../agent-gateway/agent.service';
import { CertificatesService } from './certificates.service';
import { CertificatesController } from './certificates.controller';
import { CertificateBindingsService } from './certificate-bindings.service';
import { CertificateTrackingService } from './certificate-tracking.service';
import { CertificateRemindersService, reminderStage } from './certificate-reminders.service';
import { certificateFixture } from './certificate-fixture';
import { parseCertificateChain } from './certificate-validation';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret } from '../common/secret-crypto';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { JwtStrategy } from '../auth/jwt.strategy';
import { LinesService } from '../lines/lines.service';
import { getJwtSecret } from '../common/runtime-config';
import type { ConfigSyncData, HeartbeatData } from '../agent-gateway/agent-message';

// 隔离 SQLite 执行全量迁移，覆盖真实版本事务、外键及 HTTP 契约，不访问开发库。
describe('手动证书生命周期与轻量 E2E', () => {
  jest.setTimeout(120_000);
  let dir: string, prisma: PrismaClient, service: CertificatesService, bindings: CertificateBindingsService, tracking: CertificateTrackingService, agent: AgentService, app: INestApplication, base: string;
  let adminToken: string, userToken: string;
  const originalJwtSecret = process.env.JWT_SECRET;
  const logs = { enqueue: jest.fn() };
  const settings = { certificateExpiryWarningDays: 30, certificateMailEnabled: false, certificateMailRecipients: ['admin@example.com'], smtpEnabled: true, systemTimezone: 'Asia/Shanghai' };
  const settingsService = { getSettings: jest.fn(async () => settings) };
  const mail = { sendCertificateSummary: jest.fn() };
  const first = certificateFixture({ sans: ['example.com', '*.example.net', '127.0.0.1'] });
  const second = certificateFixture({ sans: ['example.com', '*.example.net', '127.0.0.1'], to: new Date(Date.now() + 120 * 86400_000) });
  const expired = certificateFixture({ from: new Date(Date.now() - 86400_000 * 3), to: new Date(Date.now() - 86400_000) });
  const heartbeat: HeartbeatData = { protocolVersion: 2, cpuUsage: 0, memoryUsage: 0, bandwidthRate: 0, trafficSnapshots: [], kernelRunning: true };

  beforeAll(async () => {
    process.env.JWT_SECRET = randomBytes(32).toString('hex');
    dir = await mkdtemp(join(tmpdir(), 'riricloud-certificates-'));
    // 单连接让历史迁移的 PRAGMA/DROP/RENAME 共用连接，避免不同平台池大小影响。
    const databaseUrl = 'file:' + join(dir, 'test.db').replaceAll('\\', '/') + '?connection_limit=1';
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$connect();
    const migrations = join(__dirname, '../../prisma/migrations');
    for (const name of (await readdir(migrations)).sort()) {
      if (name.endsWith('.toml')) continue;
      const sql = await readFile(join(migrations, name, 'migration.sql'), 'utf8');
      for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await prisma.$executeRawUnsafe(statement);
    }
    await prisma.node.createMany({ data: [
      { id: 'entry', name: '入口', serverHost: 'example.com', agentToken: 'entry-token' },
      { id: 'landing', name: '落地', serverHost: 'example.com', agentToken: 'landing-token', communicationMode: 'HTTP', pollIntervalSecs: 60 }
    ] });
    const admin = await prisma.user.create({ data: { email: 'admin@example.com', passwordHash: 'unused', role: 'ADMIN' } });
    const user = await prisma.user.create({ data: { email: 'user@example.com', passwordHash: 'unused', role: 'USER' } });
    const jwt = new JwtService({ secret: getJwtSecret() });
    adminToken = jwt.sign({ sub: admin.id, email: admin.email, role: admin.role });
    userToken = jwt.sign({ sub: user.id, email: user.email, role: user.role });
    bindings = new CertificateBindingsService(prisma as never);
    tracking = new CertificateTrackingService(prisma as never, logs as never);
    agent = new AgentService(prisma as never, undefined, undefined, undefined, undefined, tracking);
    service = new CertificatesService(prisma as never, agent, bindings, settingsService as never, logs as never);
    const module = await Test.createTestingModule({ controllers: [CertificatesController], providers: [
      { provide: PrismaService, useValue: prisma }, { provide: CertificatesService, useValue: service }, JwtStrategy
    ] }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalGuards(new JwtAuthGuard(app.get(Reflector)));
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()) + '/api/v1/admin/certificates';
  });
  beforeEach(async () => {
    await prisma.line.updateMany({ data: { targetLineId: null } });
    await prisma.line.deleteMany(); await prisma.certificate.deleteMany(); await prisma.certificateConfigSnapshot.deleteMany();
    await prisma.systemSetting.deleteMany({ where: { key: { startsWith: 'certificateReminderDaily:' } } });
    await prisma.node.updateMany({ data: { configOverride: null, status: 'OFFLINE' } });
    logs.enqueue.mockClear(); mail.sendCertificateSummary.mockReset();
    settings.certificateMailEnabled = false;
  });
  afterAll(async () => {
    await app?.close(); await agent?.onModuleDestroy(); await prisma?.$disconnect();
    if (dir) await rm(dir, { recursive: true, force: true });
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });
  const create = (fixture = first) => service.create({ name: '测试证书', certificatePem: fixture.certificatePem, privateKeyPem: fixture.privateKeyPem });
  async function bind(id: string, extra: Record<string, unknown> = {}) {
    return prisma.line.create({ data: { name: '测试线路', entryNodeId: 'entry', entryPort: 443, certificateId: id, paramsJson: '{"tls":{"mode":"tls","enabled":true,"serverName":"example.com"}}', ...extra } });
  }
  async function request(path = '', method = 'GET', body?: unknown, token = adminToken) {
    return fetch(base + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  function config(id: string, version: number, pem = first.certificatePem, key = first.privateKeyPem): ConfigSyncData {
    return { version, singboxConfig: { inbounds: [{ tag: 'line-' + id, tls: { certificate: [pem], key: [key] } }] } } as ConfigSyncData;
  }

  it('解析链、匹配私钥、提示重复且仍可创建；列表与历史无秘密', async () => {
    const { certificate } = await create();
    expect((await service.parse(first)).privateKeyMatched).toBe(true);
    expect((await service.parse(first)).duplicates).toEqual([{ id: certificate.id, name: certificate.name }]);
    await expect(service.parse({ certificatePem: first.certificatePem, privateKeyPem: second.privateKeyPem })).rejects.toThrow(BadRequestException);
    await create();
    expect((await service.list({})).total).toBe(2);
    expect(JSON.stringify(await service.revisions(certificate.id, {}))).not.toContain('PRIVATE KEY');
    expect((await prisma.certificateRevision.findFirstOrThrow()).privateKeyPem).toMatch(/^enc:v1:/);
    expect(certificate).not.toHaveProperty('certificatePem');
  });
  it('改名/相同内容无新修订或推送，替换校验全部关联并可整体回滚', async () => {
    const { certificate } = await create(); await bind(certificate.id);
    const push = jest.spyOn(agent, 'pushConfig').mockResolvedValue(true);
    expect((await service.update(certificate.id, { name: '改名', expectedRevision: 1 })).contentChanged).toBe(false);
    expect((await service.update(certificate.id, { ...first, expectedRevision: 1 })).certificate.currentRevision).toBe(1);
    expect(push).not.toHaveBeenCalled();
    const result = await service.update(certificate.id, { ...second, expectedRevision: 1 });
    expect(result.certificate.currentRevision).toBe(2); expect(result.affectedNodeIds).toEqual(['entry']);
    expect((await service.rollback(certificate.id, 1, 2)).certificate.currentRevision).toBe(3);
    await expect(service.update(certificate.id, { name: 'stale', expectedRevision: 2 })).rejects.toThrow(ConflictException);
    push.mockRestore();
  });
  it('并发替换只有一个成功且另一请求返回 409，保留当前及十个历史版本', async () => {
    const { certificate } = await create();
    const results = await Promise.allSettled([service.update(certificate.id, { ...second, expectedRevision: 1 }), service.update(certificate.id, { ...expired, expectedRevision: 1 })]);
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(row => row.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    for (let index = 0; index < 12; index++) await service.update(certificate.id, index % 2 ? first : second);
    const revisions = await service.revisions(certificate.id, {});
    expect(revisions.total).toBe(11);
    expect(revisions.data[0].revision - revisions.data[10].revision).toBe(10);
  });
  it('过期/未来可保存，但拒绝新绑定、替换和不合格历史回滚；删除引用返回409', async () => {
    const { certificate } = await create(expired);
    await expect(bindings.assertLine({ certificateId: certificate.id, entryNodeId: 'entry' })).rejects.toThrow();
    await service.update(certificate.id, second); await bind(certificate.id);
    await expect(service.rollback(certificate.id, 1, 2)).rejects.toThrow();
    await expect(service.remove(certificate.id)).rejects.toThrow(ConflictException);
    await expect(service.update(certificate.id, expired)).rejects.toThrow();
    const future = certificateFixture({ from: new Date(Date.now() + 86400_000) });
    expect((await create(future)).certificate.status).toBe('NOT_YET_VALID');
  });
  it('实际 SNI、域名端点回退、IP SAN、协议代理和桥接均检查覆盖', async () => {
    const { certificate } = await create();
    await expect(bindings.assertLine({ certificateId: certificate.id, entryNodeId: 'entry' })).resolves.toBeUndefined();
    await expect(bindings.assertLine({ certificateId: certificate.id, entryNodeId: 'entry', endpointOverrideEnabled: true, serverHost: '127.0.0.1' })).resolves.toBeUndefined();
    await expect(bindings.assertLine({ certificateId: certificate.id, entryNodeId: 'entry', paramsJson: '{"tls":{"serverName":"wrong.com"}}' })).rejects.toThrow();
    const target = await bind(certificate.id);
    await bind(certificate.id, { type: 'RELAY', relayMode: 'PROTOCOL_PROXY', landingNodeId: 'landing', landingPort: 8443 });
    await bind(certificate.id, { type: 'RELAY', relayMode: 'TARGET_LINE', targetLineId: target.id });
    const lines = await service.associatedLines(certificate.id, {});
    expect(lines.data.some(row => row.hostingNodeIds.length === 2)).toBe(true);
    await prisma.line.update({ where: { id: target.id }, data: { endpointOverrideEnabled: true, serverName: 'wrong.com' } });
    await expect(service.update(certificate.id, second)).rejects.toThrow();
    await prisma.line.updateMany({ data: { status: 'DISABLED' } });
    await expect(service.update(certificate.id, { name: '可改名称' })).resolves.toBeDefined();
  });
  it('历史异常惰性初始化幂等，不推送、不改变内容，详情保留异常标志', async () => {
    const parsed = parseCertificateChain(first.certificatePem);
    const legacy = await prisma.certificate.create({ data: { name: 'legacy', certificatePem: 'invalid', privateKeyPem: first.privateKeyPem, subject: parsed.subject, issuer: parsed.issuer, serialNumber: parsed.serialNumber, sansJson: '[]', validFrom: parsed.validFrom, validTo: parsed.validTo } });
    await service.detail(legacy.id); await service.list({});
    expect((await service.detail(legacy.id)).certificate.chainValidation).toBe('INVALID');
    expect((await service.revisions(legacy.id, {})).total).toBe(1);
    expect((await prisma.certificate.findUniqueOrThrow({ where: { id: legacy.id } })).certificatePem).toBe('invalid');
  });
  it('历史私钥不匹配时首次列表立即显示异常，并保持初始修订幂等', async () => {
    const { certificate } = await create();
    await prisma.certificateRevision.deleteMany({ where: { certificateId: certificate.id } });
    await prisma.certificate.update({ where: { id: certificate.id }, data: { validationJson: null, contentHash: null, privateKeyPem: second.privateKeyPem } });
    expect((await service.list({})).data[0].chainValidation).toBe('INVALID');
    expect((await service.revisions(certificate.id, {})).total).toBe(1);
    expect((await service.summary()).invalid).toBe(1);
  });
  it('历史异常线路可改名/停用/解除关联，但启用和复制必须重新校验', async () => {
    const { certificate } = await create(expired); const line = await bind(certificate.id);
    const gateway = { pushConfigToAll: jest.fn().mockResolvedValue(0) };
    const lines = new LinesService(prisma as never, gateway as never, undefined, bindings);
    await expect(lines.update(line.id, { name: '历史异常仅改名' })).resolves.toBeDefined();
    await expect(lines.batchStatus({ ids: [line.id], status: 'DISABLED' })).resolves.toBeDefined();
    await expect(lines.batchStatus({ ids: [line.id], status: 'ACTIVE' })).rejects.toThrow();
    await expect(lines.duplicate(line.id)).rejects.toThrow();
    await expect(lines.update(line.id, { certificateId: null, params: { tls: { mode: 'none', enabled: false } } })).resolves.toBeDefined();
  });
  it('分页超过100条可搜索选择，状态与关联筛选正确', async () => {
    const { certificate } = await create();
    const original = await prisma.certificate.findUniqueOrThrow({ where: { id: certificate.id } });
    const { id: _id, createdAt: _created, updatedAt: _updated, ...data } = original;
    await prisma.certificate.createMany({ data: Array.from({ length: 105 }, (_, index) => ({ ...data, name: 'certificate-' + String(index).padStart(3, '0') })) });
    expect((await service.list({ page: 6 })).data.length).toBe(6);
    expect((await service.list({ search: 'certificate-104' })).data[0].name).toBe('certificate-104');
    await bind(certificate.id);
    expect((await service.list({ association: 'linked', status: 'VALID' })).total).toBe(1);
    const query = jest.spyOn(prisma.line, 'findMany');
    expect((await service.summary()).total).toBe(106);
    expect(query).toHaveBeenCalledTimes(1);
    query.mockRestore();
  });
  it('追踪配置接受与运行确认，旧回执隔离，超时后迟到确认，重建服务继续对账', async () => {
    const { certificate } = await create(); const line = await bind(certificate.id);
    await tracking.capture('entry', config(line.id, 10)); await tracking.sent('entry', 10);
    await tracking.accepted('entry', { version: 10, success: true, message: 'accepted' });
    expect((await service.deployments(certificate.id, {})).data[0].state).toBe('ACCEPTED');
    await tracking.heartbeat('entry', { ...heartbeat, appliedConfigVersion: 10, kernelRunning: false });
    expect((await service.deployments(certificate.id, {})).data[0].state).toBe('FAILED');
    await tracking.capture('entry', config(line.id, 11)); await tracking.sent('entry', 11);
    await tracking.accepted('entry', { version: 10, success: false, message: 'old' });
    await prisma.certificateDeployment.updateMany({ data: { sentAt: new Date(Date.now() - 121_000) } });
    expect((await service.deployments(certificate.id, {})).data[0].state).toBe('TIMEOUT');
    await new CertificateTrackingService(prisma as never).heartbeat('entry', { ...heartbeat, appliedConfigVersion: 11 });
    expect((await service.deployments(certificate.id, {})).data[0].state).toBe('CONFIRMED');
    await tracking.accepted('entry', { version: 11, success: true, message: 'late' });
    expect((await service.deployments(certificate.id, {})).data[0].state).toBe('CONFIRMED');
  });
  it('HTTP 超时至少三轮询周期，同修订配置推进可重新确认，旧快照不能覆盖新修订', async () => {
    const { certificate } = await create(); const line = await bind(certificate.id, { entryNodeId: 'landing' });
    await tracking.capture('landing', config(line.id, 20)); await tracking.sent('landing', 20);
    await prisma.certificateDeployment.updateMany({ data: { sentAt: new Date(Date.now() - 121_000) } });
    expect((await service.deployments(certificate.id, {})).data[0].state).toBe('SENT');
    await prisma.certificateDeployment.updateMany({ data: { sentAt: new Date(Date.now() - 181_000) } });
    expect((await service.deployments(certificate.id, {})).data[0].state).toBe('TIMEOUT');
    await tracking.heartbeat('landing', { ...heartbeat, appliedConfigVersion: 20 });
    await tracking.capture('landing', config(line.id, 21)); await tracking.sent('landing', 21);
    await tracking.heartbeat('landing', { ...heartbeat, appliedConfigVersion: 20 });
    expect((await service.deployments(certificate.id, {})).data[0].state).toBe('SENT');
    await tracking.heartbeat('landing', { ...heartbeat, appliedConfigVersion: 21 });
    expect((await service.deployments(certificate.id, {})).data[0].state).toBe('CONFIRMED');
    await service.update(certificate.id, second);
    await tracking.heartbeat('landing', { ...heartbeat, appliedConfigVersion: 21 });
    expect((await service.deployments(certificate.id, {})).data[0].state).toBe('WAITING');
    expect((await service.deployments(certificate.id, {})).data.some(row => row.state === 'SUPERSEDED')).toBe(true);
  });
  it('高级配置替换证书/私钥或移除入站，标记未控制；盲转发入口不误判', async () => {
    const { certificate } = await create(); const line = await bind(certificate.id);
    await tracking.capture('entry', config(line.id, 1, first.certificatePem, second.privateKeyPem));
    expect((await service.deployments(certificate.id, {})).data[0].state).toBe('UNMANAGED');
    await prisma.line.update({ where: { id: line.id }, data: { type: 'RELAY', relayMode: 'BLIND_FORWARD', landingNodeId: 'landing', landingPort: 8443 } });
    await tracking.capture('entry', { version: 2, singboxConfig: { inbounds: [] } } as ConfigSyncData);
    expect((await prisma.certificateConfigSnapshot.findUniqueOrThrow({ where: { nodeId_configVersion: { nodeId: 'entry', configVersion: 2 } } })).dependenciesJson).toBe('[]');
  });
  it('HTTP 实际返回配置才计发送；WS 发送、旧Agent无法确认、离线重连后可运行确认', async () => {
    const { certificate } = await create(); const line = await bind(certificate.id, { entryNodeId: 'landing' });
    await agent.pushConfig('landing');
    expect((await service.deployments(certificate.id, {})).data[0].state).toBe('WAITING');
    const poll = await agent.poll('landing-token', { ...heartbeat, appliedConfigVersion: 0 });
    expect(poll.singboxConfig).toBeDefined();
    expect((await service.deployments(certificate.id, {})).data[0].state).toBe('SENT');
    await agent.poll('landing-token', { ...heartbeat, appliedConfigVersion: poll.version });
    expect((await service.deployments(certificate.id, {})).data[0].state).toBe('CONFIRMED');
    await prisma.line.update({ where: { id: line.id }, data: { entryNodeId: 'entry' } });
    const sent: ConfigSyncData[] = [];
    await agent.register('entry', { send: data => { const message = JSON.parse(String(data)) as { type: string; data: ConfigSyncData }; if (message.type === 'config_sync') sent.push(message.data); }, close: () => {} });
    await agent.pushConfig('entry');
    expect(sent.length).toBeGreaterThan(0);
    await agent.handleHeartbeat('entry', { protocolVersion: 2, cpuUsage: 0, memoryUsage: 0, bandwidthRate: 0, trafficSnapshots: [] });
    expect((await service.deployments(certificate.id, {})).data.find(row => row.nodeId === 'entry')?.state).toBe('UNCONFIRMED');
    await agent.handleHeartbeat('entry', { ...heartbeat, appliedConfigVersion: sent.at(-1)!.version });
    expect((await service.deployments(certificate.id, {})).data.find(row => row.nodeId === 'entry')?.state).toBe('CONFIRMED');
  });
  it('提醒阶段边界、时区日去重、六小时失败重试与续期失效', async () => {
    expect([31, 30, 8, 7, 2, 1, 0, -1].map(days => reminderStage(days, 30))).toEqual([null, 'THRESHOLD', 'THRESHOLD', 'SEVEN_DAYS', 'SEVEN_DAYS', 'ONE_DAY', 'EXPIRED', 'EXPIRED']);
    const { certificate } = await create(expired); settings.certificateMailEnabled = true;
    const reminders = new CertificateRemindersService(prisma as never, settingsService as never, mail as never, service);
    mail.sendCertificateSummary.mockRejectedValueOnce(new Error('smtp unavailable'));
    await reminders.check(); await reminders.check(); expect(mail.sendCertificateSummary).toHaveBeenCalledTimes(1);
    await prisma.certificateReminder.updateMany({ data: { attemptedAt: new Date(Date.now() - 6 * 3600_000 - 1000) } });
    mail.sendCertificateSummary.mockResolvedValue({}); await reminders.check(); await reminders.check();
    expect(mail.sendCertificateSummary).toHaveBeenCalledTimes(2);
    const record = await prisma.certificateReminder.findFirstOrThrow();
    expect(record.sentDay).toBe(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()));
    await service.update(certificate.id, second); await reminders.check(); expect(mail.sendCertificateSummary).toHaveBeenCalledTimes(2);
    await reminders.onModuleDestroy();
  });
  it('管理员 HTTP 替换/回滚带修订，导出 no-store，非管理员拒绝，审计无秘密', async () => {
    const created = await request('', 'POST', { name: 'api', certificatePem: first.certificatePem, privateKeyPem: first.privateKeyPem });
    expect(created.status).toBe(201); const { certificate } = await created.json() as { certificate: { id: string } };
    const updated = await request('/' + certificate.id, 'PATCH', { certificatePem: second.certificatePem, privateKeyPem: second.privateKeyPem, expectedRevision: 1 });
    expect(updated.status).toBe(200);
    const rollback = await request('/' + certificate.id + '/rollback', 'POST', { revision: 1, expectedRevision: 2 });
    expect(rollback.status).toBe(201);
    expect((await request('/' + certificate.id, 'PATCH', { certificatePem: second.certificatePem, privateKeyPem: second.privateKeyPem, expectedRevision: 1 })).status).toBe(409);
    for (const format of ['leaf', 'fullchain', 'private-key', 'bundle']) {
      const response = await request('/' + certificate.id + '/export', 'POST', { format });
      expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('no-store');
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
      expect((await request('/' + certificate.id + '/export', 'POST', { format }, userToken)).status).toBe(403);
    }
    expect((await request('/summary', 'GET', undefined, userToken)).status).toBe(403);
    expect((await request('/' + certificate.id + '?publicOnly=true')).status).toBe(200);
    const text = JSON.stringify(logs.enqueue.mock.calls); expect(text).not.toContain('PRIVATE KEY'); expect(text).not.toContain('BEGIN CERTIFICATE');
    expect(decryptSecret((await prisma.certificate.findUniqueOrThrow({ where: { id: certificate.id } })).privateKeyPem)).toBe(first.privateKeyPem.trim());
  });
  it('删除已提醒证书及重建巡检服务后，收件人同一天不会再次收到汇总', async () => {
    settings.certificateMailEnabled = true;
    const short = certificateFixture({ to: new Date(Date.now() + 6 * 86400_000) });
    const { certificate } = await create(short);
    const reminders = new CertificateRemindersService(prisma as never, settingsService as never, mail as never, service);
    await reminders.check();
    expect(mail.sendCertificateSummary).toHaveBeenCalledTimes(1);
    await service.remove(certificate.id);
    await create(short);
    await reminders.onModuleDestroy();
    const restarted = new CertificateRemindersService(prisma as never, settingsService as never, mail as never, service);
    await restarted.check();
    expect(mail.sendCertificateSummary).toHaveBeenCalledTimes(1);
    await restarted.onModuleDestroy();
  });
  it('损坏密钥的读取和导出记录失败，公开证书导出仍可用且审计不含秘密', async () => {
    const { certificate } = await create();
    await prisma.certificate.update({ where: { id: certificate.id }, data: { privateKeyPem: 'enc:v1:invalid' } });
    logs.enqueue.mockClear();
    await expect(service.detail(certificate.id, 'operator')).rejects.toThrow();
    await expect(service.export(certificate.id, 'private-key', 'operator')).rejects.toThrow();
    expect(logs.enqueue.mock.calls.map(([entry]) => entry.metadata)).toEqual([
      expect.objectContaining({ event: 'PRIVATE_KEY_READ', result: 'FAILED', revision: 1 }),
      expect.objectContaining({ event: 'EXPORT_PRIVATE-KEY', result: 'FAILED', revision: 1 })
    ]);
    expect((await service.export(certificate.id, 'leaf', 'operator')).content.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs.enqueue.mock.calls)).not.toContain(first.privateKeyPem);
  });
});
