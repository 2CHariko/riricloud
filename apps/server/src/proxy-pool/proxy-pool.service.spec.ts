import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ProxyPoolService, PROXY_KEY_PER_USER_LIMIT } from './proxy-pool.service';
import { ProxyPoolAccessSnapshot, ProxyPoolEndpoint } from '../proxy-pool-access/proxy-pool-access.service';
import { formatProxyLineUsername } from './proxy-key.util';

const lineId = '22222222-2222-4222-8222-222222222222';
const otherLineId = '33333333-3333-4333-8333-333333333333';
const endpoint = (overrides: Partial<ProxyPoolEndpoint> = {}): ProxyPoolEndpoint => ({
  lineId, name: '香港 Mixed', region: 'HK', tags: ['HK'], protocol: 'MIXED', host: '2001:db8::1', port: 1080,
  nodeId: 'node', nodeName: '香港节点', nodeStatus: 'OFFLINE', online: false, routeKind: 'DIRECT', lineType: 'DIRECT',
  status: 'AVAILABLE', reason: null, tls: false, serverName: null, supportedProtocols: ['http', 'socks5'], trafficRate: 1,
  lastProbe: null, latencyMs: 42, lastTestedAt: null, lastTestStatus: 'SUCCESS', ...overrides
});
const snapshot = (endpoints = [endpoint()]): ProxyPoolAccessSnapshot => ({
  eligibleUserIds: new Set(['user-1', 'user-2']), endpoints, endpointsByKey: new Map([[keyRecord().id, endpoints]]),
  bindingsByNode: new Map(), nodeCapacities: [{ nodeId: 'node', nodeName: '香港节点', used: 1, limit: 512, excluded: 0 }]
});

const keyRecord = (overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  userId: 'user-1',
  name: '爬虫 A',
  username: 'pk_0123456789abcdef01234567',
  password: 'secret-password',
  whitelistIps: '203.0.113.10',
  exportToken: 'tok-1',
  isActive: true,
  trafficUsedBytes: 1024n,
  lastUsedAt: null,
  createdAt: new Date('2026-09-10T00:00:00.000Z'),
  updatedAt: new Date('2026-09-10T00:00:00.000Z'),
  ...overrides
});

