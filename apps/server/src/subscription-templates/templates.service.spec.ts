import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { TemplatesService } from './templates.service';
import { ClientKernelsService } from '../client-kernels/client-kernels.service';

describe('TemplatesService', () => {
  let service: TemplatesService;
  const kernels = { validate: jest.fn().mockResolvedValue({ engine: 'SINGBOX', status: 'UNAVAILABLE', executed: false, scope: 'FULL', diagnostics: ['KERNEL_UNAVAILABLE'] }) };
  type PrismaMock = {
    subscriptionTemplate: Record<string, jest.Mock>;
    systemSetting: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  const prisma: PrismaMock = {
    subscriptionTemplate: {
      create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn(), delete: jest.fn()
    },
    systemSetting: { findUnique: jest.fn(), upsert: jest.fn() },
    $transaction: jest.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma))
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [TemplatesService, { provide: PrismaService, useValue: prisma }, { provide: ClientKernelsService, useValue: kernels }]
    }).compile();
    service = moduleRef.get(TemplatesService);
  });

  afterEach(() => jest.clearAllMocks());

  it('拒绝非法的 JSON 覆写', async () => {
    await expect(service.create({ name: 'bad', customInjectJson: '{', isDefault: false })).rejects.toThrow(BadRequestException);
    expect(prisma.subscriptionTemplate.create).not.toHaveBeenCalled();
  });

  it('设置默认模板时清理旧默认标记', async () => {
    prisma.subscriptionTemplate.create.mockResolvedValue({
      id: 't1', name: 'new', description: null, isDefault: true, proxyGroupsJson: '[]', ruleSetsJson: '[]', dnsConfigJson: '{}', customInjectYaml: null, customInjectJson: null
    });
    await service.create({ name: 'new', isDefault: true });
    expect(prisma.subscriptionTemplate.updateMany).toHaveBeenCalledWith({ where: { id: { not: 't1' } }, data: { isDefault: false } });
    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { key: 'defaultTemplateId' }, update: { value: 't1' } }));
  });

  it('默认模板不能删除', async () => {
    prisma.subscriptionTemplate.findUnique.mockResolvedValue({ isDefault: true, _count: { plans: 0 } });
    await expect(service.remove('t1')).rejects.toThrow(ConflictException);
  });

  it('内嵌默认模板不能删除', async () => {
    prisma.subscriptionTemplate.findUnique.mockResolvedValue({ isDefault: false, isBuiltin: true, _count: { plans: 0 } });
    await expect(service.remove('builtin-template')).rejects.toThrow('内嵌默认模板不能删除，只能修改');
    expect(prisma.subscriptionTemplate.delete).not.toHaveBeenCalled();
  });

  it('复制模板时重置默认和内嵌标记', async () => {
    prisma.subscriptionTemplate.findUnique.mockResolvedValue({
      id: 'source', name: '基础模板', description: 'desc', isDefault: true, isBuiltin: true,
      proxyGroupsJson: '[]', ruleSetsJson: '[]', dnsConfigJson: '{}', customInjectYaml: null, customInjectJson: null
    });
    prisma.subscriptionTemplate.create.mockResolvedValue({
      id: 'copy', name: '基础模板 (副本)', description: 'desc', isDefault: false, isBuiltin: false,
      proxyGroupsJson: '[]', ruleSetsJson: '[]', dnsConfigJson: '{}', customInjectYaml: null, customInjectJson: null
    });
    await expect(service.duplicate('source')).resolves.toEqual(expect.objectContaining({ name: '基础模板 (副本)', isDefault: false, isBuiltin: false }));
  });

  it('无真实线路时可生成预览并返回统计', async () => {
    await expect(service.previewTemplate({
      format: 'singbox',
      template: {
        proxyGroups: [{ name: '节点选择', type: 'select', proxies: 'all' }],
        ruleSets: [{ name: '兜底', type: 'match', target: '节点选择' }],
        dnsConfig: { enable: true, fakeIp: true, directDns: ['223.5.5.5'], proxyDns: ['https://1.1.1.1/dns-query'] }
      }
    })).resolves.toEqual(expect.objectContaining({
      format: 'singbox',
      stats: expect.objectContaining({ totalNodes: 6, proxyGroupsCount: 1, rulesCount: 1 }),
      kernelCheck: expect.objectContaining({ status: 'UNAVAILABLE', executed: false })
    }));
    expect(kernels.validate).toHaveBeenCalledTimes(1);
    expect(kernels.validate).toHaveBeenCalledWith('SINGBOX', expect.any(String));
  }, 15000);
  it('Clash 预览只验证 Mihomo，不为了兼容格式再编译 Sing-box', async () => {
    kernels.validate.mockResolvedValueOnce({ engine: 'MIHOMO', status: 'UNAVAILABLE', executed: false, scope: 'FULL', diagnostics: ['KERNEL_UNAVAILABLE'] });
    const preview = await service.previewTemplate({ format: 'clash', template: {} });
    expect(preview).toHaveProperty('kernelCheck');
    expect(preview).not.toHaveProperty('singboxCheck');
    expect(kernels.validate).toHaveBeenCalledTimes(1);
    expect(kernels.validate).toHaveBeenCalledWith('MIHOMO', preview.content);
  });
  it('预览保留原契约并透传有界资源诊断，不篡改配置内容', async () => {
    const kernelCheck = { engine: 'MIHOMO', engineVersion: '1.19.30', status: 'EXTERNAL_RESOURCES_REQUIRED', executed: false, scope: 'FULL', diagnostics: ['EXTERNAL_RESOURCES_REQUIRED'],
      resourceRequirements: [{ kind: 'GEOIP', location: 'rules[0]', state: 'MISSING', reasonCode: 'RESOURCE_MISSING', actionCode: 'PREPARE_RESOURCE', references: 1 }], resourceRequirementsTruncated: 0 };
    kernels.validate.mockResolvedValueOnce(kernelCheck);
    const preview = await service.previewTemplate({ format: 'clash', template: { customInjectYaml: 'rules:\n  - GEOIP,CN,DIRECT\n  - MATCH,DIRECT' } });
    expect(preview.kernelCheck).toEqual(kernelCheck);
    expect(preview.content).toContain('GEOIP,CN,DIRECT');
    expect(preview).toEqual(expect.objectContaining({ content: expect.any(String), stats: expect.any(Object), warnings: expect.any(Array) }));
    expect(kernels.validate).toHaveBeenCalledWith('MIHOMO', preview.content);
  });
});
