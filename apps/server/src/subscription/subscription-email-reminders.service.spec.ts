import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../system/settings.service';
import {
  currentExpiryMilestone,
  currentTrafficMilestone,
  expiryEventKey,
  SubscriptionEmailRemindersService,
  trafficEventKey
} from './subscription-email-reminders.service';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function baseSettings(overrides: Record<string, unknown> = {}) {
  return {
    smtpEnabled: true,
    trafficWarningMailEnabled: true,
    trafficWarningThresholds: [80, 95, 100],
    subscriptionExpiryMailEnabled: true,
    subscriptionExpiryReminderDays: [7, 3, 1, 0],
    systemTimezone: 'Asia/Shanghai',
    publicBaseUrl: 'https://panel.example.com',
    ...overrides
  };
}

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    status: 'ACTIVE',
    trafficLimitBytes: BigInt(100),
    trafficUsedBytes: BigInt(96),
    startedAt: new Date('2026-11-01T00:00:00Z'),
    expireAt: new Date(Date.now() + 10 * DAY_MS),
    trafficPeriodStartAt: new Date('2026-11-01T00:00:00Z'),
    user: { id: 'user-1', email: 'user@example.com', nickname: 'Alice', uid: 123456 },
    plan: { name: 'Pro' },
    ...overrides
  };
}

function createPrismaMock() {
  const deliveries = new Map<string, Record<string, unknown>>();
  let sequence = 0;
  const keyOf = (input: { subscriptionId: string; kind: string; eventKey: string; milestone: string }) =>
    `${input.subscriptionId}|${input.kind}|${input.eventKey}|${input.milestone}`;
  const prisma = {
    subscription: { findMany: jest.fn().mockResolvedValue([]) },
    subscriptionEmailDelivery: {
      findUnique: jest.fn(async ({ where }: { where: { subscriptionId_kind_eventKey_milestone: { subscriptionId: string; kind: string; eventKey: string; milestone: string } } }) => {
        return deliveries.get(keyOf(where.subscriptionId_kind_eventKey_milestone)) ?? null;
      }),
      create: jest.fn(async ({ data }: { data: { subscriptionId: string; kind: string; eventKey: string; milestone: string } & Record<string, unknown> }) => {
        sequence += 1;
        const record = { id: `delivery-${sequence}`, attemptedAt: null, sentAt: null, errorCode: null, createdAt: new Date(), ...data };
        deliveries.set(keyOf(data), record);
        return record;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string; OR: Array<{ attemptedAt: { lte: Date } }> }; data: Record<string, unknown> }) => {
        const record = [...deliveries.values()].find((item) => item.id === where.id);
        if (!record || record.state === 'SENT') return { count: 0 };
        const retryBefore = where.OR[1].attemptedAt.lte;
        if (record.attemptedAt && (record.attemptedAt as Date) > retryBefore) return { count: 0 };
        Object.assign(record, data);
        return { count: 1 };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const record = [...deliveries.values()].find((item) => item.id === where.id);
        if (!record) throw new Error('missing delivery');
        Object.assign(record, data);
        return record;
      }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 })
    }
  };
  return { prisma, deliveries };
}

describe('subscription email reminder milestones', () => {
  it('流量只选择当前已经跨过的最高阈值', () => {
    expect(currentTrafficMilestone(BigInt(79), BigInt(100), [80, 95, 100])).toBeNull();
    expect(currentTrafficMilestone(BigInt(80), BigInt(100), [80, 95, 100])).toBe(80);
    expect(currentTrafficMilestone(BigInt(96), BigInt(100), [80, 95, 100])).toBe(95);
    expect(currentTrafficMilestone(BigInt(100), BigInt(100), [80, 95, 100])).toBe(100);
  });

  it('到期只选择当前最紧迫阶段且不补发更早阶段', () => {
    const days = [7, 3, 1, 0];
    expect(currentExpiryMilestone(8, days)).toBeNull();
    expect(currentExpiryMilestone(7, days)).toBe(7);
    expect(currentExpiryMilestone(2, days)).toBe(3);
    expect(currentExpiryMilestone(0, days)).toBe(0);
    expect(currentExpiryMilestone(-1, [7, 3, 1])).toBeNull();
  });

  it('周期键在续期或流量周期变化后改变', () => {
    const base = { startedAt: new Date('2026-11-01T00:00:00Z'), trafficPeriodStartAt: null, expireAt: new Date('2026-12-01T00:00:00Z') };
    expect(trafficEventKey(base)).not.toBe(trafficEventKey({ ...base, expireAt: new Date('2027-01-01T00:00:00Z') }));
    expect(expiryEventKey(base.expireAt)).not.toBe(expiryEventKey(new Date('2027-01-01T00:00:00Z')));
  });
});

