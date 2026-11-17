import { ProbeResourceService } from './probe-resource.service';
import type { PrismaService } from '../prisma/prisma.service';
import { encryptSecret } from '../common/secret-crypto';
import { LineSpeedtestService } from '../lines/line-speedtest.service';
import { ProbeTaskService } from './probe-task.service';
import type { ProbeService } from './probe.service';
import type { SettingsService } from '../system/settings.service';
import type { ProbeConnectionRequest, ProbeTarget, ProbeResult } from './probe.types';

function setup() {
  const settings = new Map<string, string>([['lineSpeedtestUserId', 'probe-user'], ['enforceEmailVerification', 'true']]);
  const subscription = { id: 'sub', status: 'ACTIVE', expireAt: null as Date | null, trafficLimitBytes: 1000n, trafficUsedBytes: 1n, planSnapshotJson: null as string | null,
    user: { id: 'probe-user', uuid: 'legal-user-uuid', email: 'probe@example.com', password: 'legal-user-credential', role: 'USER', isActive: true, emailVerifiedAt: new Date(1) as Date | null, extraLineGrants: [] as Array<{ lineId: string }> },
    plan: { lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]' } };
  const line = { id: 'line', status: 'ACTIVE', type: 'DIRECT', protocolType: 'VLESS', paramsJson: '{}', tagsJson: '[]', isPublic: true,
    entryNode: { id: 'entry', serverHost: 'example.com', status: 'ONLINE' }, entryPort: 443, updatedAt: new Date(2) };
  const prisma = { line: { findUnique: jest.fn().mockResolvedValue(line), findMany: jest.fn().mockResolvedValue([line]), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    upstreamNode: { findUnique: jest.fn() },
    subscription: { findUnique: jest.fn().mockImplementation(async () => subscription) },
    systemSetting: { findMany: jest.fn().mockImplementation(async () => [...settings].map(([key, value]) => ({ key, value }))) }, $transaction: jest.fn() };
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
  const service = new ProbeResourceService(prisma as unknown as PrismaService);
  const sequence = service.reserve('LINE', ['line']);
  const snapshot = () => service.snapshot('LINE', 'line', sequence);
  return { service, prisma, subscription, settings, line, snapshot };
}
function measured(configHash: string): ProbeResult {
  return { schemaVersion: 2, subjectType: 'LINE', subjectId: 'line', status: 'SUCCESS', errorCode: null, message: 'URL_TEST_OK', engine: 'MIHOMO', engineVersion: '1.19.30', fallbackReason: null, mihomoCompatibility: 'SUPPORTED', measurement: 'MIHOMO_URL_TEST', perspective: 'MASTER', routeKind: 'MANAGED_DIRECT', targetId: 'target', targetHost: 'example.com', testedAt: new Date().toISOString(), durationMs: 20, latencyMs: 10, stage: 'DIAL_HTTP', configHash, applied: false };
}

describe('专用订阅拨测身份', () => {
  it('未配置账号时拒绝创建自建线路连接', async () => {
    const f = setup(); f.settings.delete('lineSpeedtestUserId');
    await expect(f.snapshot()).rejects.toMatchObject({ code: 'SPEEDTEST_USER_NOT_CONFIGURED' });
  });
  it('绑定已授权账号的真实 UUID', async () => {
    const f = setup(); const snapshot = (await f.snapshot())!;
    expect(snapshot.request.connection.params.uuid).toBe('legal-user-uuid');
  });
  it.each([undefined, 'shared'])('共享 Shadowsocks 模式 %s 无逐用户统计，不能创建合法账号拨测连接', async mode => {
    const f = setup(); f.line.protocolType = 'SHADOWSOCKS'; f.line.paramsJson = JSON.stringify({ method: 'aes-128-gcm', password: 'synthetic-shared-line-key', ...(mode ? { mode } : {}) });
    await expect(f.snapshot()).rejects.toMatchObject({ code: 'SPEEDTEST_LINE_UNMETERED' });
  });
  it('SS2022 多用户拨测实际绑定所选账号，不被共享模式限制误拒绝', async () => {
    const f = setup(); f.line.protocolType = 'SHADOWSOCKS'; f.line.paramsJson = JSON.stringify({ method: '2022-blake3-aes-128-gcm', mode: 'multi-user', password: Buffer.alloc(16, 1).toString('base64') });
    const first = (await f.snapshot())!.request.connection.params.password;
    f.subscription.user.uuid = 'another-legal-user-uuid'; f.subscription.user.password = 'another-legal-user-password';
    const second = (await f.snapshot())!.request.connection.params.password;
    expect(first).not.toBe(second);
  });
  it.each(['SOCKS', 'HTTP', 'MIXED'])('%s 历史 usersEnabled=false 与网关强制用户鉴权保持一致', async protocolType => {
    const f = setup(); f.line.protocolType = protocolType; f.line.paramsJson = JSON.stringify({ usersEnabled: false });
    const connection = (await f.snapshot())!.request.connection;
    expect(connection.params.password).toBe(f.subscription.user.password);
    expect(connection.params.username).toEqual(expect.any(String));
  });
  it('执行期间撤销订阅后禁止写入成功结果', async () => {
    const f = setup(); const snapshot = (await f.snapshot())!; f.subscription.status = 'REVOKED';
    await expect(f.service.persist(snapshot, measured(snapshot.request.configHash), new AbortController().signal)).resolves.toBe(false);
    expect(f.prisma.line.updateMany).not.toHaveBeenCalled();
  });
});


describe('订阅拨测资格与写回竞态', () => {
  it.each(['TROJAN', 'HYSTERIA2', 'TUIC', 'HTTP', 'NAIVE'])('%s 使用真实订阅密码', async (protocolType) => {
    const f = setup(); f.line.protocolType = protocolType;
    expect((await f.snapshot())!.request.connection.params.password).toBe(f.subscription.user.password);
  });
  it.each(['inactive', 'email', 'expired', 'quota', 'revoked', 'missing'] as const)('%s 身份不生成连接', async (failure) => {
    const f = setup();
    if (failure === 'inactive') f.subscription.user.isActive = false;
    if (failure === 'email') f.subscription.user.emailVerifiedAt = null;
    if (failure === 'expired') f.subscription.expireAt = new Date(1);
    if (failure === 'quota') f.subscription.trafficUsedBytes = f.subscription.trafficLimitBytes;
    if (failure === 'revoked') f.subscription.status = 'REVOKED';
    if (failure === 'missing') f.prisma.subscription.findUnique.mockResolvedValueOnce(null);
    await expect(f.snapshot()).rejects.toMatchObject({ code: 'SPEEDTEST_USER_UNAVAILABLE' });
  });
  it('缺少线路资格拒绝，显式额外授权可通过非公开线路', async () => {
    const f = setup(); f.line.isPublic = false;
    await expect(f.snapshot()).rejects.toMatchObject({ code: 'SPEEDTEST_LINE_UNAUTHORIZED' });
    f.subscription.user.extraLineGrants.push({ lineId: 'line' });
    expect((await f.snapshot())!.request.connection.params.uuid).toBe(f.subscription.user.uuid);
  });
  it('禁止全局停用的公开线路和排队期间切换账号', async () => {
    const f = setup(); f.settings.set('publicLinesEnabled', 'false');
    await expect(f.snapshot()).rejects.toMatchObject({ code: 'SPEEDTEST_LINE_UNAUTHORIZED' });
    f.settings.delete('publicLinesEnabled');
    await expect(f.service.snapshot('LINE', 'line', 1, undefined, 'MIHOMO_URL_TEST', 'old-account')).rejects.toMatchObject({ code: 'SPEEDTEST_IDENTITY_CHANGED' });
  });
  it.each(['selection', 'cleared', 'credential', 'uuid', 'email', 'inactive', 'quota', 'expiry', 'grants', 'plan', 'verification', 'public'] as const)('%s 执行中变更时拒绝写回', async (change) => {
    const f = setup(); const snapshot = (await f.snapshot())!;
    if (change === 'selection') f.settings.set('lineSpeedtestUserId', 'another-user');
    if (change === 'cleared') f.settings.delete('lineSpeedtestUserId');
    if (change === 'credential') f.subscription.user.password = 'new-secret';
    if (change === 'uuid') f.subscription.user.uuid = 'new-uuid';
    if (change === 'email') f.subscription.user.email = 'new@example.com';
    if (change === 'inactive') f.subscription.user.isActive = false;
    if (change === 'quota') f.subscription.trafficUsedBytes = f.subscription.trafficLimitBytes;
    if (change === 'expiry') f.subscription.expireAt = new Date(1);
    if (change === 'grants') f.subscription.user.extraLineGrants.push({ lineId: 'extra' });
    if (change === 'plan') { f.subscription.plan.lineMatchMode = 'EXPLICIT'; f.subscription.plan.lineIdsJson = '[]'; }
    if (change === 'verification') f.subscription.user.emailVerifiedAt = null;
    if (change === 'public') f.settings.set('publicLinesEnabled', 'false');
    expect(await f.service.persist(snapshot, measured(snapshot.request.configHash), new AbortController().signal)).toBe(false);
    expect(f.prisma.line.updateMany).not.toHaveBeenCalled();
  });
  it('正常计量增长不会使结果失效，结果不保存账号及凭据', async () => {
    const f = setup(); const snapshot = (await f.snapshot())!; f.subscription.trafficUsedBytes += 1n;
    expect(await f.service.persist(snapshot, measured(snapshot.request.configHash), new AbortController().signal)).toBe(true);
    const written = JSON.stringify(f.prisma.line.updateMany.mock.calls);
    for (const value of [f.subscription.user.uuid, f.subscription.user.password, f.subscription.user.email, 'probe-user', 'authorization']) expect(written).not.toContain(value);
  });
});

function taskSetup(f: ReturnType<typeof setup>, beforeResult = () => {}) {
  const engine = { executeBatch: jest.fn(async (requests: ProbeConnectionRequest[], target: ProbeTarget) => {
    beforeResult(); return requests.map((request) => ({ ...measured(request.configHash), targetId: target.id }));
  }), executeStrictBatch: jest.fn(async () => []) };
  const settings = { getSettings: jest.fn(async () => ({ lineSpeedtestUserId: f.settings.get('lineSpeedtestUserId') ?? null, lineSpeedtestTargetUrl: 'https://example.com/generate_204', lineSpeedtestTimeoutMs: 10000 })) };
  return { engine, tasks: new ProbeTaskService(f.service, engine as unknown as ProbeService, settings as unknown as SettingsService) };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
describe('手动与定时拨测异步流程', () => {
  it.each(['MIHOMO_URL_TEST', 'PROXY_HTTP_DELAY'] as const)('共享 Shadowsocks 在 %s 拨号前返回明确不可计量结果', async measurement => {
    const f = setup(); f.line.protocolType = 'SHADOWSOCKS'; f.line.paramsJson = JSON.stringify({ method: 'aes-128-gcm', mode: 'shared', password: 'synthetic-shared-line-key' });
    const { tasks, engine } = taskSetup(f);
    try {
      const receipt = await tasks.start('admin', 'LINE', { id: 'line' }, 'MIHOMO_ONLY', measurement);
      await tick();
      expect(tasks.results(receipt.taskId).data[0]).toMatchObject({ status: 'UNSUPPORTED', errorCode: 'SPEEDTEST_LINE_UNMETERED', applied: false, latencyMs: null });
      expect(engine.executeBatch).not.toHaveBeenCalled();
      expect(engine.executeStrictBatch).not.toHaveBeenCalled();
      expect(f.prisma.line.updateMany).not.toHaveBeenCalled();
    } finally { tasks.onModuleDestroy(); }
  });
  it.each(['admin', 'SYSTEM_LINE_SCHEDULER'])('%s 使用同一真实订阅资格和 Mihomo 流程', async (owner) => {
    const f = setup(); const { tasks, engine } = taskSetup(f);
    try {
      const receipt = await tasks.start(owner, 'LINE', owner === 'admin' ? { id: 'line' } : {});
      expect(receipt).toEqual({ taskId: expect.any(String), state: 'QUEUED', total: 1 });
      await tick();
      expect(engine.executeBatch).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ connection: expect.objectContaining({ params: { uuid: f.subscription.user.uuid } }) })]), expect.any(Object), 10000, 'MIHOMO_ONLY', expect.any(AbortSignal), expect.any(Function));
      expect(tasks.results(receipt.taskId).data[0]).toMatchObject({ status: 'SUCCESS', measurement: 'MIHOMO_URL_TEST', perspective: 'MASTER', applied: true });
    } finally { tasks.onModuleDestroy(); }
  });
  it('未配置账号仍返回异步任务，结果是安全、明确的不可测原因', async () => {
    const f = setup(); f.settings.clear(); const { tasks, engine } = taskSetup(f);
    try {
      const receipt = await tasks.start('admin', 'LINE', { id: 'line' }); expect(receipt.state).toBe('QUEUED');
      await tick();
      expect(tasks.results(receipt.taskId).data[0]).toMatchObject({ status: 'SKIPPED', errorCode: 'SPEEDTEST_USER_NOT_CONFIGURED', latencyMs: null, applied: false });
      expect(engine.executeBatch).not.toHaveBeenCalled();
    } finally { tasks.onModuleDestroy(); }
  });
  it('执行中撤权后的成功测量只能显示为 STALE', async () => {
    const f = setup(); const { tasks } = taskSetup(f, () => { f.subscription.status = 'REVOKED'; });
    try {
      const receipt = await tasks.start('admin', 'LINE', { id: 'line' }); await tick();
      expect(tasks.results(receipt.taskId).data[0]).toMatchObject({ status: 'STALE', latencyMs: null, applied: false });
      expect(f.prisma.line.updateMany).not.toHaveBeenCalled();
    } finally { tasks.onModuleDestroy(); }
  });
  it('切换账号不会复用原任务，排队任务不得借用新账号', async () => {
    const f = setup(); const { tasks, engine } = taskSetup(f);
    try {
      const first = await tasks.start('admin', 'LINE', { id: 'line' }); f.settings.set('lineSpeedtestUserId', 'new-user');
      const second = await tasks.start('admin', 'LINE', { id: 'line' }); expect(second.taskId).not.toBe(first.taskId);
      await tick();
      expect(tasks.results(first.taskId).data[0]).toMatchObject({ errorCode: 'SPEEDTEST_IDENTITY_CHANGED', applied: false });
      expect(engine.executeBatch).toHaveBeenCalledTimes(1);
    } finally { tasks.onModuleDestroy(); }
  });
});

