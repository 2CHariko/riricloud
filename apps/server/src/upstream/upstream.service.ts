import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService } from '../agent-gateway/agent.service';
import { SettingsService } from '../system/settings.service';
import { LinesService } from '../lines/lines.service';
import { SystemLogsService } from '../system-logs/system-logs.service';
import { protectEntryParams } from '../common/upstream-egress';
import { resolveUpstreamCredentials } from '../common/upstream-egress';
import { findAvailableRandomPort } from '../common/ports';
import type { ProtocolType } from '../common/constants';
import {
  extractProxyProviderUrls,
  MAX_PARSED_NODES,
  parseUpstreamContent,
  UpstreamFormatError,
  type ParsedUpstreamNode,
  type SkippedUpstreamNode,
  type UpstreamFormat
} from './parsers';
import {
  maskUpstreamUrl,
  upstreamLogMetadata,
  UpstreamFetchService
} from './upstream-fetch.service';
import type {
  CreateUpstreamSubscriptionDto,
  MaterializeUpstreamDto,
  PreviewUpstreamDto,
  QueryUpstreamEntriesDto,
  QueryUpstreamSubscriptionDto,
  UpdateUpstreamSubscriptionDto
} from './dto/upstream.dto';

/** 同步调度器的自省周期：每 5 分钟检查一次是否有订阅到期。 */
const SYNC_TICK_MS = 5 * 60 * 1000;

export type UpstreamSyncSummary = {
  subscriptionId: string;
  format: UpstreamFormat;
  fetchedBytes: number;
  parsed: number;
  added: number;
  refreshed: number;
  credentialsRotated: number;
  orphaned: number;
  skipped: SkippedUpstreamNode[];
};

export type UpstreamPreviewSummary = {
  format: UpstreamFormat;
  nodes: Array<{
    entryKey: string;
    name: string;
    protocolType: string;
    server: string;
    port: number;
    imported: boolean;
    entryId: string | null;
  }>;
  skipped: SkippedUpstreamNode[];
  providerCount: number;
};

