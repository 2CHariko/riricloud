import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { PlansService } from './plans.service';
import { UpdatePlanDto } from './dto/update-plan.dto';

describe('PlansService', () => {
  let service: PlansService;
  const prisma = {
    plan: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn(), update: jest.fn(), delete: jest.fn() },
    subscriptionTemplate: { findUnique: jest.fn() },
    $transaction: jest.fn()
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PlansService, { provide: PrismaService, useValue: prisma }]
    }).compile();
    service = moduleRef.get(PlansService);
  });

  afterEach(() => jest.clearAllMocks());

  it('按标签匹配在线线路并解析线路标签', async () => {
    prisma.plan.findUnique.mockResolvedValue({
      id: 'p1', lineMatchMode: 'TAGS', lineTagsJson: '["vip"]', lineIdsJson: '[]'
    });
    const linesService = {
      getAvailableForPlan: jest.fn().mockResolvedValue([
        { id: 'l1', name: 'VIP 线路', tags: ['vip', 'hk'] }
      ]),
      toUserSummary: jest.fn((line: { id: string; name: string; tags: string[] }) => ({ id: line.id, name: line.name, tags: line.tags }))
    };
    service = new PlansService(prisma as never, linesService as never);
    await expect(service.getAvailableNodes('p1')).resolves.toEqual([
      { id: 'l1', name: 'VIP 线路', tags: ['vip', 'hk'] }
    ]);
    expect(linesService.getAvailableForPlan).toHaveBeenCalledWith(expect.objectContaining({ lineMatchMode: 'TAGS' }));
  });

  it('创建套餐时将字节数和匹配列表持久化为结构化字段', async () => {
    prisma.subscriptionTemplate.findUnique.mockResolvedValue(null);
    prisma.plan.create.mockResolvedValue({
      id: 'p1', name: '基础', description: null, price: 0, durationDays: 30,
      trafficLimitBytes: BigInt(1024), lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]',
      templateId: null, isPublic: true, sortOrder: 0
    });
    await service.create({ name: '基础', durationDays: 30, trafficLimitBytes: 1024 });
      expect(prisma.plan.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ trafficLimitBytes: BigInt(1024), lineTagsJson: '[]', lineIdsJson: '[]' })
    }));
  });

  it('以元接收价格并按分写入数据库', async () => {
    prisma.subscriptionTemplate.findUnique.mockResolvedValue(null);
    prisma.plan.create.mockResolvedValue({
      id: 'p2', name: '付费', description: null, price: 1234, durationDays: 30,
      trafficLimitBytes: BigInt(1024), lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]',
      templateId: null, isPublic: true, sortOrder: 0
    });
    await service.create({ name: '付费', price: 12.34, durationDays: 30, trafficLimitBytes: 1024 });
    expect(prisma.plan.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ price: 1234 }) }));
  });

  it('新建免费套餐默认限购一次且不可续费', async () => {
    prisma.subscriptionTemplate.findUnique.mockResolvedValue(null);
    prisma.plan.create.mockResolvedValue({
      id: 'free', name: '免费', description: null, price: 0, durationDays: 30,
      trafficLimitBytes: BigInt(1024), lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]',
      templateId: null, isPublic: true, sortOrder: 0, purchaseLimitPerUser: 1, allowRenewal: false
    });

    await service.create({ name: '免费', price: 0, durationDays: 30, trafficLimitBytes: 1024 });

    expect(prisma.plan.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ purchaseLimitPerUser: 1, allowRenewal: false })
    });
  });

  it('新建付费套餐默认不限购且允许续费', async () => {
    prisma.subscriptionTemplate.findUnique.mockResolvedValue(null);
    prisma.plan.create.mockResolvedValue({
      id: 'paid', name: '付费', description: null, price: 1000, durationDays: 30,
      trafficLimitBytes: BigInt(1024), lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]',
      templateId: null, isPublic: true, sortOrder: 0, purchaseLimitPerUser: null, allowRenewal: true
    });

    await service.create({ name: '付费', price: 10, durationDays: 30, trafficLimitBytes: 1024 });

    expect(prisma.plan.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ purchaseLimitPerUser: null, allowRenewal: true })
    });
  });

  it('存在购买台账时禁止删除套餐', async () => {
    const tx = {
      plan: {
        findUnique: jest.fn().mockResolvedValue({ id: 'free', _count: { subscriptions: 0, purchases: 1 } }),
        delete: jest.fn()
      },
      redeemCode: { count: jest.fn().mockResolvedValue(0) },
      redeemCodeCategory: { updateMany: jest.fn() }
    };
    prisma.$transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));

    await expect(service.remove('free')).rejects.toThrow('已有订阅或购买记录');
    expect(tx.plan.delete).not.toHaveBeenCalled();
  });

  it('创建套餐时支持保存并序列化 badgeText, isFeatured 与 features', async () => {
    prisma.subscriptionTemplate.findUnique.mockResolvedValue(null);
    prisma.plan.create.mockResolvedValue({
      id: 'p3', name: '尊享套餐', description: '旗舰', price: 9900, durationDays: 30,
      trafficLimitBytes: BigInt(1024), lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]',
      templateId: null, isPublic: true, sortOrder: 0,
      badgeText: 'HOT', isFeatured: true, featuresJson: '["专线接入","流媒体解锁"]'
    });
    const result = await service.create({
      name: '尊享套餐',
      description: '旗舰',
      price: 99,
      durationDays: 30,
      trafficLimitBytes: 1024,
      badgeText: 'HOT',
      isFeatured: true,
      features: ['专线接入', '流媒体解锁']
    });
    expect(prisma.plan.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        badgeText: 'HOT',
        isFeatured: true,
        featuresJson: '["专线接入","流媒体解锁"]'
      })
    }));
    expect(result).toMatchObject({
      badgeText: 'HOT',
      isFeatured: true,
      features: ['专线接入', '流媒体解锁']
    });
  });

  it('创建套餐时支持保存并反序列化 cardConfig 动态配置', async () => {
    prisma.subscriptionTemplate.findUnique.mockResolvedValue(null);
    prisma.plan.create.mockResolvedValue({
      id: 'p4', name: '流光旗舰版', description: '炫彩流光', price: 6800, durationDays: 90,
      trafficLimitBytes: BigInt(2048), lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]',
      templateId: null, isPublic: true, sortOrder: 0,
      badgeText: 'HOT', isFeatured: true, featuresJson: '[]',
      cardConfigJson: JSON.stringify({
        themeColor: 'amber',
        icon: 'Crown',
        animationEffect: 'beam_pulse',
        beamColor: 'rainbow',
        shimmerButton: true,
        originalPrice: 88,
        discountText: '立省 20 元',
        syncToSubscription: true
      })
    });
    const result = await service.create({
      name: '流光旗舰版',
      price: 68,
      durationDays: 90,
      trafficLimitBytes: 2048,
      cardConfig: {
        themeColor: 'amber',
        icon: 'Crown',
        animationEffect: 'beam_pulse',
        beamColor: 'rainbow',
        shimmerButton: true,
        originalPrice: 88,
        discountText: '立省 20 元',
        syncToSubscription: true
      }
    });
    expect(prisma.plan.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        cardConfigJson: expect.stringContaining('"syncToSubscription":true')
      })
    }));
    expect(result).toMatchObject({
      cardConfig: {
        themeColor: 'amber',
        icon: 'Crown',
        animationEffect: 'beam_pulse',
        beamColor: 'rainbow',
        shimmerButton: true,
        originalPrice: 88,
        discountText: '立省 20 元',
        syncToSubscription: true
      }
    });
  });

  it('UpdatePlanDto 配合 ValidationPipe 正常接受 cardConfig.syncToSubscription', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const payload = {
      cardConfig: {
        themeColor: 'emerald',
        syncToSubscription: true
      }
    };
    const transformed = await pipe.transform(payload, {
      type: 'body',
      metatype: UpdatePlanDto
    });
    expect(transformed.cardConfig?.syncToSubscription).toBe(true);
    expect(transformed.cardConfig?.themeColor).toBe('emerald');
  });
  it('创建套餐时保存设备限制，未指定时默认为不限', async () => {
    prisma.subscriptionTemplate.findUnique.mockResolvedValue(null);
    prisma.plan.create.mockResolvedValue({
      id: 'p-device', name: '设备套餐', description: null, price: 0, durationDays: 30,
      trafficLimitBytes: BigInt(1024), trafficResetMode: 'NONE', lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]',
      templateId: null, isPublic: true, sortOrder: 0, deviceLimit: 3
    });

    await service.create({ name: '设备套餐', durationDays: 30, trafficLimitBytes: 1024, deviceLimit: 3 });

    expect(prisma.plan.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ deviceLimit: 3 }) }));
  });

  it('更新套餐时只在请求提供设备限制时写入该字段', async () => {
    prisma.plan.findUnique.mockResolvedValue({
      id: 'p-device', name: '设备套餐', description: null, price: 0, durationDays: 30,
      trafficLimitBytes: BigInt(1024), trafficResetMode: 'NONE', lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]',
      templateId: null, isPublic: true, sortOrder: 0, deviceLimit: 3
    });
    prisma.plan.update.mockResolvedValue({
      id: 'p-device', name: '设备套餐', description: null, price: 0, durationDays: 30,
      trafficLimitBytes: BigInt(1024), trafficResetMode: 'NONE', lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]',
      templateId: null, isPublic: true, sortOrder: 0, deviceLimit: 5
    });

    await service.update('p-device', { deviceLimit: 5 });

    expect(prisma.plan.update).toHaveBeenCalledWith({ where: { id: 'p-device' }, data: { deviceLimit: 5 } });
  });

  it('套餐设为非公开或删除时自动清理引用该套餐的 defaultPlanId 设置', async () => {
    const deleteManyMock = jest.fn().mockResolvedValue({ count: 1 });
    (prisma as unknown as { systemSetting: { deleteMany: jest.Mock } }).systemSetting = {
      deleteMany: deleteManyMock
    };
    prisma.plan.findUnique.mockResolvedValue({
      id: 'p-default', name: '默认套餐', description: null, price: 0, durationDays: 30,
      trafficLimitBytes: BigInt(1024), trafficResetMode: 'NONE', lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]',
      templateId: null, isPublic: true, sortOrder: 0, deviceLimit: null
    });
    prisma.plan.update.mockResolvedValue({
      id: 'p-default', name: '默认套餐', description: null, price: 0, durationDays: 30,
      trafficLimitBytes: BigInt(1024), trafficResetMode: 'NONE', lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]',
      templateId: null, isPublic: false, sortOrder: 0, deviceLimit: null
    });

    await service.update('p-default', { isPublic: false });
    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { key: 'defaultPlanId', value: 'p-default' }
    });

    const txDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      plan: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p-default', _count: { subscriptions: 0, purchases: 0 } }),
        delete: jest.fn().mockResolvedValue({ id: 'p-default' })
      },
      redeemCode: { count: jest.fn().mockResolvedValue(0) },
      redeemCodeCategory: { updateMany: jest.fn() },
      systemSetting: { deleteMany: txDeleteMany }
    };
    prisma.$transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));

    await service.remove('p-default');
    expect(txDeleteMany).toHaveBeenCalledWith({
      where: { key: 'defaultPlanId', value: 'p-default' }
    });
  });

});
