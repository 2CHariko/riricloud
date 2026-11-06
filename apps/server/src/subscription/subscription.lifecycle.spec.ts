import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AgentGatewayService } from '../agent-gateway/agent-gateway.service';
import { LinesService } from '../lines/lines.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionService } from './subscription.service';
import { WalletService } from '../wallet/wallet.service';
import { PlanPurchasesService } from './plan-purchases.service';

describe('SubscriptionService lifecycle', () => {
  let service: SubscriptionService;
  const plan = {
    id: 'p1', name: '体验', isPublic: true, price: 1000, durationDays: 30, trafficLimitBytes: BigInt(1000),
    trafficResetMode: 'NONE', lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]', template: null,
    purchaseLimitPerUser: 1, allowRenewal: false
  };
  const subscription = {
    id: 's1', userId: 'u1', planId: 'p1', status: 'ACTIVE', trafficLimitBytes: BigInt(1000), trafficUsedBytes: BigInt(0),
    startedAt: new Date(), expireAt: new Date(Date.now() + 86400000), subscriptionToken: 'token', canceledAt: null,
    trafficPeriodStartAt: null, createdAt: new Date(), updatedAt: new Date(), plan, user: { id: 'u1', email: 'u@example.com', uuid: 'uuid', password: null, isActive: true, expireAt: null, trafficLimitBytes: BigInt(1000), trafficUsedBytes: BigInt(0), extraLineGrants: [] }
  };
  const tx = {
    subscription: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), delete: jest.fn() },
    plan: { findUnique: jest.fn() },
    userLineGrant: { deleteMany: jest.fn(), createMany: jest.fn() },
    user: { update: jest.fn() },
    balanceTransaction: { create: jest.fn() },
    planPurchase: { update: jest.fn() }
  };
  const prisma = {
    plan: { findUnique: jest.fn() },
    line: { findMany: jest.fn() },
    subscription: { findUnique: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn(), update: jest.fn() },
    node: { findMany: jest.fn() },
    $transaction: jest.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx))
  };
  const gateway = { pushConfigToAll: jest.fn() };
  const linesService = { getAvailableForPlan: jest.fn() };
  const walletService = { applyBalanceChange: jest.fn() };
  const planPurchases = { claim: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [SubscriptionService, { provide: PrismaService, useValue: prisma }, { provide: AgentGatewayService, useValue: gateway }, { provide: LinesService, useValue: linesService }, { provide: WalletService, useValue: walletService }, { provide: PlanPurchasesService, useValue: planPurchases }]
    }).compile();
    service = moduleRef.get(SubscriptionService);
  });

  beforeEach(() => {
    tx.subscription.updateMany.mockResolvedValue({ count: 0 });
    prisma.line.findMany.mockResolvedValue([]);
    planPurchases.claim.mockResolvedValue('purchase-1');
  });

  afterEach(() => jest.clearAllMocks());


  const redeemedSnapshot = {
    id: 'p1', name: '体验快照', description: null, price: 0, durationDays: 30, trafficLimitBytes: '2048',
    trafficResetMode: 'NONE', lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]', templateId: null,
    badgeText: null, isFeatured: false, featuresJson: '[]', cardConfigJson: '{}', isPublic: true, sortOrder: 0,
    purchaseLimitPerUser: 1, allowRenewal: false, speedLimitMbps: null, appendSpeedBadge: '', template: null
  } as const;

  it('套餐卡复用失效订阅时，在购买台账中直接关联真实订阅 ID', async () => {
    tx.plan.findUnique.mockResolvedValue(plan);
    tx.subscription.findUnique.mockResolvedValue({ ...subscription, status: 'EXPIRED', expireAt: new Date(Date.now() - 86400000) });
    tx.subscription.update.mockResolvedValue({ ...subscription, status: 'ACTIVE' });

    await service.activateRedeemedPlan('u1', redeemedSnapshot, tx as never);

    expect(planPurchases.claim).toHaveBeenCalledWith('u1', plan, 'REDEEM_CODE', 's1', tx);
    expect(tx.planPurchase.update).not.toHaveBeenCalled();
  });

  it('套餐卡创建新订阅后再写入绑定真实订阅 ID 的购买台账', async () => {
    const created = { ...subscription, id: 's-new', status: 'ACTIVE' };
    tx.plan.findUnique.mockResolvedValue(plan);
    tx.subscription.findUnique.mockResolvedValue(null);
    tx.subscription.create.mockResolvedValue(created);

    await service.activateRedeemedPlan('u1', redeemedSnapshot, tx as never);

    expect(planPurchases.claim).toHaveBeenCalledWith('u1', plan, 'REDEEM_CODE', 's-new', tx);
    expect(tx.subscription.create.mock.invocationCallOrder[0]).toBeLessThan(planPurchases.claim.mock.invocationCallOrder[0]);
    expect(tx.planPurchase.update).not.toHaveBeenCalled();
  });

  it('套餐卡遇到有效订阅时不写购买台账或更改订阅', async () => {
    tx.plan.findUnique.mockResolvedValue(plan);
    tx.subscription.findUnique.mockResolvedValue(subscription);

    await expect(service.activateRedeemedPlan('u1', redeemedSnapshot, tx as never)).rejects.toThrow(ConflictException);

    expect(planPurchases.claim).not.toHaveBeenCalled();
    expect(tx.subscription.update).not.toHaveBeenCalled();
    expect(tx.subscription.create).not.toHaveBeenCalled();
  });

  it('首次订购创建唯一订阅并同步 User 镜像字段', async () => {
    prisma.plan.findUnique.mockResolvedValue(plan);
    tx.subscription.findUnique.mockResolvedValue(null);
    tx.subscription.create.mockResolvedValue(subscription);
    prisma.subscription.findUnique.mockResolvedValue(subscription);
    await service.subscribe('u1', 'p1');
    expect(tx.subscription.create).toHaveBeenCalled();
    expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u1' } }));
    expect(gateway.pushConfigToAll).toHaveBeenCalled();
  });

  it('有效订阅再次订购被拒绝，防止 1:1 重复实例', async () => {
    prisma.plan.findUnique.mockResolvedValue(plan);
    tx.subscription.findUnique.mockResolvedValue(subscription);
    await expect(service.subscribe('u1', 'p1')).rejects.toThrow(ConflictException);
  });

  it('免费套餐已领取后再次订购返回 ConflictException', async () => {
    prisma.plan.findUnique.mockResolvedValue(plan);
    tx.subscription.findUnique.mockResolvedValue(null);
    planPurchases.claim.mockRejectedValue(new ConflictException('该套餐每位用户仅可购买一次'));

    await expect(service.subscribe('u1', 'p1')).rejects.toThrow(ConflictException);
    expect(tx.subscription.create).not.toHaveBeenCalled();
  });

  it('免费套餐禁止续费', async () => {
    prisma.subscription.findUnique.mockResolvedValue({ ...subscription, plan });
    prisma.plan.findUnique.mockResolvedValue(plan);

    await expect(service.renew('u1')).rejects.toThrow('该套餐不支持续费');
  });

  it('升配目标套餐消耗一次限购名额', async () => {
    const currentPlan = { ...plan, id: 'current-plan', price: 500 };
    const paidPlan = { ...plan, id: 'p2', price: 2000, purchaseLimitPerUser: 1, allowRenewal: true };
    prisma.plan.findUnique.mockResolvedValue(paidPlan);
    prisma.subscription.findUnique.mockResolvedValueOnce({ ...subscription, plan: currentPlan });
    tx.subscription.update.mockResolvedValue({ ...subscription, planId: 'p2', plan: paidPlan });
    prisma.subscription.findUnique.mockResolvedValueOnce({ ...subscription, planId: 'p2', plan: paidPlan });

    await service.upgrade('u1', 'p2');

    expect(planPurchases.claim).toHaveBeenCalledWith('u1', paidPlan, 'SELF_UPGRADE', 's1', tx);
    expect(tx.planPurchase.update).toHaveBeenCalledWith({
      where: { id: 'purchase-1' },
      data: { subscriptionId: 's1' }
    });
  });

  it('目标套餐等于当前套餐时拒绝升配并提示使用续费', async () => {
    prisma.plan.findUnique.mockResolvedValue(plan);
    prisma.subscription.findUnique.mockResolvedValue({ ...subscription, plan });

    await expect(service.upgrade('u1', 'p1')).rejects.toThrow('请使用续费');
  });

  it('管理员为无订阅用户绑定套餐时在事务内创建订阅并同步 User 镜像', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u2' });
    prisma.plan.findUnique.mockResolvedValue(plan);
    prisma.subscription.findUnique.mockReset();
    prisma.subscription.findUnique.mockResolvedValueOnce(null);
    tx.subscription.create.mockResolvedValue({ ...subscription, id: 's2', userId: 'u2' });
    prisma.subscription.findUnique.mockResolvedValueOnce({ ...subscription, id: 's2', userId: 'u2' });

    await service.adminAssign('u2', { planId: 'p1' });

    expect(tx.subscription.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'u2', planId: 'p1', status: 'ACTIVE' })
    }));
    expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u2' } }));
  });

  it('管理员选择无套餐时删除订阅并使旧 Token 失效', async () => {
    prisma.subscription.findUnique.mockResolvedValue(subscription);

    const result = await service.adminUpdate('s1', { planId: null });

    expect(tx.subscription.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: {
        subscriptionToken: expect.any(String),
        trafficLimitBytes: BigInt(0),
        trafficUsedBytes: BigInt(0),
        expireAt: null
      }
    });
    expect(tx.userLineGrant.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(result).toEqual({ removed: true, id: 's1', userId: 'u1' });
    expect(gateway.pushConfigToAll).toHaveBeenCalled();
  });

  it('管理员仅调整额度而未变更套餐时不写购买台账', async () => {
    prisma.subscription.findUnique.mockResolvedValue({ ...subscription, plan });
    tx.subscription.update.mockResolvedValue({ ...subscription, plan });
    prisma.subscription.findUnique.mockResolvedValue({ ...subscription, plan });

    await service.adminUpdate('s1', { trafficLimitBytes: 5000 });

    expect(planPurchases.claim).not.toHaveBeenCalled();
    expect(tx.planPurchase.update).not.toHaveBeenCalled();
  });

  it('管理员变更套餐时破例写入 ADMIN 来源台账', async () => {
    const targetPlan = { ...plan, id: 'p-admin', price: 2000 };
    prisma.plan.findUnique.mockResolvedValue(targetPlan);
    tx.subscription.update.mockResolvedValue({ ...subscription, plan: targetPlan, planId: 'p-admin' });
    prisma.subscription.findUnique
      .mockResolvedValueOnce({ ...subscription, plan })
      .mockResolvedValueOnce({ ...subscription, plan: targetPlan, planId: 'p-admin' });

    await service.adminUpdate('s1', { planId: 'p-admin' });

    expect(planPurchases.claim).toHaveBeenCalledWith(
      'u1',
      targetPlan,
      'ADMIN',
      's1',
      tx,
      { allowExceedLimit: true }
    );
    expect(tx.planPurchase.update).toHaveBeenCalledWith({
      where: { id: 'purchase-1' },
      data: { subscriptionId: 's1' }
    });
  });

  it('管理员实际修改流量配额时递增流量预警版本', async () => {
    const current = { ...subscription, plan: { ...plan, trafficResetMode: 'CALENDAR_MONTH' } };
    prisma.subscription.findUnique.mockResolvedValue(current);
    tx.subscription.update.mockResolvedValue({ ...current, trafficLimitBytes: BigInt(2000), trafficWarningVersion: 1 });

    await service.adminUpdate('s1', { trafficLimitBytes: 2000 });

    expect(tx.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 's1' },
      data: expect.objectContaining({ trafficWarningVersion: { increment: 1 } })
    }));
  });

  it('管理员保存相同流量配额时不递增流量预警版本', async () => {
    prisma.subscription.findUnique.mockResolvedValue({ ...subscription, plan: { ...plan, trafficResetMode: 'CALENDAR_MONTH' } });
    tx.subscription.update.mockResolvedValue(subscription);

    await service.adminUpdate('s1', { trafficLimitBytes: 1000 });

    expect(tx.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 's1' },
      data: expect.not.objectContaining({ trafficWarningVersion: expect.anything() })
    }));
  });

  it('首次订购付费套餐会在订阅事务内扣除余额', async () => {
    const paidPlan = { ...plan, price: 1999 };
    prisma.plan.findUnique.mockResolvedValue(paidPlan);
    tx.subscription.findUnique.mockResolvedValue(null);
    tx.subscription.create.mockResolvedValue({ ...subscription, plan: paidPlan });
    prisma.subscription.findUnique.mockResolvedValue({ ...subscription, plan: paidPlan });

    await service.subscribe('u1', 'p1');

    expect(walletService.applyBalanceChange).toHaveBeenCalledWith(
      tx,
      'u1',
      -1999,
      'PLAN_BUY',
      '订购套餐',
      's1'
    );
  });

  it('续费会顺延周期、重置流量并扣除当前套餐价格', async () => {
    const paidPlan = { ...plan, price: 500, allowRenewal: true };
    prisma.subscription.findUnique.mockResolvedValue(subscription);
    prisma.plan.findUnique.mockResolvedValue(paidPlan);
    tx.subscription.update.mockResolvedValue({ ...subscription, plan: paidPlan, trafficUsedBytes: BigInt(0) });
    prisma.subscription.findUnique.mockResolvedValue({ ...subscription, plan: paidPlan, trafficUsedBytes: BigInt(0) });

    await service.renew('u1');

    expect(tx.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 's1' },
      data: expect.objectContaining({ status: 'ACTIVE', trafficUsedBytes: BigInt(0) })
    }));
    expect(walletService.applyBalanceChange).toHaveBeenCalledWith(
      tx,
      'u1',
      -500,
      'PLAN_RENEW',
      '续费套餐',
      's1'
    );
  });

  it('已有订阅首次启用重置策略时只初始化周期起点，不清空当前用量', async () => {
    const resetPlan = { ...plan, trafficResetMode: 'CALENDAR_MONTH' };
    const legacy = {
      ...subscription,
      trafficUsedBytes: BigInt(123),
      trafficPeriodStartAt: null,
      plan: resetPlan,
      user: { ...subscription.user, extraLineGrants: [] }
    };
    prisma.subscription.findUnique.mockResolvedValue(legacy);
    tx.subscription.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.get('s1');

    expect(result.trafficUsedBytes).toBe(123);
    expect(tx.subscription.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', trafficPeriodStartAt: null },
      data: { trafficPeriodStartAt: expect.any(Date) }
    });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('续费周期套餐时按原订阅起点计算当前周期，而不是把周期起点回退到初始日期', async () => {
    const cyclePlan = { ...plan, trafficResetMode: 'SUBSCRIPTION_CYCLE', allowRenewal: true };
    const current = { ...subscription, plan: cyclePlan, startedAt: new Date(Date.now() - 45 * 86400000) };
    prisma.subscription.findUnique.mockResolvedValue(current);
    prisma.plan.findUnique.mockResolvedValue(cyclePlan);
    tx.subscription.update.mockResolvedValue({ ...current, plan: cyclePlan, trafficUsedBytes: BigInt(0) });
    prisma.subscription.findUnique.mockResolvedValue({ ...current, plan: cyclePlan, trafficUsedBytes: BigInt(0) });

    await service.renew('u1');

    const update = tx.subscription.update.mock.calls[0][0] as { data: { trafficPeriodStartAt: Date } };
    expect(update.data.trafficPeriodStartAt.getTime()).toBeGreaterThan(current.startedAt.getTime());
  });

  it('额外线路授权全量替换，移除订阅时同步清空授权关系', async () => {
    prisma.subscription.findUnique.mockResolvedValue({ ...subscription, user: { ...subscription.user, extraLineGrants: [] } });
    prisma.line.findMany.mockResolvedValue([{ id: 'line-1' }, { id: 'line-2' }]);
    tx.subscription.update.mockResolvedValue(subscription);
    await service.adminUpdate('s1', { extraLineIds: ['line-1', 'line-1'] });

    expect(tx.userLineGrant.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(tx.userLineGrant.createMany).toHaveBeenCalledWith({ data: [{ userId: 'u1', lineId: 'line-1' }] });

    tx.userLineGrant.deleteMany.mockClear();
    tx.userLineGrant.createMany.mockClear();
    prisma.subscription.findUnique.mockResolvedValue({ ...subscription, user: { ...subscription.user, extraLineGrants: [{ lineId: 'line-1' }] } });
    const result = await service.adminUpdate('s1', { planId: null, extraLineIds: [] });

    expect(result).toEqual({ removed: true, id: 's1', userId: 'u1' });
    expect(tx.userLineGrant.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(tx.userLineGrant.createMany).not.toHaveBeenCalled();
  });

  it('禁止向价格更低的套餐升配', async () => {
    const lowerPlan = { ...plan, id: 'p2', name: '低价套餐', price: 500 };
    prisma.plan.findUnique.mockResolvedValue(lowerPlan);
    prisma.subscription.findUnique.mockResolvedValue(subscription);

    await expect(service.upgrade('u1', 'p2')).rejects.toThrow('不能升级到价格更低的套餐');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
