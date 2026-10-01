import { encryptSecret } from '../common/secret-crypto';
import { ProxyPoolAccessService } from './proxy-pool-access.service';
import { parseProxyLineUsername } from '../proxy-pool/proxy-key.util';
import { lineProbeVersion } from '../probe/probe-resource.service';

const id = (n: number) => `11111111-1111-4111-8111-${n.toString(16).padStart(12, '0')}`;
const key = (n = 1, userId = 'user') => ({ id: id(n), userId, username: `pk_${n.toString(16).padStart(24, '0')}`, password: 'key-secret', whitelistIps: '', isActive: true, createdAt: new Date(n) });
const line = (n = 1, overrides: Record<string, unknown> = {}) => ({
  id: id(n), name: 'Mixed', type: 'DIRECT', protocolType: 'MIXED', proxyPoolEnabled: true, status: 'ACTIVE', isPublic: true,
  paramsJson: '{}', entryPort: 1080, tagsJson: '["HK"]', trafficRate: 1, certificateId: null,
  endpointOverrideEnabled: false, lastLatencyMs: null, lastProbeJson: null, lastTestStatus: null, lastTestedAt: null,
  createdAt: new Date(n), entryNode: { id: 'node', name: 'Node', status: 'OFFLINE', serverHost: '2001:db8::1', reachability: 'PUBLIC' }, ...overrides
});
const subscription = (overrides: Record<string, unknown> = {}) => ({
  status: 'ACTIVE', trafficLimitBytes: 10n, trafficUsedBytes: 0n, expireAt: null,
  plan: { lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]' },
  user: { id: 'user', isActive: true, role: 'USER', emailVerifiedAt: null, extraLineGrants: [] }, ...overrides
});

