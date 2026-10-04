import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/telemetry-client';
import { PrismaService } from '../prisma/prisma.service';
import { TelemetryPrismaService } from '../prisma/telemetry-prisma.service';
import { SettingsService } from '../system/settings.service';
import type { LogMetricsDto, TrendBucket } from './dto/log-metrics.dto';
import type { QueryLogsDto } from './dto/query-logs.dto';
import { maskSensitiveString, retainLogIdentity, sanitizeLogMetadata } from './masking.util';
import { SSEHubService } from './sse-hub.service';

export const LOG_LEVEL_SEVERITY: Record<'DEBUG' | 'INFO' | 'WARN' | 'ERROR', number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40
};

export interface EnqueueLogInput {
  id?: string;
  traceId?: string | null;
  source: 'SERVER' | 'WEB' | 'AGENT' | 'SINGBOX';
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  module: string;
  message: string;
  metadata?: Record<string, unknown> | string;
  nodeId?: string | null;
  userId?: string | null;
  createdAt?: Date;
  bypassMinIngestLevel?: boolean;
}

@Injectable()
export class SystemLogsService implements OnModuleInit, OnModuleDestroy {
  private static readonly MAX_BUFFER_ENTRIES = 5000;
  private static readonly MAX_BUFFER_BYTES = 8 * 1024 * 1024;
  private buffer: Prisma.SystemLogCreateManyInput[] = [];
  private bufferBytes = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<boolean> | null = null;
  private minIngestLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' = 'INFO';
  private readonly ingestion = { instanceId: randomUUID(), filtered: 0, dropped: 0, persistenceFailures: 0, retries: 0, persisted: 0 };
  private readonly attempts = new Map<string, number>();
  private inFlightEntries = 0;
  private inFlightBytes = 0;

  getIngestionStatus() {
    return { ...this.ingestion, pendingEntries: this.buffer.length + this.inFlightEntries, pendingBytes: this.bufferBytes + this.inFlightBytes };
  }

  recordFiltered(count = 1): void { this.ingestion.filtered += count; }

  private entryBytes(entry: Prisma.SystemLogCreateManyInput): number {
    return Buffer.byteLength(entry.message, 'utf8') + Buffer.byteLength(entry.metadata ?? '{}', 'utf8') + 256;
  }

  private important(entry: Prisma.SystemLogCreateManyInput): boolean {
    return entry.level === 'ERROR' || entry.level === 'WARN' || entry.module === 'NodeDiagnostics' || entry.module === 'ConfigSync' || /"event":/.test(entry.metadata ?? '');
  }

  private reserve(entry: Prisma.SystemLogCreateManyInput): boolean {
    const bytes = this.entryBytes(entry);
    while (this.buffer.length + this.inFlightEntries >= SystemLogsService.MAX_BUFFER_ENTRIES || this.bufferBytes + this.inFlightBytes + bytes > SystemLogsService.MAX_BUFFER_BYTES) {
      const index = this.important(entry) ? this.buffer.findIndex((item) => !this.important(item)) : -1;
      if (index < 0) { this.ingestion.dropped += 1; return false; }
      const [removed] = this.buffer.splice(index, 1);
      this.bufferBytes -= this.entryBytes(removed);
      this.attempts.delete(removed.id!);
      this.ingestion.dropped += 1;
    }
    return true;
  }

  constructor(
    private readonly telemetryPrisma: TelemetryPrismaService,
    private readonly prisma: PrismaService,
    private readonly sseHub: SSEHubService,
    @Optional() private readonly settingsService?: SettingsService
  ) {}

  async onModuleInit(): Promise<void> {
    // 启动 1000ms 定时刷新队列，批量落库 SQLite
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, 1000);

