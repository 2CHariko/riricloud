jest.mock('./upstream-fetch', () => ({ ...jest.requireActual('./upstream-fetch'), fetchUpstream: jest.fn() }));
import { UpstreamService } from './upstream.service';
import { UpstreamParserService } from './upstream-parser.service';
import { PrismaService } from '../prisma/prisma.service';
import { AgentGatewayService } from '../agent-gateway/agent-gateway.service';
import { encryptSecret, decryptSecret } from '../common/secret-crypto';
import { fetchUpstream } from './upstream-fetch';

const raw = 'trojan://password@example.com:443#one';
const source = () => ({ id: 'source', name: 'source', sourceType: 'TEXT', format: 'AUTO', detectedFormat: null, content: encryptSecret(raw), url: null, customHeadersJson: encryptSecret('{}'), status: 'ACTIVE', autoUpdate: false, updateIntervalMins: 720, lastSyncAt: null, lastSuccessAt: null, nodeCount: 0, userInfoUsedBytes: 9007199254740993n, userInfoTotalBytes: null, userInfoExpireAt: null, createdAt: new Date(), updatedAt: new Date() });
function setup() {
  const sub = source();
  const prisma = {
    upstreamSubscription: { findUnique: jest.fn(async () => sub), findMany: jest.fn(async () => [sub]), count: jest.fn(async () => 1), create: jest.fn(async ({ data }) => ({ ...sub, ...data })), update: jest.fn(async ({ data }) => ({ ...sub, ...data })), delete: jest.fn() },
    upstreamNode: { findMany: jest.fn(async () => []), findUnique: jest.fn(), create: jest.fn(async ({ data }) => ({ id: 'new', ...data })), update: jest.fn(async ({ data }) => ({ id: 'node', ...data })), updateMany: jest.fn(), count: jest.fn(async () => 0) },
    line: { updateMany: jest.fn(), findMany: jest.fn(async () => []) },
    $transaction: jest.fn()
  };
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
  const gateway = { pushConfigToAll: jest.fn() };
  const service = new UpstreamService(prisma as unknown as PrismaService, new UpstreamParserService(), gateway as unknown as AgentGatewayService);
  return { service, prisma, gateway, sub };
}
describe('上游事务与秘密回归（无数据库）', () => {
  it('列表掩码秘密，detail 显式解密，流量保持十进制字符串', async () => {
    const { service, sub } = setup();
    sub.url = encryptSecret('https://example.com/private?token=password') as never;
    sub.customHeadersJson = encryptSecret('{"Authorization":"private"}');
    const list = await service.list({});
    expect(JSON.stringify(list)).not.toContain('password');
    expect(JSON.stringify(list)).not.toContain('private');
    expect(list.data[0].userInfoUsedBytes).toBe('9007199254740993');
    const detail = await service.detail('source');
    expect(detail.subscription.url).toContain('password');
    expect(detail.subscription).toHaveProperty('content', raw);
  });
  it('URL 改为 TEXT 立即移除旧流量头，禁用创建不触发首次同步', async () => {
    const { service, sub, prisma, gateway } = setup();
    sub.sourceType = 'URL'; sub.url = encryptSecret('https://example.com/source') as never;
    await service.update('source', { sourceType: 'TEXT', content: raw });
    expect(prisma.upstreamSubscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userInfoUsedBytes: null, userInfoTotalBytes: null, userInfoExpireAt: null }) }));
    expect(gateway.pushConfigToAll).toHaveBeenCalled();
    prisma.$transaction.mockClear();
    const created = await service.create({ name: 'disabled', sourceType: 'TEXT', content: raw, status: 'DISABLED' });
    expect(created.subscription.status).toBe('DISABLED');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('默认 URL 来源缺失地址必须拒绝', async () => {
    await expect(setup().service.create({ name: 'n' })).rejects.toThrow();
  });
  it('成功快照单事务写入全部密文，不改变 AUTO，缺头清空过时元信息', async () => {
    const { service, prisma, gateway } = setup();
    const result = await service.sync('source');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const data = prisma.upstreamNode.create.mock.calls[0][0].data;
    expect(data.paramsJson).toMatch(/^enc:v1:/);
    expect(decryptSecret(data.paramsJson)).toContain('password');
    expect(data.rawConfigJson).toMatch(/^enc:v1:/);
    const update = prisma.upstreamSubscription.update.mock.calls.at(-1)![0].data;
    expect(update).not.toHaveProperty('format');
    expect(update).toMatchObject({ detectedFormat: 'URI_LIST', userInfoUsedBytes: null, userInfoTotalBytes: null, userInfoExpireAt: null });
    expect(update.content).toMatch(/^enc:v1:/);
    expect(JSON.stringify(result)).toContain('created');
    expect(gateway.pushConfigToAll).toHaveBeenCalled();
  });
  it('缺失保留稳定 ID 和引用，恢复不自动启用线路', async () => {
    const { service, prisma } = setup();
    const parsed = new UpstreamParserService().parse(raw).nodes[0];
    prisma.upstreamNode.findMany.mockResolvedValue([{ id: 'old', name: 'missing', protocolType: 'TROJAN', sourceKey: null, connectionHash: 'other', configHash: 'other', presenceStatus: 'PRESENT' }] as never);
    await service.sync('source');
    expect(prisma.upstreamNode.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ presenceStatus: 'MISSING' }) }));
    expect(prisma.line.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'DISABLED' } }));
    prisma.upstreamNode.findMany.mockResolvedValue([{ id: 'old', ...parsed, presenceStatus: 'MISSING' }] as never);
    prisma.line.updateMany.mockClear();
    await service.sync('source');
    expect(prisma.upstreamNode.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'old' }, data: expect.objectContaining({ presenceStatus: 'PRESENT', missingSince: null }) }));
    expect(prisma.line.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastProbeJson: null }) }));
  });
  it('歧义拒绝在事务中进行节点写入', async () => {
    const { service, prisma } = setup();
    prisma.upstreamNode.findMany.mockResolvedValue([1, 2].map((id) => ({ id: String(id), name: 'one', protocolType: 'TROJAN', connectionHash: 'old', configHash: 'old', sourceKey: null })) as never);
    await expect(service.sync('source')).rejects.toThrow('歧义');
    expect(prisma.upstreamNode.create).not.toHaveBeenCalled();
    expect(prisma.upstreamNode.update).not.toHaveBeenCalled();
  });
  it('同源并发同步共享一个尝试，更新排在拉取之后', async () => {
    const { service, prisma, sub } = setup();
    sub.sourceType = 'URL'; sub.url = encryptSecret('https://example.com/sub') as never;
    let complete!: (value: { content: string }) => void;
    jest.mocked(fetchUpstream).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const first = service.sync('source');
    const second = service.sync('source');
    const update = service.update('source', { name: 'new' });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(prisma.upstreamSubscription.update).not.toHaveBeenCalled();
    complete({ content: raw });
    await Promise.all([first, second, update]);
    expect(prisma.upstreamNode.create).toHaveBeenCalledTimes(1);
    expect(prisma.upstreamSubscription.update.mock.calls.at(-1)![0].data.name).toBe('new');
  });
  it('失败不改最后成功快照或流量，文本名称编辑不清空内容', async () => {
    const { service, prisma, sub } = setup();
    sub.content = encryptSecret('HTML error');
    await expect(service.sync('source')).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.upstreamSubscription.update.mock.calls.at(-1)![0].data).not.toHaveProperty('lastSuccessAt');
    await service.update('source', { name: 'renamed' });
    expect(prisma.upstreamSubscription.update.mock.calls.at(-1)![0].data).not.toHaveProperty('content');
  });
  it('标签精确匹配在分页之前执行，total 不受页大小影响，节点视图不含凭据', async () => {
    const { service, prisma } = setup();
    const safe = { id: 'n2', subscriptionId: 'source', name: 'n', protocolType: 'TROJAN', serverHost: 'example.com', serverPort: 443, paramsJson: encryptSecret('{"password":"secret"}'), rawConfigJson: encryptSecret('raw-secret'), sourceKey: null, presenceStatus: 'PRESENT', tagsJson: '["HK"]', createdAt: new Date(), updatedAt: new Date() };
    prisma.upstreamNode.findMany.mockResolvedValueOnce([{ id: 'n1', tagsJson: '["JPHK"]' }, { id: 'n2', tagsJson: '["HK"]' }, { id: 'n3', tagsJson: '["hk"]' }] as never).mockResolvedValueOnce([safe] as never);
    prisma.upstreamNode.count.mockResolvedValue(2);
    const result = await service.listNodes({ tag: 'HK', page: 1, pageSize: 1 });
    expect(result.total).toBe(2);
    expect(result.data).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.data[0]).not.toHaveProperty('params');
  });
  it('重复快照不新增、不通知；仅参数变更保持 UUID 并通知', async () => {
    const { service, prisma, gateway, sub } = setup();
    sub.userInfoUsedBytes = null as never;
    const parsed = new UpstreamParserService().parse(raw).nodes[0];
    prisma.upstreamNode.findMany.mockResolvedValue([{ id: 'stable', ...parsed, sourceKey: null, presenceStatus: 'PRESENT' }] as never);
    expect(await service.sync('source')).toMatchObject({ created: 0, updated: 0, missing: 0 });
    expect(gateway.pushConfigToAll).not.toHaveBeenCalled();
    sub.content = encryptSecret('trojan://rotated@example.com:443#one');
    expect(await service.sync('source')).toMatchObject({ created: 0, updated: 1 });
    expect(prisma.upstreamNode.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'stable' } }));
    expect(gateway.pushConfigToAll).toHaveBeenCalledTimes(1);
  });
  it('sourceKey 优先且同连接改名稳定匹配；重名轮换不能按剩余顺序猜测', async () => {
    const { service, prisma, sub } = setup();
    const parsed = new UpstreamParserService().parse(raw).nodes[0];
    prisma.upstreamNode.findMany.mockResolvedValue([{ id: 'stable', ...parsed, name: 'renamed', configHash: 'renamed-config', sourceKey: null, presenceStatus: 'PRESENT' }] as never);
    await service.sync('source');
    expect(prisma.upstreamNode.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'stable' } }));
    prisma.upstreamNode.findMany.mockResolvedValue([{ id: 'a', ...parsed, sourceKey: null, presenceStatus: 'PRESENT' }, { id: 'b', ...parsed, connectionHash: 'other', sourceKey: null, presenceStatus: 'PRESENT' }] as never);
    sub.content = encryptSecret(`${raw}\ntrojan://rotated@example.com:443#one`);
    await expect(service.sync('source')).rejects.toThrow('歧义');
  });
  it('事务提交失败只记录脱敏失败，不发配置；删除后才通知', async () => {
    const { service, prisma, gateway } = setup();
    prisma.$transaction.mockRejectedValueOnce(new Error('private-db-password'));
    await expect(service.sync('source')).rejects.toThrow('提交失败');
    expect(JSON.stringify(prisma.upstreamSubscription.update.mock.calls)).not.toContain('private-db-password');
    expect(gateway.pushConfigToAll).not.toHaveBeenCalled();
    await service.remove('source');
    expect(prisma.line.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'DISABLED', upstreamNodeId: null } }));
    expect(prisma.upstreamSubscription.delete).toHaveBeenCalled();
    expect(gateway.pushConfigToAll).toHaveBeenCalledTimes(1);
  });
  it('启动和巡检只在到期跨界通知，不重入定时同步', async () => {
    const { service, gateway, sub } = setup();
    sub.userInfoExpireAt = new Date(Date.now() - 1) as never;
    service.onModuleInit();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(gateway.pushConfigToAll).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
  });
  it('关闭取消未完成拉取且等待排队操作退出', async () => {
    const { service, sub } = setup();
    sub.sourceType = 'URL'; sub.url = encryptSecret('https://example.com/sub') as never;
    jest.mocked(fetchUpstream).mockImplementationOnce((_url, _headers, signal) => new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')))));
    const task = service.sync('source');
    const rejected = expect(task).rejects.toThrow();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await service.onModuleDestroy();
    await rejected;
  });
  it('可靠源内 ID 在地址凭据轮换时优先保留 UUID', async () => {
    const { service, prisma, sub } = setup();
    const old = new UpstreamParserService().parse(raw).nodes[0];
    prisma.upstreamNode.findMany.mockResolvedValue([{ id: 'stable', ...old, sourceKey: 'source-id', presenceStatus: 'PRESENT' }] as never);
    sub.content = encryptSecret(JSON.stringify({ proxies: [{ id: 'source-id', name: 'renamed', type: 'trojan', server: 'rotated.example.com', port: 8443, password: 'rotated' }] }));
    const summary = await service.sync('source');
    expect(summary).toMatchObject({ created: 0, updated: 1, missing: 0 });
    expect(prisma.upstreamNode.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'stable' }, data: expect.objectContaining({ sourceKey: 'source-id', serverHost: 'rotated.example.com' }) }));
  });
  it('URL/Header 写入密文，省略文本保留，空替换被拒绝', async () => {
    const { service, prisma } = setup();
    await service.update('source', { sourceType: 'URL', url: 'https://example.com/sub?token=secret', customHeaders: { Authorization: 'secret' } });
    const data = prisma.upstreamSubscription.update.mock.calls.at(-1)![0].data;
    expect(data.url).toMatch(/^enc:v1:/);
    expect(data.customHeadersJson).toMatch(/^enc:v1:/);
    await expect(service.update('source', { content: '' })).rejects.toThrow();
  });
  it('node 禁用事务联动线路，source 禁用不覆盖管理员线路状态', async () => {
    const { service, prisma, gateway } = setup();
    const node = { id: 'node', subscriptionId: 'source', tagsJson: '[]', createdAt: new Date(), updatedAt: new Date() };
    prisma.upstreamNode.findUnique.mockResolvedValue(node);
    prisma.upstreamNode.update.mockImplementationOnce(async ({ data }) => ({ ...node, ...data }));
    await service.setNodeStatus('node', 'DISABLED');
    expect(prisma.line.updateMany).toHaveBeenCalledWith({ where: { upstreamNodeId: 'node' }, data: { status: 'DISABLED' } });
    prisma.line.updateMany.mockClear();
    await service.update('source', { status: 'DISABLED' });
    expect(prisma.line.updateMany).not.toHaveBeenCalled();
    expect(gateway.pushConfigToAll).toHaveBeenCalledTimes(2);
  });
  it('三格式导出复用统一连接编译，URI 原始内容不直接返回', async () => {
    const { service, prisma, sub } = setup();
    sub.userInfoUsedBytes = null as never;
    const parsed = new UpstreamParserService().parse('trojan://p%3Aa@[2001:4860::1]:443?type=ws&path=%2Fproxy&sni=example.com#name').nodes[0];
    prisma.upstreamNode.findMany.mockResolvedValue([{ id: 'node', ...parsed, paramsJson: encryptSecret(JSON.stringify(parsed.params)), rawConfigJson: encryptSecret('unknown://must-not-export'), status: 'ACTIVE', presenceStatus: 'PRESENT', subscription: sub }] as never);
    const json = await service.exportNodes({ format: 'json' });
    expect(JSON.parse(json.body)).toMatchObject({ outbounds: [{ type: 'trojan', password: 'p:a', transport: { type: 'ws', path: '/proxy' }, tls: { server_name: 'example.com' } }] });
    const uri = await service.exportNodes({ format: 'uri' });
    expect(uri.body).toContain('trojan://');
    expect(uri.body).not.toContain('must-not-export');
    expect(uri.body).toContain('path=%2Fproxy');
    const clash = await service.exportNodes({ format: 'clash' });
    expect(clash.body).toContain('ws-opts:');
  });
  it('删除同步 TCP 探针，旧延迟不再作为协议成功展示', async () => {
    const { service, prisma } = setup();
    expect(service).not.toHaveProperty('probeNode');
    expect(service).not.toHaveProperty('measureTcpLatency');
    prisma.upstreamNode.findMany.mockResolvedValue([{ id: 'n', subscriptionId: 'source', tagsJson: '[]', lastProbeJson: null, latencyMs: 10, lastTestStatus: 'SUCCESS', createdAt: new Date(), updatedAt: new Date() }] as never);
    const result = await service.listNodes({});
    expect(result.data[0]).toMatchObject({ lastProbe: null, latencyMs: null, lastTestStatus: null });
  });
});
