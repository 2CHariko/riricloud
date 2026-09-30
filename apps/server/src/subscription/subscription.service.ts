import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AgentService } from '../agent-gateway/agent.service';
import { LinesService } from '../lines/lines.service';
import { isUserEntitled } from '../common/utils';
import type { ProtocolType } from '../common/constants';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildClashYaml,
  buildSingboxJson,
  buildUriList,
  type SubNode,
  type SubLine,
  type SubUser
} from './builders';
import type { AdminUpdateSubDto } from './dto/admin-update-subscription.dto';
import type { QuerySubscriptionDto } from './dto/query-subscription.dto';
import type { Prisma } from '@prisma/client';
import type { SubscriptionTemplateConfig } from './builders';
import { SettingsService } from '../system/settings.service';
import { WalletService } from '../wallet/wallet.service';
import { getTrafficPeriod } from '../common/traffic-reset';
import type { PlanPurchaseSource } from './plan-purchases.service';
import { PlanPurchasesService } from './plan-purchases.service';
import { formatSpeedLimit } from '../common/speed-format';
import { applyPlanSnapshot, type RedeemedPlanSnapshot } from './plan-snapshot';

type SubscriptionPlan = {
  id: string;
  name: string;
  durationDays: number;
  trafficLimitBytes: bigint;
  trafficResetMode: string;
  lineMatchMode: string;
  lineTagsJson: string;
  lineIdsJson: string;
  isPublic?: boolean;
  price?: number;
  purchaseLimitPerUser?: number | null;
  allowRenewal?: boolean;
  speedLimitMbps?: number | null;
  appendSpeedBadge?: string | null;
  template?: SubscriptionTemplateConfig | null;
};

type SubscriptionUser = {
  id: string;
  email: string;
  role?: string;
  emailVerifiedAt?: Date | null;
  uuid: string;
  password: string | null;
  isActive: boolean;
  expireAt: Date | null;
  trafficLimitBytes: bigint;
  trafficUsedBytes: bigint;
  extraLineGrants?: Array<{ lineId: string }>;
};

type SubscriptionRecord = {
  id: string;
  userId: string;
  planId: string;
  status: string;
  trafficLimitBytes: bigint;
  trafficUsedBytes: bigint;
  trafficPeriodStartAt: Date | null;
  startedAt: Date;
  expireAt: Date | null;
  subscriptionToken: string;
  canceledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  planSnapshotJson?: string | null;
  user?: SubscriptionUser | null;
  plan?: SubscriptionPlan | null;
};

type SubscriptionDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<SubscriptionRecord | null>;
  findMany: (args: Record<string, unknown>) => Promise<SubscriptionRecord[]>;
  count: (args: Record<string, unknown>) => Promise<number>;
  update: (args: Record<string, unknown>) => Promise<SubscriptionRecord>;
  updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
};

export type SubscriptionFormat = 'base64' | 'clash' | 'singbox';

export const SUBSCRIPTION_CONTENT_TYPES: Record<SubscriptionFormat, string> = {
  base64: 'text/plain; charset=utf-8',
  clash: 'text/yaml; charset=utf-8',
  singbox: 'application/json; charset=utf-8'
};

export function resolveFormat(type?: string, userAgent?: string): SubscriptionFormat {
  const t = (type ?? '').trim().toLowerCase();
  if (t === 'clash') return 'clash';
  if (t === 'sing-box' || t === 'singbox') return 'singbox';
  const ua = userAgent ?? '';
  if (/clash|meta|mihomo/i.test(ua)) return 'clash';
  if (/sing-?box/i.test(ua)) return 'singbox';
  return 'base64';
}

function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 86400000);
}

