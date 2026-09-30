import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ProxyPoolService, PROXY_KEY_PER_USER_LIMIT } from './proxy-pool.service';

const lineRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'line-1',
  name: '香港 Mixed 直连',
  tagsJson: JSON.stringify(['HK', 'proxy']),
  entryPort: 10808,
  endpointOverrideEnabled: false,
  serverHost: null,
  serverPort: null,
  lastLatencyMs: 42,
  lastTestedAt: new Date('2026-09-10T08:00:00.000Z'),
  lastTestStatus: 'SUCCESS',
  entryNode: { id: 'node-1', name: '香港节点', serverHost: '203.0.113.7', status: 'ONLINE' },
  ...overrides
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
  let service: ProxyPoolService;

  beforeEach(() => {
    jest.resetAllMocks();
    agentService.pushConfigToAll.mockResolvedValue(1);
    service = new ProxyPoolService(prisma as never, agentService as never);
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

  describe('节点端点检索', () => {
    it('仅返回启用中的 Mixed 直连线路，并解析对外地址与端口覆盖', async () => {
      prisma.line.findMany.mockResolvedValue([
        lineRecord(),
        lineRecord({
          id: 'line-2',
          name: '日本直连',
          endpointOverrideEnabled: true,
          serverHost: 'proxy.example.com',
          serverPort: 19080,
          tagsJson: JSON.stringify(['local']),
          entryNode: { id: 'node-2', name: '日本节点', serverHost: '198.51.100.9', status: 'DISABLED' },
          lastLatencyMs: null,
          lastTestedAt: null,
          lastTestStatus: null
        })
      ]);

      const result = await service.listEndpoints();
      expect(prisma.line.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ protocolType: 'MIXED', type: 'DIRECT', status: 'ACTIVE', isPublic: true })
      }));
      expect(result.endpoints[0]).toEqual(expect.objectContaining({
        lineId: 'line-1',
        region: 'HK',
        tags: ['HK', 'proxy'],
        host: '203.0.113.7',
        port: 10808,
        online: true,
        latencyMs: 42,
        lastTestedAt: '2026-09-10T08:00:00.000Z'
      }));
      expect(result.endpoints[1]).toEqual(expect.objectContaining({
        lineId: 'line-2',
        region: null,
        host: 'proxy.example.com',
        port: 19080,
        online: false
      }));
    });

    it('没有入口节点或端口的外部记录不能成为代理池端点', async () => {
      prisma.line.findMany.mockResolvedValue([lineRecord({ type: 'EXTERNAL', entryNode: null, entryPort: null })]);
      const result = await service.listEndpoints();
      expect(result.endpoints).toEqual([]);
    });

    it('按 lineIds 过滤，空过滤结果直接返回空列表', async () => {
      prisma.line.findMany.mockResolvedValue([]);
      const result = await service.listEndpoints([]);
      expect(result.endpoints).toEqual([]);
      expect(prisma.line.findMany).not.toHaveBeenCalled();

      await service.listEndpoints(['line-1']);
      expect(prisma.line.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['line-1'] } })
      }));
    });
  });

  describe('多格式导出与免登录拉取', () => {
    beforeEach(() => {
      prisma.proxyKey.findFirst.mockResolvedValue(keyRecord());
      const availableLines = [
        lineRecord(),
        lineRecord({ id: 'line-2', name: '日本直连', entryPort: 10809, tagsJson: JSON.stringify(['JP']) })
      ];
      prisma.line.findMany.mockImplementation(
        async ({ where }: { where?: { id?: { in: string[] } } } = {}) => {
          const ids = where?.id?.in;
          return ids ? availableLines.filter((line) => ids.includes(line.id)) : availableLines;
        }
      );
    });

    it('纯文本格式输出 IP:Port:User:Pass（指纹浏览器可直接导入）', async () => {
      const result = await service.exportForUser('user-1', { format: 'text' });
      expect(result.contentType).toBe('text/plain; charset=utf-8');
      expect(result.body).toBe(
        [
          '203.0.113.7:10808:pk_0123456789abcdef01234567:secret-password',
          '203.0.113.7:10809:pk_0123456789abcdef01234567:secret-password'
        ].join('\n')
      );
      expect(result.count).toBe(2);
    });

    it('URI 格式支持 socks5:// 与 http:// 切换', async () => {
      const socks = await service.exportForUser('user-1', { format: 'uri', protocol: 'socks5', lineIds: 'line-1' });
      expect(socks.body).toBe('socks5://pk_0123456789abcdef01234567:secret-password@203.0.113.7:10808');

      const http = await service.exportForUser('user-1', { format: 'uri', protocol: 'http', lineIds: 'line-1' });
      expect(http.body).toBe('http://pk_0123456789abcdef01234567:secret-password@203.0.113.7:10808');
    });

    it('节点启用 TLS 时，HTTP 协议自动输出为 https:// 代理 URI', async () => {
      const tlsLine = lineRecord({
        id: 'line-tls',
        name: '美国 HTTPS 直连',
        entryPort: 10443,
        paramsJson: JSON.stringify({ tls: { enabled: true, serverName: 'us-proxy.example.com' } })
      });
      prisma.line.findMany.mockResolvedValue([tlsLine]);

      const http = await service.exportForUser('user-1', { format: 'uri', protocol: 'http', lineIds: 'line-tls' });
      expect(http.body).toBe('https://pk_0123456789abcdef01234567:secret-password@203.0.113.7:10443');

      const socks = await service.exportForUser('user-1', { format: 'uri', protocol: 'socks5', lineIds: 'line-tls' });
      expect(socks.body).toBe('socks5://pk_0123456789abcdef01234567:secret-password@203.0.113.7:10443');
    });

    it('JSON 格式包含节点名称、地区、延迟快照、协议与凭证', async () => {
      const result = await service.exportForUser('user-1', { format: 'json', lineIds: 'line-1' });
      expect(result.contentType).toBe('application/json; charset=utf-8');
      const payload = JSON.parse(result.body) as { proxies: Array<Record<string, unknown>> };
      expect(payload.proxies).toEqual([
        expect.objectContaining({
          name: '香港 Mixed 直连',
          region: 'HK',
          node: '香港节点',
          protocol: 'mixed',
          host: '203.0.113.7',
          port: 10808,
          username: 'pk_0123456789abcdef01234567',
          password: 'secret-password',
          latencyMs: 42,
          lastTestStatus: 'SUCCESS'
        })
      ]);
    });

    it('没有可用 Mix 线路时导出返回 NotFound', async () => {
      prisma.line.findMany.mockResolvedValue([]);
      await expect(service.exportForUser('user-1', { format: 'text' })).rejects.toThrow(NotFoundException);
    });

    it('未创建凭据时导出提示先创建 Proxy Key', async () => {
      prisma.proxyKey.findFirst.mockResolvedValue(null);
      await expect(service.exportForUser('user-1', {})).rejects.toThrow('尚未创建直连代理凭据');
    });

    it('凭据停用后拒绝导出', async () => {
      prisma.proxyKey.findFirst.mockResolvedValue(keyRecord({ isActive: false }));
      await expect(service.exportForUser('user-1', { keyId: 'key-1' })).rejects.toThrow(ConflictException);
    });

    it('免登录令牌拉取：有效令牌直接导出，无效令牌 401', async () => {
      prisma.proxyKey.findUnique.mockResolvedValue({ ...keyRecord(), user: { id: 'user-1', isActive: true } });
      const result = await service.exportForToken('tok-1', { format: 'uri', protocol: 'http', lineIds: 'line-1' });
      expect(result.body).toContain('http://pk_0123456789abcdef01234567');

      prisma.proxyKey.findUnique.mockResolvedValue(null);
      await expect(service.exportForToken('bad', {})).rejects.toThrow(UnauthorizedException);

      prisma.proxyKey.findUnique.mockResolvedValue({ ...keyRecord({ isActive: false }), user: { id: 'user-1', isActive: true } });
      await expect(service.exportForToken('tok-1', {})).rejects.toThrow(UnauthorizedException);

      prisma.proxyKey.findUnique.mockResolvedValue({ ...keyRecord(), user: { id: 'user-1', isActive: false } });
      await expect(service.exportForToken('tok-1', {})).rejects.toThrow(UnauthorizedException);
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
      prisma.line.findMany.mockResolvedValue([lineRecord()]);

      const result = await service.adminOverview();
      expect(result).toEqual(expect.objectContaining({
        totalKeys: 5,
        activeKeys: 3,
        disabledKeys: 2,
        trafficUsedBytes: 2048,
        endpointCount: 1
      }));
    });
  });

  it('未注入 AgentService 时凭据变更不抛异常', async () => {
    const isolated = new ProxyPoolService(prisma as never);
    prisma.proxyKey.count.mockResolvedValue(0);
    prisma.proxyKey.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => keyRecord(data));
    await expect(isolated.createKey('user-1', { name: '无网关' })).resolves.toBeDefined();
  });
});