@Injectable()
export class UpstreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UpstreamService.name);
  private syncTimer?: NodeJS.Timeout;
  private syncing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly fetchService: UpstreamFetchService,
    @Optional() private readonly agentService?: AgentService,
    @Optional() private readonly settingsService?: SettingsService,
    @Optional() private readonly linesService?: LinesService,
    @Optional() private readonly systemLogs?: SystemLogsService
  ) {}

  onModuleInit() {
    // 进程内调度，保持零外部依赖（cron/队列均不引入）。
    this.syncTimer = setInterval(() => {
      void this.runScheduledSync();
    }, SYNC_TICK_MS);
    this.syncTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
  }

  // ==============================
  // 订阅源 CRUD
  // ==============================

  async list(query: QueryUpstreamSubscriptionDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where: Prisma.UpstreamSubscriptionWhereInput = {
      ...(query.enabled !== undefined ? { enabled: query.enabled } : {}),
      ...(query.search
        ? { OR: [{ name: { contains: query.search } }, { url: { contains: query.search } }] }
        : {})
    };
    const [rows, total] = await Promise.all([
      this.prisma.upstreamSubscription.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { _count: { select: { entries: true, lines: true } } }
      }),
      this.prisma.upstreamSubscription.count({ where })
    ]);
    const data = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        name: row.name,
        // 完整 URL 内嵌机场鉴权 Token，管理端只暴露 host
        host: maskUpstreamUrl(row.url),
        enabled: row.enabled,
        syncIntervalMins: row.syncIntervalMins,
        userAgent: row.userAgent,
        lastFetchedAt: row.lastFetchedAt,
        lastFetchStatus: row.lastFetchStatus ?? 'NEVER',
        lastFetchError: row.lastFetchError,
        detectedFormat: row.detectedFormat,
        entryCount: row._count.entries,
        lineCount: row._count.lines,
        availableEntryCount: await this.prisma.upstreamProxyEntry.count({
          where: { subscriptionId: row.id, available: true }
        }),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      }))
    );
    return { data, total, page, pageSize };
  }

  async detail(id: string) {
    const row = await this.prisma.upstreamSubscription.findUnique({
      where: { id },
      include: { _count: { select: { entries: true, lines: true } } }
    });
    if (!row) throw new NotFoundException('上游订阅不存在');
    const entries = await this.prisma.upstreamProxyEntry.findMany({
      where: { subscriptionId: id },
      orderBy: [{ available: 'desc' }, { name: 'asc' }],
      take: 100,
      include: { _count: { select: { lines: true } } }
    });
    return {
      subscription: {
        id: row.id,
        name: row.name,
        host: maskUpstreamUrl(row.url),
        enabled: row.enabled,
        syncIntervalMins: row.syncIntervalMins,
        userAgent: row.userAgent,
        lastFetchedAt: row.lastFetchedAt,
        lastFetchStatus: row.lastFetchStatus ?? 'NEVER',
        lastFetchError: row.lastFetchError,
        detectedFormat: row.detectedFormat,
        entryCount: row._count.entries,
        lineCount: row._count.lines,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      },
      entries: entries.map((entry) => this.toEntryView(entry))
    };
  }

  async create(dto: CreateUpstreamSubscriptionDto) {
    await this.assertFeatureEnabled();
    const created = await this.prisma.upstreamSubscription.create({
      data: {
        name: dto.name.trim(),
        url: dto.url.trim(),
        enabled: dto.enabled ?? true,
        syncIntervalMins: dto.syncIntervalMins ?? 720,
        userAgent: dto.userAgent?.trim() || null,
        lastFetchStatus: 'NEVER'
      }
    });
    this.audit('创建上游订阅', created, { enabled: created.enabled });
    return { subscription: { id: created.id, name: created.name, host: maskUpstreamUrl(created.url) } };
  }

  async update(id: string, dto: UpdateUpstreamSubscriptionDto) {
    const current = await this.prisma.upstreamSubscription.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('上游订阅不存在');
    const updated = await this.prisma.upstreamSubscription.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.url !== undefined ? { url: dto.url.trim(), lastFetchStatus: 'NEVER', lastFetchError: null } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.syncIntervalMins !== undefined ? { syncIntervalMins: dto.syncIntervalMins } : {}),
        ...(dto.userAgent !== undefined ? { userAgent: dto.userAgent?.trim() || null } : {})
      }
    });
    this.audit('更新上游订阅', updated);
    return { subscription: { id: updated.id, name: updated.name, host: maskUpstreamUrl(updated.url) } };
  }

  async remove(id: string) {
    const current = await this.prisma.upstreamSubscription.findUnique({
      where: { id },
      include: { entries: { select: { id: true } } }
    });
    if (!current) throw new NotFoundException('上游订阅不存在');
    const entryIds = current.entries.map((entry) => entry.id);
    if (entryIds.length) {
      const referenced = await this.prisma.line.findFirst({
        where: { upstreamEntryId: { in: entryIds } },
        select: { id: true }
      });
      if (referenced) {
        throw new ConflictException('该订阅的节点已被线路引用，请先删除或改绑相关线路');
      }
    }
    await this.prisma.upstreamSubscription.delete({ where: { id } });
    this.audit('删除上游订阅', current);
    return { deleted: true, id };
  }

  // ==============================
  // 导入预览（不落库）
  // ==============================

  async preview(dto: PreviewUpstreamDto): Promise<UpstreamPreviewSummary> {
    const resolved = await this.resolveNodes(dto);
    const keys = resolved.nodes.map((node) => node.entryKey);
    const existing = keys.length
      ? await this.prisma.upstreamProxyEntry.findMany({
          where: { entryKey: { in: keys }, subscriptionId: null },
          select: { id: true, entryKey: true }
        })
      : [];
    const existingByKey = new Map(existing.map((row) => [row.entryKey, row.id]));

    return {
      format: resolved.format,
      providerCount: resolved.providerCount,
      nodes: resolved.nodes.map((node) => ({
        entryKey: node.entryKey,
        name: node.name,
        protocolType: node.protocolType,
        server: node.server,
        port: node.port,
        imported: existingByKey.has(node.entryKey),
        entryId: existingByKey.get(node.entryKey) ?? null
      })),
      skipped: resolved.skipped
    };
  }

  /**
   * 把订阅内容落库为上游条目（不创建线路）。
   * 预览接口本身不落库，物化前由本方法持久化条目。
   */
  async importEntries(dto: PreviewUpstreamDto): Promise<{ imported: number; entryIds: string[]; skipped: SkippedUpstreamNode[] }> {
    await this.assertFeatureEnabled();
    const resolved = await this.resolveNodes(dto);
    const entryIds: string[] = [];

    for (const node of resolved.nodes) {
      const existing = await this.prisma.upstreamProxyEntry.findFirst({
        where: { subscriptionId: null, entryKey: node.entryKey },
        select: { id: true }
      });
      if (existing) {
        entryIds.push(existing.id);
        continue;
      }
      const entry = await this.prisma.upstreamProxyEntry.create({
        data: {
          subscriptionId: null,
          name: node.name,
          protocolType: node.protocolType,
          server: node.server,
          port: node.port,
          paramsJson: JSON.stringify(protectEntryParams(node.params as unknown as Record<string, unknown>)),
          entryKey: node.entryKey,
          available: true,
          lastSeenAt: new Date()
        }
      });
      entryIds.push(entry.id);
    }
    return { imported: entryIds.length, entryIds, skipped: resolved.skipped };
  }

  /**
   * 预览与导入共用的解析链路：抓取/直贴内容 → 格式识别 → 可选递归 proxy-providers → 去重。
   * 结果保留完整 `params`，因此导入无需二次解析。
   */
  private async resolveNodes(dto: PreviewUpstreamDto): Promise<{
    format: UpstreamFormat;
    nodes: ParsedUpstreamNode[];
    skipped: SkippedUpstreamNode[];
    providerCount: number;
  }> {
    if (!dto.url && !dto.content) {
      throw new BadRequestException('必须提供订阅地址或直接粘贴订阅内容');
    }
    const rawParts: string[] = [];
    if (dto.content) rawParts.push(dto.content);
    if (dto.url) {
      await this.assertFeatureEnabled();
      const fetched = await this.fetchService.fetch(dto.url, dto.userAgent);
      rawParts.push(fetched.content);
    }

    const combined = rawParts.join('\n');
    const parsed = this.safeParse(combined);
    const nodes = [...parsed.nodes];
    const skipped = [...parsed.skipped];
    let providerCount = 0;

    if (dto.followProviders && dto.url) {
      const providerUrls = extractProxyProviderUrls(combined).slice(0, 5);
      providerCount = providerUrls.length;
      for (const providerUrl of providerUrls) {
        try {
          const fetched = await this.fetchService.fetch(providerUrl, dto.userAgent);
          const providerParsed = this.safeParse(fetched.content);
          nodes.push(...providerParsed.nodes);
          skipped.push(...providerParsed.skipped);
        } catch (error) {
          skipped.push({
            name: maskUpstreamUrl(providerUrl),
            reason: 'INVALID_PARAMS',
            detail: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    // 去重（保留先出现的条目），避免同名同端点重复物化
    const unique = new Map(nodes.map((node) => [node.entryKey, node]));
    return { format: parsed.format, nodes: [...unique.values()], skipped, providerCount };
  }

  // ==============================
  // 同步与对账
  // ==============================

  async sync(id: string, options: { manual?: boolean } = {}): Promise<UpstreamSyncSummary> {
    const subscription = await this.prisma.upstreamSubscription.findUnique({ where: { id } });
    if (!subscription) throw new NotFoundException('上游订阅不存在');
    if (!options.manual && !subscription.enabled) {
      throw new BadRequestException('该上游订阅已停用');
    }
    await this.assertFeatureEnabled();

    let content: string;
    let bytes = 0;
    try {
      const fetched = await this.fetchService.fetch(subscription.url, subscription.userAgent);
      content = fetched.content;
      bytes = fetched.bytes;
    } catch (error) {
      // 抓取失败不影响既有线路可用性，仅记录状态
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.upstreamSubscription.update({
        where: { id },
        data: { lastFetchedAt: new Date(), lastFetchStatus: 'FAILED', lastFetchError: message.slice(0, 500) }
      });
      throw new BadGatewayLikeError(message);
    }

    const parsed = this.safeParse(content);
    const summary = await this.reconcile(subscription.id, parsed.format, parsed.nodes);

    await this.prisma.upstreamSubscription.update({
      where: { id },
      data: {
        lastFetchedAt: new Date(),
        lastFetchStatus: 'SUCCESS',
        lastFetchError: null,
        detectedFormat: parsed.format
      }
    });
    this.audit('同步上游订阅', subscription, {
      format: parsed.format,
      added: summary.added,
      refreshed: summary.refreshed,
      orphaned: summary.orphaned,
      skipped: summary.skipped.length
    });

    if (summary.added || summary.refreshed || summary.credentialsRotated || summary.orphaned) {
      this.scheduleConfigSync('upstream-sync');
    }

    return { ...summary, fetchedBytes: bytes, skipped: parsed.skipped };
  }

  /**
   * 对账：按 `entryKey` 匹配既有条目。
   *
   * - 命中：刷新名称/协议/端点，并**刷新凭据**（机场轮换密码时用户侧不断流）；
   * - 未命中：新增条目，但**不自动生成线路**，避免订阅列表被上游静默污染；
   * - 消失：置 `available=false` 并保留已生成线路（是否下发由健康门决定）。
   */
  private async reconcile(
    subscriptionId: string,
    format: UpstreamFormat,
    nodes: ParsedUpstreamNode[]
  ): Promise<Omit<UpstreamSyncSummary, 'fetchedBytes' | 'skipped'> & { skipped: SkippedUpstreamNode[] }> {
    const existing = await this.prisma.upstreamProxyEntry.findMany({ where: { subscriptionId } });
    const byKey = new Map(existing.map((row) => [row.entryKey, row]));

    let added = 0;
    let refreshed = 0;
    let credentialsRotated = 0;

    for (const node of nodes) {
      const protectedParams = JSON.stringify(protectEntryParams(node.params as unknown as Record<string, unknown>));
      const current = byKey.get(node.entryKey);
      if (!current) {
        await this.prisma.upstreamProxyEntry.create({
          data: {
            subscriptionId,
            name: node.name,
            protocolType: node.protocolType,
            server: node.server,
            port: node.port,
            paramsJson: protectedParams,
            entryKey: node.entryKey,
            available: true,
            lastSeenAt: new Date()
          }
        });
        added += 1;
        continue;
      }

      // 长连接出口只在参数发生变化时才写库，避免每次同步都产生无意义写入
      const credentialsChanged = this.credentialsDiffer(current.paramsJson, node);
      const nameChanged = current.name !== node.name;
      if (credentialsChanged || nameChanged || !current.available) {
        await this.prisma.upstreamProxyEntry.update({
          where: { id: current.id },
          data: {
            name: node.name,
            paramsJson: protectedParams,
            available: true,
            lastSeenAt: new Date()
          }
        });
        refreshed += 1;
        if (credentialsChanged) credentialsRotated += 1;
      } else {
        await this.prisma.upstreamProxyEntry.update({
          where: { id: current.id },
          data: { lastSeenAt: new Date() }
        });
      }
      byKey.delete(node.entryKey);
    }

    // 剩余即本次未再见到的条目
    const orphanIds = [...byKey.values()].map((row) => row.id);
    let orphaned = 0;
    if (orphanIds.length) {
      const result = await this.prisma.upstreamProxyEntry.updateMany({
        where: { id: { in: orphanIds } },
        data: { available: false }
      });
      orphaned = result.count;
    }

    if (credentialsRotated > 0) {
      this.logger.warn(
        `上游订阅 ${subscriptionId} 本次刷新了 ${credentialsRotated} 个节点的凭据，请核查上游是否被换手`
      );
    }

    return { subscriptionId, format, parsed: nodes.length, added, refreshed, credentialsRotated, orphaned, skipped: [] };
  }

  /** 凭据是否发生变化：只比对凭据字段，避免端点或名称变化被误判为凭据轮换。 */
  private credentialsDiffer(storedParamsJson: string, node: ParsedUpstreamNode): boolean {
    const stored = resolveUpstreamCredentials({ id: '', name: '', paramsJson: storedParamsJson });
    const incoming = {
      uuid: node.params.uuid ?? '',
      email: node.params.username ?? '',
      secret: node.params.password ?? ''
    };
    return stored.uuid !== incoming.uuid || stored.email !== incoming.email || stored.secret !== incoming.secret;
  }

  // ==============================
  // 条目查询
  // ==============================

  async listEntries(query: QueryUpstreamEntriesDto & { subscriptionId?: string }) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where: Prisma.UpstreamProxyEntryWhereInput = {
      ...(query.subscriptionId !== undefined ? { subscriptionId: query.subscriptionId } : {}),
      ...(query.protocolType ? { protocolType: query.protocolType } : {}),
      ...(query.available !== undefined ? { available: query.available } : {}),
      ...(query.search ? { name: { contains: query.search } } : {})
    };
    const [rows, total] = await Promise.all([
      this.prisma.upstreamProxyEntry.findMany({
        where,
        orderBy: [{ available: 'desc' }, { createdAt: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { _count: { select: { lines: true } }, subscription: { select: { id: true, name: true } } }
      }),
      this.prisma.upstreamProxyEntry.count({ where })
    ]);
    return { data: rows.map((row) => this.toEntryView(row)), total, page, pageSize };
  }

  private toEntryView(entry: {
    id: string;
    subscriptionId: string | null;
    name: string;
    protocolType: string;
    server: string;
    port: number;
    entryKey: string;
    available: boolean;
    lastSeenAt: Date;
    createdAt: Date;
    _count?: { lines: number };
    subscription?: { id: string; name: string } | null;
  }) {
    return {
      id: entry.id,
      subscriptionId: entry.subscriptionId,
      subscriptionName: entry.subscription?.name ?? null,
      name: entry.name,
      protocolType: entry.protocolType,
      // 服务器与端口是运维必需信息（没有凭据无法连接）；凭据永不返回
      server: entry.server,
      port: entry.port,
      entryKey: entry.entryKey,
      available: entry.available,
      materializedLineCount: entry._count?.lines ?? 0,
      lastSeenAt: entry.lastSeenAt,
      createdAt: entry.createdAt
    };
  }

  // ==============================
  // 物化：条目 → 线路
  // ==============================

  async materialize(dto: MaterializeUpstreamDto) {
    if (!this.linesService) {
      throw new BadRequestException('线路服务不可用，无法生成线路');
    }
    await this.assertFeatureEnabled();

    const entries = await this.prisma.upstreamProxyEntry.findMany({
      where: { id: { in: dto.entryIds } }
    });
    if (!entries.length) throw new NotFoundException('未找到任何上游条目');
    if (entries.length !== new Set(dto.entryIds).size) {
      throw new BadRequestException('部分上游条目不存在');
    }

    const node = await this.prisma.node.findUnique({
      where: { id: dto.entryNodeId },
      select: { id: true, name: true, reachability: true }
    });
    if (!node) throw new NotFoundException('入口节点不存在');
    if (node.reachability === 'NAT') {
      throw new BadRequestException('NAT 节点（无公网 IP）不支持作为上游入口，仅支持作为中继落地节点');
    }

    const tags = dto.tags?.map((tag) => tag.trim()).filter(Boolean) ?? [];
    const isPublic = dto.isPublic ?? false;
    const status = dto.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE';
    const baseParams = dto.params ?? {};
    const created: Array<{ entryId: string; egressLineId: string; lineId: string; name: string }> = [];

    for (const entry of entries) {
      // 每条上游条目生成两条线路：出口线路（不监听）+ 用户面向线路（监听入口协议）
      const egressName = this.uniqueLineName(`上游出口 · ${entry.name}`, await this.existingLineNames());
      const egressPort = await this.allocatePlaceholderPort(dto.entryNodeId);
      const egress = await this.linesService.create({
        name: egressName,
        type: 'DIRECT',
        protocolType: entry.protocolType as ProtocolType,
        params: {},
        entryNodeId: dto.entryNodeId,
        entryPort: egressPort,
        isPublic: false,
        status: 'ACTIVE',
        tags: [],
        sortOrder: 0,
        level: 0
      });
      const egressLineId = (egress.line as { id: string }).id;

      // 绑定上游条目：必须在创建后回写，因为 CreateLineDto 不暴露该字段（上游条目只能由本服务托管）
      await this.prisma.line.update({
        where: { id: egressLineId },
        data: { upstreamEntryId: entry.id, upstreamSubscriptionId: entry.subscriptionId }
      });

      const displayName = dto.namePrefix ? `${dto.namePrefix} ${entry.name}` : entry.name;
      const linePort = await this.allocateEntryPort(dto.entryNodeId, dto.entryProtocolType);
      const line = await this.linesService.create({
        name: displayName,
        type: 'DIRECT',
        protocolType: dto.entryProtocolType,
        params: baseParams,
        entryNodeId: dto.entryNodeId,
        entryPort: linePort,
        egressLineId,
        tags,
        level: dto.level ?? 0,
        sortOrder: 0,
        isPublic,
        status,
        trafficRate: dto.trafficRate ?? 1,
        speedLimitMbps: dto.speedLimitMbps ?? 0
      });

      created.push({
        entryId: entry.id,
        egressLineId,
        lineId: (line.line as { id: string }).id,
        name: displayName
      });
    }

    this.audit('物化上游条目为线路', { id: dto.entryNodeId, name: node.name, url: '' }, {
      entryCount: entries.length,
      entryProtocolType: dto.entryProtocolType,
      isPublic
    });
    this.scheduleConfigSync('upstream-materialize');

    return { created, total: created.length };
  }

  private async existingLineNames(): Promise<Set<string>> {
    const rows = await this.prisma.line.findMany({ select: { name: true } });
    return new Set(rows.map((row) => row.name));
  }

  /** 出口线路不监听端口，但仍需一个不与他人冲突的占位端口，避免用户查看时产生歧义。 */
  private async allocatePlaceholderPort(nodeId: string): Promise<number> {
    return this.findPort(nodeId, 'VLESS');
  }

  private async allocateEntryPort(nodeId: string, protocolType: ProtocolType): Promise<number> {
    return this.findPort(nodeId, protocolType);
  }

  private async findPort(nodeId: string, protocolType: ProtocolType): Promise<number> {
    const udpOnly = protocolType === 'HYSTERIA2' || protocolType === 'TUIC';
    try {
      return await findAvailableRandomPort(async (port) => {
        const rows = await this.prisma.line.findMany({
          where: {
            upstreamEntryId: null,
            OR: [{ entryNodeId: nodeId, entryPort: port }, { landingNodeId: nodeId, landingPort: port }]
          },
          select: { protocolType: true }
        });
        return !rows.some((line) => {
          const otherUdp = line.protocolType === 'HYSTERIA2' || line.protocolType === 'TUIC';
          return otherUdp === udpOnly;
        });
      });
    } catch {
      throw new ConflictException('入口节点没有可用的线路端口');
    }
  }

  private uniqueLineName(base: string, existing: Set<string>): string {
    if (!existing.has(base)) return base;
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${base} (${index})`;
      if (!existing.has(candidate)) return candidate;
    }
    return `${base} ${Date.now()}`;
  }

  // ==============================
  // 调度与辅助
  // ==============================

  private async runScheduledSync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const settings = await this.settingsService?.getSettings();
      if (settings && settings.upstreamSubscriptionEnabled === false) return;

      const subscriptions = await this.prisma.upstreamSubscription.findMany({ where: { enabled: true } });
      const now = Date.now();
      for (const subscription of subscriptions) {
        const dueAt = (subscription.lastFetchedAt?.getTime() ?? 0) + subscription.syncIntervalMins * 60 * 1000;
        if (now < dueAt) continue;
        try {
          await this.sync(subscription.id, { manual: false });
        } catch (error) {
          this.logger.warn(
            `上游订阅自动同步失败 ${upstreamLogMetadata(subscription).host}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    } catch (error) {
      this.logger.warn(`上游订阅调度检查失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.syncing = false;
    }
  }

  private safeParse(content: string): { format: UpstreamFormat; nodes: ParsedUpstreamNode[]; skipped: SkippedUpstreamNode[] } {
    try {
      return parseUpstreamContent(content);
    } catch (error) {
      if (error instanceof UpstreamFormatError) {
        throw new BadRequestException(error.message);
      }
      throw new BadRequestException(`订阅解析失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async assertFeatureEnabled(): Promise<void> {
    const settings = await this.settingsService?.getSettings();
    if (settings && settings.upstreamSubscriptionEnabled === false) {
      throw new BadRequestException('上游订阅功能已关闭，请先在系统设置中开启');
    }
  }

  private scheduleConfigSync(reason: string): void {
    if (!this.agentService) return;
    void this.agentService.pushConfigToAll().catch((error: unknown) => {
      this.logger.warn(`upstream config sync failed: reason=${reason} error=${String(error)}`);
    });
  }

  private audit(
    message: string,
    subscription: { id: string; name: string; url: string },
    metadata: Record<string, unknown> = {}
  ): void {
    this.systemLogs?.enqueue({
      level: 'INFO',
      source: 'SERVER',
      module: 'UPSTREAM',
      message,
      metadata: { ...upstreamLogMetadata(subscription), ...metadata }
    });
  }
}

/** 抓取/上游故障：交给控制器映射为 502，与参数错误区分开。 */
export class BadGatewayLikeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadGatewayLikeError';
  }
}

export { MAX_PARSED_NODES };
