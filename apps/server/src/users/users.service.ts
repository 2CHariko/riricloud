import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { AgentService } from '../agent-gateway/agent.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../system/settings.service';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users.query.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { LinesService } from '../lines/lines.service';
import { WalletService } from '../wallet/wallet.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ChangeEmailDto } from './dto/change-email.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { getTrafficPeriod } from '../common/traffic-reset';
import { VerificationService } from '../verification/verification.service';
import { assertEmailLength, assertPasswordPolicy, buildPasswordStrengthPolicy, normalizeEmail, passwordComplexityFromSettings } from '../common/auth-security';
import { defaultUserNickname, generateUniqueUserUid, normalizeNickname } from './user-identity';
import { AuthAuditEvent, AuthAuditService } from '../common/auth-audit.service';
import { PlanPurchasesService } from '../subscription/plan-purchases.service';
import { applyPlanSnapshot } from '../subscription/plan-snapshot';
import { resolveEffectiveDeviceLimit } from '../common/device-limit';

type UserSubscriptionDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<UserSubscriptionSnapshot | null>;
};

type UserPlanDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<UserPlanSnapshot | null>;
  findFirst: (args: Record<string, unknown>) => Promise<UserPlanSnapshot | null>;
};

type UserSubscriptionSnapshot = {
  id: string;
  status: string;
  trafficLimitBytes: bigint;
  trafficUsedBytes: bigint;
  startedAt: Date;
  expireAt: Date | null;
  trafficPeriodStartAt: Date | null;
  subscriptionToken: string;
  planSnapshotJson?: string | null;
  plan?: {
    id: string;
    name: string;
    lineMatchMode: string;
    lineTagsJson: string;
    lineIdsJson: string;
    durationDays: number;
    trafficResetMode: string;
  } | null;
};

type UserPlanSnapshot = {
  id: string;
  name: string;
  durationDays: number;
  trafficLimitBytes: bigint;
  isPublic: boolean;
  trafficResetMode: string;
  purchaseLimitPerUser: number | null;
};

// 管理端用户视图字段（不含 passwordHash / uuid 等敏感字段）
const ADMIN_USER_SELECT = {
  id: true,
  uid: true,
  nickname: true,
  email: true,
  emailVerifiedAt: true,
  role: true,
  balance: true,
  trafficLimitBytes: true,
  trafficUsedBytes: true,
  deviceLimit: true,
  expireAt: true,
  isActive: true,
  createdAt: true,
  subscription: {
    select: {
      id: true,
      status: true,
      trafficLimitBytes: true,
      trafficUsedBytes: true,
      startedAt: true,
      expireAt: true,
      trafficPeriodStartAt: true,
      planSnapshotJson: true,
      plan: { select: { id: true, name: true, durationDays: true, trafficResetMode: true, deviceLimit: true } }
    }
  },
  extraLineGrants: { select: { lineId: true } }
} as const;