describe('ProxyPoolService', () => {
  const prisma = {
    proxyKey: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      aggregate: jest.fn()
    },
    line: { findMany: jest.fn() }
  };
  const agentService = { pushConfigToAll: jest.fn().mockResolvedValue(1) };
  const access = { getSnapshot: jest.fn() };
  let service: ProxyPoolService;

  beforeEach(() => {
    jest.resetAllMocks();
    agentService.pushConfigToAll.mockResolvedValue(1);
    access.getSnapshot.mockResolvedValue(snapshot());
    prisma.proxyKey.findFirst.mockResolvedValue(keyRecord());
    service = new ProxyPoolService(prisma as never, access as never, agentService as never);
  });

  describe('凭据管理', () => {
    it('创建凭据时生成 pk_ 用户名与高熵密码，并把白名单格式化为统一分隔串', async () => {
      prisma.proxyKey.count.mockResolvedValue(0);
      prisma.proxyKey.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
        keyRecord({ ...data, whitelistIps: data.whitelistIps })
      );

      const result = await service.createKey('user-1', {
        name: '  爬虫 A ',
        whitelistIps: '203.0.113.10\n198.51.100.0/24'
      });

      expect(result.key.username).toMatch(/^pk_[0-9a-f]{24}$/);
      expect(result.key.whitelistIps).toEqual(['203.0.113.10', '198.51.100.0/24']);
      expect(prisma.proxyKey.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-1',
          name: '爬虫 A',
          whitelistIps: '203.0.113.10,198.51.100.0/24'
        })
      });
      expect(agentService.pushConfigToAll).toHaveBeenCalledTimes(1);
    });

    it('用户名唯一约束冲突时自动重试生成', async () => {
      prisma.proxyKey.count.mockResolvedValue(0);
      prisma.proxyKey.create
        .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
        .mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => keyRecord(data));

      const result = await service.createKey('user-1', { name: '重试' });
      expect(result.key.username).toMatch(/^pk_[0-9a-f]{24}$/);
      expect(prisma.proxyKey.create).toHaveBeenCalledTimes(2);
    });

    it('超出单账号凭据上限时拒绝创建', async () => {
      prisma.proxyKey.count.mockResolvedValue(PROXY_KEY_PER_USER_LIMIT);
      await expect(service.createKey('user-1', { name: '超限' })).rejects.toThrow(ConflictException);
      expect(prisma.proxyKey.create).not.toHaveBeenCalled();
    });

    it('白名单 CIDR 非法时拒绝创建且不落库', async () => {
      prisma.proxyKey.count.mockResolvedValue(0);
      await expect(service.createKey('user-1', { name: '非法', whitelistIps: '10.0.0.0/33' })).rejects.toThrow(BadRequestException);
      expect(prisma.proxyKey.create).not.toHaveBeenCalled();
    });

    it('越权访问他人凭据统一返回 NotFound（不泄露存在性）', async () => {
      prisma.proxyKey.findFirst.mockResolvedValue(null);
      await expect(service.updateKey('user-2', 'key-1', { name: 'x' })).rejects.toThrow(NotFoundException);
      await expect(service.deleteKey('user-2', 'key-1')).rejects.toThrow(NotFoundException);
      await expect(service.rotatePassword('user-2', 'key-1')).rejects.toThrow(NotFoundException);
      await expect(service.exportForUser('user-2', { keyId: 'key-1' })).rejects.toThrow(NotFoundException);
    });

    it('更新启停与白名单后重下发节点配置，仅改名不重下发', async () => {
      prisma.proxyKey.findFirst.mockResolvedValue(keyRecord());
      prisma.proxyKey.update.mockResolvedValue(keyRecord({ isActive: false }));

      await service.updateKey('user-1', 'key-1', { name: '改名' });
      expect(agentService.pushConfigToAll).not.toHaveBeenCalled();

      await service.updateKey('user-1', 'key-1', { isActive: false });
      expect(agentService.pushConfigToAll).toHaveBeenCalledTimes(1);
    });

    it('删除与密码轮换后重下发节点配置', async () => {
      prisma.proxyKey.findFirst.mockResolvedValue(keyRecord());
      prisma.proxyKey.delete.mockResolvedValue(keyRecord());
      prisma.proxyKey.update.mockResolvedValue(keyRecord({ password: 'rotated' }));

      await service.deleteKey('user-1', 'key-1');
      await service.rotatePassword('user-1', 'key-1');
      expect(agentService.pushConfigToAll).toHaveBeenCalledTimes(2);
    });

    it('轮换免登录令牌不触发节点配置重下发', async () => {
      prisma.proxyKey.findFirst.mockResolvedValue(keyRecord());
      prisma.proxyKey.update.mockResolvedValue(keyRecord({ exportToken: 'tok-2' }));

      const result = await service.rotateExportToken('user-1', 'key-1');
      expect(result.key.exportToken).toBe('tok-2');
      expect(agentService.pushConfigToAll).not.toHaveBeenCalled();
    });
  });

  describe('授权节点列表与导出', () => {
    it('列表不返回凭据，offline端点仍显示，默认Key与容量快照一致', async () => {
      const result = await service.listEndpoints('user-1');
      expect(result).toEqual({ keyId: keyRecord().id, endpoints: [endpoint()], excludedCount: 0 });
      expect(JSON.stringify(result)).not.toMatch(/password|username|secret/);
    });

    it('无Key为空；无权益返回403结构化code；他人Key不泄露', async () => {
      prisma.proxyKey.findFirst.mockResolvedValue(null);
      expect(await service.listEndpoints('user-1')).toEqual({ keyId: null, endpoints: [], excludedCount: 0 });
      await expect(service.listEndpoints('user-1', { keyId: 'other' })).rejects.toThrow(NotFoundException);
      access.getSnapshot.mockResolvedValue({ ...snapshot(), eligibleUserIds: new Set() });
      await expect(service.listEndpoints('user-1')).rejects.toMatchObject({ response: { code: 'PROXY_POOL_ACCESS_DENIED' } });
      await expect(service.exportForUser('user-1', {})).rejects.toThrow(ForbiddenException);
    });

    it.each(['', ' ', ',', 'bad', `${lineId},`, Array(201).fill(lineId).join(',')])('invalid selection不能扩大查询 %s', async (lineIds) => {
      await expect(service.listEndpoints('user-1', { lineIds })).rejects.toThrow(BadRequestException);
      await expect(service.exportForUser('user-1', { lineIds })).rejects.toThrow(BadRequestException);
      expect(access.getSnapshot).not.toHaveBeenCalled();
    });

    it('JSON v2 每端点派生用户名、记录容量排除数量', async () => {
      access.getSnapshot.mockResolvedValue(snapshot([endpoint(), endpoint({ lineId: otherLineId, status: 'CAPACITY_EXCLUDED', reason: 'CAPACITY' })]));
      const result = await service.exportForUser('user-1', { format: 'json' });
      expect(JSON.parse(result.body)).toMatchObject({ version: 2, excludedCount: 1, key: { username: keyRecord().username }, proxies: [{ ...endpoint(), username: formatProxyLineUsername(keyRecord().username, lineId), password: 'secret-password' }] });
      const list = await service.listEndpoints('user-1');
      expect(list.excludedCount).toBe(1);
      expect(list.endpoints[1].status).toBe('CAPACITY_EXCLUDED');
    });

    it('URI/text IPv6有方括号，凭据按Line派生而非裸pk别名', async () => {
      const username = formatProxyLineUsername(keyRecord().username, lineId);
      expect((await service.exportForUser('user-1', { format: 'uri' })).body).toBe(`socks5://${username}:secret-password@[2001:db8::1]:1080`);
      expect((await service.exportForUser('user-1', { format: 'text' })).body).toBe(`[2001:db8::1]:1080:${username}:secret-password`);
    });

    it('TLS http是https，socks5与text明确选择拒绝，默认全量过滤', async () => {
      access.getSnapshot.mockResolvedValue(snapshot([endpoint({ tls: true, supportedProtocols: ['http'] })]));
      expect((await service.exportForUser('user-1', { format: 'uri', protocol: 'http' })).body).toMatch(/^https:\/\//);
      for (const query of [{ format: 'uri' as const, protocol: 'socks5' as const }, { format: 'text' as const, protocol: 'http' as const }, { format: 'json' as const, protocol: 'socks5' as const }]) {
        await expect(service.exportForUser('user-1', { ...query, lineIds: lineId })).rejects.toMatchObject({ response: { code: 'PROXY_POOL_SELECTION_UNAVAILABLE', lineIds: [lineId] } });
        await expect(service.exportForUser('user-1', query)).rejects.toThrow(NotFoundException);
      }
    });

    it('明确选择missing/unauthorized/capacity统一409，不泄露原因', async () => {
      access.getSnapshot.mockResolvedValue(snapshot([endpoint({ status: 'CAPACITY_EXCLUDED' })]));
      await expect(service.exportForUser('user-1', { format: 'json', lineIds: `${lineId},${otherLineId}` })).rejects.toMatchObject({ response: { code: 'PROXY_POOL_SELECTION_UNAVAILABLE', lineIds: [lineId, otherLineId] } });
    });

    it('有效token每次检查权益、无效/停用401、不能用token选择他人Key', async () => {
      prisma.proxyKey.findUnique.mockResolvedValue(keyRecord());
      expect((await service.exportForToken('tok-1', { format: 'json' })).count).toBe(1);
      await expect(service.exportForToken('tok-1', { keyId: 'other' })).rejects.toThrow(NotFoundException);
      access.getSnapshot.mockResolvedValue({ ...snapshot(), eligibleUserIds: new Set() });
      await expect(service.exportForToken('tok-1', {})).rejects.toThrow(ForbiddenException);
      prisma.proxyKey.findUnique.mockResolvedValue(null);
      await expect(service.exportForToken('bad', {})).rejects.toThrow(UnauthorizedException);
      prisma.proxyKey.findUnique.mockResolvedValue(keyRecord({ isActive: false }));
      await expect(service.exportForToken('tok-1', {})).rejects.toThrow(UnauthorizedException);
    });

    it('无endpoint404、无Key需创建、停用Key不可导出', async () => {
      access.getSnapshot.mockResolvedValue(snapshot([]));
      await expect(service.exportForUser('user-1', {})).rejects.toThrow(NotFoundException);
      prisma.proxyKey.findFirst.mockResolvedValue(null);
      await expect(service.exportForUser('user-1', {})).rejects.toThrow(BadRequestException);
      prisma.proxyKey.findFirst.mockResolvedValue(keyRecord({ isActive: false }));
      await expect(service.exportForUser('user-1', { keyId: keyRecord().id })).rejects.toThrow(ConflictException);
    });
  });

  describe('管理侧', () => {
    it('分页检索并附带归属用户信息', async () => {
      prisma.proxyKey.findMany.mockResolvedValue([
        { ...keyRecord(), user: { id: 'user-1', email: 'a@x.com', uid: 100001, isActive: true } }
      ]);
      prisma.proxyKey.count.mockResolvedValue(1);

      const result = await service.adminListKeys({ page: 2, pageSize: 10, search: 'pk_', isActive: true });
      expect(prisma.proxyKey.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ isActive: true, OR: expect.any(Array) }),
        skip: 10,
        take: 10
      }));
      expect(result.total).toBe(1);
      expect(result.data[0].user).toEqual({ id: 'user-1', email: 'a@x.com', uid: 100001, isActive: true });
    });

    it('管理端启停与删除凭据都重下发节点配置', async () => {
      prisma.proxyKey.findUnique.mockResolvedValue(keyRecord());
      prisma.proxyKey.update.mockResolvedValue(keyRecord({ isActive: false }));
      prisma.proxyKey.delete.mockResolvedValue(keyRecord());

      await service.adminSetKeyActive('key-1', false);
      await service.adminDeleteKey('key-1');
      expect(agentService.pushConfigToAll).toHaveBeenCalledTimes(2);
    });

    it('总览汇总凭据规模、累计流量与端点数量', async () => {
      prisma.proxyKey.count.mockResolvedValueOnce(5).mockResolvedValueOnce(3);
      prisma.proxyKey.aggregate.mockResolvedValue({ _sum: { trafficUsedBytes: 2048n } });
      access.getSnapshot.mockResolvedValue(snapshot());

      const result = await service.adminOverview();
      expect(result).toEqual(expect.objectContaining({
        totalKeys: 5,
        activeKeys: 3,
        disabledKeys: 2,
        trafficUsedBytes: 2048,
        endpointCount: 1,
        nodeCapacities: [{ nodeId: 'node', nodeName: '香港节点', used: 1, limit: 512, excluded: 0 }]
      }));
    });
  });

  it('未注入 AgentService 时凭据变更不抛异常', async () => {
    const isolated = new ProxyPoolService(prisma as never, access as never);
    prisma.proxyKey.count.mockResolvedValue(0);
    prisma.proxyKey.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => keyRecord(data));
    await expect(isolated.createKey('user-1', { name: '无网关' })).resolves.toBeDefined();
  });
});
