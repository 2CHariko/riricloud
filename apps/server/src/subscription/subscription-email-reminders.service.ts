import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService, type SystemSettings } from '../system/settings.service';
import { applyPlanSnapshot } from './plan-snapshot';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const RETRY_MS = 6 * 60 * MINUTE_MS;
const EXPIRED_GRACE_MS = DAY_MS;
const RETENTION_MS = 180 * DAY_MS;
const BATCH_SIZE = 100;

export const TRAFFIC_WARNING_KIND = 'TRAFFIC_WARNING';
export const SUBSCRIPTION_EXPIRY_KIND = 'SUBSCRIPTION_EXPIRY';

export function trafficPercentage(used: bigint, limit: bigint): number {
  if (limit <= BigInt(0)) return 100;
  const percentage = Number((used * BigInt(100)) / limit);
  return Math.min(Math.max(percentage, 0), Number.MAX_SAFE_INTEGER);
}

export function currentTrafficMilestone(used: bigint, limit: bigint, thresholds: number[]): number | null {
  const percentage = used >= limit ? 100 : trafficPercentage(used, limit);
  const due = thresholds.filter((threshold) => percentage >= threshold);
  return due.length ? Math.max(...due) : null;
}

export function currentExpiryMilestone(daysRemaining: number, configuredDays: number[]): number | null {
  if (daysRemaining <= 0) return configuredDays.includes(0) ? 0 : null;
  const due = configuredDays.filter((days) => days > 0 && daysRemaining <= days);
  return due.length ? Math.min(...due) : null;
}

export function trafficEventKey(subscription: { trafficPeriodStartAt: Date | null; startedAt: Date; expireAt: Date | null }): string {
  const cycleStart = subscription.trafficPeriodStartAt ?? subscription.startedAt;
  return `${cycleStart.toISOString()}|${subscription.expireAt?.toISOString() ?? 'none'}`;
}

export function expiryEventKey(expireAt: Date): string {
  return expireAt.toISOString();
}

