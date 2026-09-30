import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePlanDto } from './dto/create-plan.dto';
import { QueryPlanDto } from './dto/query-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { LinesService } from '../lines/lines.service';

type PlanViewInput = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  durationDays: number;
  trafficLimitBytes: bigint;
  trafficResetMode: string;
  lineMatchMode: string;
  lineTagsJson: string;
  lineIdsJson: string;
  templateId: string | null;
  badgeText?: string | null;
  isFeatured?: boolean;
  featuresJson?: string;
  cardConfigJson?: string;
  isPublic: boolean;
  sortOrder: number;
  purchaseLimitPerUser?: number | null;
  allowRenewal?: boolean;
  [key: string]: unknown;
};

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseCardConfig(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

@Injectable()
export class PlansService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly linesService?: LinesService
  ) {}

  async create(dto: CreatePlanDto) {
    await this.ensureTemplate(dto.templateId);
    const plan = await this.prisma.plan.create({ data: this.toCreateData(dto) });
    return this.toView(plan);
  }

  async list(query: QueryPlanDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = {
      ...(query.search ? { name: { contains: query.search } } : {}),
      ...(query.isPublic !== undefined ? { isPublic: query.isPublic } : {})
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.plan.findMany({
        where,
        include: { template: { select: { id: true, name: true, isDefault: true } } },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      this.prisma.plan.count({ where })
    ]);
    return { data: data.map((plan) => this.toView(plan)), total, page, pageSize };
  }

  async listPublic() {
    const result = await this.list({ page: 1, pageSize: 100, isPublic: true });
    return result.data;
  }

  async get(id: string) {
    const plan = await this.prisma.plan.findUnique({
      where: { id },
      include: { template: { select: { id: true, name: true, isDefault: true } } }
    });
    if (!plan) throw new NotFoundException('套餐不存在');
    return this.toView(plan);
  }

  async update(id: string, dto: UpdatePlanDto) {
    await this.get(id);
    await this.ensureTemplate(dto.templateId);
    const plan = await this.prisma.plan.update({ where: { id }, data: this.toUpdateData(dto) });
    if (!plan.isPublic) {
      await (this.prisma as unknown as {
        systemSetting?: { deleteMany?: (args: Record<string, unknown>) => Promise<unknown> };
      }).systemSetting?.deleteMany?.({ where: { key: 'defaultPlanId', value: id } });
    }
    return this.toView(plan);
  }

  async remove(id: string) {
    return this.prisma.$transaction(async (tx) => {
      const plan = await tx.plan.findUnique({
        where: { id },
        include: { _count: { select: { subscriptions: true, purchases: true } } }
      });
      if (!plan) throw new NotFoundException('套餐不存在');
      const unusedRedeemCodes = await tx.redeemCode.count({ where: { planId: id, status: 'UNUSED' } });
      if (unusedRedeemCodes > 0) {
        throw new ConflictException('仍有未兑换套餐卡引用该套餐，请先作废或等待兑换后再删除');
      }
      if (plan._count.subscriptions > 0 || plan._count.purchases > 0) {
        throw new ConflictException('已有订阅或购买记录使用该套餐，请先下架而不要删除');
      }
      // 分类不物理删除；套餐被移除后归档并清除配置引用，已发出的卡仍按奖励快照履约。
      await tx.redeemCodeCategory.updateMany({ where: { planId: id }, data: { isActive: false, planId: null } });
      await (tx as unknown as {
        systemSetting?: { deleteMany?: (args: Record<string, unknown>) => Promise<unknown> };
      }).systemSetting?.deleteMany?.({ where: { key: 'defaultPlanId', value: id } });
      await tx.plan.delete({ where: { id } });
      return { deleted: true };
    });
  }

  async getAvailableLines(id: string) {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('套餐不存在');
    if (!this.linesService) throw new NotFoundException('线路服务不可用');
    const resources = await this.linesService.getAvailableForPlan(plan);
    return resources.map((line) => this.linesService!.toUserSummary(line));
  }

  // 兼容旧管理端路径；返回内容已切换为线路。
  async getAvailableNodes(id: string) {
    return this.getAvailableLines(id);
  }

  private async ensureTemplate(templateId: string | null | undefined) {
    if (templateId && !(await this.prisma.subscriptionTemplate.findUnique({ where: { id: templateId } }))) {
      throw new NotFoundException('订阅模板不存在');
    }
  }

  private toCreateData(dto: CreatePlanDto) {
    return {
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      price: toCents(dto.price ?? 0),
      durationDays: dto.durationDays,
      trafficLimitBytes: BigInt(dto.trafficLimitBytes),
      trafficResetMode: dto.trafficResetMode ?? 'NONE',
      lineMatchMode: dto.lineMatchMode ?? 'ALL',
      lineTagsJson: JSON.stringify(dto.lineTags ?? []),
      lineIdsJson: JSON.stringify(dto.lineIds ?? []),
      templateId: dto.templateId ?? null,
      badgeText: dto.badgeText?.trim() || null,
      isFeatured: dto.isFeatured ?? false,
      featuresJson: JSON.stringify(dto.features ?? []),
      cardConfigJson: JSON.stringify(dto.cardConfig ?? {}),
      isPublic: dto.isPublic ?? true,
      sortOrder: dto.sortOrder ?? 0,
      purchaseLimitPerUser: dto.purchaseLimitPerUser !== undefined
        ? dto.purchaseLimitPerUser
        : toCents(dto.price ?? 0) === 0 ? 1 : null,
      allowRenewal: dto.allowRenewal ?? (toCents(dto.price ?? 0) !== 0),
      speedLimitMbps: dto.speedLimitMbps ?? 0,
      deviceLimit: dto.deviceLimit ?? 0,
      appendSpeedBadge: dto.appendSpeedBadge ?? 'INHERIT'
    };
  }

  private toUpdateData(dto: UpdatePlanDto) {
    const price = dto.price !== undefined ? toCents(dto.price) : undefined;
    const freePlan = price === 0;
    const paidPlan = price !== undefined && price > 0;
    return {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
      ...(price !== undefined ? { price } : {}),
      ...(dto.durationDays !== undefined ? { durationDays: dto.durationDays } : {}),
      ...(dto.trafficLimitBytes !== undefined ? { trafficLimitBytes: BigInt(dto.trafficLimitBytes) } : {}),
      ...(dto.trafficResetMode !== undefined ? { trafficResetMode: dto.trafficResetMode } : {}),
      ...(dto.lineMatchMode !== undefined ? { lineMatchMode: dto.lineMatchMode } : {}),
      ...(dto.lineTags !== undefined ? { lineTagsJson: JSON.stringify(dto.lineTags) } : {}),
      ...(dto.lineIds !== undefined ? { lineIdsJson: JSON.stringify(dto.lineIds) } : {}),
      ...(dto.templateId !== undefined ? { templateId: dto.templateId } : {}),
      ...(dto.badgeText !== undefined ? { badgeText: dto.badgeText?.trim() || null } : {}),
      ...(dto.isFeatured !== undefined ? { isFeatured: dto.isFeatured } : {}),
      ...(dto.features !== undefined ? { featuresJson: JSON.stringify(dto.features) } : {}),
      ...(dto.cardConfig !== undefined ? { cardConfigJson: JSON.stringify(dto.cardConfig) } : {}),
      ...(dto.isPublic !== undefined ? { isPublic: dto.isPublic } : {}),
      ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      ...(dto.speedLimitMbps !== undefined ? { speedLimitMbps: dto.speedLimitMbps ?? 0 } : {}),
      ...(dto.deviceLimit !== undefined ? { deviceLimit: dto.deviceLimit ?? 0 } : {}),
      ...(dto.appendSpeedBadge !== undefined ? { appendSpeedBadge: dto.appendSpeedBadge } : {}),
      ...(dto.purchaseLimitPerUser !== undefined
        ? { purchaseLimitPerUser: dto.purchaseLimitPerUser }
        : freePlan
          ? { purchaseLimitPerUser: 1 }
          : paidPlan
            ? { purchaseLimitPerUser: null }
            : {}),
      ...(dto.allowRenewal !== undefined
        ? { allowRenewal: dto.allowRenewal }
        : freePlan
          ? { allowRenewal: false }
          : paidPlan
            ? { allowRenewal: true }
            : {})
    };
  }

  private toView(plan: PlanViewInput) {
    return {
      ...plan,
      price: fromCents(plan.price),
      trafficLimitBytes: Number(plan.trafficLimitBytes),
      lineTags: parseStringArray(plan.lineTagsJson),
      lineIds: parseStringArray(plan.lineIdsJson),
      features: typeof plan.featuresJson === 'string' ? parseStringArray(plan.featuresJson) : [],
      badgeText: plan.badgeText ?? null,
      isFeatured: Boolean(plan.isFeatured),
      cardConfig: parseCardConfig(plan.cardConfigJson),
      lineTagsJson: undefined,
      lineIdsJson: undefined,
      featuresJson: undefined,
      cardConfigJson: undefined
    };
  }
}

function toCents(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('套餐价格必须为非负数');
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || cents > 2147483647) throw new Error('套餐价格超出范围');
  return cents;
}

function fromCents(value: number): number {
  return Number((value / 100).toFixed(2));
}