    if (this.settingsService) {
      try {
        const settings = await this.settingsService.getSettings();
        if (settings.logsMinIngestLevel) {
          this.minIngestLevel = settings.logsMinIngestLevel;
        }
      } catch {
        // use default
      }
      this.settingsService.onSettingsChange((patch) => {
        if (patch.logsMinIngestLevel) {
          this.minIngestLevel = patch.logsMinIngestLevel;
        }
      });
    }
  }

  getMinIngestLevel(): 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' {
    return this.minIngestLevel;
  }

  setMinIngestLevel(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'): void {
    this.minIngestLevel = level;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /**
   * 写入单条或批量日志到内存环形缓冲队列
   */
  enqueue(input: EnqueueLogInput): void {
    if (!input.bypassMinIngestLevel && LOG_LEVEL_SEVERITY[input.level] < LOG_LEVEL_SEVERITY[this.minIngestLevel]) {
      this.ingestion.filtered += 1;
      return;
    }

    const id = input.id || randomUUID();
    const createdAt = input.createdAt || new Date();
    const maskedMessage = maskSensitiveString(input.message).slice(0, 8192);

    let metadataStr = '{}';
    if (typeof input.metadata === 'string') {
      try {
        const parsed = JSON.parse(input.metadata);
        metadataStr = JSON.stringify(sanitizeLogMetadata(parsed));
      } catch {
        metadataStr = JSON.stringify({ raw: maskSensitiveString(input.metadata) });
      }
    } else if (input.metadata && typeof input.metadata === 'object') {
      metadataStr = JSON.stringify(sanitizeLogMetadata(input.metadata));
    }

    if (Buffer.byteLength(metadataStr, 'utf8') > 16 * 1024) {
      metadataStr = JSON.stringify({ ...retainLogIdentity(JSON.parse(metadataStr)), truncated: true });
    }

    const entry: Prisma.SystemLogCreateManyInput = {
      id,
      traceId: input.traceId || null,
      source: input.source,
      level: input.level,
      module: input.module.slice(0, 128),
      message: maskedMessage,
      metadata: metadataStr,
      nodeId: input.nodeId || null,
      userId: input.userId || null,
      createdAt
    };

    const entryBytes = this.entryBytes(entry);
    if (!this.reserve(entry)) return;

    // 1. 立即广播给当前活跃的 SSE 实时监听客户端（0ms 极低延迟）
    this.sseHub.publish({
      ...entry,
      id,
      metadata: metadataStr,
      createdAt
    });

    // 2. 压入内存批量写入缓冲队列
    this.buffer.push(entry);
    this.bufferBytes += entryBytes;

    // 3. 防抖阈值：积攒超过 50 条立即触发批量写入
    if (this.buffer.length >= 50) {
      void this.flush();
    }
  }

  /**
   * 将内存缓冲队列中的日志批量异步写入 SQLite
   */
  async flush(): Promise<void> {
    if (this.flushPromise) {
      const completed = await this.flushPromise;
      if (completed && this.buffer.length > 0) await this.flush();
      return;
    }
    if (this.buffer.length === 0) {
      return;
    }
    const toWrite = this.buffer.splice(0, 500);
    const writeBytes = toWrite.reduce((sum, entry) => sum + this.entryBytes(entry), 0);
    this.bufferBytes -= writeBytes;
    this.inFlightEntries = toWrite.length;
    this.inFlightBytes = writeBytes;

    const promise = (async () => {
      try {
        await this.telemetryPrisma.systemLog.createMany({ data: toWrite });
        this.ingestion.persisted += toWrite.length;
        toWrite.forEach((item) => this.attempts.delete(item.id!));
        return true;
      } catch {
        // 不在日志链路中递归记录数据库错误；计数可经 metrics/bundle 读取。
        this.ingestion.persistenceFailures += 1;
        this.inFlightEntries = 0;
        this.inFlightBytes = 0;
        for (const item of toWrite) {
          const attempts = (this.attempts.get(item.id!) ?? 0) + 1;
          if (attempts >= 3 || !this.reserve(item)) {
            if (attempts >= 3) this.ingestion.dropped += 1;
            this.attempts.delete(item.id!);
            continue;
          }
          this.attempts.set(item.id!, attempts);
          this.ingestion.retries += 1;
          this.buffer.push(item);
          this.bufferBytes += this.entryBytes(item);
        }
        // 重试留待下一次定时刷新，避免故障时无界忙等。
        return false;
      } finally {
        this.inFlightEntries = 0;
        this.inFlightBytes = 0;
      }
    })();
    this.flushPromise = promise;
    let completed = false;
    try {
      completed = await promise;
    } finally {
      if (this.flushPromise === promise) this.flushPromise = null;
    }
    if (completed && this.buffer.length > 0) await this.flush();
  }

  /**
   * 多维分页组合检索
   */
  async query(dto: QueryLogsDto) {
    // 查询前先刷写内存，确保检索到最新入队的日志
    await this.flush();

    const page = dto.page && dto.page > 0 ? Number(dto.page) : 1;
    const pageSize = dto.pageSize && dto.pageSize > 0 ? Math.min(Number(dto.pageSize), 200) : 50;
    const skip = (page - 1) * pageSize;

    const where = this.buildWhere(dto);

    const [total, items] = await Promise.all([
      this.telemetryPrisma.systemLog.count({ where }),
      this.telemetryPrisma.systemLog.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
      })
    ]);

    // 跨库关联数据回填（保留原返回给前端的 API 结构）
    const nodeIds = [...new Set(items.map((i) => i.nodeId).filter((id): id is string => Boolean(id)))];
    const userIds = [...new Set(items.map((i) => i.userId).filter((id): id is string => Boolean(id)))];

    const [nodes, users] = await Promise.all([
      nodeIds.length > 0
        ? this.prisma.node.findMany({
            where: { id: { in: nodeIds } },
            select: { id: true, name: true, serverHost: true }
          })
        : [],
      userIds.length > 0
        ? this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, email: true, nickname: true }
          })
        : []
    ]);

    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const userMap = new Map(users.map((u) => [u.id, u]));

    const enrichedItems = items.map((item) => ({
      ...item,
      node: item.nodeId ? (nodeMap.get(item.nodeId) ?? null) : null,
      user: item.userId ? (userMap.get(item.userId) ?? null) : null
    }));

    return {
      items: enrichedItems,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize)
    };
  }

  /**
   * 获取大盘 KPI 指标与 24 小时分级趋势
   */
  private buildWhere(dto: QueryLogsDto): Prisma.SystemLogWhereInput {
    const where: Prisma.SystemLogWhereInput = {};
    if (dto.level) where.level = dto.level;
    if (dto.source) where.source = dto.source;
    if (dto.nodeId) where.nodeId = dto.nodeId;
    if (dto.userId) where.userId = dto.userId;
    if (dto.module) where.module = { contains: dto.module.trim() };
    if (dto.traceId) where.traceId = dto.traceId;
    if (dto.startTime || dto.endTime) where.createdAt = { gte: dto.startTime ? new Date(dto.startTime) : undefined, lte: dto.endTime ? new Date(dto.endTime) : undefined };
    if (dto.keyword?.trim()) {
      const kw = dto.keyword.trim();
      where.OR = [{ message: { contains: kw } }, { module: { contains: kw } }, { traceId: { contains: kw } }, { metadata: { contains: kw } }];
    }
    return where;
  }

  async getMetrics(hours = 24, dto: QueryLogsDto = {}): Promise<LogMetricsDto> {
    await this.flush();
    hours = Number.isFinite(hours) ? Math.max(1, Math.min(168, Math.floor(hours))) : 24;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const where = this.buildWhere(dto);
    const windowWhere = { ...where, AND: [{ createdAt: { gte: since } }] };
    const [totalLogs, errorCount24h, warnCount24h, recentLogs, windowCount] = await Promise.all([
      this.telemetryPrisma.systemLog.count({ where }),
      this.telemetryPrisma.systemLog.count({ where: { ...windowWhere, level: dto.level && dto.level !== 'ERROR' ? '__NONE__' : 'ERROR' } }),
      this.telemetryPrisma.systemLog.count({ where: { ...windowWhere, level: dto.level && dto.level !== 'WARN' ? '__NONE__' : 'WARN' } }),
      this.telemetryPrisma.systemLog.findMany({
        where: windowWhere,
        select: { level: true, source: true, module: true, metadata: true, createdAt: true },
        take: 20000,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
      }),
      this.telemetryPrisma.systemLog.count({ where: windowWhere })
    ]);

    // 计算分小时时间桶
    const bucketMap = new Map<string, TrendBucket>();
    const now = new Date();
    for (let i = hours - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 60 * 60 * 1000);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`;
      bucketMap.set(key, {
        bucket: key,
        total: 0,
        info: 0,
        warn: 0,
        error: 0,
        debug: 0
      });
    }

    let latencySum = 0;
    let latencyCount = 0;

    for (const log of recentLogs) {
      const d = new Date(log.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`;
      let b = bucketMap.get(key);
      if (!b) {
        b = { bucket: key, total: 0, info: 0, warn: 0, error: 0, debug: 0 };
        bucketMap.set(key, b);
      }
      b.total += 1;
      if (log.level === 'ERROR') b.error += 1;
      else if (log.level === 'WARN') b.warn += 1;
      else if (log.level === 'DEBUG') b.debug += 1;
      else b.info += 1;

      // 提取延迟
      if (log.source === 'SERVER' && log.module === 'HTTP' && log.metadata) {
        try {
          const parsed = JSON.parse(log.metadata);
          if (typeof parsed.durationMs === 'number' && Number.isFinite(parsed.durationMs) && parsed.durationMs >= 0) {
            latencySum += parsed.durationMs;
            latencyCount += 1;
          }
        } catch {
          // ignore
        }
      }
    }

    const avgLatencyMs = latencyCount > 0 ? Math.round(latencySum / latencyCount) : 0;

    return {
      totalLogs,
      errorCount24h,
      warnCount24h,
      avgLatencyMs,
      ingestion: this.getIngestionStatus(),
      sampled: windowCount > 20000,
      sampleLimit: 20000,
      trend: Array.from(bucketMap.values()).sort((a, b) => a.bucket.localeCompare(b.bucket))
    };
  }

  /**
   * 清理过期与超出上限的日志记录
   */
  async clean(retentionDays?: number, maxRecords?: number): Promise<{ deletedCount: number }> {
    await this.flush();
    let deletedCount = 0;

    // 1. 按保留天数清理
    if (retentionDays && retentionDays > 0) {
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      const res = await this.telemetryPrisma.systemLog.deleteMany({
        where: { createdAt: { lt: cutoff } }
      });
      deletedCount += res.count;
    }

    // 2. 按最大条数上限清理
    if (maxRecords && maxRecords > 0) {
      const currentTotal = await this.telemetryPrisma.systemLog.count();
      if (currentTotal > maxRecords) {
        const excess = currentTotal - maxRecords;
        // 时间戳相同的记录用 id 确定边界，避免超量删除。
        const pivotLogs = await this.telemetryPrisma.systemLog.findMany({
          select: { id: true, createdAt: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 1,
          skip: excess - 1
        });
        if (pivotLogs.length > 0) {
          const pivot = pivotLogs[0];
          const res = await this.telemetryPrisma.systemLog.deleteMany({
            where: { OR: [{ createdAt: { lt: pivot.createdAt } }, { createdAt: pivot.createdAt, id: { lte: pivot.id } }] }
          });
          deletedCount += res.count;
        }
      }
    }

    return { deletedCount };
  }

  /**
   * 导出日志数据
   */
  async export(dto: QueryLogsDto, format: 'json' | 'csv' | 'bundle' = 'json'): Promise<string> {
    const result = await this.exportWithManifest(dto, format);
    return result.data;
  }

  async exportWithManifest(dto: QueryLogsDto, format: 'json' | 'csv' | 'bundle' = 'json') {
    await this.flush();
    const where = this.buildWhere(dto);
    const [items, matchedCount] = await Promise.all([
      this.telemetryPrisma.systemLog.findMany({ where, take: 5000, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      this.telemetryPrisma.systemLog.count({ where })
    ]);
    const truncated = matchedCount > 5000;
    if (format === 'bundle') {
      const nodeIds = [...new Set(items.map((item) => item.nodeId).filter((id): id is string => Boolean(id)))];
      const nodes = nodeIds.length ? await this.prisma.node.findMany({
        where: { id: { in: nodeIds } },
        select: { id: true, name: true, status: true, agentVersion: true, kernelVersion: true, osArch: true, kernelRunning: true, singboxLogMode: true, singboxLogModeUntil: true }
      }) : [];
      const ingestion = this.getIngestionStatus();
      const manifest = {
        generatedAt: new Date().toISOString(), filters: dto, matchedCount, exportedCount: items.length, limit: 5000,
        truncated, pending: ingestion.pendingEntries, ingestion,
        timeRange: { first: items.at(-1)?.createdAt ?? null, last: items[0]?.createdAt ?? null },
        completeness: 'query-only; capture, delivery and retention gaps may exist',
        ordering: 'event-time-or-received-time; id tie-breaker',
        correlationScope: 'master-process'
      };
      return { truncated, data: JSON.stringify({ schemaVersion: 1, manifest, nodes, logs: items }, null, 2) };
    }

    if (format === 'csv') {
      const headers = ['id', 'createdAt', 'source', 'level', 'module', 'traceId', 'nodeId', 'message', 'metadata'];
      const csvCell = (value: string) => {
        const safe = /^[\s]*[=+@-]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
        return `"${safe.replace(/"/g, '""')}"`;
      };
      const rows = items.map((item) => [
        item.id, item.createdAt.toISOString(), item.source, item.level, item.module,
        item.traceId || '', item.nodeId || '', item.message, item.metadata
      ].map(csvCell));
      return { truncated, data: [headers.join(','), ...rows.map((r) => r.join(','))].join('\n') };
    }

    return { truncated, data: JSON.stringify(items, null, 2) };
  }
}