describe('外部和上游线路隔离', () => {
  it.each(['UPSTREAM_NODE', 'LINE'] as const)('%s 外部资源不需要或读取拨测账号', async (type) => {
    const f = setup(); f.settings.clear();
    const upstream = { id: 'upstream', protocolType: 'TROJAN', paramsJson: encryptSecret('{"password":"upstream-password"}'), serverHost: 'example.com', serverPort: 443, status: 'ACTIVE', presenceStatus: 'PRESENT', subscriptionId: 'source', configHash: 'cfg', connectionHash: 'conn', updatedAt: new Date(2), subscription: { id: 'source', status: 'ACTIVE', updatedAt: new Date(1), userInfoUsedBytes: null, userInfoTotalBytes: null, userInfoExpireAt: null } };
    f.prisma.upstreamNode.findUnique.mockResolvedValue(upstream);
    Object.assign(f.line, { type: 'EXTERNAL', upstreamNode: upstream });
    const snapshot = (await f.service.snapshot(type, type === 'LINE' ? 'line' : 'upstream', 1))!;
    expect(snapshot.request.connection.params.password).toBe('upstream-password');
    expect(snapshot.request.routeKind).toBe('UPSTREAM_DIRECT');
    expect(snapshot.authorization).toBeUndefined();
    expect(f.prisma.systemSetting.findMany).not.toHaveBeenCalled();
    expect(f.prisma.subscription.findUnique).not.toHaveBeenCalled();
  });
});

