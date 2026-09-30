import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TelemetryPrismaService } from '../prisma/telemetry-prisma.service';
import { SettingsService } from '../system/settings.service';
import { createDateInTimezone, getTimeZoneParts } from '../common/traffic-reset';
import {
  type LineTrafficRankItem,
  type RateBucketType,
  type TrafficBucketType,
  type TrafficOverviewResponse,
  type TrafficTimeRange,
  type TrafficTimeSeriesPoint,
  type UserTrafficDetailResponse,
  type UserTrafficRankItem
} from './dto/traffic.dto';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const RATE_METRIC_BUCKET_MS = 5 * MINUTE_MS;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15 * 1000;
const UNASSIGNED_LINE_KEY = '__unassigned__';
const UNASSIGNED_LINE_NAME = '未分配线路（节点直连）';

type TrafficLine = {
  id: string;
  name: string;
  protocolType: string;
  type: string;
  trafficRate: number;
};

type FallbackTrafficLine = TrafficLine & {
  entryNodeId: string | null;
  landingNodeId: string | null;
  relayMode: string | null;
};

type TrafficRow = {
  nodeId: string;
  userId: string;
  upload: bigint;
  download: bigint;
  recordedAt: Date;
  line?: TrafficLine | null;
};

type RangeConfig = {
  bucketType: TrafficBucketType;
  bucketStart: Date;
  bucketCount: number;
  bucketKeys: string[];
  bucketDates: Date[];
  periodEnd: Date;
};

type LineAggregate = {
  line: TrafficLine | null;
  upload: bigint;
  download: bigint;
};

type UserAggregate = {
  upload: bigint;
  download: bigint;
  billedTotal: number;
};

type TrafficUser = {
  id: string;
  email: string;
  role: string;
  isActive: boolean;
  subscription: {
    plan: { name: string } | null;
  } | null;
};

type SeriesAggregate = {
  upload: bigint;
  download: bigint;
  billedTotal: number;
};

type Aggregation = {
  totalUpload: bigint;
  totalDownload: bigint;
  totalBilled: number;
  activeUsers: Set<string>;
  activeLines: Set<string>;
  lineAggregates: Map<string, LineAggregate>;
  userAggregates: Map<string, UserAggregate>;
  series: SeriesAggregate[];
};

type RateMetricRow = {
  nodeId: string;
  bucketStart: Date;
  sampleCount: number;
  uploadRateSum: number;
  downloadRateSum: number;
  uploadRatePeak: number;
  downloadRatePeak: number;
};

type RateRangeConfig = {
  bucketType: RateBucketType;
  bucketMs: number;
  bucketStart: Date;
  bucketDates: Date[];
  periodEnd: Date;
};

type RateBucketAggregate = {
  sampleCount: number;
  uploadRateSum: number;
  downloadRateSum: number;
  nodePeaks: Map<string, { uploadRatePeak: number; downloadRatePeak: number }>;
};