@Injectable()
export class SubscriptionEmailRemindersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionEmailRemindersService.name);
  private startup?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  private lastCleanupAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly mail: MailService
  ) {}

  onModuleInit() {
    this.startup = setTimeout(() => { void this.check(); }, 30000);
    this.startup.unref();
    this.timer = setInterval(() => { void this.check(); }, 5 * MINUTE_MS);
    this.timer.unref();
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.startup) clearTimeout(this.startup);
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  check(): Promise<void> {
    if (this.running) return this.running;
    if (this.stopped) return Promise.resolve();
    this.running = this.run()
      .catch(() => { this.logger.warn('Subscription email reminder sweep failed'); })
      .finally(() => { this.running = undefined; });
    return this.running;
  }

  private async run() {
    const settings = await this.settings.getSettings();
    if (!settings.smtpEnabled || (!settings.trafficWarningMailEnabled && !settings.subscriptionExpiryMailEnabled)) return;
    const now = new Date();
    let cursor: string | undefined;
    while (!this.stopped) {
      const subscriptions = await this.prisma.subscription.findMany({
        where: {
          OR: [
            { status: { in: ['ACTIVE', 'CANCELED'] } },
            { status: 'EXPIRED', expireAt: { gte: new Date(now.getTime() - EXPIRED_GRACE_MS) } }
          ],
          user: {
            isActive: true,
            role: 'USER',
            emailVerifiedAt: { not: null },
            subscriptionEmailNotificationsEnabled: true
          }
        },
        include: {
          user: { select: { id: true, email: true } },
          plan: { select: { name: true } }
        },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
      });
      if (!subscriptions.length) break;
      for (const raw of subscriptions) {
        if (this.stopped) return;
        const subscription = applyPlanSnapshot(raw);
        await this.processSubscription(subscription, settings, now);
      }
      if (subscriptions.length < BATCH_SIZE) break;
      cursor = subscriptions[subscriptions.length - 1].id;
    }
    await this.cleanupOldDeliveries(now);
  }

  private async processSubscription(subscription: {
    id: string;
    status: string;
    trafficLimitBytes: bigint;
    trafficUsedBytes: bigint;
    startedAt: Date;
    expireAt: Date | null;
    trafficPeriodStartAt: Date | null;
    user: { id: string; email: string };
    plan: { name?: string } | null;
  }, settings: SystemSettings, now: Date) {
    const planName = subscription.plan?.name || '当前套餐';
    if (settings.trafficWarningMailEnabled && subscription.status !== 'EXPIRED' && subscription.trafficLimitBytes > BigInt(0)) {
      const milestone = currentTrafficMilestone(subscription.trafficUsedBytes, subscription.trafficLimitBytes, settings.trafficWarningThresholds);
      if (milestone !== null) {
        const percentage = subscription.trafficUsedBytes >= subscription.trafficLimitBytes ? 100 : trafficPercentage(subscription.trafficUsedBytes, subscription.trafficLimitBytes);
        await this.deliver({
          userId: subscription.user.id,
          subscriptionId: subscription.id,
          kind: TRAFFIC_WARNING_KIND,
          milestone: String(milestone),
          eventKey: trafficEventKey(subscription)
        }, now, () => this.mail.sendTrafficWarning(subscription.user.email, {
          planName,
          usedBytes: subscription.trafficUsedBytes,
          limitBytes: subscription.trafficLimitBytes,
          percentage
        }));
      }
    }

    if (settings.subscriptionExpiryMailEnabled && subscription.expireAt && ['ACTIVE', 'CANCELED', 'EXPIRED'].includes(subscription.status)) {
      const expiredFor = now.getTime() - subscription.expireAt.getTime();
      if (!(subscription.status === 'EXPIRED' && expiredFor > EXPIRED_GRACE_MS)) {
        const daysRemaining = subscription.expireAt.getTime() <= now.getTime() ? 0 : Math.ceil((subscription.expireAt.getTime() - now.getTime()) / DAY_MS);
        const milestone = currentExpiryMilestone(daysRemaining, settings.subscriptionExpiryReminderDays);
        if (milestone !== null) {
          await this.deliver({
            userId: subscription.user.id,
            subscriptionId: subscription.id,
            kind: SUBSCRIPTION_EXPIRY_KIND,
            milestone: String(milestone),
            eventKey: expiryEventKey(subscription.expireAt)
          }, now, () => this.mail.sendSubscriptionExpiry(subscription.user.email, {
            planName,
            expireAt: subscription.expireAt!,
            daysRemaining,
            timezone: settings.systemTimezone
          }));
        }
      }
    }
  }

  private async deliver(input: {
    userId: string;
    subscriptionId: string;
    kind: string;
    milestone: string;
    eventKey: string;
  }, now: Date, send: () => Promise<unknown>) {
    const retryBefore = new Date(now.getTime() - RETRY_MS);
    const existing = await this.prisma.subscriptionEmailDelivery.findUnique({
      where: {
        subscriptionId_kind_eventKey_milestone: {
          subscriptionId: input.subscriptionId,
          kind: input.kind,
          eventKey: input.eventKey,
          milestone: input.milestone
        }
      }
    });
    if (existing?.state === 'SENT') return;
    if (existing?.attemptedAt && existing.attemptedAt > retryBefore) return;

    let deliveryId = existing?.id;
    if (!deliveryId) {
      try {
        const created = await this.prisma.subscriptionEmailDelivery.create({
          data: { ...input, state: 'PENDING', errorCode: null }
        });
        deliveryId = created.id;
      } catch (error) {
        if ((error as { code?: string } | null)?.code !== 'P2002') throw error;
        const concurrent = await this.prisma.subscriptionEmailDelivery.findUnique({
          where: {
            subscriptionId_kind_eventKey_milestone: {
              subscriptionId: input.subscriptionId,
              kind: input.kind,
              eventKey: input.eventKey,
              milestone: input.milestone
            }
          }
        });
        if (!concurrent) return;
        deliveryId = concurrent.id;
      }
    }
    const claimed = await this.prisma.subscriptionEmailDelivery.updateMany({
      where: {
        id: deliveryId,
        state: { not: 'SENT' },
        OR: [{ attemptedAt: null }, { attemptedAt: { lte: retryBefore } }]
      },
      data: { state: 'PENDING', attemptedAt: now, errorCode: null }
    });
    if (!claimed.count) return;

    try {
      await send();
      await this.prisma.subscriptionEmailDelivery.update({
        where: { id: deliveryId },
        data: { state: 'SENT', sentAt: new Date(), errorCode: null }
      });
    } catch {
      await this.prisma.subscriptionEmailDelivery.update({
        where: { id: deliveryId },
        data: { state: 'FAILED', errorCode: 'SEND_FAILED' }
      });
      this.logger.warn(`Subscription email delivery failed: ${input.kind}/${input.milestone}`);
    }
  }

  private async cleanupOldDeliveries(now: Date) {
    if (now.getTime() - this.lastCleanupAt < DAY_MS) return;
    this.lastCleanupAt = now.getTime();
    await this.prisma.subscriptionEmailDelivery.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - RETENTION_MS) } }
    });
  }
}