type AdminUserQueryResult = Prisma.UserGetPayload<{ select: typeof ADMIN_USER_SELECT }>;

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private settingsService: SettingsService,
    private agentGateway: AgentService,
    @Optional() private linesService?: LinesService,
    @Optional() private walletService?: WalletService,
    @Optional() private verificationService?: VerificationService,
    @Optional() private authAuditService?: AuthAuditService,
    @Optional() private planPurchases?: PlanPurchasesService
  ) {}

  // 重置订阅令牌：旧链接立即失效，返回新 token
  async resetSubscriptionToken(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException();
    }
    const subscriptionDelegate = (this.prisma as unknown as { subscription?: UserSubscriptionDelegate }).subscription;
    const subscription = subscriptionDelegate
      ? await subscriptionDelegate.findUnique({ where: { userId } })
      : null;
    if (!subscription) {
      throw new BadRequestException('该用户未绑定有效订阅，无法重置订阅链接');
    }
    const subscriptionToken = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.update({ where: { id: subscription.id }, data: { subscriptionToken } });
      await tx.user.update({ where: { id: userId }, data: { subscriptionToken } });
    });
    return subscriptionToken;
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    if (!user || !(await bcrypt.compare(dto.oldPassword, user.passwordHash))) {
      this.audit('PASSWORD_CHANGE_FAILURE', { reason: 'old_password' }, userId);
      throw new UnauthorizedException('旧密码错误');
    }
    const passwordSettings = await this.settingsService.getSettings();
    assertPasswordPolicy(dto.newPassword, passwordSettings?.passwordMinLength ?? 8, buildPasswordStrengthPolicy(passwordComplexityFromSettings(passwordSettings)));
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(dto.newPassword, 10), sessionVersion: { increment: 1 } } });
    this.audit('PASSWORD_CHANGED', {}, userId);
    this.audit('SESSION_INVALIDATED', { reason: 'password_change' }, userId);
    return { updated: true };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { uid: true } });
    if (!user) throw new UnauthorizedException();
    const nickname = normalizeNickname(dto.nickname);
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { nickname },
      select: { uid: true, nickname: true }
    });
    return { uid: updated.uid, nickname: updated.nickname ?? defaultUserNickname(updated.uid) };
  }

  async verifyEmail(userId: string, code: string) {
    const verificationService = this.verificationService;
    if (!verificationService) throw new BadRequestException('邮箱验证服务不可用');
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
    if (!user) throw new UnauthorizedException();
    let updated;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        await verificationService.verifyCode(user.email, 'VERIFY_CURRENT_EMAIL', code, tx);
        return tx.user.update({
          where: { id: userId },
          data: { emailVerifiedAt: new Date() },
          select: { id: true, email: true, emailVerifiedAt: true }
        });
      });
    } catch (error) {
      this.audit('VERIFICATION_FAILURE', { action: 'VERIFY_CURRENT_EMAIL' }, userId);
      throw error;
    }
    void this.agentGateway.pushConfigToAll();
    this.audit('VERIFICATION_CONSUMED', { action: 'VERIFY_CURRENT_EMAIL' }, userId);
    return { verified: true, emailVerifiedAt: updated.emailVerifiedAt ? updated.emailVerifiedAt.toISOString() : null };
  }

  async changeEmail(userId: string, dto: ChangeEmailDto) {
    const verificationService = this.verificationService;
    if (!verificationService) throw new BadRequestException('邮箱验证服务不可用');
    const newEmail = normalizeEmail(dto.newEmail);
    assertEmailLength(newEmail);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, passwordHash: true } });
    if (!user) throw new UnauthorizedException();
    if (!(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
      this.audit('PASSWORD_CHANGE_FAILURE', { reason: 'current_password', action: 'CHANGE_EMAIL' }, userId);
      throw new UnauthorizedException('当前密码错误');
    }
    let result;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.user.findUnique({ where: { email: newEmail }, select: { id: true } });
        if (existing && existing.id !== userId) throw new ConflictException('新邮箱已被其他账号使用');
        await verificationService.verifyCode(newEmail, 'CHANGE_EMAIL', dto.verificationCode, tx);
        await this.planPurchases?.prepareEmailChange(userId, newEmail, tx);
        await tx.user.update({ where: { id: userId }, data: { email: newEmail, emailVerifiedAt: new Date() } });
        return { updated: true, email: newEmail };
      });
    } catch (error) {
      this.audit('VERIFICATION_FAILURE', { action: 'CHANGE_EMAIL' }, userId);
      throw error;
    }
    void this.agentGateway.pushConfigToAll();
    this.audit('VERIFICATION_CONSUMED', { action: 'CHANGE_EMAIL' }, userId);
    return result;
  }

  async resetUuid(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new UnauthorizedException();
    const uuid = randomUUID();
    await this.prisma.user.update({ where: { id: userId }, data: { uuid } });
    void this.agentGateway.pushConfigToAll();
    return { uuid };
  }

  async adjustBalance(userId: string, amount: number, description?: string) {
    if (!this.walletService) throw new BadRequestException('钱包服务不可用');
    const result = await this.walletService.adjustBalance(userId, amount, 'ADMIN_ADJUST', description ?? '管理员调账');
    return { userId, ...result };
  }

  async getUserDevices(userId: string) {
    return this.agentGateway.getUserDeviceManagement(userId);
  }

  async kickUserDevices(userId: string, ip?: string) {
    return this.agentGateway.kickUserDevices(userId, ip);
  }

  // ---------- 管理员接口 ----------

  // 分页列表：邮箱、角色、账号状态、订阅状态与套餐均由数据库过滤
  async listUsers(query: ListUsersQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    let subscriptionWhere: Record<string, unknown> | null | undefined = undefined;

    const wantNoSubscription = query.subscriptionStatus === 'NONE';
    const wantNoPlan = query.planId === 'NONE';

    if (wantNoSubscription || wantNoPlan) {
      if ((query.subscriptionStatus && !wantNoSubscription) || (query.planId && !wantNoPlan)) {
        subscriptionWhere = { is: { status: 'NONE' } };
      } else {
        subscriptionWhere = null;
      }
    } else if (query.subscriptionStatus || query.planId) {
      subscriptionWhere = {
        is: {
          ...(query.subscriptionStatus ? { status: query.subscriptionStatus } : {}),
          ...(query.planId ? { planId: query.planId } : {})
        }
      };
    }

    const search = query.search?.trim();
    const numericUid = search && /^\d{6}$/.test(search) ? Number(search) : null;
    const where = {
      ...(numericUid !== null
        ? { uid: numericUid }
        : search
          ? { OR: [{ email: { contains: search } }, { nickname: { contains: search } }] }
          : {}),
      ...(query.role ? { role: query.role } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.emailVerified !== undefined
        ? query.emailVerified
          ? { emailVerifiedAt: { not: null } }
          : { emailVerifiedAt: null }
        : {}),
      ...(subscriptionWhere !== undefined ? { subscription: subscriptionWhere } : {})
    };
    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: ADMIN_USER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      this.prisma.user.count({ where })
    ]);
    const settings = await this.settingsService.getSettings();
    const timeZone = settings?.systemTimezone ?? 'Asia/Shanghai';
    const deviceCounts = await this.agentGateway.getBatchUserOnlineDeviceCounts(users.map((user) => user.id));
    // BigInt 在服务边界转 Number（< 2^53 无精度损失）
    const data = users.map((user) => {
      const formatted = this.formatAdminUser(user, timeZone);
      const effective = resolveEffectiveDeviceLimit({
        globalEnabled: settings?.deviceLimitEnabled !== false,
        userDeviceLimit: user.deviceLimit,
        planDeviceLimit: user.subscription?.plan?.deviceLimit
      });
      return { ...formatted, onlineDeviceCount: deviceCounts.get(user.id) ?? 0, ...effective };
    });
    return { data, total, page, pageSize };
  }

  private formatAdminUser(user: AdminUserQueryResult, timeZone: string) {
    const { extraLineGrants, ...u } = user;
    const subscription = u.subscription ? applyPlanSnapshot(u.subscription) : null;
    return {
      ...u,
      emailVerifiedAt: u.emailVerifiedAt ? (u.emailVerifiedAt instanceof Date ? u.emailVerifiedAt.toISOString() : u.emailVerifiedAt) : null,
      trafficLimitBytes: Number(u.trafficLimitBytes),
      trafficUsedBytes: Number(u.trafficUsedBytes),
      subscription: subscription
        ? {
            id: subscription.id,
            status: subscription.status,
            trafficLimitBytes: Number(subscription.trafficLimitBytes),
            trafficUsedBytes: Number(subscription.trafficUsedBytes),
            startedAt: subscription.startedAt,
            expireAt: subscription.expireAt,
            trafficResetMode: subscription.plan?.trafficResetMode ?? 'NONE',
            nextTrafficResetAt: subscription.plan
              ? getTrafficPeriod(
                  subscription.plan.trafficResetMode,
                  new Date(),
                  subscription.startedAt,
                  subscription.plan.durationDays,
                  timeZone
                )?.nextResetAt ?? null
              : null,
            extraLineIds: (extraLineGrants ?? []).map((grant: { lineId: string }) => grant.lineId),
            // 用户管理 API 仅返回约定字段，避免泄漏套餐快照及其中无法直接 JSON 序列化的 BigInt。
            plan: subscription.plan ? { id: subscription.plan.id, name: subscription.plan.name } : null
          }
        : null
    };
  }

  async createUser(dto: CreateUserDto) {
    const email = normalizeEmail(dto.email);
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('邮箱已存在');
    }
    const settings = await this.settingsService.getSettings();
    assertPasswordPolicy(dto.password, settings?.passwordMinLength ?? 8, buildPasswordStrengthPolicy(passwordComplexityFromSettings(settings)));
    const plan = await this.resolveInitialPlan(dto.planId);
    const timeZone = settings?.systemTimezone ?? 'Asia/Shanghai';
    const now = new Date();
    const trafficLimitBytes = BigInt(dto.trafficLimitBytes ?? plan?.trafficLimitBytes ?? 0);
    const expireAt = dto.expireAt !== undefined
      ? dto.expireAt
        ? new Date(dto.expireAt)
        : null
      : plan
        ? new Date(now.getTime() + plan.durationDays * 86400000)
        : null;
    const subscriptionToken = randomUUID();
    const uid = await generateUniqueUserUid(this.prisma.user);
    const nickname = dto.nickname ? normalizeNickname(dto.nickname) : defaultUserNickname(uid);
    const data = {
      uid,
      nickname,
      email,
      passwordHash: await bcrypt.hash(dto.password, 10),
      role: dto.role ?? 'USER',
      deviceLimit: dto.deviceLimit ?? null,
      trafficLimitBytes,
      expireAt,
      subscriptionToken
    };
    const user = plan
      ? await this.prisma.$transaction(async (tx) => {
          const created = await tx.user.create({ data, select: ADMIN_USER_SELECT });
          const purchaseId = this.planPurchases
            ? await this.planPurchases.claim(
                created.id,
                plan,
                'ADMIN',
                null,
                tx,
                { allowExceedLimit: true }
              )
            : null;
          const subscription = await tx.subscription.create({
            data: {
              userId: created.id,
              planId: plan.id,
              status: 'ACTIVE',
              trafficLimitBytes,
              trafficUsedBytes: BigInt(0),
              startedAt: now,
              expireAt,
              subscriptionToken,
              trafficPeriodStartAt: getTrafficPeriod(plan.trafficResetMode, now, now, plan.durationDays, timeZone)?.startAt ?? null
            }
          });
          if (purchaseId) {
            await tx.planPurchase.update({ where: { id: purchaseId }, data: { subscriptionId: subscription.id } });
          }
          return created;
        })
      : await this.prisma.user.create({ data, select: ADMIN_USER_SELECT });
    void this.agentGateway.pushConfigToAll();
    this.audit('ADMIN_USER_CREATED', { emailHash: this.authAuditService?.emailHash(email) });
    return this.formatAdminUser(user, timeZone);
  }

  async updateUser(id: string, dto: UpdateUserDto, operatorId: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    const settings = await this.settingsService.getSettings();
    // 防锁死：管理员不能修改自己的角色
    if (dto.role !== undefined && id === operatorId && dto.role !== user.role) {
      throw new ForbiddenException('不能修改自己的角色');
    }
    const data: Record<string, unknown> = {};
    if (dto.role !== undefined) data.role = dto.role;
    if (dto.deviceLimit !== undefined) data.deviceLimit = dto.deviceLimit;
    if (dto.trafficLimitBytes !== undefined) data.trafficLimitBytes = BigInt(dto.trafficLimitBytes);
    if (dto.expireAt !== undefined) data.expireAt = dto.expireAt ? new Date(dto.expireAt) : null;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.emailVerified !== undefined) {
      data.emailVerifiedAt = dto.emailVerified ? new Date() : null;
    }
    if (dto.password !== undefined) {
      assertPasswordPolicy(dto.password, settings?.passwordMinLength ?? 8, buildPasswordStrengthPolicy(passwordComplexityFromSettings(settings)));
      data.passwordHash = await bcrypt.hash(dto.password, 10);
    }
    if (dto.password !== undefined || dto.isActive === false) {
      data.sessionVersion = { increment: 1 };
    }
    const updated = await this.prisma.user.update({ where: { id }, data, select: ADMIN_USER_SELECT });
    const subscriptionDelegate = (this.prisma as unknown as { subscription?: UserSubscriptionDelegate }).subscription;
    const subscription = subscriptionDelegate
      ? await subscriptionDelegate.findUnique({ where: { userId: id } })
      : null;
    if (subscription) {
      await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          ...(dto.trafficLimitBytes !== undefined ? { trafficLimitBytes: BigInt(dto.trafficLimitBytes) } : {}),
          ...(dto.expireAt !== undefined ? { expireAt: dto.expireAt ? new Date(dto.expireAt) : null } : {})
        }
      });
    }
    // 配额/到期/激活/角色变化影响订阅资格，向在线节点同步用户名单
    void this.agentGateway.pushConfigToAll();
    if (dto.password !== undefined) {
      this.audit('ADMIN_PASSWORD_CHANGED', { operatorId }, id);
      this.audit('SESSION_INVALIDATED', { reason: 'admin_password_change', operatorId }, id);
    }
    if (dto.isActive === false) {
      this.audit('ACCOUNT_DISABLED', { operatorId }, id);
      this.audit('SESSION_INVALIDATED', { reason: 'account_disabled', operatorId }, id);
    }
    const timeZone = settings?.systemTimezone ?? 'Asia/Shanghai';
    return this.formatAdminUser(updated, timeZone);
  }

  async deleteUser(id: string, operatorId: string) {
    if (id === operatorId) {
      throw new ForbiddenException('不能删除自己');
    }
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    await this.prisma.$transaction(async (tx) => {
      await this.planPurchases?.ensureAliasForDeletion(id, tx);
      // TrafficLog 经 schema onDelete: Cascade 级联删除；购买身份通过 SetNull 保留。
      await tx.user.delete({ where: { id } });
    });
    this.audit('ACCOUNT_DISABLED', { operatorId, reason: 'deleted' }, id);
    void this.agentGateway.pushConfigToAll();
    return { deleted: true, id };
  }

  private audit(event: AuthAuditEvent, metadata: Record<string, unknown> = {}, userId?: string | null): void {
    this.authAuditService?.record(event, metadata, userId);
  }

  async getDashboard(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException();
    }
    const subscriptionDelegate = (this.prisma as unknown as { subscription?: UserSubscriptionDelegate }).subscription;
    const rawSubscription = subscriptionDelegate
      ? await subscriptionDelegate.findUnique({ where: { userId }, include: { plan: true } })
      : null;
    const subscription = rawSubscription ? applyPlanSnapshot(rawSubscription) as typeof rawSubscription : null;
    const lines = await this.availableLineSummaries(user, subscription);
    const trafficLimitBytes = subscription?.trafficLimitBytes ?? user.trafficLimitBytes;
    const trafficUsedBytes = subscription?.trafficUsedBytes ?? user.trafficUsedBytes;
    const expireAt = subscription?.expireAt ?? user.expireAt;
    const subscriptionToken = subscription?.subscriptionToken ?? user.subscriptionToken;
    return {
      // BigInt 无法 JSON 序列化，在服务边界转 Number（流量值 < 2^53，无精度损失）
      trafficLimitBytes: Number(trafficLimitBytes),
      trafficUsedBytes: Number(trafficUsedBytes),
      expireAt,
      subscriptionToken,
      plan: subscription?.plan ? { id: subscription.plan.id, name: subscription.plan.name, status: subscription.status } : null,
      onlineNodeCount: lines.length,
      lines
    };
  }

  // 公开节点列表（用户可见视图，不含 agentToken 等敏感字段）
  async getAvailableNodes(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException();
    }
    const subscriptionDelegate = (this.prisma as unknown as { subscription?: UserSubscriptionDelegate }).subscription;
    const rawSubscription = subscriptionDelegate
      ? await subscriptionDelegate.findUnique({ where: { userId }, include: { plan: true } })
      : null;
    const subscription = rawSubscription ? applyPlanSnapshot(rawSubscription) as typeof rawSubscription : null;
    const lines = await this.availableLineSummaries(user, subscription);
    return {
      entitled: this.hasLineEntitlement(user, subscription),
      lines,
      nodes: lines
    };
  }

  private hasLineEntitlement(user: { isActive: boolean; expireAt: Date | null; trafficUsedBytes: bigint; trafficLimitBytes: bigint }, subscription: UserSubscriptionSnapshot | null): boolean {
    return Boolean(subscription && user.isActive && ['ACTIVE', 'CANCELED'].includes(subscription.status) && (!subscription.expireAt || subscription.expireAt > new Date()) && subscription.trafficUsedBytes < subscription.trafficLimitBytes);
  }

  private async availableLineSummaries(user: Prisma.UserGetPayload<object>, subscription: UserSubscriptionSnapshot | null) {
    const settings = await this.settingsService.getSettings();
    if (!this.linesService || !this.hasLineEntitlement(user, subscription) || (settings?.enforceEmailVerification && user.role !== 'ADMIN' && !user.emailVerifiedAt)) return [];
    const extraLineIds = await this.getExtraLineIds(user.id);
    const resources = await this.linesService.getAvailableForPlan(subscription?.plan ?? { lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]' }, extraLineIds);
    return resources.map((line) => this.linesService!.toUserSummary(line));
  }

  private async resolveInitialPlan(planId?: string | null) {
    const planDelegate = (this.prisma as unknown as { plan?: UserPlanDelegate }).plan;
    if (!planDelegate) return null;
    if (planId === null) return null;
    if (planId) {
      const plan = await planDelegate.findUnique({ where: { id: planId } });
      if (!plan) throw new NotFoundException('套餐不存在');
      return plan;
    }
    return (
      (await planDelegate.findFirst({ where: { name: '体验套餐' } })) ??
      (await planDelegate.findFirst({ where: { isPublic: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }))
    );
  }

  private async getExtraLineIds(userId: string): Promise<string[]> {
    const delegate = (this.prisma as unknown as {
      userLineGrant?: { findMany: (args: Record<string, unknown>) => Promise<Array<{ lineId: string }>> };
    }).userLineGrant;
    if (!delegate) return [];
    const rows = await delegate.findMany({ where: { userId }, select: { lineId: true } });
    return rows.map((row) => row.lineId);
  }
}