describe('ProxyPoolAccessService policy', () => {
  const prisma = { subscription: { findMany: jest.fn() }, proxyKey: { findMany: jest.fn() }, line: { findMany: jest.fn() } };
  const settings = { getSettings: jest.fn() };
  let service: ProxyPoolAccessService;
  beforeEach(() => {
    jest.resetAllMocks();
    settings.getSettings.mockResolvedValue({ publicLinesEnabled: true, enforceEmailVerification: false });
    prisma.subscription.findMany.mockResolvedValue([subscription()]);
    prisma.proxyKey.findMany.mockResolvedValue([key()]);
    prisma.line.findMany.mockResolvedValue([line()]);
    service = new ProxyPoolAccessService(prisma as never, settings as never);
  });

  it('offline 可用、派生绑定精确 lineId、安全 endpoint 不含秘密', async () => {
    prisma.line.findMany.mockResolvedValue([line(1, { paramsJson: '{"password":"line-secret"}', tunnelSecret: 'tunnel-secret' })]);
    const snapshot = await service.getSnapshot();
    expect(snapshot.endpointsByKey.get(id(1))?.[0]).toMatchObject({ online: false, status: 'AVAILABLE', trafficRate: 1, supportedProtocols: ['http', 'socks5'] });
    expect(JSON.stringify(snapshot.endpoints)).not.toMatch(/secret|paramsJson|password|username|tunnelSecret/);
    const [binding] = snapshot.bindingsByNode.get('node')!;
    expect(parseProxyLineUsername(binding.username)).toEqual({ rawCredential: key().username, lineId: id(1) });
    expect(await service.getNodeBindings('missing')).toEqual([]);
    expect(prisma.line.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));
  });

  it('旧延迟不能冒充成功，证书版本改变失效新测量', async () => {
    const resource = { ...line(1, { certificateId: 'cert', lastLatencyMs: 99, lastTestStatus: 'SUCCESS' }), lastProbeJson: null as string | null, certificate: { id: 'cert', updatedAt: new Date(1) } };
    prisma.line.findMany.mockResolvedValue([resource]);
    expect((await service.getSnapshot()).endpoints[0].latencyMs).toBeNull();
    const measured = { schemaVersion: 1, subjectType: 'LINE', subjectId: resource.id, status: 'SUCCESS', measurement: 'PROXY_HTTP_DELAY', perspective: 'MASTER', routeKind: 'MANAGED_DIRECT', stage: 'DIAL_HTTP', engine: 'MIHOMO', mihomoCompatibility: 'SUPPORTED', testedAt: new Date().toISOString(), durationMs: 10, latencyMs: 10, configHash: lineProbeVersion(resource as never) };
    resource.lastProbeJson = JSON.stringify(measured);
    expect((await service.getSnapshot()).endpoints[0].latencyMs).toBe(10);
    (resource.certificate as { updatedAt: Date }).updatedAt = new Date(2);
    expect((await service.getSnapshot()).endpoints[0]).toMatchObject({ latencyMs: null, lastProbe: { status: 'STALE' } });
  });
  it.each([
    { status: 'EXPIRED' }, { status: 'REVOKED' }, { trafficUsedBytes: 10n }, { trafficLimitBytes: 0n },
    { expireAt: new Date(0) }, { plan: null }, { user: { ...subscription().user, isActive: false } }
  ])('无资格 fail closed %p', async (overrides) => {
    prisma.subscription.findMany.mockResolvedValue([subscription(overrides)]);
    const snapshot = await service.getSnapshot();
    expect(snapshot.eligibleUserIds.size).toBe(0);
    expect(snapshot.bindingsByNode.size).toBe(0);
  });

  it('CANCELED保留权益，邮箱策略允许ADMIN但拒绝未验证USER', async () => {
    settings.getSettings.mockResolvedValue({ publicLinesEnabled: true, enforceEmailVerification: true });
    expect(await service.getNodeBindings('node')).toEqual([]);
    prisma.subscription.findMany.mockResolvedValue([subscription({ status: 'CANCELED', user: { ...subscription().user, role: 'ADMIN' } })]);
    expect(await service.getNodeBindings('node')).toHaveLength(1);
  });

  it('套餐 EXPLICIT/TAGS/ALL 与额外私有授权复用，不泄露其他私有线路', async () => {
    prisma.line.findMany.mockResolvedValue([line(1), line(2, { isPublic: false }), line(3, { isPublic: false })]);
    prisma.subscription.findMany.mockResolvedValue([subscription({ plan: { lineMatchMode: 'EXPLICIT', lineIdsJson: JSON.stringify([id(1)]), lineTagsJson: '[]' }, user: { ...subscription().user, extraLineGrants: [{ lineId: id(2) }] } })]);
    expect((await service.getSnapshot()).endpointsByKey.get(id(1))?.map((e) => e.lineId)).toEqual([id(1), id(2)]);
    prisma.subscription.findMany.mockResolvedValue([subscription({ plan: { lineMatchMode: 'TAGS', lineIdsJson: '[]', lineTagsJson: '["JP"]' } })]);
    expect(await service.getNodeBindings('node')).toEqual([]);
  });

  it('applyPlanSnapshot冻结授权规则', async () => {
    prisma.subscription.findMany.mockResolvedValue([subscription({ planSnapshotJson: JSON.stringify({ name: 'snapshot', trafficLimitBytes: '10', lineMatchMode: 'EXPLICIT', lineTagsJson: '[]', lineIdsJson: '[]' }) })]);
    expect(await service.getNodeBindings('node')).toEqual([]);
  });

  it('512/513稳定按Key-Line分配且无资格Key不占容量', async () => {
    prisma.proxyKey.findMany.mockResolvedValue([key(0, 'ineligible'), ...Array.from({ length: 513 }, (_, i) => key(i + 1))]);
    const snapshot = await service.getSnapshot();
    const bindings = snapshot.bindingsByNode.get('node')!;
    expect(bindings).toHaveLength(512);
    expect(bindings[511].keyId).toBe(id(512));
    expect(snapshot.endpointsByKey.get(id(513))?.[0].status).toBe('CAPACITY_EXCLUDED');
    expect(snapshot.nodeCapacities).toEqual([{ nodeId: 'node', nodeName: 'Node', used: 512, limit: 512, excluded: 1 }]);
    expect(prisma.proxyKey.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.subscription.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.line.findMany).toHaveBeenCalledTimes(1);
  });

  it('同一Key多个Line计多个绑定，TLS只允许HTTP', async () => {
    prisma.line.findMany.mockResolvedValue([line(1), line(2, { certificateId: 'cert' })]);
    const snapshot = await service.getSnapshot();
    expect(snapshot.bindingsByNode.get('node')).toHaveLength(2);
    expect(snapshot.endpointsByKey.get(id(1))?.[1].supportedProtocols).toEqual(['http']);
  });

  it('容量按Key再Line顺序，撤销资格后下一次读取立即释放容量', async () => {
    prisma.line.findMany.mockResolvedValue([line(1), line(2)]);
    prisma.proxyKey.findMany.mockResolvedValue(Array.from({ length: 257 }, (_, i) => key(i + 1)));
    const bindings = await service.getNodeBindings('node');
    expect(bindings).toHaveLength(512);
    expect(bindings.slice(0, 2).map((binding) => [binding.keyId, binding.lineId])).toEqual([[id(1), id(1)], [id(1), id(2)]]);
    expect(bindings[511]).toMatchObject({ keyId: id(256), lineId: id(2) });
    prisma.subscription.findMany.mockResolvedValue([]);
    expect(await service.getNodeBindings('node')).toEqual([]);
  });

  it('不下发非法白名单、非规范原Key或非UUID线路', async () => {
    for (const badKey of [{ ...key(), whitelistIps: 'bad-ip' }, { ...key(), username: 'pk_bad' }]) {
      prisma.proxyKey.findMany.mockResolvedValue([badKey]);
      expect(await service.getNodeBindings('node')).toEqual([]);
    }
    prisma.proxyKey.findMany.mockResolvedValue([key()]);
    prisma.line.findMany.mockResolvedValue([line(1, { id: 'bad' })]);
    expect(await service.getNodeBindings('node')).toEqual([]);
  });

  it.each([{ proxyPoolEnabled: false }, { status: 'DISABLED' }, { protocolType: 'HTTP' }, { type: 'EXTERNAL' }, { entryNode: null }, { entryPort: 0 }, { paramsJson: 'invalid' }, { entryNode: { ...line().entryNode, status: 'DISABLED' } }, { entryNode: { ...line().entryNode, reachability: 'NAT' } }])('无效线路不得下发 %p', async (overrides) => {
    prisma.line.findMany.mockResolvedValue([line(1, overrides)]);
    expect(await service.getNodeBindings('node')).toEqual([]);
  });

  it('关闭publicLinesEnabled也不下发私有额外授权', async () => {
    settings.getSettings.mockResolvedValue({ publicLinesEnabled: false });
    expect(await service.getNodeBindings('node')).toEqual([]);
  });

  it('上游必须可用且Singbox可表达、鉴权显式开启，API不暴露连接秘密', async () => {
    const upstreamNode = { status: 'ACTIVE', presenceStatus: 'PRESENT', protocolType: 'HTTP', serverHost: 'proxy.example.com', serverPort: 443,
      paramsJson: encryptSecret(JSON.stringify({ username: 'upstream-user', password: 'upstream-secret', tls: { enabled: true } })),
      subscription: { status: 'ACTIVE', userInfoExpireAt: null, userInfoTotalBytes: null, userInfoUsedBytes: null } };
    const relay = { type: 'RELAY', relayMode: 'UPSTREAM_NODE', paramsJson: '{"usersEnabled":true}', upstreamNode };
    prisma.line.findMany.mockResolvedValue([line(1, relay)]);
    const snapshot = await service.getSnapshot();
    expect(snapshot.endpointsByKey.get(id(1))?.[0].routeKind).toBe('UPSTREAM_RELAY');
    expect(JSON.stringify(snapshot.endpoints)).not.toContain('upstream-secret');
    for (const overrides of [{ paramsJson: '{}' }, { upstreamNode: { ...upstreamNode, status: 'DISABLED' } }, { upstreamNode: { ...upstreamNode, protocolType: 'SOCKS' } }]) {
      prisma.line.findMany.mockResolvedValue([line(1, { ...relay, ...overrides })]);
      expect(await service.getNodeBindings('node')).toEqual([]);
    }
  });
  it('有效上游但非法落地覆盖不占绑定容量', async () => {
    const upstreamNode = { status: 'ACTIVE', presenceStatus: 'PRESENT', protocolType: 'HTTP', serverHost: 'proxy.example.com', serverPort: 443, paramsJson: encryptSecret('{"username":"up","password":"secret"}'), subscription: { status: 'ACTIVE', userInfoExpireAt: null, userInfoTotalBytes: null, userInfoUsedBytes: null } };
    prisma.line.findMany.mockResolvedValue([line(1, { type: 'RELAY', relayMode: 'UPSTREAM_NODE', paramsJson: '{"usersEnabled":true}', upstreamNode, landingEndpointOverrideEnabled: true, landingServerHost: 'bad/host' })]);
    expect(await service.getNodeBindings('node')).toEqual([]);
  });
});