@Injectable()
export class SubscriptionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionService.name);
  private expiryTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly linesService: LinesService,
    @Optional() private readonly agentGateway?: AgentService,
    @Optional() private readonly settingsService?: SettingsService,
    @Optional() private readonly walletService?: WalletService,
    @Optional() private readonly planPurchases?: PlanPurchasesService
  ) {}

  onModuleInit() {
    if (this.subscriptionDelegate()) {
      // 用进程内巡检保持零外部依赖；unref 不阻止测试进程自然退出。
      this.expiryTimer = setInterval(() => {
        void this.maintainSubscriptions().catch((err) => {
          this.logger.warn(`subscription maintenance sweep failed: ${err}`);
        });
      }, 60000);
      this.expiryTimer.unref();
    }
  }

  onModuleDestroy() {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
  }

  async getSubscription(token: string, opts: { type?: string; userAgent?: string; templateId?: string } = {}) {
    const rawSubscription = await this.findByToken(token);
    const foundSubscription = rawSubscription ? applyPlanSnapshot(rawSubscription) as SubscriptionRecord : null;
    const subscription = foundSubscription && foundSubscription.plan?.trafficResetMode
      ? (await this.ensureTrafficReset(foundSubscription)).subscription
      : foundSubscription;
    const user = subscription?.user ?? (await this.prisma.user.findUnique({ where: { subscriptionToken: token } }));
    if (!user) throw new NotFoundException('订阅不存在');

    if (subscription ? !this.isSubscriptionEntitled(subscription, user) : !isUserEntitled(user)) {
      throw new ForbiddenException('账号已过期、被禁用或超出流量配额');
    }

    const settings = await this.settingsService?.getSettings();
    if (settings?.enforceEmailVerification && !user.emailVerifiedAt && user.role !== 'ADMIN') {
      throw new ForbiddenException('系统已开启强制邮箱验证，请先在个人中心完成邮箱验证或更换可用邮箱后再获取订阅');
    }

    const lines = subscription
      ? await this.linesService.getAvailableForPlan(
          subscription.plan ?? { lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]' },
          this.getExtraLineIds(subscription)
        )
      : await this.linesService.getAvailableForPlan({ lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]' });

    const plan = subscription?.plan;
    const planSpeedLimit = plan?.speedLimitMbps ?? null;
    const appendBadgeSetting = settings?.appendSubscriptionSpeedBadge ?? false;
    const unitConversion = settings?.speedLimitUnitConversionEnabled !== false;
    const shouldAppendBadge = plan?.appendSpeedBadge === 'ENABLE'
      ? true
      : plan?.appendSpeedBadge === 'DISABLE'
        ? false
        : appendBadgeSetting;

    const subscriptionSources: SubLine[] = lines.map((line) => {
      const lineSpeedLimit = line.speedLimitMbps ?? null;
      let effectiveSpeed: number | null = null;
      if (planSpeedLimit && planSpeedLimit > 0 && lineSpeedLimit && lineSpeedLimit > 0) {
        effectiveSpeed = Math.min(planSpeedLimit, lineSpeedLimit);
      } else if (planSpeedLimit && planSpeedLimit > 0) {
        effectiveSpeed = planSpeedLimit;
      } else if (lineSpeedLimit && lineSpeedLimit > 0) {
        effectiveSpeed = lineSpeedLimit;
      }

      let lineName = line.name;
      if (shouldAppendBadge && effectiveSpeed && effectiveSpeed > 0) {
        const badge = formatSpeedLimit(effectiveSpeed, unitConversion);
        lineName = `${line.name} [${badge}]`;
      }

      const params = { ...(line.params ?? {}) };
      if (line.protocolType === 'HYSTERIA2' && effectiveSpeed && effectiveSpeed > 0) {
        params.upMbps = effectiveSpeed;
        params.downMbps = effectiveSpeed;
      }

      return {
        id: line.id,
        name: lineName,
        type: line.type,
        relayMode: line.relayMode,
        endpointOverrideEnabled: line.endpointOverrideEnabled,
        serverHost: line.serverHost,
        serverPort: line.serverPort,
        serverName: line.serverName,
        host: line.host,
        trafficRate: line.trafficRate,
        tags: line.tags,
        level: line.level,
        protocolType: line.protocolType as ProtocolType,
        params,
        speedLimitMbps: effectiveSpeed
      };
    });

    const subUser: SubUser = { uuid: user.uuid, email: user.email, credential: user.password ?? user.uuid };
    const format = resolveFormat(opts.type, opts.userAgent);
    const template = await this.resolveTemplate(subscription?.plan?.template, opts.templateId);
    return {
      body: this.render(format, subscriptionSources, subUser, template),
      contentType: SUBSCRIPTION_CONTENT_TYPES[format],
      userInfoHeader: settings?.includeUsageHeaders === false ? undefined : this.buildUserInfoHeader(subscription ?? user),
      updateIntervalHours: settings?.subscriptionUpdateIntervalHours ?? 24
    };
  }

  async subscribe(
    userId: string,
    planId: string,
    transactionClient?: Prisma.TransactionClient,
    options: { source?: PlanPurchaseSource; skipIfClaimUnavailable?: boolean } = {}
  ) {
    this.requireSubscriptionDelegate();
    const client = transactionClient ?? this.prisma;
    const plan = await client.plan.findUnique({ where: { id: planId }, include: { template: true } });
    if (!plan || !plan.isPublic) {
      if (options.skipIfClaimUnavailable) return null;
      throw new NotFoundException('套餐不存在或未开放');
    }
    const now = new Date();
    const createSubscription = async (tx: Prisma.TransactionClient) => {
      const current = await tx.subscription.findUnique({ where: { userId } });
      if (current && this.isSubscriptionActive(current)) {
        throw new ConflictException('已有有效订阅，请使用升配操作');
      }
      let purchaseId: string | null = null;
      if (this.planPurchases) {
        try {
          purchaseId = await this.planPurchases.claim(
            userId,
            plan,
            options.source ?? 'SELF_BUY',
            null,
            tx
          );
        } catch (error) {
          if (options.skipIfClaimUnavailable && error instanceof ConflictException) return null;
          throw error;
        }
      }
      const data = {
        planId: plan.id,
        status: 'ACTIVE',
        trafficLimitBytes: plan.trafficLimitBytes,
        trafficUsedBytes: BigInt(0),
        startedAt: now,
        expireAt: addDays(now, plan.durationDays),
        subscriptionToken: randomUUID(),
        canceledAt: null,
        planSnapshotJson: null,
        trafficPeriodStartAt: this.getInitialTrafficPeriodStart(plan, now)
      };
      const subscription = current
        ? await tx.subscription.update({ where: { id: current.id }, data })
        : await tx.subscription.create({ data: { ...data, userId } });
      if (purchaseId) {
        await tx.planPurchase.update({ where: { id: purchaseId }, data: { subscriptionId: subscription.id } });
      }
      await this.chargePlan(tx, userId, plan.price, 'PLAN_BUY', '订购套餐', subscription.id);
      await this.syncUserMirror(tx, userId, subscription);
      return subscription;
    };
    const result = transactionClient ? await createSubscription(transactionClient) : await this.prisma.$transaction(createSubscription);
    if (!result) return null;
    if (transactionClient) return result;
    void this.agentGateway?.pushConfigToAll();
    return this.get(result.id);
  }

  async activateRedeemedPlan(userId: string, snapshot: RedeemedPlanSnapshot, transactionClient: Prisma.TransactionClient) {
    this.requireSubscriptionDelegate();
    const plan = await transactionClient.plan.findUnique({ where: { id: snapshot.id } });
    if (!plan) throw new NotFoundException('套餐不存在，无法履约该套餐卡');
    const now = new Date();
    const current = await transactionClient.subscription.findUnique({ where: { userId } });
    if (current && this.isSubscriptionActive(current)) throw new ConflictException('已有有效订阅，请在当前订阅结束后重试套餐卡兑换');
    const effectivePlan = { ...snapshot, trafficLimitBytes: BigInt(snapshot.trafficLimitBytes) };
    const data = {
      planId: plan.id,
      planSnapshotJson: JSON.stringify(snapshot),
      status: 'ACTIVE',
      trafficLimitBytes: BigInt(snapshot.trafficLimitBytes),
      trafficUsedBytes: BigInt(0),
      startedAt: now,
      expireAt: addDays(now, snapshot.durationDays),
      subscriptionToken: randomUUID(),
      canceledAt: null,
      trafficPeriodStartAt: this.getInitialTrafficPeriodStart(effectivePlan, now)
    };
    let subscription: { id: string };
    if (current) {
      if (this.planPurchases) {
        await this.planPurchases.claim(userId, plan, 'REDEEM_CODE', current.id, transactionClient);
      }
      subscription = await transactionClient.subscription.update({ where: { id: current.id }, data });
    } else {
      subscription = await transactionClient.subscription.create({ data: { ...data, userId } });
      if (this.planPurchases) {
        await this.planPurchases.claim(userId, plan, 'REDEEM_CODE', subscription.id, transactionClient);
      }
    }
    await this.syncUserMirror(transactionClient, userId, subscription as SubscriptionRecord);
    return subscription;
  }

  notifyFulfillmentCompleted() {
    void this.agentGateway?.pushConfigToAll();
  }

  async upgrade(userId: string, planId: string) {
    const delegate = this.requireSubscriptionDelegate();
    const plan = await this.prisma.plan.findUnique({ where: { id: planId }, include: { template: true } });
    if (!plan || !plan.isPublic) throw new NotFoundException('套餐不存在或未开放');
    const current = await delegate.findUnique({ where: { userId }, include: { plan: { select: { id: true, price: true } } } });
    if (!current || !this.isSubscriptionActive(current)) throw new ConflictException('当前没有可升配的有效订阅');
    if (typeof current.plan?.price !== 'number') throw new NotFoundException('当前套餐不存在');
    if (current.plan.id === plan.id) throw new ConflictException('当前已是该套餐，如需延长周期请使用续费');
    if (plan.price < current.plan.price) throw new ConflictException('不能升级到价格更低的套餐');
    const subscription = await this.prisma.$transaction(async (tx) => {
      const purchaseId = this.planPurchases
        ? await this.planPurchases.claim(userId, plan, 'SELF_UPGRADE', current.id, tx)
        : null;
      const updated = await tx.subscription.update({
        where: { id: current.id },
        data: {
          planId: plan.id,
          trafficLimitBytes: plan.trafficLimitBytes,
          trafficUsedBytes: BigInt(0),
          startedAt: new Date(),
          expireAt: addDays(new Date(), plan.durationDays),
          status: 'ACTIVE',
          canceledAt: null,
          planSnapshotJson: null,
          trafficPeriodStartAt: this.getInitialTrafficPeriodStart(plan, new Date())
        }
      });
      if (purchaseId) {
        await tx.planPurchase.update({ where: { id: purchaseId }, data: { subscriptionId: updated.id } });
      }
      await this.chargePlan(tx, userId, plan.price, 'PLAN_UPGRADE', '升配套餐', updated.id);
      await this.syncUserMirror(tx, userId, updated);
      return updated;
    });
    void this.agentGateway?.pushConfigToAll();
    return this.get(subscription.id);
  }

  async renew(userId: string) {
    const delegate = this.requireSubscriptionDelegate();
    const current = await delegate.findUnique({ where: { userId } });
    if (!current || !['ACTIVE', 'CANCELED'].includes(current.status)) {
      throw new ConflictException('当前没有可续费的订阅');
    }
    const rawPlan = await this.prisma.plan.findUnique({ where: { id: current.planId } });
    if (!rawPlan) throw new NotFoundException('套餐不存在');
    const effectiveCurrent = applyPlanSnapshot({ ...current, planSnapshotJson: current.planSnapshotJson, plan: rawPlan }) as typeof current & { plan: typeof rawPlan };
    const plan = effectiveCurrent.plan;
    if (plan.allowRenewal === false) throw new ConflictException('该套餐不支持续费');
    const now = new Date();
    const baseExpireAt = current.expireAt && current.expireAt.getTime() > now.getTime() ? current.expireAt : now;
    const subscription = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.subscription.update({
        where: { id: current.id },
        data: {
          status: 'ACTIVE',
          trafficLimitBytes: plan.trafficLimitBytes,
          trafficUsedBytes: BigInt(0),
          expireAt: addDays(baseExpireAt, plan.durationDays),
          canceledAt: null,
          trafficPeriodStartAt: this.getInitialTrafficPeriodStart(plan, now, current.startedAt)
        }
      });
      await this.chargePlan(tx, userId, plan.price, 'PLAN_RENEW', '续费套餐', updated.id);
      await this.syncUserMirror(tx, userId, updated);
      return updated;
    });
    void this.agentGateway?.pushConfigToAll();
    return this.get(subscription.id);
  }

  async cancel(userId: string) {
    const delegate = this.requireSubscriptionDelegate();
    const current = await delegate.findUnique({ where: { userId } });
    if (!current) throw new NotFoundException('订阅不存在');
    const status = current.expireAt && current.expireAt.getTime() <= Date.now() ? 'EXPIRED' : 'CANCELED';
    const subscription = await this.prisma.subscription.update({
      where: { id: current.id },
      data: { status, canceledAt: new Date() }
    });
    void this.agentGateway?.pushConfigToAll();
    return this.get(subscription.id);
  }

  async getUserDevices(userId: string) {
    if (!this.agentGateway) throw new BadRequestException('设备管理服务不可用');
    return this.agentGateway.getUserDeviceManagement(userId);
  }

  async kickUserDevices(userId: string, ip?: string) {
    if (!this.agentGateway) throw new BadRequestException('设备管理服务不可用');
    return this.agentGateway.kickUserDevices(userId, ip);
  }

  async getForUser(userId: string) {
    const delegate = this.requireSubscriptionDelegate();
    const deviceManagement = this.agentGateway ? await this.agentGateway.getUserDeviceManagement(userId) : null;
    const rawSubscription = await delegate.findUnique({
      where: { userId },
      include: {
        user: { select: { id: true, email: true, isActive: true, extraLineGrants: { select: { lineId: true } } } },
        plan: { include: { template: true } }
      }
    });
    if (!rawSubscription) {
      return {
        subscription: null,
        lines: [],
        nodes: [],
        planClaims: await this.planPurchases?.listClaimsForUser(userId) ?? [],
        deviceManagement
      };
    }
    const subscription = applyPlanSnapshot(rawSubscription) as unknown as SubscriptionRecord;
    const current = subscription.plan?.trafficResetMode
      ? (await this.ensureTrafficReset(subscription)).subscription
      : subscription;
    return {
      subscription: this.toView(current),
      lines: await this.getLinesForSubscription(current),
      nodes: await this.getLinesForSubscription(current),
      planClaims: await this.planPurchases?.listClaimsForUser(userId) ?? [],
      deviceManagement
    };
  }

  async resetToken(userId: string) {
    const delegate = this.requireSubscriptionDelegate();
    const current = await delegate.findUnique({ where: { userId } });
    if (!current) {
      throw new BadRequestException('该用户未绑定有效订阅，无法重置订阅链接');
    }
    return this.resetTokenBySubscription(current.id);
  }

  async resetTokenBySubscription(id: string) {
    const current = await this.getRaw(id);
    const token = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.update({ where: { id }, data: { subscriptionToken: token } });
      await tx.user.update({ where: { id: current.userId }, data: { subscriptionToken: token } });
    });
    return { subscriptionToken: token };
  }

  async list(query: QuerySubscriptionDto) {
    const delegate = this.requireSubscriptionDelegate();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.planId ? { planId: query.planId } : {}),
      ...(query.search ? { user: { email: { contains: query.search } } } : {})
    };
    const [data, total] = await Promise.all([
      delegate.findMany({
        where,
        include: {
          user: { select: { id: true, email: true, isActive: true, extraLineGrants: { select: { lineId: true } } } },
          plan: { select: { id: true, name: true, price: true, durationDays: true, trafficLimitBytes: true, trafficResetMode: true } }
        },
        orderBy: [{ updatedAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      delegate.count({ where })
    ]);
    return { data: data.map((item) => this.toView(item)), total, page, pageSize };
  }

  async get(id: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, email: true, isActive: true, extraLineGrants: { select: { lineId: true } } } },
        plan: { include: { template: true } }
      }
    });
    if (!subscription) throw new NotFoundException('订阅不存在');
    const current = (subscription.plan?.trafficResetMode
      ? (await this.ensureTrafficReset(subscription as unknown as SubscriptionRecord)).subscription
      : subscription) as unknown as SubscriptionRecord;
    return this.toView(current);
  }

  async adminUpdate(id: string, dto: AdminUpdateSubDto) {
    const current = await this.getRaw(id);
    await this.assertExtraLineIds(dto.extraLineIds);
    if (dto.planId === null) return this.adminRemove(id, current.userId);
    const plan = dto.planId ? await this.prisma.plan.findUnique({ where: { id: dto.planId } }) : null;
    if (dto.planId && !plan) throw new NotFoundException('套餐不存在');
    const limit = dto.trafficLimitBytes !== undefined ? BigInt(dto.trafficLimitBytes) : plan?.trafficLimitBytes ?? current.trafficLimitBytes;
    const used = dto.trafficUsedBytes !== undefined ? BigInt(dto.trafficUsedBytes) : current.trafficUsedBytes;
    if (used > limit) throw new BadRequestException('已用流量不能大于流量配额');
    const expireAt = dto.expireAt !== undefined
      ? dto.expireAt
        ? new Date(dto.expireAt)
        : null
      : dto.addDays
        ? addDays(current.expireAt && current.expireAt.getTime() > Date.now() ? current.expireAt : new Date(), dto.addDays)
        : current.expireAt;
    const planChanged = Boolean(dto.planId && dto.planId !== current.planId);
    const subscription = await this.prisma.$transaction(async (tx) => {
      const purchaseId = planChanged && plan && this.planPurchases
        ? await this.planPurchases.claim(
            current.userId,
            plan,
            'ADMIN',
            current.id,
            tx,
            { allowExceedLimit: true }
          )
        : null;
      const updated = await tx.subscription.update({
        where: { id },
        data: {
          ...(dto.planId ? { planId: dto.planId } : {}),
          ...(planChanged ? { planSnapshotJson: null } : {}),
          ...(dto.status ? { status: dto.status } : {}),
          trafficLimitBytes: limit,
          trafficUsedBytes: used,
          expireAt,
          ...(dto.planId ? { trafficPeriodStartAt: this.getInitialTrafficPeriodStart(plan!, new Date(), current.startedAt) } : {})
        }
      });
      if (purchaseId) {
        await tx.planPurchase.update({ where: { id: purchaseId }, data: { subscriptionId: updated.id } });
      }
      if (dto.extraLineIds !== undefined) {
        await this.replaceExtraLineGrants(tx, current.userId, dto.extraLineIds);
      }
      await this.syncUserMirror(tx, current.userId, updated);
      return updated;
    });
    void this.agentGateway?.pushConfigToAll();
    return this.get(subscription.id);
  }

  private async adminRemove(id: string, userId: string) {
    const subscriptionToken = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.delete({ where: { id } });
      await tx.user.update({
        where: { id: userId },
        data: {
          subscriptionToken,
          trafficLimitBytes: BigInt(0),
          trafficUsedBytes: BigInt(0),
          expireAt: null
        }
      });
      await tx.userLineGrant.deleteMany({ where: { userId } });
    });
    void this.agentGateway?.pushConfigToAll();
    return { removed: true, id, userId };
  }


  async adminAssign(userId: string, dto: AdminUpdateSubDto) {
    if (!dto.planId) throw new BadRequestException('绑定订阅必须指定套餐');
    await this.assertExtraLineIds(dto.extraLineIds);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException('用户不存在');
    const delegate = this.requireSubscriptionDelegate();
    const current = await delegate.findUnique({ where: { userId } });
    if (current) return this.adminUpdate(current.id, dto);

    const plan = await this.prisma.plan.findUnique({ where: { id: dto.planId } });
    if (!plan) throw new NotFoundException('套餐不存在');
    const now = new Date();
    const limit = dto.trafficLimitBytes !== undefined ? BigInt(dto.trafficLimitBytes) : plan.trafficLimitBytes;
    const used = dto.trafficUsedBytes !== undefined ? BigInt(dto.trafficUsedBytes) : BigInt(0);
    if (used > limit) throw new BadRequestException('已用流量不能大于流量配额');
    const expireAt = dto.expireAt !== undefined
      ? dto.expireAt
        ? new Date(dto.expireAt)
        : null
      : dto.addDays
        ? addDays(now, dto.addDays)
        : addDays(now, plan.durationDays);
    const subscriptionToken = randomUUID();
    const subscription = await this.prisma.$transaction(async (tx) => {
      const purchaseId = this.planPurchases
        ? await this.planPurchases.claim(
            userId,
            plan,
            'ADMIN',
            null,
            tx,
            { allowExceedLimit: true }
          )
        : null;
      const created = await tx.subscription.create({
        data: {
          userId,
          planId: plan.id,
          status: dto.status ?? 'ACTIVE',
          trafficLimitBytes: limit,
          trafficUsedBytes: used,
          startedAt: now,
          expireAt,
          subscriptionToken,
          trafficPeriodStartAt: this.getInitialTrafficPeriodStart(plan, now)
        }
      });
      if (purchaseId) {
        await tx.planPurchase.update({ where: { id: purchaseId }, data: { subscriptionId: created.id } });
      }
      if (dto.extraLineIds !== undefined) {
        await this.replaceExtraLineGrants(tx, userId, dto.extraLineIds);
      }
      await this.syncUserMirror(tx, userId, created);
      return created;
    });
    void this.agentGateway?.pushConfigToAll();
    return this.get(subscription.id);
  }

  private render(format: SubscriptionFormat, lines: Array<SubLine | SubNode>, user: SubUser, template?: SubscriptionTemplateConfig): string {
    switch (format) {
      case 'clash':
        return buildClashYaml(user, lines, template);
      case 'singbox':
        return buildSingboxJson(user, lines, template);
      default:
        return Buffer.from(buildUriList(user, lines).join('\n'), 'utf-8').toString('base64');
    }
  }

  private buildUserInfoHeader(user: {
    trafficLimitBytes: bigint;
    trafficUsedBytes: bigint;
    expireAt: Date | null;
  }): string {
    const expire = user.expireAt ? Math.floor(user.expireAt.getTime() / 1000) : 0;
    return `upload=0; download=${user.trafficUsedBytes}; total=${user.trafficLimitBytes}; expire=${expire}`;
  }

  private isSubscriptionActive(subscription: { status: string; expireAt: Date | null }) {
    return ['ACTIVE', 'CANCELED'].includes(subscription.status) && (!subscription.expireAt || subscription.expireAt.getTime() > Date.now());
  }

  private isSubscriptionEntitled(subscription: SubscriptionRecord, user: SubscriptionUser) {
    return this.isSubscriptionActive(subscription) && user.isActive && subscription.trafficUsedBytes < subscription.trafficLimitBytes;
  }

  private async expireSubscriptions() {
    const delegate = this.subscriptionDelegate();
    if (!delegate) return;
    const result = await delegate.updateMany({
      where: { status: { in: ['ACTIVE', 'CANCELED'] }, expireAt: { not: null, lt: new Date() } },
      data: { status: 'EXPIRED' }
    });
    if (result.count > 0) void this.agentGateway?.pushConfigToAll();
  }

  private async maintainSubscriptions() {
    await this.expireSubscriptions();
    const resetCount = await this.resetDueTrafficPeriods();
    if (resetCount > 0) void this.agentGateway?.pushConfigToAll();
  }

  private async resetDueTrafficPeriods(now = new Date()): Promise<number> {
    const settings = await this.settingsService?.getSettings();
    const timeZone = settings?.systemTimezone ?? 'Asia/Shanghai';
    const subscriptions = await this.prisma.subscription.findMany({ include: { plan: true } });
    const due = subscriptions
      .map((raw) => {
        const subscription = applyPlanSnapshot(raw) as typeof raw;
        const mode = subscription.plan?.trafficResetMode ?? 'NONE';
        const period = getTrafficPeriod(mode, now, subscription.startedAt, subscription.plan?.durationDays ?? 0, timeZone);
        const previous = subscription.trafficPeriodStartAt;
        return { subscription, period, shouldReset: Boolean(period && previous && previous.getTime() < period.startAt.getTime()) };
      })
      .filter((item) => item.period && (!item.subscription.trafficPeriodStartAt || item.shouldReset));
    if (!due.length) return 0;

    await this.prisma.$transaction(async (tx) => {
      for (const item of due) {
        if (!item.period) continue;
        if (!item.subscription.trafficPeriodStartAt) {
          await tx.subscription.updateMany({
            where: { id: item.subscription.id, trafficPeriodStartAt: null },
            data: { trafficPeriodStartAt: item.period.startAt }
          });
        } else if (item.shouldReset) {
          const updated = await tx.subscription.updateMany({
            where: { id: item.subscription.id, trafficPeriodStartAt: item.subscription.trafficPeriodStartAt },
            data: { trafficPeriodStartAt: item.period.startAt, trafficUsedBytes: BigInt(0) }
          });
          if (updated.count > 0) {
            await tx.user.update({ where: { id: item.subscription.userId }, data: { trafficUsedBytes: BigInt(0) } });
          }
        }
      }
    });
    return due.filter((item) => item.shouldReset).length;
  }

  private async ensureTrafficReset(subscription: SubscriptionRecord, now = new Date()): Promise<{ subscription: SubscriptionRecord; changed: boolean }> {
    const effective = applyPlanSnapshot(subscription) as SubscriptionRecord;
    const plan = effective.plan;
    const mode = plan?.trafficResetMode ?? 'NONE';
    const settings = await this.settingsService?.getSettings();
    const timeZone = settings?.systemTimezone ?? 'Asia/Shanghai';
    const period = plan ? getTrafficPeriod(mode, now, subscription.startedAt, plan.durationDays, timeZone) : null;
    if (!period) return { subscription, changed: false };

    const previous = subscription.trafficPeriodStartAt ?? null;
    const shouldReset = Boolean(previous && previous.getTime() < period.startAt.getTime());
    if (previous && !shouldReset) return { subscription, changed: false };

    const changed = await this.prisma.$transaction(async (tx) => {
      if (!previous) {
        const result = await tx.subscription.updateMany({
          where: { id: subscription.id, trafficPeriodStartAt: null },
          data: { trafficPeriodStartAt: period.startAt }
        });
        return result.count > 0;
      }
      if (!shouldReset) return false;
      const result = await tx.subscription.updateMany({
        where: { id: subscription.id, trafficPeriodStartAt: previous },
        data: { trafficPeriodStartAt: period.startAt, trafficUsedBytes: BigInt(0) }
      });
      if (result.count > 0) {
        await tx.user.update({ where: { id: subscription.userId }, data: { trafficUsedBytes: BigInt(0) } });
      }
      return result.count > 0;
    });
    if (shouldReset && changed) void this.agentGateway?.pushConfigToAll();
    if (!changed && previous && shouldReset) {
      const latest = await this.prisma.subscription.findUnique({
        where: { id: subscription.id },
        include: {
          user: { select: { id: true, email: true, isActive: true, extraLineGrants: { select: { lineId: true } } } },
          plan: { include: { template: true } }
        }
      });
      if (latest) return { subscription: latest as unknown as SubscriptionRecord, changed: false };
    }
    return {
      changed,
      subscription: {
        ...subscription,
        trafficPeriodStartAt: period.startAt,
        trafficUsedBytes: shouldReset ? BigInt(0) : subscription.trafficUsedBytes
      }
    };
  }

  private getInitialTrafficPeriodStart(
    plan: { trafficResetMode?: string; durationDays: number },
    now: Date,
    startedAt = now,
    timeZone = 'Asia/Shanghai'
  ): Date | null {
    return getTrafficPeriod(plan.trafficResetMode ?? 'NONE', now, startedAt, plan.durationDays, timeZone)?.startAt ?? null;
  }

  private getExtraLineIds(subscription: SubscriptionRecord): string[] {
    return subscription.user?.extraLineGrants?.map((grant) => grant.lineId) ?? [];
  }

  private async assertExtraLineIds(lineIds?: string[]) {
    if (lineIds === undefined) return;
    const ids = [...new Set(lineIds)];
    if (!ids.length) return;
    const rows = await this.prisma.line.findMany({ where: { id: { in: ids } }, select: { id: true } });
    const existing = new Set(rows.map((row) => row.id));
    const missing = ids.find((id) => !existing.has(id));
    if (missing) throw new NotFoundException('额外线路不存在');
  }

  private async replaceExtraLineGrants(tx: Prisma.TransactionClient, userId: string, lineIds: string[]) {
    const ids = [...new Set(lineIds)];
    await tx.userLineGrant.deleteMany({ where: { userId } });
    if (ids.length) {
      await tx.userLineGrant.createMany({ data: ids.map((lineId) => ({ userId, lineId })) });
    }
  }

  private async getLinesForSubscription(subscription: SubscriptionRecord) {
    const effective = applyPlanSnapshot(subscription) as SubscriptionRecord;
    const directLines = await this.linesService.getAvailableForPlan(
      effective.plan ?? { lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]' },
      this.getExtraLineIds(subscription)
    );

    let upstreamLines: Array<Awaited<ReturnType<LinesService['getAvailableForPlan']>>[number]> = [];
    try {
      const upstreamNodes = await this.prisma.upstreamNode.findMany({
        where: {
          isDirectSub: true,
          status: 'ACTIVE',
          subscription: { status: 'ACTIVE' }
        }
      });
      upstreamLines = (upstreamNodes || []).map((node) => {
        let params: Record<string, unknown> = {};
        try {
          params = JSON.parse(node.paramsJson || '{}');
        } catch {
          // ignore
        }
        let tags: string[] = [];
        try {
          tags = JSON.parse(node.tagsJson || '[]');
        } catch {
          // ignore
        }
        return {
          id: node.id,
          name: `[直连] ${node.name}`,
          type: 'DIRECT',
          protocolType: node.protocolType as unknown as ProtocolType,
          serverHost: node.serverHost,
          serverPort: node.serverPort,
          params,
          trafficRate: 0,
          tags
        } as unknown as Awaited<ReturnType<LinesService['getAvailableForPlan']>>[number];
      });
    } catch {
      // ignore
    }

    return [...directLines, ...upstreamLines];
  }

  private async resolveTemplate(template?: SubscriptionTemplateConfig | null, templateId?: string) {
    const templateDelegate = (this.prisma as unknown as {
      subscriptionTemplate?: {
        findUnique?: (args: Record<string, unknown>) => Promise<SubscriptionTemplateConfig | null>;
        findFirst?: (args: Record<string, unknown>) => Promise<SubscriptionTemplateConfig | null>;
      };
    }).subscriptionTemplate;
    if (!templateDelegate) return undefined;
    if (templateId?.trim() && templateDelegate.findUnique) {
      const requested = await templateDelegate.findUnique({ where: { id: templateId.trim() } });
      if (!requested) throw new NotFoundException('指定订阅模板不存在');
      return requested;
    }
    if (template) return template;
    const settings = await this.settingsService?.getSettings();
    if (settings?.defaultTemplateId && templateDelegate.findUnique) {
      const configured = await templateDelegate.findUnique({ where: { id: settings.defaultTemplateId } });
      if (configured) return configured;
    }
    return (templateDelegate.findFirst ? await templateDelegate.findFirst({ where: { isDefault: true } }) : null) ?? undefined;
  }

  private subscriptionDelegate(): SubscriptionDelegate | undefined {
    return (this.prisma as unknown as { subscription?: SubscriptionDelegate }).subscription;
  }

  private requireSubscriptionDelegate(): SubscriptionDelegate {
    const delegate = this.subscriptionDelegate();
    if (!delegate) throw new BadRequestException('订阅模块尚未完成数据库迁移');
    return delegate;
  }

  private async findByToken(token: string): Promise<SubscriptionRecord | null> {
    const delegate = this.subscriptionDelegate();
    if (!delegate) return null;
    return delegate.findUnique({
      where: { subscriptionToken: token },
      include: {
        user: { include: { extraLineGrants: { select: { lineId: true } } } },
        plan: { include: { template: true } }
      }
    });
  }

  private async getRaw(id: string): Promise<SubscriptionRecord> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, email: true, isActive: true, extraLineGrants: { select: { lineId: true } } } },
        plan: true
      }
    });
    if (!subscription) throw new NotFoundException('订阅不存在');
    return subscription as unknown as SubscriptionRecord;
  }

  private async chargePlan(
    tx: Prisma.TransactionClient,
    userId: string,
    price: number,
    type: 'PLAN_BUY' | 'PLAN_RENEW' | 'PLAN_UPGRADE',
    description: string,
    referenceId: string
  ) {
    if (!price || price <= 0) return;
    if (!this.walletService) throw new BadRequestException('钱包服务不可用');
    await this.walletService.applyBalanceChange(tx, userId, -price, type, description, referenceId);
  }

  private async syncUserMirror(tx: Prisma.TransactionClient, userId: string, subscription: SubscriptionRecord) {
    await tx.user.update({
      where: { id: userId },
      data: {
        trafficLimitBytes: subscription.trafficLimitBytes,
        trafficUsedBytes: subscription.trafficUsedBytes,
        expireAt: subscription.expireAt,
        subscriptionToken: subscription.subscriptionToken
      }
    });
  }

  private toView(subscription: SubscriptionRecord, timeZone = 'Asia/Shanghai') {
    subscription = applyPlanSnapshot(subscription) as SubscriptionRecord;
    const trafficResetMode = subscription.plan?.trafficResetMode ?? 'NONE';
    const period = subscription.plan
      ? getTrafficPeriod(trafficResetMode, new Date(), subscription.startedAt, subscription.plan.durationDays, timeZone)
      : null;
    return {
      ...subscription,
      trafficLimitBytes: Number(subscription.trafficLimitBytes),
      trafficUsedBytes: Number(subscription.trafficUsedBytes),
      trafficResetMode,
      nextTrafficResetAt: period?.nextResetAt ?? null,
      extraLineIds: this.getExtraLineIds(subscription),
      plan: subscription.plan
        ? {
            ...subscription.plan,
            trafficResetMode: subscription.plan.trafficResetMode ?? 'NONE',
            ...(typeof subscription.plan.price === 'number' ? { price: subscription.plan.price / 100 } : {}),
            trafficLimitBytes: Number(subscription.plan.trafficLimitBytes)
          }
        : undefined
    };
  }
}
