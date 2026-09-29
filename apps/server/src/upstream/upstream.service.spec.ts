import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { UpstreamService, BadGatewayLikeError } from './upstream.service';
import { UpstreamFetchService, maskUpstreamUrl, upstreamLogMetadata } from './upstream-fetch.service';
import { protectEntryParams } from '../common/upstream-egress';

const MIHOMO_CONTENT = `
proxies:
  - name: "🇯🇵 东京 01"
    type: trojan
    server: jp.example.com
    port: 443
    password: first-password
    sni: jp.example.com
  - name: "🇸🇬 新加坡 01"
    type: vless
    server: sg.example.com
    port: 443
    uuid: 11111111-1111-4111-8111-111111111111
    tls: true
    servername: sg.example.com
`;

describe('UpstreamService', () => {
  const subscriptionRecord = (overrides: Record<string, unknown> = {}) => ({
    id: 'sub-1',
    name: '机场 A',
    url: 'https://sub.example.com/api/v1/client/subscribe?token=SECRET-TOKEN',
    enabled: true,
    syncIntervalMins: 720,
    userAgent: null,
    lastFetchedAt: null,
    lastFetchStatus: 'NEVER',
    lastFetchError: null,
    detectedFormat: null,
    createdAt: new Date('2026-09-30T00:00:00.000Z'),
    updatedAt: new Date('2026-09-30T00:00:00.000Z'),
    ...overrides
  });

  const prisma = {
    upstreamSubscription: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn()
    },
    upstreamProxyEntry: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn()
    },
    line: { findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    node: { findUnique: jest.fn() }
  };

  const fetchService = { fetch: jest.fn() } as unknown as UpstreamFetchService;
  const agentService = { pushConfigToAll: jest.fn().mockResolvedValue(1) };
  const settingsService = {
    getSettings: jest.fn().mockResolvedValue({
      upstreamSubscriptionEnabled: true,
      upstreamHealthGateEnabled: true,
      upstreamHealthMaxAgeSecs: 1800
    })
  };
  const linesService = { create: jest.fn() };
  const systemLogs = { enqueue: jest.fn() };

  let service: UpstreamService;

  beforeEach(() => {
    jest.clearAllMocks();
    agentService.pushConfigToAll.mockResolvedValue(1);
    settingsService.getSettings.mockResolvedValue({
      upstreamSubscriptionEnabled: true,
      upstreamHealthGateEnabled: true,
      upstreamHealthMaxAgeSecs: 1800
    });
    prisma.upstreamSubscription.findMany.mockResolvedValue([]);
    prisma.upstreamSubscription.count.mockResolvedValue(0);
    prisma.upstreamProxyEntry.findMany.mockResolvedValue([]);
    prisma.upstreamProxyEntry.findFirst.mockResolvedValue(null);
    prisma.upstreamProxyEntry.updateMany.mockResolvedValue({ count: 0 });
    prisma.line.findMany.mockResolvedValue([]);
    prisma.line.findFirst.mockResolvedValue(null);
    service = new UpstreamService(
      prisma as never,
      fetchService,
      agentService as never,
      settingsService as never,
      linesService as never,
      systemLogs as never
    );
  });

  describe('URL 脱敏', () => {
    it('maskUpstreamUrl 只保留协议与 host，丢弃 path/query/userinfo', () => {
      expect(maskUpstreamUrl('https://sub.example.com/api/v1/client/subscribe?token=SECRET')).toBe('https://sub.example.com');
      expect(maskUpstreamUrl('https://user:pass@sub.example.com:8443/x?t=1')).toBe('https://sub.example.com:8443');
      expect(maskUpstreamUrl('not a url')).toBe('(无效地址)');
    });

    it('审计元数据不含完整 URL 与 Token', () => {
      const metadata = upstreamLogMetadata(subscriptionRecord());
      expect(metadata.host).toBe('https://sub.example.com');
      expect(JSON.stringify(metadata)).not.toContain('SECRET-TOKEN');
    });

    it('列表接口只返回 host，不返回完整 URL', async () => {
      prisma.upstreamSubscription.findMany.mockResolvedValue([
        { ...subscriptionRecord(), _count: { entries: 3, lines: 2 } }
      ]);
      prisma.upstreamSubscription.count.mockResolvedValue(1);
      prisma.upstreamProxyEntry.count.mockResolvedValue(2);

      const result = await service.list({});
      expect(result.data[0]).toMatchObject({ host: 'https://sub.example.com', entryCount: 3, lineCount: 2 });
      expect(JSON.stringify(result)).not.toContain('SECRET-TOKEN');
    });
  });

  describe('预览', () => {
    it('粘贴内容预览不落库，并返回可导入节点与跳过原因', async () => {
      const result = await service.preview({ content: MIHOMO_CONTENT });

      expect(result.format).toBe('MIHOMO');
      expect(result.nodes.map((node) => node.name)).toEqual(['🇯🇵 东京 01', '🇸🇬 新加坡 01']);
      expect(prisma.upstreamProxyEntry.create).not.toHaveBeenCalled();
      expect(prisma.upstreamSubscription.create).not.toHaveBeenCalled();
    });

    it('URL 预览走安全抓取并标注 provider 数量', async () => {
      (fetchService.fetch as jest.Mock).mockResolvedValue({ content: MIHOMO_CONTENT, bytes: 100, latencyMs: 5, finalUserAgent: 'ua' });

      const result = await service.preview({ url: 'https://sub.example.com/x?token=t', followProviders: true });
      expect(fetchService.fetch).toHaveBeenCalledWith('https://sub.example.com/x?token=t', undefined);
      expect(result.nodes).toHaveLength(2);
      expect(result.providerCount).toBe(0);
    });

    it('未提供 url 与 content 时返回 400', async () => {
      await expect(service.preview({})).rejects.toThrow(new BadRequestException('必须提供订阅地址或直接粘贴订阅内容'));
    });

    it('功能总开关关闭时拒绝按 URL 预览', async () => {
      settingsService.getSettings.mockResolvedValue({ upstreamSubscriptionEnabled: false });
      await expect(service.preview({ url: 'https://sub.example.com/x' })).rejects.toThrow('上游订阅功能已关闭，请先在系统设置中开启');
    });
  });

  describe('同步与对账', () => {
    it('新增条目时按 entryKey 落库，凭据以密文保存', async () => {
      prisma.upstreamSubscription.findUnique.mockResolvedValue(subscriptionRecord());
      (fetchService.fetch as jest.Mock).mockResolvedValue({ content: MIHOMO_CONTENT, bytes: 200, latencyMs: 9, finalUserAgent: 'ua' });
      prisma.upstreamProxyEntry.findMany.mockResolvedValueOnce([]);
      prisma.upstreamProxyEntry.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data);
      prisma.upstreamSubscription.update.mockResolvedValue(subscriptionRecord());

      const summary = await service.sync('sub-1', { manual: true });

      expect(summary).toMatchObject({ format: 'MIHOMO', parsed: 2, added: 2, refreshed: 0, orphaned: 0 });
      const firstCreate = prisma.upstreamProxyEntry.create.mock.calls[0][0] as { data: { paramsJson: string; entryKey: string } };
      expect(firstCreate.data.paramsJson).toContain('enc:v1:');
      expect(firstCreate.data.paramsJson).not.toContain('first-password');
      expect(firstCreate.data.entryKey).toMatch(/^[0-9a-f]{64}$/);
    });

    it('凭据轮换只刷新不新增，且 entryKey 保持不变（线路不断流）', async () => {
      prisma.upstreamSubscription.findUnique.mockResolvedValue(subscriptionRecord());
      prisma.upstreamSubscription.update.mockResolvedValue(subscriptionRecord());

      // 第一次同步注入原始密码，第二次注入轮换后的密码
      (fetchService.fetch as jest.Mock)
        .mockResolvedValueOnce({ content: MIHOMO_CONTENT, bytes: 200, latencyMs: 9, finalUserAgent: 'ua' })
        .mockResolvedValueOnce({ content: MIHOMO_CONTENT.replace('first-password', 'second-password'), bytes: 200, latencyMs: 9, finalUserAgent: 'ua' });

      prisma.upstreamProxyEntry.findMany.mockResolvedValueOnce([]);
      const created: Array<Record<string, unknown>> = [];
      prisma.upstreamProxyEntry.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      });
      await service.sync('sub-1', { manual: true });

      const trojanEntry = created.find((row) => row.protocolType === 'TROJAN')!;
      expect(trojanEntry).toBeDefined();

      // 第二次同步：同 key 命中 → 刷新凭据，不新增同 key 条目
      prisma.upstreamProxyEntry.findMany.mockResolvedValueOnce([{ ...trojanEntry, id: 'entry-1', available: true }]);
      prisma.upstreamProxyEntry.update.mockResolvedValue({});
      prisma.upstreamProxyEntry.create.mockClear();

      const summary = await service.sync('sub-1', { manual: true });

      expect(summary.credentialsRotated).toBe(1);
      expect(summary.refreshed).toBe(1);
      // 只剩 vless 条目是新增的，trojan 走的是刷新路径
      expect(summary.added).toBe(1);
      expect(prisma.upstreamProxyEntry.create.mock.calls.map((call) => (call[0] as { data: { entryKey: string } }).data.entryKey))
        .not.toContain(trojanEntry.entryKey);

      const updateCall = prisma.upstreamProxyEntry.update.mock.calls[0][0] as { where: { id: string }; data: { paramsJson: string } };
      expect(updateCall.where.id).toBe('entry-1');
      // 刷新后的凭据依然是密文
      expect(updateCall.data.paramsJson).toContain('enc:v1:');
      expect(updateCall.data.paramsJson).not.toContain('second-password');
    });

    it('上游消失的条目置为不可用并保留线路（不删除）', async () => {
      prisma.upstreamSubscription.findUnique.mockResolvedValue(subscriptionRecord());
      (fetchService.fetch as jest.Mock).mockResolvedValue({ content: MIHOMO_CONTENT, bytes: 10, latencyMs: 1, finalUserAgent: 'ua' });
      prisma.upstreamSubscription.update.mockResolvedValue(subscriptionRecord());
      prisma.upstreamProxyEntry.findMany.mockResolvedValueOnce([
        { id: 'entry-old', entryKey: 'deadbeef', paramsJson: '{}', name: '下线节点', available: true }
      ]);
      prisma.upstreamProxyEntry.updateMany.mockResolvedValue({ count: 1 });

      const summary = await service.sync('sub-1', { manual: true });

      expect(summary.orphaned).toBe(1);
      expect(prisma.upstreamProxyEntry.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['entry-old'] } },
        data: { available: false }
      });
      // 绝不删除条目或线路
      expect(prisma.upstreamProxyEntry).not.toHaveProperty('delete');
      expect(prisma.line).not.toHaveProperty('delete');
    });

    it('抓取失败记录状态并抛 502 语义错误，既有线路不受影响', async () => {
      prisma.upstreamSubscription.findUnique.mockResolvedValue(subscriptionRecord());
      (fetchService.fetch as jest.Mock).mockRejectedValue(new Error('抓取上游订阅失败 (https://sub.example.com): timeout'));
      prisma.upstreamSubscription.update.mockResolvedValue(subscriptionRecord());

      await expect(service.sync('sub-1', { manual: true })).rejects.toBeInstanceOf(BadGatewayLikeError);
      expect(prisma.upstreamSubscription.update).toHaveBeenCalledWith({
        where: { id: 'sub-1' },
        data: expect.objectContaining({ lastFetchStatus: 'FAILED' })
      });
    });

    it('订阅不存在时返回 404', async () => {
      prisma.upstreamSubscription.findUnique.mockResolvedValue(null);
      await expect(service.sync('missing', { manual: true })).rejects.toThrow(new NotFoundException('上游订阅不存在'));
    });

    it('凭据密文可还原出真实上游secret（保证出口能真正连上）', async () => {
      prisma.upstreamSubscription.findUnique.mockResolvedValue(subscriptionRecord());
      (fetchService.fetch as jest.Mock).mockResolvedValue({ content: MIHOMO_CONTENT, bytes: 1, latencyMs: 1, finalUserAgent: 'ua' });
      prisma.upstreamProxyEntry.findMany.mockResolvedValueOnce([]);
      prisma.upstreamProxyEntry.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data);
      prisma.upstreamSubscription.update.mockResolvedValue(subscriptionRecord());

      await service.sync('sub-1', { manual: true });
      const trojan = (prisma.upstreamProxyEntry.create.mock.calls as Array<[{ data: { paramsJson: string; protocolType: string } }]>)
        .map((call) => call[0].data)
        .find((row) => row.protocolType === 'TROJAN')!;

      const revealed = JSON.parse(
        JSON.stringify(protectEntryParams(JSON.parse(trojan.paramsJson) as Record<string, unknown>))
      ) as Record<string, unknown>;
      // 幂等：已加密值再保护一次不应变化
      expect(revealed).toEqual(JSON.parse(trojan.paramsJson));
    });
  });

  describe('删除订阅', () => {
    it('条目被线路引用时拒绝删除', async () => {
      prisma.upstreamSubscription.findUnique.mockResolvedValue({
        ...subscriptionRecord(),
        entries: [{ id: 'entry-1' }]
      });
      prisma.line.findFirst.mockResolvedValue({ id: 'line-1' });

      await expect(service.remove('sub-1')).rejects.toThrow(ConflictException);
      expect(prisma.upstreamSubscription.delete).not.toHaveBeenCalled();
    });

    it('无引用时正常删除', async () => {
      prisma.upstreamSubscription.findUnique.mockResolvedValue({ ...subscriptionRecord(), entries: [] });
      prisma.upstreamSubscription.delete.mockResolvedValue(subscriptionRecord());

      await expect(service.remove('sub-1')).resolves.toEqual({ deleted: true, id: 'sub-1' });
    });
  });

  describe('物化', () => {
    const entry = {
      id: 'entry-1',
      subscriptionId: null,
      name: '🇯🇵 东京 01',
      protocolType: 'TROJAN',
      server: 'jp.example.com',
      port: 443,
      paramsJson: '{}',
      entryKey: 'key-1',
      available: true
    };

    it('NAT 入口节点被拒绝', async () => {
      prisma.upstreamProxyEntry.findMany.mockResolvedValue([entry]);
      prisma.node.findUnique.mockResolvedValue({ id: 'node-nat', name: '家宽', reachability: 'NAT' });

      await expect(service.materialize({
        entryIds: ['entry-1'],
        entryNodeId: 'node-nat',
        entryProtocolType: 'VLESS'
      })).rejects.toThrow('NAT 节点（无公网 IP）不支持作为上游入口，仅支持作为中继落地节点');
    });

    it('条目不存在时返回 404，部分缺失返回 400', async () => {
      prisma.upstreamProxyEntry.findMany.mockResolvedValue([]);
      await expect(service.materialize({ entryIds: ['a'], entryNodeId: 'n', entryProtocolType: 'VLESS' }))
        .rejects.toThrow(NotFoundException);

      prisma.upstreamProxyEntry.findMany.mockResolvedValue([entry]);
      await expect(service.materialize({ entryIds: ['entry-1', 'entry-2'], entryNodeId: 'n', entryProtocolType: 'VLESS' }))
        .rejects.toThrow(new BadRequestException('部分上游条目不存在'));
    });

    it('每条条目生成"出口线路 + 入口线路"，并把入口指向出口', async () => {
      prisma.upstreamProxyEntry.findMany.mockResolvedValue([entry]);
      prisma.node.findUnique.mockResolvedValue({ id: 'node-1', name: '东京节点', reachability: 'PUBLIC' });
      prisma.line.findMany.mockResolvedValue([]);
      prisma.line.update.mockResolvedValue({});

      let created = 0;
      linesService.create.mockImplementation(async () => {
        created += 1;
        return { line: { id: `line-${created}` } };
      });

      const result = await service.materialize({
        entryIds: ['entry-1'],
        entryNodeId: 'node-1',
        entryProtocolType: 'VLESS',
        namePrefix: '上游'
      });

      expect(linesService.create).toHaveBeenCalledTimes(2);
      // 第一条是出口线路：不公开、直接类型
      expect(linesService.create.mock.calls[0][0]).toMatchObject({ type: 'DIRECT', isPublic: false });
      // 第二条是用户面向线路：挂载出口
      expect(linesService.create.mock.calls[1][0]).toMatchObject({
        name: '上游 🇯🇵 东京 01',
        egressLineId: 'line-1'
      });
      // 出口身份只能在创建后回写（CreateLineDto 不暴露该字段）
      expect(prisma.line.update).toHaveBeenCalledWith({
        where: { id: 'line-1' },
        data: { upstreamEntryId: 'entry-1', upstreamSubscriptionId: null }
      });
      expect(result.created).toEqual([
        { entryId: 'entry-1', egressLineId: 'line-1', lineId: 'line-2', name: '上游 🇯🇵 东京 01' }
      ]);
    });

    it('生成后触发配置下发', async () => {
      prisma.upstreamProxyEntry.findMany.mockResolvedValue([entry]);
      prisma.node.findUnique.mockResolvedValue({ id: 'node-1', name: '东京节点', reachability: 'PUBLIC' });
      prisma.line.findMany.mockResolvedValue([]);
      prisma.line.update.mockResolvedValue({});
      linesService.create.mockResolvedValue({ line: { id: 'line-x' } });

      await service.materialize({ entryIds: ['entry-1'], entryNodeId: 'node-1', entryProtocolType: 'VLESS' });

      expect(agentService.pushConfigToAll).toHaveBeenCalled();
    });
  });

  describe('导入条目', () => {
    it('已有同 key 条目时复用，不重复创建', async () => {
      prisma.upstreamProxyEntry.findFirst.mockResolvedValue({ id: 'existing-1' });

      const result = await service.importEntries({ content: MIHOMO_CONTENT });
      expect(result.entryIds).toEqual(['existing-1', 'existing-1']);
      expect(prisma.upstreamProxyEntry.create).not.toHaveBeenCalled();
    });

    it('新内容创建条目并返回 ID 列表', async () => {
      prisma.upstreamProxyEntry.findFirst.mockResolvedValue(null);
      let counter = 0;
      prisma.upstreamProxyEntry.create.mockImplementation(async () => ({ id: `created-${++counter}` }));

      const result = await service.importEntries({ content: MIHOMO_CONTENT });
      expect(result.imported).toBe(2);
      expect(result.entryIds).toEqual(['created-1', 'created-2']);
    });
  });

  describe('订阅源 CRUD', () => {
    it('创建时仅落库不抓取', async () => {
      prisma.upstreamSubscription.create.mockResolvedValue(subscriptionRecord());

      const result = await service.create({ name: ' 机场 A ', url: 'https://sub.example.com/x?token=t' });

      expect(fetchService.fetch).not.toHaveBeenCalled();
      expect(result.subscription.host).toBe('https://sub.example.com');
      expect(prisma.upstreamSubscription.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ name: '机场 A', lastFetchStatus: 'NEVER' })
      });
    });

    it('更新 URL 时重置抓取状态', async () => {
      prisma.upstreamSubscription.findUnique.mockResolvedValue(subscriptionRecord({ lastFetchStatus: 'FAILED', lastFetchError: 'boom' }));
      prisma.upstreamSubscription.update.mockResolvedValue(subscriptionRecord());

      await service.update('sub-1', { url: 'https://new.example.com/x' });

      expect(prisma.upstreamSubscription.update).toHaveBeenCalledWith({
        where: { id: 'sub-1' },
        data: expect.objectContaining({ url: 'https://new.example.com/x', lastFetchStatus: 'NEVER', lastFetchError: null })
      });
    });
  });
});