it('托管线路遗留参数不能覆盖专用订阅认证身份', async () => {
  const f = setup(); f.line.protocolType = 'TUIC'; f.line.paramsJson = JSON.stringify({ uuid: 'obsolete-static-uuid', password: 'obsolete-static-password' });
  const snapshot = (await f.snapshot())!;
  expect(snapshot.request.connection.params).toMatchObject({ uuid: f.subscription.user.uuid, password: f.subscription.user.password });
});

it('写回通过同一事务读取最新权益，而非事务外的有效账号快照', async () => {
  const f = setup(); const snapshot = (await f.snapshot())!;
  const tx = { ...f.prisma, subscription: { findUnique: jest.fn().mockResolvedValue({ ...f.subscription, status: 'REVOKED' }) } };
  f.prisma.$transaction.mockImplementation(async (callback) => callback(tx));
  expect(await f.service.persist(snapshot, measured(snapshot.request.configHash), new AbortController().signal)).toBe(false);
  expect(tx.subscription.findUnique).toHaveBeenCalled();
  expect(f.prisma.line.updateMany).not.toHaveBeenCalled();
});
it('定时服务实际触发相同订阅身份拨测流程', async () => {
  jest.useFakeTimers();
  const f = setup(); const { tasks, engine } = taskSetup(f);
  const scheduleSettings = { getSettings: jest.fn().mockResolvedValue({ lineSpeedtestEnabled: true, lineSpeedtestIntervalMins: 1 }) };
  const scheduler = new LineSpeedtestService(tasks, scheduleSettings as unknown as SettingsService);
  const start = jest.spyOn(tasks, 'start');
  try {
    scheduler.onModuleInit(); await jest.advanceTimersByTimeAsync(60_010);
    expect(start).toHaveBeenCalledWith('SYSTEM_LINE_SCHEDULER', 'LINE', {});
    expect(engine.executeBatch.mock.calls[0][0][0].connection.params.uuid).toBe(f.subscription.user.uuid);
    expect(f.prisma.line.updateMany).toHaveBeenCalled();
  } finally { scheduler.onModuleDestroy(); tasks.onModuleDestroy(); jest.useRealTimers(); }
});