describe('SubscriptionEmailRemindersService', () => {
  it('发送当前最高流量阈值并保证后续巡检不重复发送', async () => {
    const { prisma, deliveries } = createPrismaMock();
    prisma.subscription.findMany.mockResolvedValue([subscription()]);
    const settings = { getSettings: jest.fn().mockResolvedValue(baseSettings()) };
    const mail = { sendTrafficWarning: jest.fn().mockResolvedValue({}), sendSubscriptionExpiry: jest.fn() };
    const service = new SubscriptionEmailRemindersService(prisma as unknown as PrismaService, settings as unknown as SettingsService, mail as unknown as MailService);

    await service.check();
    expect(mail.sendTrafficWarning).toHaveBeenCalledTimes(1);
    expect(mail.sendTrafficWarning.mock.calls[0][1]).toEqual(expect.objectContaining({ percentage: 96, planName: 'Pro' }));
    expect([...deliveries.values()][0]).toEqual(expect.objectContaining({ kind: 'TRAFFIC_WARNING', milestone: '95', state: 'SENT' }));

    await service.check();
    expect(mail.sendTrafficWarning).toHaveBeenCalledTimes(1);
  });

  it('查询条件只包含启用偏好、已验证邮箱且处于有效状态的普通用户', async () => {
    const { prisma } = createPrismaMock();
    const settings = { getSettings: jest.fn().mockResolvedValue(baseSettings({ subscriptionExpiryMailEnabled: false })) };
    const mail = { sendTrafficWarning: jest.fn(), sendSubscriptionExpiry: jest.fn() };
    const service = new SubscriptionEmailRemindersService(prisma as unknown as PrismaService, settings as unknown as SettingsService, mail as unknown as MailService);
    await service.check();
    expect(prisma.subscription.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        user: {
          isActive: true,
          role: 'USER',
          emailVerifiedAt: { not: null },
          subscriptionEmailNotificationsEnabled: true
        }
      })
    }));
  });

  it('到期邮件在已过期但仍在 24 小时宽限期内发送', async () => {
    const { prisma } = createPrismaMock();
    prisma.subscription.findMany.mockResolvedValue([subscription({
      status: 'EXPIRED',
      expireAt: new Date(Date.now() - HOUR_MS),
      trafficUsedBytes: BigInt(0)
    })]);
    const settings = { getSettings: jest.fn().mockResolvedValue(baseSettings({ trafficWarningMailEnabled: false })) };
    const mail = { sendTrafficWarning: jest.fn(), sendSubscriptionExpiry: jest.fn().mockResolvedValue({}) };
    const service = new SubscriptionEmailRemindersService(prisma as unknown as PrismaService, settings as unknown as SettingsService, mail as unknown as MailService);

    await service.check();
    expect(mail.sendSubscriptionExpiry).toHaveBeenCalledWith('user@example.com', expect.objectContaining({ daysRemaining: 0, planName: 'Pro' }));
  });

  it('SMTP 失败后记录 FAILED，6 小时内不重试，之后可恢复发送', async () => {
    const { prisma, deliveries } = createPrismaMock();
    prisma.subscription.findMany.mockResolvedValue([subscription({ expireAt: new Date(Date.now() + 6 * DAY_MS), status: 'ACTIVE' })]);
    const settings = { getSettings: jest.fn().mockResolvedValue(baseSettings({ trafficWarningMailEnabled: false })) };
    const mail = { sendTrafficWarning: jest.fn(), sendSubscriptionExpiry: jest.fn().mockRejectedValueOnce(new Error('smtp down')).mockResolvedValue({}) };
    const service = new SubscriptionEmailRemindersService(prisma as unknown as PrismaService, settings as unknown as SettingsService, mail as unknown as MailService);

    await service.check();
    expect(mail.sendSubscriptionExpiry).toHaveBeenCalledTimes(1);
    const record = [...deliveries.values()][0];
    expect(record).toEqual(expect.objectContaining({ state: 'FAILED', errorCode: 'SEND_FAILED' }));

    await service.check();
    expect(mail.sendSubscriptionExpiry).toHaveBeenCalledTimes(1);

    record.attemptedAt = new Date(Date.now() - 7 * HOUR_MS);
    await service.check();
    expect(mail.sendSubscriptionExpiry).toHaveBeenCalledTimes(2);
    expect(record.state).toBe('SENT');
  });
});