@Injectable()
export class TrafficService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telemetryPrisma: TelemetryPrismaService,
    @Optional() private readonly settingsService?: SettingsService
  ) {}

  private async getTimezone(): Promise<string> {
    return (await this.settingsService?.getSettings())?.systemTimezone ?? 'Asia/Shanghai';
  }

  async getOverview(range: TrafficTimeRange = 'today'): Promise<TrafficOverviewResponse> {
    const timeZone = await this.getTimezone();
    const config = this.buildRange(range, timeZone);
    const [rows, fallbackLines, totalLinesCount, totalUsersCount, rateOverview] = await Promise.all([
      this.findTrafficRows(config),
      this.findFallbackLines(),
      this.prisma.line.count(),
      this.prisma.user.count(),
      this.getRateOverview(range, timeZone)
    ]);
    const aggregation = this.aggregate(rows, fallbackLines, config, timeZone);
    const lineRankings = this.toLineRankings(
      aggregation.lineAggregates,
      aggregation.totalUpload + aggregation.totalDownload,
      fallbackLines
    );
    const userRankings = await this.toUserRankings(
      aggregation.userAggregates,
      aggregation.totalUpload + aggregation.totalDownload
    );

    return {
      timeRange: range,
      bucketType: config.bucketType,
      summary: {
        totalUpload: this.toNumber(aggregation.totalUpload),
        totalDownload: this.toNumber(aggregation.totalDownload),
        totalPhysical: this.toNumber(aggregation.totalUpload + aggregation.totalDownload),
        totalBilled: this.round2(aggregation.totalBilled),
        activeLinesCount: aggregation.activeLines.size,
        totalLinesCount,
        activeUsersCount: aggregation.activeUsers.size,
        totalUsersCount
      },
      timeSeries: this.toTimeSeries(aggregation.series, config, timeZone),
      lineRankings,
      userRankings,
      ...rateOverview
    };
  }

  private async getRateOverview(range: TrafficTimeRange, timeZone = 'Asia/Shanghai'): Promise<Pick<TrafficOverviewResponse, 'rate' | 'rateSeries'>> {
    const config = this.buildRateRange(range, timeZone);
    const [metrics, current] = await Promise.all([
      this.findRateMetrics(config),
      this.findCurrentRates(new Date())
    ]);
    const buckets = Array.from({ length: config.bucketDates.length }, (): RateBucketAggregate => ({
      sampleCount: 0,
      uploadRateSum: 0,
      downloadRateSum: 0,
      nodePeaks: new Map()
    }));
    let totalSamples = 0;
    let totalUploadRateSum = 0;
    let totalDownloadRateSum = 0;

    for (const metric of metrics) {
      const bucketIndex = Math.floor((metric.bucketStart.getTime() - config.bucketStart.getTime()) / config.bucketMs);
      if (bucketIndex < 0 || bucketIndex >= buckets.length) continue;
      const bucket = buckets[bucketIndex];
      bucket.sampleCount += metric.sampleCount;
      bucket.uploadRateSum += metric.uploadRateSum;
      bucket.downloadRateSum += metric.downloadRateSum;
      const previousPeak = bucket.nodePeaks.get(metric.nodeId) ?? { uploadRatePeak: 0, downloadRatePeak: 0 };
      bucket.nodePeaks.set(metric.nodeId, {
        uploadRatePeak: Math.max(previousPeak.uploadRatePeak, metric.uploadRatePeak),
        downloadRatePeak: Math.max(previousPeak.downloadRatePeak, metric.downloadRatePeak)
      });
      totalSamples += metric.sampleCount;
      totalUploadRateSum += metric.uploadRateSum;
      totalDownloadRateSum += metric.downloadRateSum;
    }

    const rateSeries = buckets.map((bucket, index) => {
      let peakUploadRate = 0;
      let peakDownloadRate = 0;
      for (const peak of bucket.nodePeaks.values()) {
        peakUploadRate += peak.uploadRatePeak;
        peakDownloadRate += peak.downloadRatePeak;
      }
      const bucketDate = config.bucketDates[index];
      return {
        timestamp: bucketDate.toISOString(),
        displayTime: this.formatRateDisplay(bucketDate, config.bucketType, timeZone),
        uploadRate: this.round2(bucket.sampleCount > 0 ? bucket.uploadRateSum / bucket.sampleCount : 0),
        downloadRate: this.round2(bucket.sampleCount > 0 ? bucket.downloadRateSum / bucket.sampleCount : 0),
        peakUploadRate: this.round2(peakUploadRate),
        peakDownloadRate: this.round2(peakDownloadRate),
        sampleCount: bucket.sampleCount
      };
    });
    const peakUploadRate = rateSeries.reduce((peak, item) => Math.max(peak, item.peakUploadRate), 0);
    const peakDownloadRate = rateSeries.reduce((peak, item) => Math.max(peak, item.peakDownloadRate), 0);
    return {
      rate: {
        currentUploadRate: this.round2(current.uploadRate),
        currentDownloadRate: this.round2(current.downloadRate),
        averageUploadRate: this.round2(totalSamples > 0 ? totalUploadRateSum / totalSamples : 0),
        averageDownloadRate: this.round2(totalSamples > 0 ? totalDownloadRateSum / totalSamples : 0),
        peakUploadRate: this.round2(peakUploadRate),
        peakDownloadRate: this.round2(peakDownloadRate),
        unit: 'bytes/s',
        scope: 'node-network'
      },
      rateSeries
    };
  }

  private async findRateMetrics(config: RateRangeConfig): Promise<RateMetricRow[]> {
    const delegate = this.telemetryPrisma.nodeRateMetric;
    return delegate.findMany({
      where: { bucketStart: { gte: config.bucketStart, lt: config.periodEnd } },
      select: {
        nodeId: true,
        bucketStart: true,
        sampleCount: true,
        uploadRateSum: true,
        downloadRateSum: true,
        uploadRatePeak: true,
        downloadRatePeak: true
      },
      orderBy: { bucketStart: 'asc' }
    });
  }

  private async findCurrentRates(now: Date): Promise<{ uploadRate: number; downloadRate: number }> {
    const nodeDelegate = (this.prisma as unknown as {
      node?: { findMany: (args: Record<string, unknown>) => Promise<Array<{
        status: string;
        communicationMode?: string | null;
        pollIntervalSecs?: number | null;
        lastSeenAt: Date | null;
        uploadRate: number | null;
        downloadRate: number | null;
      }>> };
    }).node;
    if (!nodeDelegate) return { uploadRate: 0, downloadRate: 0 };
    const settings = await this.settingsService?.getSettings();
    const timeoutMs = (settings?.heartbeatTimeoutSecs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS / 1000) * 1000;
    const nodes = await nodeDelegate.findMany({
      where: { status: 'ONLINE' },
      select: { status: true, communicationMode: true, pollIntervalSecs: true, lastSeenAt: true, uploadRate: true, downloadRate: true }
    });
    return nodes.reduce((total, node) => {
      const staleWindowMs = node.communicationMode === 'HTTP'
        ? Math.max(timeoutMs, (node.pollIntervalSecs ?? 15) * 3_000)
        : timeoutMs;
      const fresh = node.lastSeenAt && now.getTime() - node.lastSeenAt.getTime() <= staleWindowMs;
      if (!fresh || node.uploadRate == null || node.downloadRate == null) return total;
      return {
        uploadRate: total.uploadRate + this.nonNegativeFinite(node.uploadRate),
        downloadRate: total.downloadRate + this.nonNegativeFinite(node.downloadRate)
      };
    }, { uploadRate: 0, downloadRate: 0 });
  }

  async getUserDetail(userId: string, range: TrafficTimeRange = 'today'): Promise<UserTrafficDetailResponse> {
    const timeZone = await this.getTimezone();
    const config = this.buildRange(range, timeZone);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        trafficLimitBytes: true,
        trafficUsedBytes: true,
        expireAt: true,
        subscription: {
          select: {
            trafficLimitBytes: true,
            trafficUsedBytes: true,
            expireAt: true,
            plan: { select: { name: true } }
          }
        }
      }
    });
    if (!user) throw new NotFoundException('用户不存在');

    const [rows, fallbackLines] = await Promise.all([
      this.findTrafficRows(config, userId),
      this.findFallbackLines()
    ]);
    const aggregation = this.aggregate(rows, fallbackLines, config, timeZone);
    const lineBreakdown = this.toLineRankings(aggregation.lineAggregates, aggregation.totalUpload + aggregation.totalDownload);
    const quota = user.subscription ?? user;
    const limit = this.toNumber(quota.trafficLimitBytes);
    const used = this.toNumber(quota.trafficUsedBytes);

    return {
      userId: user.id,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      timeRange: range,
      bucketType: config.bucketType,
      quota: {
        trafficLimitBytes: limit,
        trafficUsedBytes: used,
        remainingBytes: Math.max(limit - used, 0),
        expireAt: quota.expireAt?.toISOString() ?? null,
        planName: user.subscription?.plan?.name ?? null
      },
      summary: {
        periodUpload: this.toNumber(aggregation.totalUpload),
        periodDownload: this.toNumber(aggregation.totalDownload),
        periodTotal: this.toNumber(aggregation.totalUpload + aggregation.totalDownload),
        periodBilled: this.round2(aggregation.totalBilled)
      },
      timeSeries: this.toTimeSeries(aggregation.series, config, timeZone),
      lineBreakdown
    };
  }

  private async findTrafficRows(config: RangeConfig, userId?: string): Promise<TrafficRow[]> {
    const hourlyDelegate = this.telemetryPrisma.trafficHourlyMetric;

    if (hourlyDelegate) {
      const hourlyMetrics = await hourlyDelegate.findMany({
        where: {
          ...(userId ? { userId } : {}),
          bucketStart: { gte: config.bucketStart, lt: config.periodEnd }
        },
        select: {
          nodeId: true,
          userId: true,
          lineId: true,
          upload: true,
          download: true,
          billedBytes: true,
          bucketStart: true
        },
        orderBy: { bucketStart: 'asc' }
      });

      if (hourlyMetrics.length > 0) {
        const referencedLineIds = [...new Set(hourlyMetrics.map((m) => m.lineId).filter((id) => Boolean(id)))];
        const lines = referencedLineIds.length
          ? await this.prisma.line.findMany({
              where: { id: { in: referencedLineIds } },
              select: { id: true, name: true, protocolType: true, type: true, trafficRate: true }
            })
          : [];
        const lineMap = new Map(lines.map((l) => [l.id, l]));

        return hourlyMetrics.map((m) => ({
          nodeId: m.nodeId,
          userId: m.userId,
          upload: m.upload,
          download: m.download,
          recordedAt: m.bucketStart,
          line: m.lineId ? (lineMap.get(m.lineId) as TrafficLine | null) ?? null : null
        }));
      }
    }

    const legacyDelegate = (this.prisma as unknown as {
      trafficLog?: {
        findMany: (args: Record<string, unknown>) => Promise<TrafficRow[]>;
      };
    }).trafficLog;

    if (legacyDelegate) {
      return legacyDelegate.findMany({
        where: {
          ...(userId ? { userId } : {}),
          recordedAt: { gte: config.bucketStart, lt: config.periodEnd }
        },
        select: {
          nodeId: true,
          userId: true,
          upload: true,
          download: true,
          recordedAt: true,
          line: { select: { id: true, name: true, protocolType: true, type: true, trafficRate: true } }
        },
        orderBy: { recordedAt: 'asc' }
      });
    }

    return [];
  }

  private async findFallbackLines(): Promise<FallbackTrafficLine[]> {
    return this.prisma.line.findMany({
      where: { status: 'ACTIVE', type: { not: 'EXTERNAL' }, entryNodeId: { not: null } },
      select: {
        id: true,
        name: true,
        protocolType: true,
        type: true,
        trafficRate: true,
        entryNodeId: true,
        landingNodeId: true,
        relayMode: true
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
    }) as unknown as Promise<FallbackTrafficLine[]>;
  }

  private aggregate(
    rows: TrafficRow[],
    fallbackLines: FallbackTrafficLine[],
    config: RangeConfig,
    timeZone = 'Asia/Shanghai'
  ): Aggregation {
    const fallbackByEntryNode = new Map<string, TrafficLine>();
    const fallbackByBlindLandingNode = new Map<string, TrafficLine>();
    for (const line of fallbackLines) {
      if (line.type === 'EXTERNAL' || !line.entryNodeId) continue;
      if (!fallbackByEntryNode.has(line.entryNodeId)) fallbackByEntryNode.set(line.entryNodeId, line);
      if (line.type === 'RELAY' && line.relayMode === 'BLIND_FORWARD' && line.landingNodeId && !fallbackByBlindLandingNode.has(line.landingNodeId)) {
        fallbackByBlindLandingNode.set(line.landingNodeId, line);
      }
    }
    const aggregation: Aggregation = {
      totalUpload: 0n,
      totalDownload: 0n,
      totalBilled: 0,
      activeUsers: new Set<string>(),
      activeLines: new Set<string>(),
      lineAggregates: new Map<string, LineAggregate>(),
      userAggregates: new Map<string, UserAggregate>(),
      series: Array.from({ length: config.bucketCount }, () => ({ upload: 0n, download: 0n, billedTotal: 0 }))
    };

    for (const row of rows) {
      const upload = row.upload < 0n ? 0n : row.upload;
      const download = row.download < 0n ? 0n : row.download;
      const total = upload + download;
      const line = row.line ?? fallbackByEntryNode.get(row.nodeId) ?? fallbackByBlindLandingNode.get(row.nodeId) ?? null;
      const trafficRate = this.getTrafficRate(line);
      const billedTotal = this.toNumber(total) * trafficRate;
      const lineKey = line?.id ?? UNASSIGNED_LINE_KEY;
      const current = aggregation.lineAggregates.get(lineKey) ?? { line, upload: 0n, download: 0n };
      current.upload += upload;
      current.download += download;
      aggregation.lineAggregates.set(lineKey, current);
      aggregation.totalUpload += upload;
      aggregation.totalDownload += download;
      aggregation.totalBilled += billedTotal;
      if (total > 0n) {
        aggregation.activeUsers.add(row.userId);
        const userAggregate = aggregation.userAggregates.get(row.userId) ?? { upload: 0n, download: 0n, billedTotal: 0 };
        userAggregate.upload += upload;
        userAggregate.download += download;
        userAggregate.billedTotal += billedTotal;
        aggregation.userAggregates.set(row.userId, userAggregate);
        if (line) aggregation.activeLines.add(line.id);
      }

      const bucketIndex = this.getBucketIndex(row.recordedAt, config, timeZone);
      if (bucketIndex >= 0 && bucketIndex < aggregation.series.length) {
        aggregation.series[bucketIndex].upload += upload;
        aggregation.series[bucketIndex].download += download;
        aggregation.series[bucketIndex].billedTotal += billedTotal;
      }
    }
    return aggregation;
  }

  private async toUserRankings(
    userAggregates: Map<string, UserAggregate>,
    totalPhysical: bigint
  ): Promise<UserTrafficRankItem[]> {
    const rankedAggregates = Array.from(userAggregates.entries())
      .sort((left, right) => {
        const leftTotal = left[1].upload + left[1].download;
        const rightTotal = right[1].upload + right[1].download;
        if (rightTotal !== leftTotal) return rightTotal > leftTotal ? 1 : -1;
        return left[0].localeCompare(right[0]);
      })
      .slice(0, 100);
    const userIds = rankedAggregates.map(([userId]) => userId);
    if (userIds.length === 0) return [];

    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        subscription: { select: { plan: { select: { name: true } } } }
      }
    }) as unknown as TrafficUser[];
    const usersById = new Map(users.map((user) => [user.id, user]));
    const total = this.toNumber(totalPhysical);

    const rankings = rankedAggregates
      .map(([userId, aggregate]) => {
        const user = usersById.get(userId);
        if (!user) return null;
        const physical = aggregate.upload + aggregate.download;
        const physicalNumber = this.toNumber(physical);
        return {
          userId,
          email: user.email,
          role: user.role,
          isActive: user.isActive,
          planName: user.subscription?.plan?.name ?? null,
          upload: this.toNumber(aggregate.upload),
          download: this.toNumber(aggregate.download),
          total: physicalNumber,
          billedTotal: this.round2(aggregate.billedTotal),
          percentage: total > 0 ? this.round2((physicalNumber / total) * 100) : 0
        } satisfies UserTrafficRankItem;
      })
      .filter((item): item is UserTrafficRankItem => item !== null);
    return rankings.sort((left, right) => {
      if (right.total !== left.total) return right.total - left.total;
      return left.email.localeCompare(right.email);
    });
  }

  private toLineRankings(
    lineAggregates: Map<string, LineAggregate>,
    totalPhysical: bigint,
    allActiveLines: FallbackTrafficLine[] = []
  ): LineTrafficRankItem[] {
    const total = this.toNumber(totalPhysical);
    const aggregates = new Map(lineAggregates);

    for (const activeLine of allActiveLines) {
      if (!aggregates.has(activeLine.id)) {
        aggregates.set(activeLine.id, {
          line: activeLine,
          upload: 0n,
          download: 0n
        });
      }
    }

    return Array.from(aggregates.values())
      .map(({ line, upload, download }) => {
        const physical = upload + download;
        const trafficRate = this.getTrafficRate(line);
        return {
          lineId: line?.id ?? null,
          lineName: line?.name ?? UNASSIGNED_LINE_NAME,
          ...(line ? { protocolType: line.protocolType, lineType: line.type } : {}),
          trafficRate,
          upload: this.toNumber(upload),
          download: this.toNumber(download),
          total: this.toNumber(physical),
          billedTotal: this.round2(this.toNumber(physical) * trafficRate),
          percentage: total > 0 ? this.round2((this.toNumber(physical) / total) * 100) : 0
        };
      })
      .sort((left, right) => {
        if (right.billedTotal !== left.billedTotal) {
          return right.billedTotal - left.billedTotal;
        }
        return left.lineName.localeCompare(right.lineName);
      });
  }

  private toTimeSeries(series: SeriesAggregate[], config: RangeConfig, timeZone = 'Asia/Shanghai'): TrafficTimeSeriesPoint[] {
    return series.map((point, index) => {
      const upload = this.toNumber(point.upload);
      const download = this.toNumber(point.download);
      const bucketDate = config.bucketDates[index];
      return {
        timestamp: this.formatTimestamp(bucketDate, config.bucketType, timeZone),
        displayTime: config.bucketType === 'hour' ? this.formatHour(bucketDate, timeZone) : this.formatShortDate(bucketDate, timeZone),
        upload,
        download,
        total: upload + download,
        billedTotal: this.round2(point.billedTotal)
      };
    });
  }

  private buildRange(range: TrafficTimeRange, timeZone = 'Asia/Shanghai'): RangeConfig {
    const now = new Date();
    const bucketType: TrafficBucketType = range === 'today' || range === '24h' ? 'hour' : 'day';
    const bucketCount = range === 'today' || range === '24h' ? 24 : range === '7d' ? 7 : 30;
    const bucketStart = range === 'today' ? this.startOfDay(now, timeZone) : this.startOfBucket(now, bucketType, timeZone);
    if (range === '24h') bucketStart.setTime(bucketStart.getTime() - (bucketCount - 1) * HOUR_MS);
    if (range === '7d' || range === '30d') {
      const parts = getTimeZoneParts(bucketStart, timeZone);
      bucketStart.setTime(createDateInTimezone(parts.year, parts.month, parts.day - (bucketCount - 1), 0, 0, 0, timeZone).getTime());
    }
    const bucketDates = Array.from({ length: bucketCount }, (_, index) => {
      if (bucketType === 'hour') return new Date(bucketStart.getTime() + index * HOUR_MS);
      const parts = getTimeZoneParts(bucketStart, timeZone);
      return createDateInTimezone(parts.year, parts.month, parts.day + index, 0, 0, 0, timeZone);
    });
    return {
      bucketType,
      bucketStart,
      bucketCount,
      bucketKeys: bucketDates.map((date) => this.formatDate(date, timeZone)),
      bucketDates,
      periodEnd: now
    };
  }

  private buildRateRange(range: TrafficTimeRange, timeZone = 'Asia/Shanghai'): RateRangeConfig {
    const now = new Date();
    const bucketType: RateBucketType = range === 'today' || range === '24h' ? '5m' : range === '7d' ? '30m' : '1h';
    const bucketMs = bucketType === '5m' ? RATE_METRIC_BUCKET_MS : bucketType === '30m' ? 30 * MINUTE_MS : HOUR_MS;
    let start: Date;
    if (range === 'today') {
      start = this.startOfDay(now, timeZone);
    } else if (range === '24h') {
      start = new Date(now.getTime() - 24 * HOUR_MS);
    } else {
      const todayStart = this.startOfDay(now, timeZone);
      const parts = getTimeZoneParts(todayStart, timeZone);
      start = createDateInTimezone(parts.year, parts.month, parts.day - (range === '7d' ? 6 : 29), 0, 0, 0, timeZone);
    }
    const bucketStart = new Date(Math.floor(start.getTime() / bucketMs) * bucketMs);
    const bucketCount = Math.max(1, Math.floor((now.getTime() - bucketStart.getTime()) / bucketMs) + 1);
    const bucketDates = Array.from({ length: bucketCount }, (_, index) => new Date(bucketStart.getTime() + index * bucketMs));
    return { bucketType, bucketMs, bucketStart, bucketDates, periodEnd: now };
  }

  private startOfBucket(date: Date, bucketType: TrafficBucketType, timeZone = 'Asia/Shanghai'): Date {
    const parts = getTimeZoneParts(date, timeZone);
    if (bucketType === 'hour') return createDateInTimezone(parts.year, parts.month, parts.day, parts.hour, 0, 0, timeZone);
    return createDateInTimezone(parts.year, parts.month, parts.day, 0, 0, 0, timeZone);
  }

  private startOfDay(date: Date, timeZone = 'Asia/Shanghai'): Date {
    const parts = getTimeZoneParts(date, timeZone);
    return createDateInTimezone(parts.year, parts.month, parts.day, 0, 0, 0, timeZone);
  }

  private getBucketIndex(date: Date, config: RangeConfig, timeZone = 'Asia/Shanghai'): number {
    if (config.bucketType === 'hour') return Math.floor((date.getTime() - config.bucketStart.getTime()) / HOUR_MS);
    return config.bucketKeys.indexOf(this.formatDate(date, timeZone));
  }

  private getTrafficRate(line: TrafficLine | null): number {
    return line && Number.isFinite(line.trafficRate) && line.trafficRate >= 0 ? line.trafficRate : 1;
  }

  private nonNegativeFinite(value: number): number {
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  private formatRateDisplay(date: Date, bucketType: RateBucketType, timeZone = 'Asia/Shanghai'): string {
    const parts = getTimeZoneParts(date, timeZone);
    const day = `${this.pad(parts.month)}-${this.pad(parts.day)}`;
    if (bucketType === '1h') return `${day} ${this.formatHour(date, timeZone)}`;
    return `${day} ${this.pad(parts.hour)}:${this.pad(parts.minute)}`;
  }

  private formatTimestamp(date: Date, bucketType: TrafficBucketType, timeZone = 'Asia/Shanghai'): string {
    return bucketType === 'hour' ? `${this.formatDate(date, timeZone)} ${this.formatHour(date, timeZone)}` : this.formatDate(date, timeZone);
  }

  private formatDate(date: Date, timeZone = 'Asia/Shanghai'): string {
    const parts = getTimeZoneParts(date, timeZone);
    return `${parts.year}-${this.pad(parts.month)}-${this.pad(parts.day)}`;
  }

  private formatShortDate(date: Date, timeZone = 'Asia/Shanghai'): string {
    const parts = getTimeZoneParts(date, timeZone);
    return `${this.pad(parts.month)}-${this.pad(parts.day)}`;
  }

  private formatHour(date: Date, timeZone = 'Asia/Shanghai'): string {
    const parts = getTimeZoneParts(date, timeZone);
    return `${this.pad(parts.hour)}:00`;
  }

  private pad(value: number): string {
    return String(value).padStart(2, '0');
  }

  private toNumber(value: bigint): number {
    return Number(value);
  }

  private round2(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
