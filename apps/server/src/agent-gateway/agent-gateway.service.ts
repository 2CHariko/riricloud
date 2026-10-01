import { buildUpstreamOutbound } from '../common/upstream-connection';
import { getUpstreamUnavailableReason, isMeteredUpstreamEntry, type UpstreamAvailabilityNode } from '../common/upstream-availability';
import { readUpstreamRelayConnection } from '../common/upstream-relay-connection';
import { ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TelemetryPrismaService } from '../prisma/telemetry-prisma.service';
import { deepMerge, isUserEntitled } from '../common/utils';
import {
  buildClientTls,
  buildClientTransport,
  buildProxyPoolWhitelistRules,
  buildShadowsocksClientPassword,
  buildServerInbounds,
  buildSharedListenFields,
  normalizeShadowsocksPassword,
  parseTrafficCredential,
  revealInboundSecrets,
  type InboundUserCredential,
  type ProxyPoolCredential,
  type SharedListenOptions
} from '../common/inbound';
import { parseProxyLineUsername } from '../proxy-pool/proxy-key.util';
import { ProxyPoolAccessService, type ProxyPoolBinding } from '../proxy-pool-access/proxy-pool-access.service';
import { resolveLineTags } from '../common/line-tags';
import { DEFAULT_INBOUND_LISTEN, getClashApiListen, getStatsApiListen } from '../common/ports';
import {
  INTERNAL_RELAY_TRANSIT_EMAIL,
  INTERNAL_RELAY_TRANSIT_SECRET,
  INTERNAL_RELAY_TRANSIT_UUID,
  INTERNAL_SPEEDTEST_EMAIL,
  INTERNAL_SPEEDTEST_SECRET,
  INTERNAL_SPEEDTEST_UUID,
  type ProtocolType
} from '../common/constants';
import { AGENT_PROTOCOL_VERSION, type AuthResultData, type AgentPollResponse, type AgentTaskMessage, type AgentTransportMode, type ConfigApplyResultData, type ConfigSyncData, type SingboxLogCaptureLevel, type TunnelConfigPayload, type TunnelPortMapping, type HeartbeatData, type ProbeRequest, type ProbeResultData, type RestartAgentResultData, type UpgradeResultData, type UpgradeTarget, type UpgradeTaskData, type LogReportData, type MirrorRequestData, type MirrorResponseEndData, type MirrorResponseHeadersData, type MirrorErrorData, type AgentLogRotationConfig } from './agent-message';
import type { AgentPollDto } from './dto/agent-poll.dto';
import { SettingsService } from '../system/settings.service';
import { SystemLogsService } from '../system-logs/system-logs.service';
import { isLineAuthorized } from '../common/line-access';
import { getTrafficPeriod } from '../common/traffic-reset';
import { applyPlanSnapshot } from '../subscription/plan-snapshot';
import { hashAgentToken } from '../common/agent-token';
import { decryptSecret } from '../common/secret-crypto';
import { normalizeBinaryVersion } from '../common/binary-version';
import { resolveEffectiveDeviceLimit } from '../common/device-limit';
import type { AgentOnlineDeviceReportItem, KickDevicesTaskData } from './agent-message';

const PRIVATE_CIDR_BLOCKS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  'fc00::/7',
  'fe80::/10',
  '::1/128'
];

// 活跃连接注册表：nodeId → WebSocket
export type AgentSocket = { send: (data: string | Buffer) => void; close: (code?: number, reason?: string) => void };

export type MirrorStreamHandlers = {
  onHeaders: (data: MirrorResponseHeadersData) => void;
  onChunk: (chunk: Buffer) => void;
  onEnd: (data: MirrorResponseEndData) => void;
  onError: (data: MirrorErrorData) => void;
};

type MirrorSession = { nodeId: string; handlers: MirrorStreamHandlers };

type SubscriptionUserSnapshot = {
  id?: string;
  uuid: string;
  email: string;
  deviceLimit?: number | null;
  role?: string;
  emailVerifiedAt?: Date | null;
  password: string | null;
  isActive: boolean;
  extraLineGrants?: Array<{ lineId: string }>;
};

type SubscriptionSnapshot = {
  id: string;
  status: string;
  trafficLimitBytes: bigint;
  trafficUsedBytes: bigint;
  expireAt: Date | null;
  planSnapshotJson?: string | null;
  user: SubscriptionUserSnapshot;
  plan?: {
    lineMatchMode: string;
    lineTagsJson: string;
    lineIdsJson: string;
    deviceLimit?: number | null;
  } | null;
};

type SubscriptionDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<SubscriptionSnapshot[]>;
};

type TrafficSubscriptionDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<{
    id: string;
    userId: string;
    trafficLimitBytes?: bigint | null;
    trafficUsedBytes?: bigint | null;
    trafficPeriodStartAt?: Date | null;
    startedAt?: Date;
    plan?: { durationDays: number; trafficResetMode: string } | null;
  }>>;
  update: (args: Record<string, unknown>) => Promise<unknown>;
};

type TrafficCursorDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<{
    credential: string;
    uploadTotal: bigint;
    downloadTotal: bigint;
  }>>;
  upsert: (args: Record<string, unknown>) => Promise<unknown>;
};

type ResolvedTrafficLine = {
  id: string;
  trafficRate: number;
};


type TrafficProxyKeySnapshot = {
  id: string;
  userId: string;
  username: string;
};

type TrafficProxyKeyDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<TrafficProxyKeySnapshot[]>;
  update: (args: Record<string, unknown>) => Promise<unknown>;
};

type OnlineDeviceReport = { userId: string; userUuid: string; ip: string; nodeId: string; lineId: string | null; connections: number; lastSeenAt: number; firstSeenAt: number };
type PendingTask = AgentTaskMessage & { deliveredAt: number };

type TaskResult = {
  taskId: string;
  type: 'upgrade' | 'probe' | 'restart' | 'kick_devices';
  success: boolean;
  message: string;
  completedAt: string;
};

export type UpgradeTaskOptions = {
  resourceId?: string;
  assetId?: string;
  releaseId?: string;
  previousAssetId?: string | null;
  operation?: 'UPGRADE' | 'ROLLBACK';
  files?: UpgradeTaskData['files'];
  requestedById?: string;
};

type DeploymentTaskRecord = {
  id: string;
  nodeId: string;
  assetId: string;
  previousAssetId: string | null;
  releaseId: string;
  kind: string;
  operation: string;
  status: string;
  attempts: number;
  payloadJson: string;
  errorMessage: string | null;
  requestedById: string | null;
  requestedAt: Date;
  dispatchedAt: Date | null;
  completedAt: Date | null;
};

type DeploymentTaskDelegate = {
  create: (args: Record<string, unknown>) => Promise<DeploymentTaskRecord>;
  findUnique: (args: Record<string, unknown>) => Promise<DeploymentTaskRecord | null>;
  findFirst: (args: Record<string, unknown>) => Promise<DeploymentTaskRecord | null>;
  findMany: (args: Record<string, unknown>) => Promise<DeploymentTaskRecord[]>;
  update: (args: Record<string, unknown>) => Promise<DeploymentTaskRecord>;
};

const NODE_RATE_BUCKET_MS = 5 * 60 * 1000;
const DEFAULT_NODE_RATE_RETENTION_DAYS = 30;

type NodeRateMetricDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<{
    id: string;
    sampleCount: number;
    uploadRateSum: number;
    downloadRateSum: number;
    uploadRatePeak: number;
    downloadRatePeak: number;
  } | null>;
  create: (args: Record<string, unknown>) => Promise<unknown>;
  update: (args: Record<string, unknown>) => Promise<unknown>;
};

type NodeRateMetricRootDelegate = {
  deleteMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
};

const RATE_METRIC_CLEANUP_INTERVAL_MS = 12 * 60 * 60 * 1000;
const RATE_METRIC_CLEANUP_RETRY_MS = 5 * 60 * 1000;
const RATE_METRIC_FLUSH_INTERVAL_MS = 5_000;
const AGENT_WRITE_RETRY_DELAY_MS = 250;
const AGENT_WRITE_MAX_ATTEMPTS = 3;

// 升级版本对账窗口：超过告警阈值未确认说明新进程可能未接管（重启失败）；超过保留窗口放弃追踪。
const UPGRADE_VERSION_CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;
const UPGRADE_VERSION_CONFIRM_RETENTION_MS = 15 * 60 * 1000;

type VersionConfirmation = {
  taskId: string;
  expectedVersion: string;
  completedAt: number;
  warned: boolean;
};


const SINGBOX_DIAGNOSTIC_DURATION_MS = 30 * 60 * 1000;
const SINGBOX_DIAGNOSTIC_SWEEP_INTERVAL_MS = 30 * 1000;
const SINGBOX_LOG_CAPTURE_CAPABILITY = 'singbox_log_capture';
const SINGBOX_LOG_MODES = ['NORMAL', 'INFO', 'DEBUG'] as const;
type SingboxLogMode = (typeof SINGBOX_LOG_MODES)[number];

// 直连代理池凭据用户名前缀，用于在流量快照中快速识别并跳过无关查询
const PROXY_KEY_USERNAME_PREFIX = 'pk_';

// 需要用户认证的本地代理协议：空 users 的 mixed/socks/http 在 Sing-box 中等价于开放代理
const AUTHENTICATED_PROXY_PROTOCOLS: readonly ProtocolType[] = ['MIXED', 'SOCKS', 'HTTP'];

type PendingHeartbeat = {
  data: HeartbeatData;
  mode: AgentTransportMode;
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
  retryCount: number;
};

type RateMetricAggregate = {
  nodeId: string;
  bucketStart: Date;
  sampleCount: number;
  uploadRateSum: number;
  downloadRateSum: number;
  uploadRatePeak: number;
  downloadRatePeak: number;
};

const TRAFFIC_HOURLY_BUCKET_MS = 60 * 60 * 1000;
const TRAFFIC_HOURLY_FLUSH_INTERVAL_MS = 10_000;

type TrafficHourlyBucketItem = {
  id: string;
  bucketStart: Date;
  nodeId: string;
  userId: string;
  lineId: string;
  proxyKeyId: string;
  upload: bigint;
  download: bigint;
  billedBytes: bigint;
};

@Injectable()
export class AgentService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(AgentService.name);
  private readonly sockets = new Map<string, AgentSocket>();
  private readonly pendingTasks = new Map<string, PendingTask[]>();
  private readonly onlineDeviceReports = new Map<string, Map<string, OnlineDeviceReport>>();
  private readonly deviceEnforcementAt = new Map<string, number>();
  private deviceOnlineWindowSecs = 60;
  private nextDeviceEnforcementCleanupAt = 0;
  private readonly taskResults = new Map<string, TaskResult>();
  private readonly configCache = new Map<string, ConfigSyncData>();
  private readonly mirrorSessions = new Map<string, MirrorSession>();
  private readonly pendingHeartbeats = new Map<string, PendingHeartbeat>();
  private readonly heartbeatRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly versionConfirmations = new Map<string, VersionConfirmation>();
  private writeTail: Promise<void> = Promise.resolve();
  private writeQueueDepth = 0;
  private readonly rateMetricBuckets = new Map<string, RateMetricAggregate>();
  private readonly trafficHourlyBuckets = new Map<string, TrafficHourlyBucketItem>();
  private configVersion = Date.now();
  private configPushTimer?: NodeJS.Timeout;
  private rateMetricFlushTimer?: NodeJS.Timeout;
  private trafficHourlyFlushTimer?: NodeJS.Timeout;
  private singboxDiagnosticTimer?: NodeJS.Timeout;
  private configPushWaiters: Array<(count: number) => void> = [];
  private nextRateMetricCleanupAt = 0;
  private trafficCounterResetCount = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly settingsService?: SettingsService,
    @Optional() private readonly systemLogsService?: SystemLogsService,
    @Optional() private readonly telemetryPrisma?: TelemetryPrismaService,
    @Optional() private readonly proxyPoolAccess?: ProxyPoolAccessService
  ) {
    if (this.settingsService) {
      this.settingsService.onSettingsChange((patch) => {
        if (
          patch.publicLinesEnabled !== undefined || patch.enforceEmailVerification !== undefined ||
          patch.agentLogMaxSizeMb !== undefined ||
          patch.agentLogMaxFiles !== undefined ||
          patch.deviceLimitEnabled !== undefined ||
          patch.deviceOnlineWindowSecs !== undefined
        ) {
          if (patch.deviceOnlineWindowSecs !== undefined) this.deviceOnlineWindowSecs = patch.deviceOnlineWindowSecs ?? 60;
          void this.pushConfigToAll();
        }
      });
    }
  }

  // 握手鉴权：校验 agentToken，返回鉴权结果与节点
  async authenticate(token: string | undefined): Promise<
    { ok: true; nodeId: string; nodeName: string } | { ok: false; message: string }
  > {
    if (!token) {
      return { ok: false, message: '缺少 token' };
    }
      const node = await this.prisma.node.findFirst({ where: { OR: [{ agentTokenHash: hashAgentToken(token) }, { agentToken: token }] } });
    if (!node) {
      return { ok: false, message: '无效的 AgentToken' };
    }
    if (node.status === 'DISABLED') {
      return { ok: false, message: '节点已被禁用' };
    }
    return { ok: true, nodeId: node.id, nodeName: node.name };
  }

  // 注册连接并标记上线
  async register(nodeId: string, socket: AgentSocket): Promise<AuthResultData> {
    const existing = this.sockets.get(nodeId);
    if (existing) {
      // 同节点旧连接顶替：新连接优先
      existing.close(4000, 'superseded by new connection');
    }
    this.sockets.set(nodeId, socket);
    await this.enqueueAgentWrite('register', () => this.prisma.node.update({
      where: { id: nodeId },
      data: { status: 'ONLINE', communicationMode: 'WS', lastSeenAt: new Date() }
    }));
    const node = await this.prisma.node.findUnique({ where: { id: nodeId } });
    await this.dispatchQueuedUpgradeTasks(nodeId);
    this.logger.log(`agent online: node=${node?.name ?? nodeId}`);
    this.systemLogsService?.enqueue({
      nodeId,
      source: 'AGENT',
      level: 'INFO',
      module: 'NodeGateway',
      message: `节点上线: ${node?.name ?? nodeId} (${node?.serverHost || 'unknown'})`,
      metadata: { osArch: node?.osArch, communicationMode: 'WS' }
    });
    return { success: true, message: '鉴权成功', nodeId, protocolVersion: AGENT_PROTOCOL_VERSION };
  }

  private activeOnlineDeviceReports(userId?: string): OnlineDeviceReport[] {
    const cutoff = Math.floor(Date.now() / 1000) - this.deviceOnlineWindowSecs;
    const active: OnlineDeviceReport[] = [];
    for (const [nodeId, reports] of this.onlineDeviceReports) {
      for (const [key, report] of reports) {
        if (report.lastSeenAt < cutoff) {
          reports.delete(key);
          continue;
        }
        if (!userId || report.userId === userId) active.push(report);
      }
      if (!reports.size) this.onlineDeviceReports.delete(nodeId);
    }
    return active;
  }

  private isTrackableClientIp(rawIp: string): boolean {
    const ip = rawIp.trim().toLowerCase();
    if (isIP(ip) === 0) return false;
    if (ip === '::1' || ip === '::' || ip === '0.0.0.0' || ip.startsWith('127.') || ip.startsWith('::ffff:127.')) {
      return false;
    }
    return true;
  }

  private evictOnlineDeviceReports(userId: string, ip?: string): void {
    for (const [nodeId, reports] of this.onlineDeviceReports) {
      for (const [key, report] of reports) {
        if (report.userId === userId && (!ip || report.ip === ip)) {
          reports.delete(key);
        }
      }
      if (!reports.size) this.onlineDeviceReports.delete(nodeId);
    }
  }

  private async updateOnlineDeviceReports(nodeId: string, items: AgentOnlineDeviceReportItem[]): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const settings = await this.settingsService?.getSettings();
    const windowSecs = Math.max(15, Math.min(600, settings?.deviceOnlineWindowSecs ?? 60));
    this.deviceOnlineWindowSecs = windowSecs;
    const cleaned = items
      .filter((item) => this.isTrackableClientIp(item.ip) && item.lastSeenAt >= now - windowSecs && item.lastSeenAt <= now + 30)
      .map((item) => { const parsed = parseTrafficCredential(item.userUuid); return { ...item, userUuid: parsed.rawCredential.trim(), lineId: item.lineId ?? parsed.lineId ?? undefined }; })
      .filter((item) => item.userUuid.length > 0 && item.userUuid.length <= 256 && !item.userUuid.startsWith(PROXY_KEY_USERNAME_PREFIX));
    const identities = [...new Set(cleaned.map((item) => item.userUuid))];
    const reportsByNode = this.onlineDeviceReports.get(nodeId) ?? new Map<string, OnlineDeviceReport>();
    if (!identities.length) {
      reportsByNode.clear();
      this.onlineDeviceReports.delete(nodeId);
      return;
    }
    const userDelegate = this.prisma.user as unknown as {
      findMany: (args: Record<string, unknown>) => Promise<Array<{
        id: string; uuid: string; email: string; deviceLimit: number | null; isActive: boolean;
        subscription?: { planSnapshotJson?: string | null; plan?: { deviceLimit?: number | null } | null } | null;
      }>>;
    };
    const users = await userDelegate.findMany({
      where: { OR: [{ email: { in: identities } }, { uuid: { in: identities } }] },
      select: { id: true, uuid: true, email: true, deviceLimit: true, isActive: true, subscription: { select: { planSnapshotJson: true, plan: { select: { deviceLimit: true } } } } }
    });
    const byIdentity = new Map<string, typeof users[number]>();
    for (const user of users) {
      byIdentity.set(user.email.toLowerCase(), user);
      byIdentity.set(user.uuid, user);
    }
    const next = new Map<string, OnlineDeviceReport>();
    for (const item of cleaned) {
      const user = byIdentity.get(item.userUuid.toLowerCase()) ?? byIdentity.get(item.userUuid);
      if (!user) continue;
      const parsed = parseTrafficCredential(item.userUuid);
      const lineId = item.lineId ?? parsed.lineId;
      const key = user.id + '|' + item.ip + '|' + (lineId ?? '');
      const previous = reportsByNode.get(key);
      const previousSameDevice = [...reportsByNode.values()].filter((report) => report.userId === user.id && report.ip === item.ip);
      const firstSeenAt = previous?.firstSeenAt ?? (previousSameDevice.length ? Math.min(...previousSameDevice.map((report) => report.firstSeenAt)) : now);
      next.set(key, {
        userId: user.id,
        userUuid: user.uuid,
        ip: item.ip,
        nodeId,
        lineId: lineId ?? null,
        connections: Math.max(0, Math.min(item.connections, 1000000)),
        lastSeenAt: item.lastSeenAt,
        firstSeenAt
      });
    }
    this.onlineDeviceReports.set(nodeId, next);
    if (settings?.deviceLimitEnabled === false) return;
    this.cleanupDeviceEnforcementCache(now * 1000);

    const policyByUser = new Map<string, { email: string; limit: number | null; active: boolean }>();
    for (const user of users) {
      let snapshotLimit: number | null | undefined;
      try {
        const snapshot = user.subscription?.planSnapshotJson ? JSON.parse(user.subscription.planSnapshotJson) as Record<string, unknown> : null;
        if (typeof snapshot?.deviceLimit === 'number' || snapshot?.deviceLimit === null) snapshotLimit = snapshot.deviceLimit as number | null;
      } catch { /* Invalid legacy snapshots fall back to the current plan. */ }
      const policy = resolveEffectiveDeviceLimit({
        globalEnabled: true,
        userDeviceLimit: user.deviceLimit,
        planDeviceLimit: snapshotLimit !== undefined ? snapshotLimit : user.subscription?.plan?.deviceLimit
      });
      policyByUser.set(user.id, { email: user.email, limit: policy.effectiveDeviceLimit, active: user.isActive });
    }
    const reportsByUser = new Map<string, OnlineDeviceReport[]>();
    for (const report of this.activeOnlineDeviceReports()) {
      const group = reportsByUser.get(report.userId) ?? [];
      group.push(report);
      reportsByUser.set(report.userId, group);
    }
    for (const [userId, reports] of reportsByUser) {
      const policy = policyByUser.get(userId);
      if (!policy?.active || !policy.limit || policy.limit < 1) continue;
      const byIp = new Map<string, number>();
      for (const report of reports) byIp.set(report.ip, Math.min(byIp.get(report.ip) ?? Number.POSITIVE_INFINITY, report.firstSeenAt));
      const orderedIps = [...byIp.entries()].sort((a, b) => a[1] - b[1]).map(([ip]) => ip);
      for (const ip of orderedIps.slice(policy.limit)) {
        const cooldownKey = userId + '|' + ip;
        const lastEnforcement = this.deviceEnforcementAt.get(cooldownKey) ?? 0;
        if (Date.now() - lastEnforcement < 30000) continue;
        this.deviceEnforcementAt.set(cooldownKey, Date.now());
        const nodeIds = [...new Set(reports.filter((report) => report.ip === ip).map((report) => report.nodeId))];
        const dispatched = await Promise.all(nodeIds.map((targetNodeId) => this.dispatchDeviceKick(targetNodeId, {
          taskId: randomUUID(),
          items: [{ userUuid: policy.email, ip, blockDurationSecs: 60 }]
        })));
        if (dispatched.some(Boolean)) {
          this.evictOnlineDeviceReports(userId, ip);
        }
      }
    }
  }

  private cleanupDeviceEnforcementCache(now: number): void {
    if (now < this.nextDeviceEnforcementCleanupAt) return;
    const cutoff = now - 60 * 60 * 1000;
    for (const [key, enforcedAt] of this.deviceEnforcementAt) {
      if (enforcedAt < cutoff) this.deviceEnforcementAt.delete(key);
    }
    this.nextDeviceEnforcementCleanupAt = now + 5 * 60 * 1000;
  }

  async getBatchUserOnlineDeviceCounts(userIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    const reports = this.activeOnlineDeviceReports();
    for (const userId of userIds) {
      counts.set(userId, new Set(reports.filter((report) => report.userId === userId).map((report) => report.ip)).size);
    }
    return counts;
  }

  async getUserDeviceManagement(userId: string) {
    const userDelegate = this.prisma.user as unknown as {
      findUnique: (args: Record<string, unknown>) => Promise<{
        id: string; email: string; uuid: string; deviceLimit: number | null;
        subscription?: { planSnapshotJson?: string | null; plan?: { deviceLimit?: number | null } | null } | null;
      } | null>;
    };
    const user = await userDelegate.findUnique({
      where: { id: userId },
      select: { id: true, email: true, uuid: true, deviceLimit: true, subscription: { select: { planSnapshotJson: true, plan: { select: { deviceLimit: true } } } } }
    });
    if (!user) throw new NotFoundException('用户不存在');
    let snapshotLimit: number | null | undefined;
    try {
      const snapshot = user.subscription?.planSnapshotJson ? JSON.parse(user.subscription.planSnapshotJson) as Record<string, unknown> : null;
      if (typeof snapshot?.deviceLimit === 'number' || snapshot?.deviceLimit === null) snapshotLimit = snapshot.deviceLimit as number | null;
    } catch { /* Invalid legacy snapshots fall back to the current plan. */ }
    const settings = await this.settingsService?.getSettings();
    const limit = resolveEffectiveDeviceLimit({
      globalEnabled: settings?.deviceLimitEnabled !== false,
      userDeviceLimit: user.deviceLimit,
      planDeviceLimit: snapshotLimit !== undefined ? snapshotLimit : user.subscription?.plan?.deviceLimit
    });
    const reports = this.activeOnlineDeviceReports(userId);
    const nodeIds = [...new Set(reports.map((report) => report.nodeId))];
    const lineIds = [...new Set(reports.map((report) => report.lineId).filter((id): id is string => !!id))];
    const [nodes, lines] = await Promise.all([
      nodeIds.length ? this.prisma.node.findMany({ where: { id: { in: nodeIds } }, select: { id: true, name: true } }) : [],
      lineIds.length ? (this.prisma as unknown as { line?: { findMany: (args: Record<string, unknown>) => Promise<Array<{ id: string; name: string }>> } }).line?.findMany({ where: { id: { in: lineIds } }, select: { id: true, name: true } }) ?? Promise.resolve([]) : []
    ]);
    const nodeNames = new Map(nodes.map((node) => [node.id, node.name]));
    const lineNames = new Map(lines.map((line) => [line.id, line.name]));
    const byIp = new Map<string, { ip: string; connections: number; firstSeenAt: number; lastSeenAt: number; nodes: Array<{ nodeId: string; nodeName: string; lineId: string | null; lineName: string | null; connections: number }> }>();
    for (const report of reports) {
      const device = byIp.get(report.ip) ?? { ip: report.ip, connections: 0, firstSeenAt: report.firstSeenAt, lastSeenAt: report.lastSeenAt, nodes: [] };
      device.connections += report.connections;
      device.firstSeenAt = Math.min(device.firstSeenAt, report.firstSeenAt);
      device.lastSeenAt = Math.max(device.lastSeenAt, report.lastSeenAt);
      device.nodes.push({ nodeId: report.nodeId, nodeName: nodeNames.get(report.nodeId) ?? report.nodeId, lineId: report.lineId, lineName: report.lineId ? lineNames.get(report.lineId) ?? null : null, connections: report.connections });
      byIp.set(report.ip, device);
    }
    const devices = [...byIp.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    return {
      onlineDeviceCount: devices.length,
      configuredDeviceLimit: limit.configuredDeviceLimit,
      effectiveDeviceLimit: limit.effectiveDeviceLimit,
      deviceLimitSource: limit.deviceLimitSource,
      configuredDeviceLimitSource: limit.configuredDeviceLimitSource,
      deviceLimitEnabled: settings?.deviceLimitEnabled !== false,
      devices
    };
  }

  async kickUserDevices(userId: string, ip?: string) {
    if (ip && !this.isTrackableClientIp(ip)) throw new ConflictException('客户端 IP 格式无效');
    const userDelegate = this.prisma.user as unknown as { findUnique: (args: Record<string, unknown>) => Promise<{ email: string } | null> };
    const user = await userDelegate.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user) throw new NotFoundException('用户不存在');
    const matching = this.activeOnlineDeviceReports(userId).filter((report) => !ip || report.ip === ip);
    const kickedIps = [...new Set(matching.map((report) => report.ip))];
    const nodeIds = [...new Set(matching.map((report) => report.nodeId))];
    const taskId = randomUUID();
    const results = await Promise.all(nodeIds.map((nodeId) => this.dispatchDeviceKick(nodeId, {
      taskId,
      items: [{ userUuid: user.email, ...(ip ? { ip } : {}), blockDurationSecs: 60 }]
    })));
    const requested = results.some(Boolean);
    if (requested) {
      this.evictOnlineDeviceReports(userId, ip);
      for (const kickedIp of kickedIps) {
        this.deviceEnforcementAt.delete(userId + '|' + kickedIp);
      }
    }
    return { taskId, requested, notifiedNodes: results.filter(Boolean).length, kickedIps };
  }

  private async dispatchDeviceKick(nodeId: string, data: KickDevicesTaskData): Promise<boolean> {
    const socket = this.sockets.get(nodeId);
    if (socket) {
      try {
        socket.send(JSON.stringify({ type: 'kick_devices', data }));
        return true;
      } catch (error) {
        this.logger.warn('send device management task failed: node=' + nodeId + ' error=' + error);
        return false;
      }
    }
    const node = await this.prisma.node.findUnique({ where: { id: nodeId }, select: { status: true, communicationMode: true } });
    if (node?.status !== 'ONLINE' || node.communicationMode !== 'HTTP') return false;
    const tasks = this.pendingTasks.get(nodeId) ?? [];
    tasks.push({ type: 'kick_devices_task', data, deliveredAt: 0 });
    this.pendingTasks.set(nodeId, tasks);
    return true;
  }

  // 心跳处理：遥测更新 + 流量同事务入库扣减（S6 红线）；内核状态可选字段落列
  async handleHeartbeat(nodeId: string, data: HeartbeatData, mode: AgentTransportMode = 'WS'): Promise<void> {
    if (data.onlineDevices !== undefined) await this.updateOnlineDeviceReports(nodeId, data.onlineDevices);
    let deviceTrackingChanged = false;
    if (data.capabilities !== undefined) {
      const existing = await this.prisma.node.findUnique({ where: { id: nodeId }, select: { capabilitiesJson: true } });
      const wasEnabled = this.parseCapabilities(existing?.capabilitiesJson).includes('device_tracking');
      const isEnabled = data.capabilities.includes('device_tracking');
      deviceTrackingChanged = wasEnabled !== isEnabled;
    }
    const splitRates = this.getSplitRates(data);
    if (splitRates) {
      // 心跳合并只影响落库状态，速率采样本身必须保留，避免聚合桶少算样本。
      this.accumulateRateMetric(nodeId, new Date(), splitRates.uploadRate, splitRates.downloadRate);
    }
    await new Promise<void>((resolve, reject) => {
      const pending = this.pendingHeartbeats.get(nodeId);
      if (pending) {
        pending.data = data;
        pending.mode = mode;
        pending.waiters.push({ resolve, reject });
        return;
      }
      this.pendingHeartbeats.set(nodeId, { data, mode, waiters: [{ resolve, reject }], retryCount: 0 });
      void this.drainHeartbeats(nodeId);
    });
    if (deviceTrackingChanged) {
      this.configCache.delete(nodeId);
      void this.pushConfig(nodeId);
    }
  }

  private async drainHeartbeats(nodeId: string): Promise<void> {
    while (true) {
      const pending = this.pendingHeartbeats.get(nodeId);
      if (!pending) return;
      this.pendingHeartbeats.delete(nodeId);
      try {
        await this.enqueueAgentWrite('heartbeat', () => this.persistHeartbeat(nodeId, pending.data, pending.mode));
        pending.waiters.forEach(({ resolve }) => resolve());
      } catch (error) {
        pending.waiters.forEach(({ reject }) => reject(error));
        const latest = this.pendingHeartbeats.get(nodeId);
        if (latest) {
          latest.retryCount = pending.retryCount + 1;
        } else {
          this.pendingHeartbeats.set(nodeId, {
            data: pending.data,
            mode: pending.mode,
            waiters: [],
            retryCount: pending.retryCount + 1
          });
        }
        const retryCount = pending.retryCount + 1;
        const delayMs = Math.min(30_000, AGENT_WRITE_RETRY_DELAY_MS * (2 ** Math.min(retryCount, 7)));
        this.scheduleHeartbeatRetry(nodeId, delayMs);
        this.logger.warn(`heartbeat persistence failed: node=${nodeId} retryInMs=${delayMs} error=${error}`);
        return;
      }
    }
  }

  private async resolveActiveLineForNode(nodeId: string): Promise<ResolvedTrafficLine | null> {
    const lineDelegate = (this.prisma as unknown as {
      line?: {
        findFirst: (args: Record<string, unknown>) => Promise<{ id: string; trafficRate?: number | null } | null>;
      };
    }).line;
    if (!lineDelegate) return null;

    const findFirst = (where: Record<string, unknown>) => lineDelegate.findFirst({
      where,
      select: { id: true, trafficRate: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
    });
    const line = await findFirst({ entryNodeId: nodeId, status: 'ACTIVE' })
      ?? await findFirst({
        landingNodeId: nodeId,
        type: 'RELAY',
        relayMode: 'BLIND_FORWARD',
        status: 'ACTIVE'
      });
    return line ? { id: line.id, trafficRate: this.normalizeTrafficRate(line.trafficRate) } : null;
  }

  private async persistHeartbeat(nodeId: string, data: HeartbeatData, mode: AgentTransportMode): Promise<void> {
    const heartbeatAt = new Date();
    await this.prisma.node.update({
      where: { id: nodeId },
      data: {
        cpuUsage: data.cpuUsage,
        memoryUsage: data.memoryUsage,
        bandwidthRate: data.bandwidthRate,
        // 旧版 Agent 没有拆分字段，清空旧的拆分值，避免把历史值误当作当前速率。
        uploadRate: data.uploadRate ?? null,
        downloadRate: data.downloadRate ?? null,
        lastSeenAt: heartbeatAt,
        status: 'ONLINE',
        communicationMode: mode,
        // 旧版 Agent 不上报内核状态时保持原值（undefined 不写入）
        ...(data.kernelRunning !== undefined ? { kernelRunning: data.kernelRunning } : {}),
        ...(data.lastError !== undefined && data.lastError !== ''
          ? { configError: data.lastError }
          : {}),
        ...(data.lastError === '' ? { configError: null } : {}),
        ...(data.agentVersion !== undefined ? { agentVersion: data.agentVersion } : {}),
        ...(data.osArch !== undefined ? { osArch: data.osArch } : {}),
        ...(data.kernelVersion !== undefined ? { kernelVersion: data.kernelVersion } : {}),
        ...(data.capabilities !== undefined ? { capabilitiesJson: JSON.stringify([...new Set(data.capabilities)].slice(0, 32)) } : {})
      }
    });
    const trafficSnapshots = data.trafficSnapshots ?? [];
    if (trafficSnapshots.length) {
      const resolvedLine = await this.resolveActiveLineForNode(nodeId);
      const outcome = await this.persistTrafficSnapshots(nodeId, trafficSnapshots, resolvedLine, heartbeatAt);
      // 流量周期重置（重新发凭据）与超额熔断（吊销凭据）都需要立即重下发节点配置
      if (outcome.reset || outcome.exhausted) void this.pushConfigToAll();
    }
    this.reconcileUpgradeVersion(nodeId, data.agentVersion);
  }

  // 升级版本对账：心跳上报版本达到升级目标即确认；超时未确认发出一次性 WARN，说明 Agent 重启可能失败。
  private reconcileUpgradeVersion(nodeId: string, reportedVersion: string | undefined): void {
    const entry = this.versionConfirmations.get(nodeId);
    if (!entry) return;
    if (reportedVersion !== undefined && normalizeBinaryVersion(reportedVersion) === normalizeBinaryVersion(entry.expectedVersion)) {
      this.versionConfirmations.delete(nodeId);
      this.systemLogsService?.enqueue({
        nodeId,
        source: 'SERVER',
        level: 'INFO',
        module: 'UpgradeTask',
        message: `升级版本已确认上报 (${entry.expectedVersion})`,
        metadata: { taskId: entry.taskId, expectedVersion: entry.expectedVersion }
      });
      return;
    }
    const ageMs = Date.now() - entry.completedAt;
    if (ageMs > UPGRADE_VERSION_CONFIRM_RETENTION_MS) {
      this.versionConfirmations.delete(nodeId);
      return;
    }
    if (ageMs > UPGRADE_VERSION_CONFIRM_TIMEOUT_MS && !entry.warned) {
      entry.warned = true;
      this.systemLogsService?.enqueue({
        nodeId,
        source: 'SERVER',
        level: 'WARN',
        module: 'UpgradeTask',
        message: `升级任务已完成但 Agent 心跳仍上报 ${reportedVersion ?? '未上报'}（目标 ${entry.expectedVersion}），Agent 重启可能失败`,
        metadata: { taskId: entry.taskId, expectedVersion: entry.expectedVersion, reportedVersion: reportedVersion ?? null }
      });
    }
  }

  // 详情接口消费：升级任务已完成但心跳版本尚未确认时返回待确认信息，驱动前端警示横幅。
  getPendingVersionConfirmation(nodeId: string): { taskId: string; expectedVersion: string; completedAt: string } | null {
    const entry = this.versionConfirmations.get(nodeId);
    if (!entry) return null;
    return { taskId: entry.taskId, expectedVersion: entry.expectedVersion, completedAt: new Date(entry.completedAt).toISOString() };
  }

  // 主控重启后恢复升级版本对账窗口；节点已在重启前上报目标版本的条目不恢复。
  async onModuleInit(): Promise<void> {
    this.singboxDiagnosticTimer = setInterval(() => {
      void this.expireSingboxDiagnostics().catch((error) => {
        this.logger.warn(`sing-box diagnostic expiry sweep failed: ${error}`);
      });
    }, SINGBOX_DIAGNOSTIC_SWEEP_INTERVAL_MS);
    this.singboxDiagnosticTimer.unref?.();

    const delegate = this.deploymentTasks();
    if (!delegate) return;
    const since = new Date(Date.now() - UPGRADE_VERSION_CONFIRM_RETENTION_MS);
    const tasks = await delegate.findMany({
      where: { kind: 'AGENT', status: 'COMPLETED', completedAt: { gte: since } },
      orderBy: { completedAt: 'desc' }
    });
    const latestByNode = new Map<string, DeploymentTaskRecord>();
    for (const task of tasks) {
      if (!latestByNode.has(task.nodeId)) latestByNode.set(task.nodeId, task);
    }
    if (!latestByNode.size) return;
    const nodes = await this.prisma.node.findMany({
      where: { id: { in: [...latestByNode.keys()] } },
      select: { id: true, agentVersion: true }
    });
    const reportedByNode = new Map(nodes.map((node) => [node.id, node.agentVersion]));
    for (const [nodeId, task] of latestByNode) {
      let expectedVersion: string;
      try {
        expectedVersion = this.parseUpgradePayload(task.payloadJson).version;
      } catch {
        continue;
      }
      if (normalizeBinaryVersion(reportedByNode.get(nodeId)) === normalizeBinaryVersion(expectedVersion)) continue;
      const completedAt = task.completedAt?.getTime() ?? Date.now();
      this.versionConfirmations.set(nodeId, {
        taskId: task.id,
        expectedVersion,
        completedAt,
        warned: Date.now() - completedAt > UPGRADE_VERSION_CONFIRM_TIMEOUT_MS
      });
    }
  }

  private async persistTrafficSnapshots(
    nodeId: string,
    records: HeartbeatData['trafficSnapshots'],
    line?: ResolvedTrafficLine | null,
    observedAt = new Date()
  ): Promise<{ reset: boolean; exhausted: boolean }> {
    let resetCount = 0;
    let exhaustedCount = 0;
    const hourlyDeltas: Array<{
      nodeId: string;
      userId: string;
      lineId: string;
      proxyKeyId: string;
      observedAt: Date;
      upload: bigint;
      download: bigint;
      billedBytes: bigint;
    }> = [];
    await this.prisma.$transaction(async (tx) => {
      const snapshotsByCredential = new Map<string, { uploadTotal: bigint; downloadTotal: bigint }>();
      for (const record of records) {
        const current = snapshotsByCredential.get(record.userUuid);
        const uploadTotal = BigInt(record.uploadTotal);
        const downloadTotal = BigInt(record.downloadTotal);
        if (!current) {
          snapshotsByCredential.set(record.userUuid, { uploadTotal, downloadTotal });
          continue;
        }
        current.uploadTotal = current.uploadTotal > uploadTotal ? current.uploadTotal : uploadTotal;
        current.downloadTotal = current.downloadTotal > downloadTotal ? current.downloadTotal : downloadTotal;
      }
      const credentials = [...snapshotsByCredential.keys()];
      const parsedByCredential = new Map<string, { rawCredential: string; lineId: string | null }>();
      const rawCredentials = new Set<string>();
      const referencedLineIds = new Set<string>();

      for (const cred of credentials) {
        const parsed = parseTrafficCredential(cred);
        parsedByCredential.set(cred, parsed);
        rawCredentials.add(parsed.rawCredential);
        if (parsed.lineId) referencedLineIds.add(parsed.lineId);
      }

      const users = await tx.user.findMany({
        where: { OR: [{ uuid: { in: [...rawCredentials] } }, { email: { in: [...rawCredentials] } }] },
        select: { id: true, uuid: true, email: true, trafficLimitBytes: true, trafficUsedBytes: true }
      });
      const usersByCredential = new Map<string, { id: string; uuid: string; email: string }>();
      users.forEach((user) => {
        usersByCredential.set(user.uuid, user);
        usersByCredential.set(user.email, user);
      });
      const userLimitById = new Map(
        users
          .filter((user) => typeof user.trafficLimitBytes === 'bigint' && typeof user.trafficUsedBytes === 'bigint')
          .map((user) => [user.id, { limit: user.trafficLimitBytes as bigint, used: user.trafficUsedBytes as bigint }])
      );

      // 直连代理池凭据（pk_ 前缀）映射回归属用户；仅在存在此类凭据时才查询，避免无谓开销
      const proxyKeyDelegate = (tx as unknown as { proxyKey?: TrafficProxyKeyDelegate }).proxyKey;
      const proxyKeyCredentials = [...rawCredentials].filter((credential) => credential.startsWith(PROXY_KEY_USERNAME_PREFIX));
      const proxyKeys = proxyKeyDelegate && proxyKeyCredentials.length
        ? await proxyKeyDelegate.findMany({
            where: { username: { in: proxyKeyCredentials } },
            select: { id: true, userId: true, username: true }
          })
        : [];
      const proxyKeysByUsername = new Map(proxyKeys.map((key) => [key.username, key]));

      const lineDelegate = (tx as unknown as {
        line?: { findMany: (args: Record<string, unknown>) => Promise<Array<{ id: string; trafficRate?: number | null; entryNodeId?: string | null }>> };
      }).line;
      const loadedLines = lineDelegate && referencedLineIds.size > 0
        ? await lineDelegate.findMany({
            where: { id: { in: [...referencedLineIds] } },
            select: { id: true, trafficRate: true, entryNodeId: true }
          })
        : [];
      const linesById = new Map(loadedLines.map((l) => [l.id, { id: l.id, trafficRate: this.normalizeTrafficRate(l.trafficRate), entryNodeId: l.entryNodeId }]));

      const cursor = (tx as unknown as { trafficCursor?: TrafficCursorDelegate }).trafficCursor;
      if (!cursor) throw new Error('TrafficCursor delegate is unavailable');
      const cursors = await cursor.findMany({
        where: { nodeId, credential: { in: credentials } },
        select: { credential: true, uploadTotal: true, downloadTotal: true }
      });
      const cursorByCredential = new Map(cursors.map((item) => [item.credential, item]));

      const totalsByUser = new Map<string, bigint>();
      const totalsByProxyKey = new Map<string, bigint>();
      const cursorUpdates = new Map<string, { uploadTotal: bigint; downloadTotal: bigint }>();
      for (const [credential, current] of snapshotsByCredential) {
        cursorUpdates.set(credential, current);
        const parsed = parsedByCredential.get(credential) ?? { rawCredential: credential, lineId: null };
        const proxyLineIdentity = credential.startsWith('pk_line_') ? parseProxyLineUsername(credential) : null;
        if (credential.startsWith('pk_line_') && (!proxyLineIdentity || linesById.get(proxyLineIdentity.lineId)?.entryNodeId !== nodeId)) {
          this.logger.warn('heartbeat: invalid proxy line identity');
          continue;
        }
        if (this.isInternalSystemCredential(parsed.rawCredential)) continue;

        const previous = cursorByCredential.get(credential);
        const previousUpload = previous?.uploadTotal ?? 0n;
        const previousDownload = previous?.downloadTotal ?? 0n;
        const uploadReset = current.uploadTotal < previousUpload;
        const downloadReset = current.downloadTotal < previousDownload;
        if (uploadReset || downloadReset) {
          this.trafficCounterResetCount += 1;
          this.logger.warn(`traffic counter reset detected: node=${nodeId} count=${this.trafficCounterResetCount}`);
        }
        const upload = uploadReset ? current.uploadTotal : current.uploadTotal - previousUpload;
        const download = downloadReset ? current.downloadTotal : current.downloadTotal - previousDownload;
        // 先按订阅用户凭据（uuid/email）匹配，再回退到直连代理池凭据（pk_xxxx）
        const user = usersByCredential.get(parsed.rawCredential);
        const proxyKey = user ? undefined : proxyKeysByUsername.get(parsed.rawCredential);
        const targetUserId = user?.id ?? proxyKey?.userId;
        if (!targetUserId) {
          this.logger.warn('heartbeat: unknown user credential');
          continue;
        }
        const total = upload + download;
        if (total === 0n) continue;

        const activeLine = proxyLineIdentity
          ? linesById.get(proxyLineIdentity.lineId)
          : parsed.lineId ? (linesById.get(parsed.lineId) ?? { id: parsed.lineId, trafficRate: 1 }) : line;
        const targetLineId = activeLine?.id;
        const targetTrafficRate = activeLine?.trafficRate ?? 1;

        const billedBytes = this.calculateBilledBytes(total, targetTrafficRate);
        hourlyDeltas.push({
          nodeId,
          userId: targetUserId,
          lineId: targetLineId ?? '',
          proxyKeyId: proxyKey?.id ?? '',
          observedAt,
          upload,
          download,
          billedBytes
        });
        totalsByUser.set(targetUserId, (totalsByUser.get(targetUserId) ?? 0n) + billedBytes);
        if (proxyKey) {
          totalsByProxyKey.set(proxyKey.id, (totalsByProxyKey.get(proxyKey.id) ?? 0n) + billedBytes);
        }
      }
      const subscription = (tx as unknown as { subscription?: TrafficSubscriptionDelegate }).subscription;
      const subscriptionByUser = new Map<string, string>();
      // 订阅口径配额优先于用户主账户口径，用于判断本批次是否触发超额熔断
      const quotaByUser = new Map<string, { limit: bigint; used: bigint }>();
      if (subscription && totalsByUser.size) {
        const subscriptions = await subscription.findMany({
          where: { userId: { in: [...totalsByUser.keys()] } },
          select: {
            id: true,
            userId: true,
            startedAt: true,
            trafficPeriodStartAt: true,
            trafficLimitBytes: true,
            trafficUsedBytes: true,
            planSnapshotJson: true,
            plan: { select: { durationDays: true, trafficResetMode: true } }
          }
        });
        const timezone = (await this.settingsService?.getSettings())?.systemTimezone ?? 'Asia/Shanghai';
        for (const rawItem of subscriptions) {
          const item = applyPlanSnapshot(rawItem) as typeof rawItem;
          subscriptionByUser.set(item.userId, item.id);
          if (typeof item.trafficLimitBytes === 'bigint' && typeof item.trafficUsedBytes === 'bigint') {
            quotaByUser.set(item.userId, { limit: item.trafficLimitBytes, used: item.trafficUsedBytes });
          }
          if (!item.plan || !item.startedAt) continue;
          const period = getTrafficPeriod(item.plan.trafficResetMode, observedAt, item.startedAt, item.plan.durationDays, timezone);
          if (!period) continue;
          const previous = item.trafficPeriodStartAt ?? null;
          const shouldReset = Boolean(previous && previous.getTime() < period.startAt.getTime());
          if (!previous) {
            await tx.subscription.updateMany({
              where: { id: item.id, trafficPeriodStartAt: null },
              data: { trafficPeriodStartAt: period.startAt }
            });
          } else if (shouldReset) {
            const updated = await tx.subscription.updateMany({
              where: { id: item.id, trafficPeriodStartAt: previous },
              data: { trafficPeriodStartAt: period.startAt, trafficUsedBytes: BigInt(0) }
            });
            if (updated.count > 0) {
              await tx.user.update({ where: { id: item.userId }, data: { trafficUsedBytes: BigInt(0) } });
              resetCount += 1;
            }
          }
        }
      }
      const subscriptionTotals = new Map<string, bigint>();
      for (const [userId, total] of totalsByUser) {
        const subscriptionId = subscriptionByUser.get(userId);
        if (subscription && subscriptionId) {
          subscriptionTotals.set(subscriptionId, (subscriptionTotals.get(subscriptionId) ?? 0n) + total);
        }
      }
      await this.batchIncrement(tx, 'User', totalsByUser);
      await this.batchIncrement(tx, 'Subscription', subscriptionTotals);
      await this.batchIncrementProxyKeys(tx, totalsByProxyKey, observedAt);
      await this.batchUpsertTrafficCursors(tx, nodeId, cursorUpdates);

      // 超额熔断：本批次入账后触及配额的账号，其凭据将在随后重下发的节点配置中被吊销
      for (const [userId, billed] of totalsByUser) {
        const quota = quotaByUser.get(userId) ?? userLimitById.get(userId);
        if (!quota || typeof quota.limit !== 'bigint' || typeof quota.used !== 'bigint') continue;
        if (quota.used + billed >= quota.limit) exhaustedCount += 1;
      }
    });

    for (const delta of hourlyDeltas) {
      this.accumulateTrafficHourlyMetric(
        delta.nodeId,
        delta.userId,
        delta.lineId,
        delta.proxyKeyId,
        delta.observedAt,
        delta.upload,
        delta.download,
        delta.billedBytes
      );
    }

    return { reset: resetCount > 0, exhausted: exhaustedCount > 0 };
  }

  private isInternalSystemCredential(credential: string): boolean {
    return (
      credential === INTERNAL_RELAY_TRANSIT_UUID ||
      credential === INTERNAL_RELAY_TRANSIT_EMAIL ||
      credential === INTERNAL_SPEEDTEST_UUID ||
      credential === INTERNAL_SPEEDTEST_EMAIL
    );
  }

  private normalizeTrafficRate(value: number | null | undefined): number {
    return value !== undefined && value !== null && Number.isFinite(value) && value >= 0 ? value : 1;
  }

  // 将数据库中的浮点倍率转成十进制定点数，避免大整数流量先转 Number 后丢失精度。
  private calculateBilledBytes(total: bigint, trafficRate: number): bigint {
    if (total <= 0n) return 0n;
    const rate = this.normalizeTrafficRate(trafficRate);
    if (rate === 1) return total;

    const [coefficient, exponentText] = rate.toString().toLowerCase().split('e');
    const [integerPart, fractionPart = ''] = coefficient.split('.');
    let numerator = BigInt(`${integerPart}${fractionPart}`);
    const exponent = exponentText ? Number(exponentText) : 0;
    const scale = fractionPart.length - exponent;
    let denominator = 1n;
    if (scale >= 0) {
      denominator = 10n ** BigInt(scale);
    } else {
      numerator *= 10n ** BigInt(-scale);
    }
    const product = total * numerator;
    return (product * 2n + denominator) / (denominator * 2n);
  }

  private enqueueAgentWrite<T>(label: string, task: () => Promise<T>): Promise<T> {
    const queuedAt = Date.now();
    this.writeQueueDepth += 1;
    const run = this.writeTail.catch(() => undefined).then(async () => {
      this.writeQueueDepth = Math.max(0, this.writeQueueDepth - 1);
      const waitMs = Date.now() - queuedAt;
      if (waitMs >= 250) {
        this.logger.warn(`agent write queue delayed: type=${label} waitMs=${waitMs} depth=${this.writeQueueDepth}`);
      }
      const startedAt = Date.now();
      try {
        let lastError: unknown;
        for (let attempt = 1; attempt <= AGENT_WRITE_MAX_ATTEMPTS; attempt += 1) {
          try {
            return await task();
          } catch (error) {
            lastError = error;
            if (attempt === AGENT_WRITE_MAX_ATTEMPTS) throw error;
            const delayMs = AGENT_WRITE_RETRY_DELAY_MS * (2 ** (attempt - 1));
            this.logger.warn(`agent write retry: type=${label} attempt=${attempt + 1} delayMs=${delayMs}`);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
        throw lastError;
      } finally {
        const durationMs = Date.now() - startedAt;
        if (durationMs >= 1000) {
          this.logger.warn(`agent write slow: type=${label} durationMs=${durationMs}`);
        }
      }
    });
    this.writeTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private scheduleHeartbeatRetry(nodeId: string, delayMs: number): void {
    if (this.heartbeatRetryTimers.has(nodeId)) return;
    const timer = setTimeout(() => {
      this.heartbeatRetryTimers.delete(nodeId);
      void this.drainHeartbeats(nodeId);
    }, delayMs);
    timer.unref?.();
    this.heartbeatRetryTimers.set(nodeId, timer);
  }

  private accumulateRateMetric(nodeId: string, heartbeatAt: Date, uploadRate: number, downloadRate: number): void {
    const bucketStart = new Date(Math.floor(heartbeatAt.getTime() / NODE_RATE_BUCKET_MS) * NODE_RATE_BUCKET_MS);
    const key = `${nodeId}:${bucketStart.getTime()}`;
    const existing = this.rateMetricBuckets.get(key);
    if (existing) {
      existing.sampleCount += 1;
      existing.uploadRateSum += uploadRate;
      existing.downloadRateSum += downloadRate;
      existing.uploadRatePeak = Math.max(existing.uploadRatePeak, uploadRate);
      existing.downloadRatePeak = Math.max(existing.downloadRatePeak, downloadRate);
    } else {
      this.rateMetricBuckets.set(key, {
        nodeId,
        bucketStart,
        sampleCount: 1,
        uploadRateSum: uploadRate,
        downloadRateSum: downloadRate,
        uploadRatePeak: uploadRate,
        downloadRatePeak: downloadRate
      });
    }
    if (!this.rateMetricFlushTimer) {
      this.rateMetricFlushTimer = setTimeout(() => {
        this.rateMetricFlushTimer = undefined;
        void this.flushRateMetrics().catch((err) => this.logger.warn(`rate metric flush failed: ${err}`));
      }, RATE_METRIC_FLUSH_INTERVAL_MS);
      this.rateMetricFlushTimer.unref?.();
    }
  }

  private async flushRateMetrics(): Promise<void> {
    if (!this.rateMetricBuckets.size) return;
    const batches = [...this.rateMetricBuckets.values()];
    this.rateMetricBuckets.clear();
    const telemetryClient = this.telemetryPrisma ?? (this.prisma as unknown as TelemetryPrismaService);
    try {
      await this.enqueueAgentWrite('rate-metrics', async () => {
        await telemetryClient.$transaction(async (tx) => {
          const delegate = (tx as unknown as { nodeRateMetric?: NodeRateMetricDelegate }).nodeRateMetric;
          if (!delegate) return;
          for (const item of batches) {
            await this.recordRateMetric(delegate, item.nodeId, item.bucketStart, item.uploadRateSum / item.sampleCount, item.downloadRateSum / item.sampleCount, item);
          }
        });
      });
    } catch (error) {
      for (const item of batches) {
        const key = `${item.nodeId}:${item.bucketStart.getTime()}`;
        const existing = this.rateMetricBuckets.get(key);
        if (!existing) {
          this.rateMetricBuckets.set(key, item);
        } else {
          existing.sampleCount += item.sampleCount;
          existing.uploadRateSum += item.uploadRateSum;
          existing.downloadRateSum += item.downloadRateSum;
          existing.uploadRatePeak = Math.max(existing.uploadRatePeak, item.uploadRatePeak);
          existing.downloadRatePeak = Math.max(existing.downloadRatePeak, item.downloadRatePeak);
        }
      }
      throw error;
    }
  }

  private accumulateTrafficHourlyMetric(
    nodeId: string,
    userId: string,
    lineId: string,
    proxyKeyId: string,
    observedAt: Date,
    upload: bigint,
    download: bigint,
    billedBytes: bigint
  ): void {
    const bucketStart = new Date(Math.floor(observedAt.getTime() / TRAFFIC_HOURLY_BUCKET_MS) * TRAFFIC_HOURLY_BUCKET_MS);
    const key = `${bucketStart.getTime()}:${nodeId}:${userId}:${lineId}:${proxyKeyId}`;
    const existing = this.trafficHourlyBuckets.get(key);
    if (existing) {
      existing.upload += upload;
      existing.download += download;
      existing.billedBytes += billedBytes;
    } else {
      this.trafficHourlyBuckets.set(key, {
        id: randomUUID(),
        bucketStart,
        nodeId,
        userId,
        lineId,
        proxyKeyId,
        upload,
        download,
        billedBytes
      });
    }
    if (!this.trafficHourlyFlushTimer) {
      this.trafficHourlyFlushTimer = setTimeout(() => {
        this.trafficHourlyFlushTimer = undefined;
        void this.flushTrafficHourlyMetrics().catch((err) => this.logger.warn(`traffic hourly metric flush failed: ${err}`));
      }, TRAFFIC_HOURLY_FLUSH_INTERVAL_MS);
      this.trafficHourlyFlushTimer.unref?.();
    }
  }

  async flushTrafficHourlyMetrics(): Promise<void> {
    if (!this.trafficHourlyBuckets.size) return;
    const batches = [...this.trafficHourlyBuckets.values()];
    this.trafficHourlyBuckets.clear();
    const telemetryClient = this.telemetryPrisma ?? (this.prisma as unknown as TelemetryPrismaService);
    try {
      await this.enqueueAgentWrite('traffic-hourly-metrics', async () => {
        await telemetryClient.$transaction(async (tx) => {
          for (const item of batches) {
            await tx.$executeRawUnsafe(
              `INSERT INTO "TrafficHourlyMetric" (
                "id", "bucketStart", "nodeId", "userId", "lineId", "proxyKeyId",
                "upload", "download", "billedBytes", "createdAt", "updatedAt"
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
              ON CONFLICT("bucketStart", "nodeId", "userId", "lineId", "proxyKeyId")
              DO UPDATE SET
                "upload" = "TrafficHourlyMetric"."upload" + excluded."upload",
                "download" = "TrafficHourlyMetric"."download" + excluded."download",
                "billedBytes" = "TrafficHourlyMetric"."billedBytes" + excluded."billedBytes",
                "updatedAt" = CURRENT_TIMESTAMP`,
              item.id,
              item.bucketStart.getTime(),
              item.nodeId,
              item.userId,
              item.lineId,
              item.proxyKeyId,
              item.upload.toString(),
              item.download.toString(),
              item.billedBytes.toString()
            );
          }
        });
      });
    } catch (error) {
      for (const item of batches) {
        const key = `${item.bucketStart.getTime()}:${item.nodeId}:${item.userId}:${item.lineId}:${item.proxyKeyId}`;
        const existing = this.trafficHourlyBuckets.get(key);
        if (!existing) {
          this.trafficHourlyBuckets.set(key, item);
        } else {
          existing.upload += item.upload;
          existing.download += item.download;
          existing.billedBytes += item.billedBytes;
        }
      }
      throw error;
    }
  }

  getBufferedTrafficHourlyMetrics(): TrafficHourlyBucketItem[] {
    return [...this.trafficHourlyBuckets.values()];
  }

  private async batchIncrement(
    tx: unknown,
    table: 'User' | 'Subscription',
    increments: Map<string, bigint>
  ): Promise<void> {
    if (!increments.size) return;
    const rawClient = tx as { $executeRaw?: (query: Prisma.Sql) => Promise<number> };
    if (rawClient.$executeRaw) {
      const ids = [...increments.keys()];
      const cases = [...increments.entries()].map(([id, total]) => Prisma.sql`WHEN ${id} THEN ${total}`);
      const tableName = table === 'User' ? '"User"' : '"Subscription"';
      await rawClient.$executeRaw(Prisma.sql`
        UPDATE ${Prisma.raw(tableName)}
        SET "trafficUsedBytes" = "trafficUsedBytes" + CASE "id" ${Prisma.join(cases, ' ')} ELSE 0 END
        WHERE "id" IN (${Prisma.join(ids)})
      `);
      return;
    }
    const delegate = (tx as unknown as { user?: { update: (args: Record<string, unknown>) => Promise<unknown> }; subscription?: TrafficSubscriptionDelegate });
    const target = table === 'User' ? delegate.user : delegate.subscription;
    if (!target) throw new Error(`${table} delegate is unavailable`);
    for (const [id, total] of increments) {
      await target.update({ where: { id }, data: { trafficUsedBytes: { increment: total } } });
    }
  }

  // 直连代理池凭据流量累计：与主账户同一事务写入，同步刷新最近使用时间
  private async batchIncrementProxyKeys(
    tx: unknown,
    increments: Map<string, bigint>,
    observedAt: Date
  ): Promise<void> {
    if (!increments.size) return;
    const rawClient = tx as { $executeRaw?: (query: Prisma.Sql) => Promise<number> };
    if (rawClient.$executeRaw) {
      const ids = [...increments.keys()];
      const cases = [...increments.entries()].map(([id, total]) => Prisma.sql`WHEN ${id} THEN ${total}`);
      await rawClient.$executeRaw(Prisma.sql`
        UPDATE "ProxyKey"
        SET "trafficUsedBytes" = "trafficUsedBytes" + CASE "id" ${Prisma.join(cases, ' ')} ELSE 0 END,
            "lastUsedAt" = ${observedAt}
        WHERE "id" IN (${Prisma.join(ids)})
      `);
      return;
    }
    const delegate = (tx as unknown as { proxyKey?: TrafficProxyKeyDelegate }).proxyKey;
    if (!delegate) throw new Error('ProxyKey delegate is unavailable');
    for (const [id, total] of increments) {
      await delegate.update({
        where: { id },
        data: { trafficUsedBytes: { increment: total }, lastUsedAt: observedAt }
      });
    }
  }

  private async batchUpsertTrafficCursors(    tx: unknown,
    nodeId: string,
    updates: Map<string, { uploadTotal: bigint; downloadTotal: bigint }>
  ): Promise<void> {
    if (!updates.size) return;
    const rawClient = tx as { $executeRaw?: (query: Prisma.Sql) => Promise<number> };
    if (rawClient.$executeRaw) {
      const updatedAt = new Date();
      const values = [...updates.entries()].map(([credential, totals]) => Prisma.sql`(
        ${randomUUID()}, ${nodeId}, ${credential}, ${totals.uploadTotal}, ${totals.downloadTotal}, ${updatedAt}
      )`);
      await rawClient.$executeRaw(Prisma.sql`
        INSERT INTO "TrafficCursor" ("id", "nodeId", "credential", "uploadTotal", "downloadTotal", "updatedAt")
        VALUES ${Prisma.join(values, ', ')}
        ON CONFLICT ("nodeId", "credential") DO UPDATE SET
          "uploadTotal" = excluded."uploadTotal",
          "downloadTotal" = excluded."downloadTotal",
          "updatedAt" = excluded."updatedAt"
      `);
      return;
    }
    const delegate = (tx as unknown as { trafficCursor?: TrafficCursorDelegate }).trafficCursor;
    if (!delegate) throw new Error('TrafficCursor delegate is unavailable');
    for (const [credential, totals] of updates) {
      await delegate.upsert({
        where: { nodeId_credential: { nodeId, credential } },
        create: { nodeId, credential, ...totals },
        update: totals
      });
    }
  }

  private getSplitRates(data: HeartbeatData): { uploadRate: number; downloadRate: number } | null {
    if (
      data.uploadRate === undefined ||
      data.downloadRate === undefined ||
      !Number.isFinite(data.uploadRate) ||
      !Number.isFinite(data.downloadRate) ||
      data.uploadRate < 0 ||
      data.downloadRate < 0
    ) {
      return null;
    }
    return { uploadRate: data.uploadRate, downloadRate: data.downloadRate };
  }

  private async recordRateMetric(
    delegate: NodeRateMetricDelegate,
    nodeId: string,
    heartbeatAt: Date,
    uploadRate: number,
    downloadRate: number,
    aggregate?: RateMetricAggregate
  ): Promise<void> {
    const bucketStart = new Date(Math.floor(heartbeatAt.getTime() / NODE_RATE_BUCKET_MS) * NODE_RATE_BUCKET_MS);
    const where = { nodeId_bucketStart: { nodeId, bucketStart } };
    const sampleCount = aggregate?.sampleCount ?? 1;
    const uploadRateSum = aggregate?.uploadRateSum ?? uploadRate;
    const downloadRateSum = aggregate?.downloadRateSum ?? downloadRate;
    const uploadRatePeak = aggregate?.uploadRatePeak ?? uploadRate;
    const downloadRatePeak = aggregate?.downloadRatePeak ?? downloadRate;
    const existing = await delegate.findUnique({ where });
    if (existing) {
      await delegate.update({
        where: { id: existing.id },
        data: {
          sampleCount: { increment: sampleCount },
          uploadRateSum: { increment: uploadRateSum },
          downloadRateSum: { increment: downloadRateSum },
          uploadRatePeak: Math.max(existing.uploadRatePeak, uploadRatePeak),
          downloadRatePeak: Math.max(existing.downloadRatePeak, downloadRatePeak)
        }
      });
    } else {
      await delegate.create({
        data: {
          nodeId,
          bucketStart,
          sampleCount,
          uploadRateSum,
          downloadRateSum,
          uploadRatePeak,
          downloadRatePeak
        }
      });
    }
  }

  // 低频清理历史速率桶，避免每个心跳都在写事务中扫描和删除历史数据。
  async cleanupOldRateMetrics(): Promise<void> {
    const telemetryClient = this.telemetryPrisma ?? (this.prisma as unknown as TelemetryPrismaService);
    const delegate = (telemetryClient as unknown as { nodeRateMetric?: NodeRateMetricRootDelegate }).nodeRateMetric;
    if (!delegate) return;
    const now = Date.now();
    if (now < this.nextRateMetricCleanupAt) return;
    this.nextRateMetricCleanupAt = now + RATE_METRIC_CLEANUP_INTERVAL_MS;
    try {
      const retentionDays = (await this.settingsService?.getSettings())?.nodeRateRetentionDays ?? DEFAULT_NODE_RATE_RETENTION_DAYS;
      const result = await this.enqueueAgentWrite('rate-cleanup', () => delegate.deleteMany({
        where: { bucketStart: { lt: new Date(now - retentionDays * 24 * 60 * 60 * 1000) } }
      }));
      if (result.count > 0) {
        this.logger.log(`rate metric cleanup removed ${result.count} expired bucket(s) (retention=${retentionDays}d)`);
      }
    } catch (err) {
      this.nextRateMetricCleanupAt = now + RATE_METRIC_CLEANUP_RETRY_MS;
      throw err;
    }
  }

  // HTTP 轮询适配器的单一业务入口：先处理回执，再返回配置差异与待执行任务。
  async poll(token: string | undefined, data: AgentPollDto): Promise<AgentPollResponse> {
    const auth = await this.authenticate(token);
    if (!auth.ok) {
      throw new UnauthorizedException(auth.message);
    }

    // 同一节点切换到 HTTP 后，旧 WS 连接不得继续接收任务或覆盖通信模式。
    this.supersedeSocket(auth.nodeId);
    await this.handleHeartbeat(auth.nodeId, data, 'HTTP');
    if (data.logs && data.logs.length > 0) {
      await this.handleLogReport(auth.nodeId, { logs: data.logs });
    }
    for (const result of data.configApplyResults ?? []) {
      await this.handleConfigApplyResult(auth.nodeId, result);
    }
    for (const result of data.upgradeResults ?? []) {
      await this.handleUpgradeResult(auth.nodeId, result);
    }
    for (const result of data.probeResults ?? []) {
      await this.handleProbeResult(auth.nodeId, result);
    }
    for (const result of data.restartAgentResults ?? []) {
      await this.handleRestartResult(auth.nodeId, result);
    }
    for (const result of data.kickDevicesResults ?? []) {
      this.handleKickDevicesResult(auth.nodeId, result);
    }

    const desired = await this.getDesiredConfigSync(auth.nodeId);
    const settings = await this.settingsService?.getSettings();
    const node = await this.prisma.node.findUnique({
      where: { id: auth.nodeId },
      select: { pollIntervalSecs: true }
    });
    const nextPollSecs = Math.max(5, Math.min(300, node?.pollIntervalSecs ?? settings?.defaultPollIntervalSecs ?? 15));
    const needUpdate = data.appliedConfigVersion !== desired.version;
    return {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      needUpdate,
      version: desired.version,
      singboxConfig: needUpdate ? desired.singboxConfig : null,
      singboxLogCaptureLevel: desired.singboxLogCaptureLevel,
      agentLogRotation: desired.agentLogRotation,
      tasks: await this.takePendingTasks(auth.nodeId),
      nextPollSecs,
      userDeviceLimits: desired.userDeviceLimits ?? {},
      ...(desired.portSpeedLimits ? { portSpeedLimits: desired.portSpeedLimits } : {})
    };
  }

  // config_apply_result 回执处理：失败原因落 configError（成功清空），供管理端展示
  async handleConfigApplyResult(nodeId: string, data: ConfigApplyResultData): Promise<void> {
    const message = data.success ? null : (data.message?.slice(0, 8192) ?? 'unknown error');
    await this.enqueueAgentWrite('config-result', () => this.prisma.node
      .update({ where: { id: nodeId }, data: { configError: message } }))
      .catch((err) => this.logger.warn(`config_apply_result: ${err}`));
    if (data.success) {
      this.logger.log(`config applied: node=${nodeId} version=${data.version}`);
    } else {
      this.logger.warn(`config apply failed: node=${nodeId} version=${data.version} error=${data.message}`);
    }
    this.systemLogsService?.enqueue({
      nodeId,
      source: 'AGENT',
      level: data.success ? 'INFO' : 'ERROR',
      module: 'ConfigSync',
      message: `节点配置应用${data.success ? '成功' : '失败'}${data.message ? `: ${data.message}` : ''}`,
      metadata: { version: data.version, success: data.success, error: data.message }
    });
  }

  async handleUpgradeResult(nodeId: string, data: UpgradeResultData): Promise<void> {
    const result = {
      taskId: data.taskId,
      type: 'upgrade',
      success: data.success,
      message: data.message,
      completedAt: new Date().toISOString()
    } satisfies TaskResult;
    this.acknowledgeTask(nodeId, data.taskId, result);
    // 回执只代表二进制已替换、进程尚未重启：记录目标版本等待心跳对账，
    // 超时未确认说明新进程接管失败（升级后画像版本不更新的根因兜底）。
    if (data.success && data.target === 'agent') {
      this.versionConfirmations.set(nodeId, {
        taskId: data.taskId,
        expectedVersion: data.version,
        completedAt: Date.now(),
        warned: false
      });
    }
    const delegate = this.deploymentTasks();
    if (delegate) {
      const task = await delegate.findFirst({ where: { id: data.taskId, nodeId } });
      if (task) {
        await delegate.update({
          where: { id: task.id },
          data: {
            status: data.success ? 'COMPLETED' : 'FAILED',
            errorMessage: data.success ? null : data.message.slice(0, 8192),
            completedAt: new Date(result.completedAt)
          }
        });
        if (data.success && task.assetId) {
          const currentField = data.target === 'agent' ? 'currentAgentAssetId' : 'currentSingboxAssetId';
          await this.enqueueAgentWrite('upgrade-node-asset', () => this.prisma.node.update({
            where: { id: nodeId },
            data: { [currentField]: task.assetId }
          }));
        }
      }
    }
    const outcome = data.success ? 'succeeded' : 'failed';
    this.logger[data.success ? 'log' : 'warn'](
      `agent upgrade ${outcome}: node=${nodeId} target=${data.target} version=${data.version} task=${data.taskId} message=${data.message}`
    );
    this.systemLogsService?.enqueue({
      nodeId,
      source: 'AGENT',
      level: data.success ? 'INFO' : 'ERROR',
      module: 'UpgradeTask',
      message: `节点组件升级${data.success ? '成功' : '失败'} (${data.target}@${data.version})${data.message ? `: ${data.message}` : ''}`,
      metadata: { target: data.target, version: data.version, taskId: data.taskId, success: data.success, message: data.message }
    });
  }

  async handleProbeResult(nodeId: string, data: ProbeResultData): Promise<void> {
    const completedAt = new Date().toISOString();
    this.acknowledgeTask(nodeId, data.taskId, {
      taskId: data.taskId,
      type: 'probe',
      success: data.success,
      message: data.results.find((result) => !result.success)?.message ?? (data.success ? 'ok' : 'probe failed'),
      completedAt
    });
    await this.enqueueAgentWrite('probe-result', () => this.prisma.node.update({
      where: { id: nodeId },
      data: {
        lastProbeResult: JSON.stringify({
          taskId: data.taskId,
          success: data.success,
          results: data.results,
          completedAt
        })
      }
    }));
    this.logger.log(
      `agent probe completed: node=${nodeId} task=${data.taskId} success=${data.success} results=${data.results.length}`
    );
  }

  handleKickDevicesResult(nodeId: string, data: { taskId: string; success: boolean; message: string; kickedConnections: number }): void {
    this.acknowledgeTask(nodeId, data.taskId, {
      taskId: data.taskId,
      type: 'kick_devices',
      success: data.success,
      message: data.message,
      completedAt: new Date().toISOString()
    });
  }

  async handleRestartResult(nodeId: string, data: RestartAgentResultData): Promise<void> {
    this.acknowledgeTask(nodeId, data.taskId, {
      taskId: data.taskId,
      type: 'restart',
      success: data.success,
      message: data.message,
      completedAt: new Date().toISOString()
    });
    this.logger[data.success ? 'log' : 'warn'](
      `agent restart ${data.success ? 'succeeded' : 'failed'}: node=${nodeId} task=${data.taskId} message=${data.message}`
    );
    this.systemLogsService?.enqueue({
      nodeId,
      source: 'AGENT',
      level: data.success ? 'INFO' : 'WARN',
      module: 'AgentGateway',
      message: `节点 Agent 重启${data.success ? '成功' : '失败'}${data.message ? `: ${data.message}` : ''}`,
      metadata: { taskId: data.taskId, success: data.success, message: data.message }
    });
  }

  async handleLogReport(nodeId: string, data: LogReportData): Promise<void> {
    if (!this.systemLogsService || !data?.logs?.length) return;
    const node = await this.prisma.node.findUnique({
      where: { id: nodeId },
      select: { singboxLogMode: true, singboxLogModeUntil: true }
    });
    if (!node) return;
    const mode = this.resolveSingboxLogMode(node.singboxLogMode, node.singboxLogModeUntil);
    const captureLevel = this.captureLevelForMode(mode);
    const minimumSeverity = this.logSeverity(captureLevel);

    for (const item of data.logs) {
      const source = item.source === 'SINGBOX' ? 'SINGBOX' : 'AGENT';
      const itemSeverity = this.logSeverity(item.level);
      const isSingbox = source === 'SINGBOX';
      const isAccess = Boolean(item.metadata && typeof item.metadata === 'object' && item.metadata.category === 'ACCESS');
      if (isSingbox && (itemSeverity < minimumSeverity || (mode === 'NORMAL' && isAccess))) {
        continue;
      }
      this.systemLogsService.enqueue({
        nodeId,
        source,
        level: item.level,
        module: item.module || 'Agent',
        message: item.message,
        metadata: item.metadata,
        // 诊断动作是管理员显式开启的，仅允许该节点的 Sing-box 日志绕过全局门槛。
        bypassMinIngestLevel: isSingbox && mode !== 'NORMAL'
      });
    }
  }

  private logSeverity(level: string): number {
    return { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 }[level] ?? 0;
  }

  private resolveSingboxLogMode(mode: string | null | undefined, until: Date | null | undefined): SingboxLogMode {
    if (!mode || mode === 'NORMAL') return 'NORMAL';
    if (!until || until.getTime() <= Date.now()) return 'NORMAL';
    return SINGBOX_LOG_MODES.includes(mode as SingboxLogMode) ? mode as SingboxLogMode : 'NORMAL';
  }

  private captureLevelForMode(mode: SingboxLogMode): SingboxLogCaptureLevel {
    return mode === 'NORMAL' ? 'WARN' : mode;
  }

  private async expireSingboxDiagnostics(): Promise<void> {
    const now = new Date();
    const expired = await this.prisma.node.findMany({
      where: {
        singboxLogMode: { in: ['INFO', 'DEBUG'] },
        singboxLogModeUntil: { lte: now }
      },
      select: { id: true, name: true }
    });
    if (!expired.length) return;
    await this.enqueueAgentWrite('singbox-log-diagnostic-expire', () => this.prisma.node.updateMany({
      where: {
        id: { in: expired.map((node) => node.id) },
        singboxLogMode: { in: ['INFO', 'DEBUG'] },
        singboxLogModeUntil: { lte: now }
      },
      data: { singboxLogMode: 'NORMAL', singboxLogModeUntil: null }
    }));
    for (const node of expired) {
      this.configCache.delete(node.id);
      void this.pushConfig(node.id);
      this.systemLogsService?.enqueue({
        nodeId: node.id,
        source: 'SERVER',
        level: 'INFO',
        module: 'NodeDiagnostics',
        message: `节点 ${node.name} 的 Sing-box 诊断日志已自动过期并恢复 NORMAL`,
        metadata: { reason: 'expired' }
      });
    }
  }

  async enableSingboxLogDiagnostics(nodeId: string, level: Exclude<SingboxLogMode, 'NORMAL'>, operatorId?: string) {
    if (!['INFO', 'DEBUG'].includes(level)) throw new ConflictException('诊断日志级别无效');
    const node = await this.prisma.node.findUnique({
      where: { id: nodeId },
      select: { id: true, name: true, status: true, capabilitiesJson: true }
    });
    if (!node) throw new NotFoundException('节点不存在');
    if (node.status !== 'ONLINE') throw new ConflictException('仅在线节点支持临时诊断日志');
    if (!this.parseCapabilities(node.capabilitiesJson).includes(SINGBOX_LOG_CAPTURE_CAPABILITY)) {
      throw new ConflictException('节点 Agent 不支持诊断日志，请先升级 Agent');
    }
    const expiresAt = new Date(Date.now() + SINGBOX_DIAGNOSTIC_DURATION_MS);
    await this.enqueueAgentWrite('singbox-log-diagnostic-enable', () => this.prisma.node.update({
      where: { id: nodeId },
      data: { singboxLogMode: level, singboxLogModeUntil: expiresAt }
    }));
    this.configCache.delete(nodeId);
    const requested = await this.pushConfig(nodeId);
    this.systemLogsService?.enqueue({
      nodeId,
      source: 'SERVER',
      level: 'INFO',
      module: 'NodeDiagnostics',
      message: `节点 ${node.name} 已开启 Sing-box ${level} 诊断日志`,
      metadata: { level, expiresAt: expiresAt.toISOString(), requested, operatorId: operatorId ?? null }
    });
    return { nodeId, enabled: true, level, expiresAt: expiresAt.toISOString(), requested };
  }

  async disableSingboxLogDiagnostics(nodeId: string, operatorId?: string) {
    const node = await this.prisma.node.findUnique({ where: { id: nodeId }, select: { id: true, name: true } });
    if (!node) throw new NotFoundException('节点不存在');
    await this.enqueueAgentWrite('singbox-log-diagnostic-disable', () => this.prisma.node.update({
      where: { id: nodeId },
      data: { singboxLogMode: 'NORMAL', singboxLogModeUntil: null }
    }));
    this.configCache.delete(nodeId);
    const requested = await this.pushConfig(nodeId);
    this.systemLogsService?.enqueue({
      nodeId,
      source: 'SERVER',
      level: 'INFO',
      module: 'NodeDiagnostics',
      message: `节点 ${node.name} 已关闭 Sing-box 诊断日志`,
      metadata: { requested, operatorId: operatorId ?? null }
    });
    return { nodeId, enabled: false, level: 'NORMAL', expiresAt: null, requested };
  }

  // Line 自己拥有协议与端点：同一条 Line 在出口节点生成协议入站，
  // 中继线路再按入口角色追加盲转发或协议代理配置。
  async buildConfigSync(nodeId: string): Promise<ConfigSyncData> {
    const node = await this.prisma.node.findUnique({
      where: { id: nodeId },
      include: {
        entryLines: {
          where: { status: 'ACTIVE', type: { not: 'EXTERNAL' } },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          include: {
            landingNode: true,
            certificate: true,
            upstreamNode: { include: { subscription: true } },
            targetLine: { include: { entryNode: true } },
            relaySources: {
              where: { status: 'ACTIVE' },
              select: { id: true, tagsJson: true, isPublic: true, status: true }
            }
          }
        },
        landingLines: {
          where: { status: 'ACTIVE', type: { not: 'EXTERNAL' } },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          include: {
            entryNode: true,
            certificate: true,
            targetLine: { include: { entryNode: true } },
            relaySources: {
              where: { status: 'ACTIVE' },
              select: { id: true, tagsJson: true, isPublic: true, status: true }
            }
          }
        }
      }
    });
    if (!node) {
      throw new NotFoundException('节点不存在');
    }

    // vless/tuic 用 uuid 登录；hy2 的 password 回退 uuid（与订阅输出一致，见 docs/DATA_MODELS.md §3.1）
    const subscriptionDelegate = (this.prisma as unknown as { subscription?: SubscriptionDelegate }).subscription;
    let entitledSubscriptions: SubscriptionSnapshot[] = [];
    const settings = await this.settingsService?.getSettings();
    const enforceEmailVerification = settings?.enforceEmailVerification ?? false;
    const userDeviceLimits: Record<string, number> = {};
    const agentLogRotation: AgentLogRotationConfig = {
      maxSizeMb: settings?.agentLogMaxSizeMb ?? 50,
      maxFiles: settings?.agentLogMaxFiles ?? 5
    };

    if (subscriptionDelegate) {
      entitledSubscriptions = await subscriptionDelegate.findMany({
        where: { status: { in: ['ACTIVE', 'CANCELED'] } },
        include: {
          user: {
            select: {
              id: true,
              uuid: true,
              email: true,
              deviceLimit: true,
              role: true,
              emailVerifiedAt: true,
              password: true,
              isActive: true,
              extraLineGrants: { select: { lineId: true } }
            }
          },
          plan: { select: { lineMatchMode: true, lineTagsJson: true, lineIdsJson: true, deviceLimit: true } }
        }
      });
      entitledSubscriptions = entitledSubscriptions.map((subscription) => applyPlanSnapshot(subscription) as typeof subscription);
      entitledSubscriptions = entitledSubscriptions.filter((subscription) =>
        subscription.user.isActive &&
        (!enforceEmailVerification || !!subscription.user.emailVerifiedAt || subscription.user.role === 'ADMIN') &&
        subscription.trafficUsedBytes < subscription.trafficLimitBytes &&
        (!subscription.expireAt || subscription.expireAt.getTime() > Date.now())
      );
    } else {
      const entitledUsers = await this.prisma.user.findMany({
        where: {
          isActive: true,
          ...(enforceEmailVerification ? { OR: [{ emailVerifiedAt: { not: null } }, { role: 'ADMIN' }] } : {})
        },
        select: { id: true, uuid: true, email: true, deviceLimit: true, role: true, emailVerifiedAt: true, password: true, isActive: true, expireAt: true, trafficLimitBytes: true, trafficUsedBytes: true }
      });
      entitledSubscriptions = entitledUsers
        .filter(isUserEntitled)
        .map((u) => ({
          id: u.uuid,
          status: 'ACTIVE',
          trafficLimitBytes: u.trafficLimitBytes,
          trafficUsedBytes: u.trafficUsedBytes,
          expireAt: u.expireAt,
          user: { id: u.id, uuid: u.uuid, email: u.email, deviceLimit: u.deviceLimit, role: u.role, emailVerifiedAt: u.emailVerifiedAt, password: u.password, isActive: u.isActive }
        }));
    }

    if (settings?.deviceLimitEnabled !== false) {
      for (const subscription of entitledSubscriptions) {
        const limit = resolveEffectiveDeviceLimit({
          globalEnabled: true,
          userDeviceLimit: subscription.user.deviceLimit,
          planDeviceLimit: subscription.plan?.deviceLimit
        }).effectiveDeviceLimit;
        if (limit && limit > 0) {
          userDeviceLimits[subscription.user.email] = limit;
          userDeviceLimits[subscription.user.uuid] = limit;
        }
      }
    }

    type ConfigLine = {
      id: string;
      tag: string | null;
      listen: string;
      proxyPoolEnabled?: boolean;
      type: string;
      relayMode: string | null;
      protocolType: string;
      paramsJson: string;
      entryNodeId: string | null;
      entryPort: number | null;
      landingNodeId: string | null;
      landingPort: number | null;
      allowLanAccess?: boolean;
      endpointOverrideEnabled?: boolean;
      serverHost?: string | null;
      landingEndpointOverrideEnabled?: boolean;
      landingServerHost?: string | null;
      landingServerPort?: number | null;
      tunnelType?: string | null;
      tunnelPort?: number | null;
      tunnelSecret?: string | null;
      tagsJson: string;
      isPublic: boolean;
      status: string;
      speedLimitMbps?: number | null;
      tcpFastOpen?: boolean;
      tcpMultiPath?: boolean;
      udpFragment?: boolean | null;
      udpTimeout?: string | null;
      proxyProtocol?: boolean;
      proxyProtocolAcceptNoHeader?: boolean;
      entryNode?: { serverHost: string; status?: string; reachability?: string } | null;
      landingNode?: { serverHost: string; status?: string; reachability?: string } | null;
      certificate: { certificatePem: string; privateKeyPem: string } | null;
      targetLine?: {
        id: string;
        type: string;
        protocolType: string;
        paramsJson: string;
        entryPort: number | null;
        status: string;
        endpointOverrideEnabled?: boolean;
        serverHost?: string | null;
        serverPort?: number | null;
        serverName?: string | null;
        host?: string | null;
        entryNode: { serverHost: string; status?: string } | null;
      } | null;
      relaySources?: Array<{ id: string; tagsJson: string; isPublic: boolean; status: string }>;
      upstreamNode?: (UpstreamAvailabilityNode & { id: string; name: string; serverHost: string; serverPort: number }) | null;
    };
    const lines = new Map<string, ConfigLine>();
    for (const line of node.entryLines ?? []) {
      lines.set(line.id, {
        ...line,
        entryNode: { serverHost: node.serverHost, status: node.status, reachability: (node as { reachability?: string }).reachability ?? 'PUBLIC' }
      });
    }
    for (const line of node.landingLines ?? []) {
      if (!lines.has(line.id)) {
        lines.set(line.id, {
          ...line,
          landingNode: { serverHost: node.serverHost, status: node.status, reachability: (node as { reachability?: string }).reachability ?? 'PUBLIC' }
        });
      }
    }

    const publicLinesEnabled = (await this.settingsService?.getSettings())?.publicLinesEnabled !== false;
    const inbounds: Array<Record<string, unknown>> = [];
    const outbounds: Array<Record<string, unknown>> = [{ type: 'direct', tag: 'direct' }];
    const relayRules: Array<Record<string, unknown>> = [];
    const portSpeedLimits: Record<number, number> = {};
    // 与端点导出共用逐线路绑定分配，缺少解析器时拒绝注入而非回退旧裸 Key。
    const bindings = this.proxyPoolAccess ? await this.proxyPoolAccess.getNodeBindings(nodeId) : [];
    const bindingsByLine = new Map<string, ProxyPoolBinding[]>();
    for (const binding of bindings) bindingsByLine.set(binding.lineId, [...(bindingsByLine.get(binding.lineId) ?? []), binding]);
    const proxyPoolRules: Array<Record<string, unknown>> = [];
    const authorizedUsers = new Map<string, InboundUserCredential>();
    const usersForLine = (line: Pick<ConfigLine, 'id' | 'tagsJson' | 'isPublic' | 'status'>): InboundUserCredential[] => {
      const lineUsers = entitledSubscriptions
        .filter((subscription) => {
          if (!subscription.plan) return true;
          return isLineAuthorized(
            subscription.plan,
            line,
            subscription.user.extraLineGrants?.map((grant) => grant.lineId) ?? []
          );
        })
        .map((subscription) => ({
          uuid: subscription.user.uuid,
          email: subscription.user.email,
          credential: subscription.user.password ?? subscription.user.uuid
        }));
      lineUsers.forEach((user) => authorizedUsers.set(user.uuid, user));
      return [...lineUsers, this.internalSpeedtestUser()];
    };
    for (const line of lines.values()) {
      if (line.type === 'EXTERNAL' || !line.entryNodeId || !line.entryPort) continue;
      if (!publicLinesEnabled) continue;
      const protocolType = line.protocolType as ProtocolType;
      const isProxyPoolProtocol = line.proxyPoolEnabled === true && protocolType === 'MIXED' && (line.type === 'DIRECT' || (line.type === 'RELAY' && line.relayMode === 'UPSTREAM_NODE'));
      const lineParams = this.buildLineParams(line);
      if (line.relayMode === 'UPSTREAM_NODE' && (!line.upstreamNode || getUpstreamUnavailableReason(line.upstreamNode) || !isMeteredUpstreamEntry(protocolType, lineParams))) continue;
      // 保留密码协议原有订阅鉴权；只有显式代理池开关才取得独立 Key。
      const params = isProxyPoolProtocol || (line.relayMode !== 'UPSTREAM_NODE' && AUTHENTICATED_PROXY_PROTOCOLS.includes(protocolType)) ? { ...lineParams, usersEnabled: true } : lineParams;
      const lineBindings = isProxyPoolProtocol ? bindingsByLine.get(line.id) ?? [] : [];
      const lineTags = resolveLineTags(line);
      const isEntry = line.entryNodeId === nodeId;
      const isLanding = line.landingNodeId === nodeId;
      if (node.status === 'DISABLED') continue;
      const users = usersForLine(line);
      const inboundUsers = line.type === 'DIRECT' && line.relaySources?.length
        ? [...new Map(
          [...users, ...line.relaySources.flatMap((source) => usersForLine(source))]
            .map((user) => [user.uuid, user] as const)
        ).values()]
        : users;
      const targetInboundUsers = line.type === 'DIRECT' && line.relaySources?.length
        ? [...inboundUsers, this.internalRelayTransitUser()]
        : inboundUsers;
      const proxyPoolUsersForTag = (tag: string): ProxyPoolCredential[] => {
        if (!lineBindings.length || !isEntry) return [];
        proxyPoolRules.push(...buildProxyPoolWhitelistRules({ tag, credentials: lineBindings }));
        return lineBindings.map(({ username, password }) => ({ username, password }));
      };

      const listenOptions: SharedListenOptions = {
        tcpFastOpen: line.tcpFastOpen,
        tcpMultiPath: line.tcpMultiPath,
        udpFragment: line.udpFragment,
        udpTimeout: line.udpTimeout,
        proxyProtocol: line.proxyProtocol,
        proxyProtocolAcceptNoHeader: line.proxyProtocolAcceptNoHeader
      };
      if (line.speedLimitMbps && line.speedLimitMbps > 0) {
        if (isEntry) {
          portSpeedLimits[line.entryPort] = line.speedLimitMbps;
        }
        if (isLanding && !(line.type === 'RELAY' && line.relayMode === 'TARGET_LINE') && line.landingPort) {
          portSpeedLimits[line.landingPort] = line.speedLimitMbps;
        }
      }

      if (line.type === 'DIRECT' && isEntry) {
        const tag = lineTags.direct ?? `line-${line.id}`;
        inbounds.push(...buildServerInbounds({
          type: protocolType,
          tag,
          listen: line.listen || DEFAULT_INBOUND_LISTEN,
          port: line.entryPort,
          params,
          users: targetInboundUsers,
          lineId: line.id,
          proxyPoolUsers: proxyPoolUsersForTag(tag),
          listenOptions
        }));
        continue;
      }

      if (isEntry && line.relayMode === 'BLIND_FORWARD' && line.landingNode && line.landingPort) {
        const isNatLanding = line.landingNode.reachability === 'NAT';
        const blindListenFields = buildSharedListenFields(listenOptions);
        const hasLandingOverride = !isNatLanding && Boolean(line.landingEndpointOverrideEnabled && line.landingServerHost);
        const overrideAddress = isNatLanding
          ? '127.0.0.1'
          : (hasLandingOverride ? line.landingServerHost!.trim() : line.landingNode.serverHost);
        const overridePort = isNatLanding
          ? line.landingPort
          : (hasLandingOverride && line.landingServerPort ? line.landingServerPort : line.landingPort);
        inbounds.push({
          type: 'direct',
          tag: lineTags.entry ?? `relay-${line.id}-entry`,
          listen: line.listen || DEFAULT_INBOUND_LISTEN,
          listen_port: line.entryPort,
          ...blindListenFields,
          override_address: overrideAddress,
          override_port: overridePort
        });
      }

      if (isEntry && line.relayMode === 'PROTOCOL_PROXY') {
        const relayTag = lineTags.entry ?? `relay-${line.id}-entry`;
        const relayInbounds = buildServerInbounds({
          type: protocolType,
          tag: relayTag,
          listen: line.listen || DEFAULT_INBOUND_LISTEN,
          port: line.entryPort,
          params,
          users,
          lineId: line.id,
          proxyPoolUsers: proxyPoolUsersForTag(relayTag),
          listenOptions
        });
        inbounds.push(...relayInbounds);
        const outbound = this.buildProtocolRelayOutbound(line);
        if (!outbound) {
          inbounds.splice(-relayInbounds.length, relayInbounds.length);
          continue;
        }
        outbounds.push(outbound);
        relayRules.push({ inbound: [relayTag], outbound: `relay-out-${line.id}` });
      }

      if (isEntry && line.relayMode === 'TARGET_LINE') {
        const targetLine = line.targetLine;
        if (!targetLine || targetLine.status !== 'ACTIVE' || !targetLine.entryNode || !targetLine.entryPort) continue;
        const relayTag = lineTags.entry ?? `relay-${line.id}-entry`;
        const relayInbounds = buildServerInbounds({
          type: protocolType,
          tag: relayTag,
          listen: line.listen || DEFAULT_INBOUND_LISTEN,
          port: line.entryPort,
          params,
          users,
          lineId: line.id,
          proxyPoolUsers: proxyPoolUsersForTag(relayTag),
          listenOptions
        });
        inbounds.push(...relayInbounds);
        const targetLineHasOverride = Boolean(targetLine.endpointOverrideEnabled && targetLine.serverHost);
        const defaultHost = targetLineHasOverride ? targetLine.serverHost!.trim() : targetLine.entryNode.serverHost;
        const defaultPort = (targetLine.endpointOverrideEnabled && targetLine.serverPort) ? targetLine.serverPort : targetLine.entryPort;

        // 解耦物理拨号目标与应用层 TLS SNI / HTTP Host：
        // 若目标线路显式指定了 serverName，优先使用；
        // 若未指定且目标线路的接入端点域名有效（非纯 IP），自动继承该域名作为 TLS SNI，防止使用回源 IP 时因缺少 SNI 导致 x509 证书校验失败；
        // 若目标节点的主机地址为域名，亦可作为兜底。
        const targetTlsServerName = (targetLine.endpointOverrideEnabled && targetLine.serverName?.trim())
          ? targetLine.serverName.trim()
          : (targetLineHasOverride && isIP(targetLine.serverHost!.trim()) === 0
              ? targetLine.serverHost!.trim()
              : (isIP(targetLine.entryNode.serverHost.trim()) === 0 ? targetLine.entryNode.serverHost.trim() : undefined));

        const targetTransportHost = (targetLine.endpointOverrideEnabled && targetLine.host?.trim())
          ? targetLine.host.trim()
          : targetTlsServerName;

        const outbound = this.buildProtocolRelayOutbound({
          id: line.id,
          protocolType: targetLine.protocolType,
          paramsJson: targetLine.paramsJson,
          landingPort: defaultPort,
          landingNode: { serverHost: defaultHost, reachability: 'PUBLIC' },
          landingEndpointOverrideEnabled: line.landingEndpointOverrideEnabled,
          landingServerHost: line.landingServerHost,
          landingServerPort: line.landingServerPort,
          serverNameOverride: targetTlsServerName,
          hostOverride: targetTransportHost
        });
        if (!outbound) {
          inbounds.splice(-relayInbounds.length, relayInbounds.length);
          continue;
        }
        outbounds.push(outbound);
        relayRules.push({ inbound: [relayTag], outbound: `relay-out-${line.id}` });
      }

      if (isEntry && line.relayMode === 'UPSTREAM_NODE') {
        const upstreamNode = line.upstreamNode;
        if (!upstreamNode || getUpstreamUnavailableReason(upstreamNode)) continue;
        const relayTag = lineTags.entry ?? `relay-${line.id}-entry`;
        const relayInbounds = buildServerInbounds({
          type: protocolType,
          tag: relayTag,
          listen: line.listen || DEFAULT_INBOUND_LISTEN,
          port: line.entryPort,
          params,
          users,
          lineId: line.id,
          proxyPoolUsers: proxyPoolUsersForTag(relayTag),
          listenOptions
        });
        inbounds.push(...relayInbounds);
        const outbound = this.buildUpstreamRelayOutbound(line, upstreamNode);
        if (!outbound) {
          inbounds.splice(-relayInbounds.length, relayInbounds.length);
          continue;
        }
        outbounds.push(outbound);
        relayRules.push({ inbound: [relayTag], outbound: `relay-out-${line.id}` });
      }

      if (isLanding && !(line.type === 'RELAY' && line.relayMode === 'TARGET_LINE') && line.landingPort) {
        const exitUsers = line.type === 'RELAY' && line.relayMode === 'PROTOCOL_PROXY'
          ? [this.internalRelayTransitUser()]
          : users;
        const landingTag = lineTags.landing ?? `line-${line.id}-landing`;
        const isSelfNat = (node as { reachability?: string }).reachability === 'NAT';
        inbounds.push(...buildServerInbounds({
          type: protocolType,
          tag: landingTag,
          listen: isSelfNat ? '127.0.0.1' : (line.listen || DEFAULT_INBOUND_LISTEN),
          port: line.landingPort,
          params,
          users: exitUsers,
          lineId: line.id,
          proxyPoolUsers: proxyPoolUsersForTag(landingTag),
          listenOptions
        }));
        if (isSelfNat && !line.allowLanAccess) {
          relayRules.push({
            inbound: [landingTag],
            ip_cidr: PRIVATE_CIDR_BLOCKS,
            outbound: 'block'
          });
        }
      }
    }


    if (relayRules.some((rule) => rule.outbound === 'block') && !outbounds.some((outbound) => outbound.tag === 'block')) {
      outbounds.push({ type: 'block', tag: 'block' });
    }

    const tunnelConfigs: TunnelConfigPayload[] = [];
    const serverTunnelMap = new Map<number, {
      secret: string;
      mappings: Map<number, TunnelPortMapping>;
    }>();
    const clientTunnelMap = new Map<string, {
      serverHost: string;
      serverPort: number;
      secret: string;
      mappings: Map<number, TunnelPortMapping>;
    }>();

    for (const line of lines.values()) {
      if (node.status === 'DISABLED') continue;
      if (line.type !== 'RELAY') continue;
      const isEntry = line.entryNodeId === nodeId;
      const isLanding = line.landingNodeId === nodeId;

      // 如果当前节点为入口节点，且落地节点为 NAT 节点
      if (isEntry && line.landingNode?.reachability === 'NAT' && line.tunnelPort && line.tunnelSecret && line.landingPort) {
        let entry = serverTunnelMap.get(line.tunnelPort);
        if (!entry) {
          entry = { secret: line.tunnelSecret, mappings: new Map() };
          serverTunnelMap.set(line.tunnelPort, entry);
        }
        entry.mappings.set(line.landingPort, {
          lineId: line.id,
          localPort: line.landingPort,
          targetPort: line.landingPort
        });
      }

      // 如果当前节点为落地节点，且自身为 NAT 节点
      if (isLanding && (node as { reachability?: string }).reachability === 'NAT' && line.tunnelPort && line.tunnelSecret && line.landingPort) {
        const entryServerHost = (line.endpointOverrideEnabled && line.serverHost ? line.serverHost : line.entryNode?.serverHost)?.trim();
        if (entryServerHost) {
          const key = `${entryServerHost}:${line.tunnelPort}`;
          let entry = clientTunnelMap.get(key);
          if (!entry) {
            entry = {
              serverHost: entryServerHost,
              serverPort: line.tunnelPort,
              secret: line.tunnelSecret,
              mappings: new Map()
            };
            clientTunnelMap.set(key, entry);
          }
          entry.mappings.set(line.landingPort, {
            lineId: line.id,
            localPort: line.landingPort,
            targetPort: line.landingPort
          });
        }
      }
    }

    for (const [listenPort, data] of serverTunnelMap.entries()) {
      tunnelConfigs.push({
        id: `tunnel-${listenPort}`,
        role: 'SERVER',
        listenPort,
        secret: data.secret,
        mappings: Array.from(data.mappings.values())
      });
    }

    for (const data of clientTunnelMap.values()) {
      tunnelConfigs.push({
        id: `tunnel-${data.serverPort}`,
        role: 'CLIENT',
        serverAddr: `${data.serverHost}:${data.serverPort}`,
        secret: data.secret,
        mappings: Array.from(data.mappings.values())
      });
    }

    const statsUsers = new Set<string>();
    for (const inbound of inbounds) {
      if (Array.isArray(inbound.users)) {
        for (const user of inbound.users as Array<Record<string, unknown>>) {
          const name = typeof user.name === 'string' ? user.name : typeof user.username === 'string' ? user.username : null;
          if (name) statsUsers.add(name);
        }
      }
    }

    let singboxConfig: Record<string, unknown> = {
      log: { level: 'warn', timestamp: true },
      inbounds,
      outbounds,
      experimental: {
        v2ray_api: {
          listen: getStatsApiListen(),
          stats: {
            enabled: true,
            users: [...statsUsers],
            inbounds: inbounds.map((inbound) => inbound.tag).filter((tag): tag is string => typeof tag === 'string' && tag.length > 0)
          }
        }
      },
      ...((proxyPoolRules.length || relayRules.length) ? { route: { rules: [...proxyPoolRules, ...relayRules] } } : {})
    };
    if (node.configOverride) {
      singboxConfig = deepMerge(singboxConfig, JSON.parse(node.configOverride) as Record<string, unknown>);
    }
    if (this.parseCapabilities(node.capabilitiesJson).includes('device_tracking')) {
      const experimental = (singboxConfig.experimental && typeof singboxConfig.experimental === 'object' && !Array.isArray(singboxConfig.experimental))
        ? singboxConfig.experimental as Record<string, unknown>
        : {};
      const clashApi = (experimental.clash_api && typeof experimental.clash_api === 'object' && !Array.isArray(experimental.clash_api))
        ? experimental.clash_api as Record<string, unknown>
        : {};
      const customController = typeof clashApi.external_controller === 'string' && clashApi.external_controller.trim().length > 0
        ? clashApi.external_controller.trim()
        : getClashApiListen();
      singboxConfig.experimental = {
        ...experimental,
        clash_api: { ...clashApi, external_controller: customController }
      };
    }
    const logMode = this.resolveSingboxLogMode(node.singboxLogMode, node.singboxLogModeUntil);
    if (logMode !== 'NORMAL') {
      const logConfig = (singboxConfig.log && typeof singboxConfig.log === 'object' && !Array.isArray(singboxConfig.log))
        ? singboxConfig.log as Record<string, unknown>
        : {};
      singboxConfig.log = { ...logConfig, level: logMode.toLowerCase() };
    }
    return {
      version: ++this.configVersion,
      singboxConfig,
      singboxLogCaptureLevel: this.captureLevelForMode(logMode),
      agentLogRotation,
      tunnelConfigs,
      ...(Object.keys(portSpeedLimits).length > 0 ? { portSpeedLimits } : {}),
      userDeviceLimits
    };
  }

  private buildLineParams(line: {
    paramsJson: string;
    certificate?: { certificatePem: string; privateKeyPem: string } | null;
  }): Record<string, unknown> {
    const params = revealInboundSecrets(JSON.parse(line.paramsJson) as Record<string, unknown>);
    if (!line.certificate) return params;
    const tls = params.tls;
    if (!tls || typeof tls !== 'object' || Array.isArray(tls)) return params;
    return {
      ...params,
      tls: {
        ...(tls as Record<string, unknown>),
        certificate: [line.certificate.certificatePem],
        key: [decryptSecret(line.certificate.privateKeyPem)]
      }
    };
  }


  private async getDesiredConfigSync(nodeId: string): Promise<ConfigSyncData> {
    const cached = this.configCache.get(nodeId);
    if (cached) return cached;
    const payload = await this.buildConfigSync(nodeId);
    this.configCache.set(nodeId, payload);
    return payload;
  }

  private buildProtocolRelayOutbound(
    line: {
      id: string;
      protocolType: string;
      paramsJson: string;
      landingPort?: number | null;
      landingNode?: { serverHost: string; reachability?: string } | null;
      landingEndpointOverrideEnabled?: boolean;
      landingServerHost?: string | null;
      landingServerPort?: number | null;
      serverNameOverride?: string | null;
      hostOverride?: string | null;
    }
  ): Record<string, unknown> | undefined {
    if (!line.landingNode || !line.landingPort) return undefined;
    const protocolType = line.protocolType as ProtocolType;
    const params = revealInboundSecrets(JSON.parse(line.paramsJson) as Record<string, unknown>);
    const tls = (params.tls ?? {}) as Record<string, unknown>;
    const reality = tls.reality as Record<string, unknown> | undefined;
    const fallbackServerName = typeof tls.serverName === 'string' && tls.serverName.trim()
      ? tls.serverName.trim()
      : reality && Array.isArray(reality.serverNames) && typeof reality.serverNames[0] === 'string'
        ? reality.serverNames[0]
        : undefined;

    // 当连接目标被覆盖为纯 IP 时，若未提供显式 SNI，尝试使用落地节点的域名（若其不为 IP）
    const nodeDomainServerName = (line.landingNode && isIP(line.landingNode.serverHost.trim()) === 0)
      ? line.landingNode.serverHost.trim()
      : undefined;

    const tlsServerName = line.serverNameOverride?.trim() || fallbackServerName || nodeDomainServerName;
    const isNatLanding = line.landingNode.reachability === 'NAT';
    const hasLandingOverride = !isNatLanding && Boolean(line.landingEndpointOverrideEnabled && line.landingServerHost);
    const targetHost = isNatLanding
      ? '127.0.0.1'
      : (hasLandingOverride ? line.landingServerHost!.trim() : line.landingNode.serverHost);
    const targetPort = isNatLanding
      ? line.landingPort
      : (hasLandingOverride && line.landingServerPort ? line.landingServerPort : line.landingPort);
    const outbound: Record<string, unknown> = {
      type: protocolType.toLowerCase(),
      tag: `relay-out-${line.id}`,
      server: targetHost,
      server_port: targetPort
    };
    switch (protocolType) {
      case 'VLESS':
        outbound.uuid = INTERNAL_RELAY_TRANSIT_UUID;
        if (typeof params.flow === 'string') outbound.flow = params.flow;
        break;
      case 'VMESS':
        outbound.uuid = INTERNAL_RELAY_TRANSIT_UUID;
        outbound.alter_id = typeof params.alterId === 'number' ? params.alterId : 0;
        outbound.security = 'auto';
        break;
      case 'TROJAN':
        outbound.password = INTERNAL_RELAY_TRANSIT_SECRET;
        break;
      case 'HYSTERIA2':
        outbound.password = INTERNAL_RELAY_TRANSIT_SECRET;
        if (typeof params.upMbps === 'number') outbound.up_mbps = params.upMbps;
        if (typeof params.downMbps === 'number') outbound.down_mbps = params.downMbps;
        if (params.obfs) outbound.obfs = params.obfs;
        break;
      case 'TUIC':
        outbound.uuid = INTERNAL_RELAY_TRANSIT_UUID;
        outbound.password = INTERNAL_RELAY_TRANSIT_SECRET;
        outbound.congestion_control = typeof params.congestionControl === 'string' ? params.congestionControl : 'bbr';
        if (params.zeroRttHandshake === true) outbound.zero_rtt_handshake = true;
        break;
      case 'SHADOWSOCKS':
        outbound.method = typeof params.method === 'string' ? params.method : '2022-blake3-aes-128-gcm';
        outbound.password = params.mode === 'multi-user'
          ? buildShadowsocksClientPassword(
            outbound.method as string,
            typeof params.password === 'string' ? params.password : '',
            INTERNAL_RELAY_TRANSIT_SECRET,
            INTERNAL_RELAY_TRANSIT_UUID
          )
          : normalizeShadowsocksPassword(outbound.method as string, typeof params.password === 'string' ? params.password : '');
        break;
      case 'NAIVE':
        outbound.username = INTERNAL_RELAY_TRANSIT_EMAIL;
        outbound.password = INTERNAL_RELAY_TRANSIT_SECRET;
        break;
      case 'SHADOWTLS':
        return undefined;
      default:
        return undefined;
    }

    const clientTls = buildClientTls(
      tls as unknown as Parameters<typeof buildClientTls>[0],
      tlsServerName,
      protocolType === 'NAIVE' ? { includeAlpn: false, includeInsecure: false } : undefined
    );
    if (clientTls) outbound.tls = clientTls;
    const transport = (params.transport ?? {}) as Record<string, unknown>;
    const transportHost = line.hostOverride?.trim() || (typeof transport.host === 'string' ? transport.host : null);
    const clientTransport = buildClientTransport(
      transport as unknown as Parameters<typeof buildClientTransport>[0],
      transportHost
    );
    if (clientTransport) outbound.transport = clientTransport;
    return outbound;
  }

  private buildUpstreamRelayOutbound(
    line: { id: string; landingEndpointOverrideEnabled?: boolean; landingServerHost?: string | null; landingServerPort?: number | null },
    upstreamNode: { protocolType: string; serverHost: string; serverPort: number; paramsJson: string }
  ): Record<string, unknown> | undefined {
    try {
      return buildUpstreamOutbound(readUpstreamRelayConnection(line, upstreamNode), `relay-out-${line.id}`);
    } catch {
      return undefined;
    }
  }

  private internalRelayTransitUser(): InboundUserCredential {
    return {
      uuid: INTERNAL_RELAY_TRANSIT_UUID,
      email: INTERNAL_RELAY_TRANSIT_EMAIL,
      credential: INTERNAL_RELAY_TRANSIT_SECRET
    };
  }

  private internalSpeedtestUser(): InboundUserCredential {
    return {
      uuid: INTERNAL_SPEEDTEST_UUID,
      email: INTERNAL_SPEEDTEST_EMAIL,
      credential: INTERNAL_SPEEDTEST_SECRET
    };
  }

  // 向指定节点推送配置（reload 触发）
  async pushConfig(nodeId: string): Promise<boolean> {
    try {
      const payload = await this.buildConfigSync(nodeId);
      this.configCache.set(nodeId, payload);
      const socket = this.sockets.get(nodeId);
      if (!socket) {
        const node = await this.prisma.node.findUnique({
          where: { id: nodeId },
          select: { status: true, communicationMode: true }
        });
        return node?.status === 'ONLINE' && node.communicationMode === 'HTTP';
      }
      socket.send(JSON.stringify({ type: 'config_sync', data: payload }));
      return true;
    } catch (err) {
      this.logger.error(`pushConfig failed for node=${nodeId}: ${err}`);
      return false;
    }
  }

  // 用户增删/资格变动时向全部在线节点推送（协议约定见 docs/API_AND_PROTOCOLS.md §2.2）
  async pushConfigToAll(): Promise<number> {
    this.configCache.clear();
    const settings = await this.settingsService?.getSettings();
    const debounceMs = settings?.configSyncDebounceMs ?? 250;
    return new Promise((resolve) => {
      this.configPushWaiters.push(resolve);
      if (this.configPushTimer) clearTimeout(this.configPushTimer);
      this.configPushTimer = setTimeout(() => {
        this.configPushTimer = undefined;
        void this.flushConfigToAll().then((count) => {
          const waiters = this.configPushWaiters.splice(0);
          waiters.forEach((waiter) => waiter(count));
        });
      }, debounceMs);
    });
  }

  private async flushConfigToAll(): Promise<number> {
    let pushed = 0;
    for (const nodeId of this.sockets.keys()) {
      if (await this.pushConfig(nodeId)) {
        pushed += 1;
      }
    }
    if (pushed > 0) {
      this.logger.log(`config_sync pushed to ${pushed} online node(s)`);
    }
    return pushed;
  }

  async requestUpgrade(
    nodeId: string,
    target: UpgradeTarget,
    version: string,
    url: string,
    sha256: string,
    options: UpgradeTaskOptions = {}
  ) {
    if (!/^https?:\/\//i.test(url)) throw new Error('upgrade URL must use http or https');
    if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('upgrade sha256 must be 64 hexadecimal characters');
    const taskId = randomUUID();
    const payload: UpgradeTaskData = {
      taskId,
      target,
      version,
      url,
      sha256,
      ...(options.resourceId ? { resourceId: options.resourceId } : {}),
      ...(options.assetId ? { assetId: options.assetId } : {}),
      ...(options.operation ? { operation: options.operation } : {}),
      ...(options.files?.length ? { files: options.files } : {})
    };
    const delegate = this.deploymentTasks();
    if (delegate) {
      // 自定义 URL 升级无关联资产/资源，assetId 与 releaseId 落空值，仍保留完整任务时间线
      await delegate.create({
        data: {
          id: taskId,
          nodeId,
          assetId: options.assetId ?? null,
          previousAssetId: options.previousAssetId ?? null,
          releaseId: options.releaseId ?? null,
          kind: target.toUpperCase(),
          operation: options.operation ?? 'UPGRADE',
          status: 'QUEUED',
          attempts: 0,
          payloadJson: JSON.stringify(payload),
          requestedById: options.requestedById ?? null
        }
      });
    }
    const sent = await this.dispatchUpgradeTask(nodeId, payload);
    return { taskId, requested: sent };
  }

  async retryUpgrade(nodeId: string, taskId: string, operatorId?: string) {
    const delegate = this.deploymentTasks();
    if (!delegate) throw new NotFoundException('升级任务不存在');
    const task = await delegate.findFirst({ where: { id: taskId, nodeId } });
    if (!task) throw new NotFoundException('升级任务不存在');
    if (!['FAILED', 'COMPLETED'].includes(task.status)) {
      return { taskId, requested: false, status: task.status };
    }
    const payload = this.parseUpgradePayload(task.payloadJson);
    await delegate.update({
      where: { id: task.id },
      data: {
        status: 'QUEUED',
        attempts: 0,
        errorMessage: null,
        completedAt: null,
        requestedById: operatorId ?? task.requestedById
      }
    });
    const requested = await this.dispatchUpgradeTask(nodeId, payload);
    return { taskId, requested };
  }

  async requestProbe(nodeId: string, probes: ProbeRequest[]) {
    if (!probes.length || probes.length > 8) throw new Error('probe task must contain 1 to 8 probes');
    const taskId = randomUUID();
    const sent = await this.sendTask(nodeId, 'probe_task', { taskId, probes });
    return { taskId, requested: sent };
  }

  async requestRestart(nodeId: string) {
    const taskId = randomUUID();
    const sent = await this.sendTask(nodeId, 'restart_agent_task', { taskId });
    return { taskId, requested: sent };
  }

  async startMirrorTask(nodeId: string, request: MirrorRequestData, handlers: MirrorStreamHandlers): Promise<() => void> {
    const node = await this.prisma.node.findUnique({
      where: { id: nodeId },
      select: { status: true, communicationMode: true, capabilitiesJson: true }
    });
    if (node?.status !== 'ONLINE' || node.communicationMode !== 'WS' || !this.parseCapabilities(node.capabilitiesJson).includes('mirror_proxy')) {
      throw new ConflictException('节点未在线或未宣告 mirror_proxy 能力');
    }
    const socket = this.sockets.get(nodeId);
    if (!socket) throw new ConflictException('节点 WebSocket 连接不可用');
    if (this.mirrorSessions.has(request.taskId)) throw new ConflictException('镜像任务已存在');
    this.mirrorSessions.set(request.taskId, { nodeId, handlers });
    try {
      socket.send(JSON.stringify({ type: 'mirror_request', data: request }));
    } catch (error) {
      this.mirrorSessions.delete(request.taskId);
      throw error;
    }
    return () => this.cancelMirrorTask(request.taskId);
  }

  cancelMirrorTask(taskId: string): void {
    const session = this.mirrorSessions.get(taskId);
    if (!session) return;
    this.mirrorSessions.delete(taskId);
    try {
      this.sockets.get(session.nodeId)?.send(JSON.stringify({ type: 'mirror_cancel', data: { taskId } }));
    } catch (error) {
      this.logger.warn(`send mirror cancel failed: task=${taskId} error=${error}`);
    }
  }

  handleMirrorText(nodeId: string, type: string, data: unknown): void {
    if (!['mirror_response_headers', 'mirror_response_end', 'mirror_error'].includes(type)) return;
    const taskId = typeof (data as { taskId?: unknown })?.taskId === 'string' ? (data as { taskId: string }).taskId : '';
    const session = this.mirrorSessions.get(taskId);
    if (!session || session.nodeId !== nodeId) return;
    if (type === 'mirror_response_headers') session.handlers.onHeaders(data as MirrorResponseHeadersData);
    if (type === 'mirror_response_end') {
      this.mirrorSessions.delete(taskId);
      session.handlers.onEnd(data as MirrorResponseEndData);
    }
    if (type === 'mirror_error') {
      this.mirrorSessions.delete(taskId);
      session.handlers.onError(data as MirrorErrorData);
    }
  }

  handleMirrorBinary(nodeId: string, raw: Buffer): void {
    if (raw.length < 3) return;
    const taskIdLength = raw.readUInt16BE(0);
    if (taskIdLength < 1 || taskIdLength > 128 || raw.length < taskIdLength + 2) return;
    const taskId = raw.subarray(2, taskIdLength + 2).toString('utf8');
    const session = this.mirrorSessions.get(taskId);
    if (!session || session.nodeId !== nodeId) return;
    session.handlers.onChunk(raw.subarray(taskIdLength + 2));
  }

  private parseCapabilities(raw: string | null | undefined): string[] {
    try {
      const parsed: unknown = JSON.parse(raw ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  private async sendTask(nodeId: string, type: 'upgrade_task' | 'probe_task' | 'restart_agent_task', data: unknown): Promise<boolean> {
    const socket = this.sockets.get(nodeId);
    if (socket) {
      try {
        socket.send(JSON.stringify({ type, data }));
        return true;
      } catch (err) {
        this.logger.warn(`send agent task failed: node=${nodeId} type=${type} error=${err}`);
        return false;
      }
    }

    const node = await this.prisma.node.findUnique({
      where: { id: nodeId },
      select: { status: true, communicationMode: true }
    });
    if (node?.status !== 'ONLINE' || node.communicationMode !== 'HTTP') return false;
    const task = { type, data } as AgentTaskMessage;
    const tasks = this.pendingTasks.get(nodeId) ?? [];
    tasks.push({ ...task, deliveredAt: 0 } as PendingTask);
    this.pendingTasks.set(nodeId, tasks);
    return true;
  }

  private async dispatchUpgradeTask(nodeId: string, payload: UpgradeTaskData): Promise<boolean> {
    const socket = this.sockets.get(nodeId);
    if (socket) {
      try {
        socket.send(JSON.stringify({ type: 'upgrade_task', data: payload }));
        await this.markDeploymentDispatched(payload.taskId);
        return true;
      } catch (err) {
        this.logger.warn(`send upgrade task failed: node=${nodeId} error=${err}`);
        return false;
      }
    }
    const node = await this.prisma.node.findUnique({ where: { id: nodeId }, select: { status: true, communicationMode: true } });
    return node?.status === 'ONLINE' && node.communicationMode === 'HTTP';
  }

  private async takePendingTasks(nodeId: string): Promise<AgentTaskMessage[]> {
    const result: AgentTaskMessage[] = [];
    const tasks = this.pendingTasks.get(nodeId) ?? [];
    const now = Date.now();
    const selected = tasks.filter((task) => task.deliveredAt === 0 || now - task.deliveredAt >= 60_000).slice(0, 8);
    selected.forEach((task) => { task.deliveredAt = now; });
    result.push(...selected.map((task): AgentTaskMessage => {
      if (task.type === 'upgrade_task') return { type: 'upgrade_task', data: task.data };
      if (task.type === 'probe_task') return { type: 'probe_task', data: task.data };
      if (task.type === 'restart_agent_task') return { type: 'restart_agent_task', data: task.data };
      return { type: 'kick_devices_task', data: task.data };
    }));
    const delegate = this.deploymentTasks();
    if (!delegate || result.length >= 8) return result.slice(0, 8);
    const persistent = await delegate.findMany({
      where: { nodeId, status: { in: ['QUEUED', 'DISPATCHED'] } },
      orderBy: { requestedAt: 'asc' },
      take: 8
    });
    for (const task of persistent) {
      if (result.length >= 8) break;
      if (task.status === 'DISPATCHED' && task.dispatchedAt && now - task.dispatchedAt.getTime() < 60_000) continue;
      const payload = this.parseUpgradePayload(task.payloadJson);
      await this.markDeploymentDispatched(task.id);
      result.push({ type: 'upgrade_task', data: payload });
    }
    return result;
  }

  private acknowledgeTask(nodeId: string, taskId: string, result: TaskResult) {
    const tasks = this.pendingTasks.get(nodeId);
    if (tasks) {
      const remaining = tasks.filter((task) => {
        const candidate = task.data as { taskId?: string };
        return candidate.taskId !== taskId;
      });
      if (remaining.length) this.pendingTasks.set(nodeId, remaining);
      else this.pendingTasks.delete(nodeId);
    }
    this.taskResults.set(`${nodeId}:${taskId}`, result);
  }

  getTaskStatus(nodeId: string, taskId: string) {
    const result = this.taskResults.get(`${nodeId}:${taskId}`);
    if (result) return { ...result, status: result.success ? 'COMPLETED' as const : 'FAILED' as const };
    const queued = (this.pendingTasks.get(nodeId) ?? []).some((task) => (task.data as { taskId?: string }).taskId === taskId);
    return { taskId, status: queued ? 'QUEUED' as const : 'PENDING' as const };
  }

  async getPersistedTaskStatus(nodeId: string, taskId: string) {
    const cached = this.getTaskStatus(nodeId, taskId);
    const delegate = this.deploymentTasks();
    if (!delegate) return cached;
    const task = await delegate.findFirst({ where: { id: taskId, nodeId } });
    if (!task) return cached;
    return {
      taskId,
      status: task.status as 'QUEUED' | 'DISPATCHED' | 'COMPLETED' | 'FAILED',
      success: task.status === 'COMPLETED' ? true : task.status === 'FAILED' ? false : undefined,
      message: task.errorMessage ?? undefined,
      attempts: task.attempts,
      requestedAt: task.requestedAt,
      dispatchedAt: task.dispatchedAt,
      completedAt: task.completedAt
    };
  }

  private deploymentTasks(): DeploymentTaskDelegate | undefined {
    return (this.prisma as unknown as { binaryDeploymentTask?: DeploymentTaskDelegate }).binaryDeploymentTask;
  }

  private parseUpgradePayload(raw: string): UpgradeTaskData {
    const parsed = JSON.parse(raw) as UpgradeTaskData;
    if (!parsed.taskId || !parsed.target || !parsed.version || !parsed.url || !parsed.sha256) {
      throw new Error('升级任务数据损坏');
    }
    return parsed;
  }

  private async markDeploymentDispatched(taskId: string): Promise<void> {
    const delegate = this.deploymentTasks();
    if (!delegate) return;
    const task = await delegate.findUnique({ where: { id: taskId } });
    if (!task) return;
    await delegate.update({
      where: { id: taskId },
      data: { status: 'DISPATCHED', attempts: task.attempts + 1, dispatchedAt: new Date() }
    });
  }

  private async dispatchQueuedUpgradeTasks(nodeId: string): Promise<void> {
    const delegate = this.deploymentTasks();
    if (!delegate || !this.sockets.has(nodeId)) return;
    const now = Date.now();
    const tasks = await delegate.findMany({ where: { nodeId, status: { in: ['QUEUED', 'DISPATCHED'] } }, orderBy: { requestedAt: 'asc' }, take: 8 });
    for (const task of tasks) {
      // 与 takePendingTasks 对齐：刚派发的任务不立即重发，避免重连顶替时触发重复升级重启
      if (task.status === 'DISPATCHED' && task.dispatchedAt && now - task.dispatchedAt.getTime() < 60_000) continue;
      try {
        await this.dispatchUpgradeTask(nodeId, this.parseUpgradePayload(task.payloadJson));
      } catch (err) {
        this.logger.warn(`dispatch restored upgrade task failed: node=${nodeId} task=${task.id} error=${err}`);
      }
    }
  }

  // 断开：置离线并移除注册
  async unregister(nodeId: string, socket?: AgentSocket): Promise<void> {
    if (socket && this.sockets.get(nodeId) !== socket) {
      return;
    }
    this.sockets.delete(nodeId);
    for (const [taskId, session] of this.mirrorSessions) {
      if (session.nodeId === nodeId) {
        this.mirrorSessions.delete(taskId);
        session.handlers.onError({ taskId, code: 'NODE_DISCONNECTED', message: '节点连接已断开' });
      }
    }
    this.logger.log(`agent offline: nodeId=${nodeId}`);
    void this.prisma.node
      .findUnique({ where: { id: nodeId }, select: { name: true, serverHost: true } })
      .then((node) => {
        this.systemLogsService?.enqueue({
          nodeId,
          source: 'AGENT',
          level: 'WARN',
          module: 'NodeGateway',
          message: `节点断开离线: ${node?.name ?? nodeId} (${node?.serverHost || 'unknown'})`
        });
      })
      .catch(() => {
        this.systemLogsService?.enqueue({
          nodeId,
          source: 'AGENT',
          level: 'WARN',
          module: 'NodeGateway',
          message: `节点断开离线: ${nodeId}`
        });
      });
  }

  isCurrentSocket(nodeId: string, socket: AgentSocket): boolean {
    return this.sockets.get(nodeId) === socket;
  }

  private supersedeSocket(nodeId: string): void {
    const socket = this.sockets.get(nodeId);
    if (!socket) return;
    this.sockets.delete(nodeId);
    try {
      socket.close(4002, 'switched to HTTP polling');
    } catch (err) {
      this.logger.warn(`close superseded agent socket failed: node=${nodeId} error=${err}`);
    }
    this.logger.log(`agent WS superseded by HTTP polling: node=${nodeId}`);
  }

  // 节点删除前断开其在线 Agent：只移除注册与关闭连接，不写库（节点即将删除）
  disconnectNode(nodeId: string): boolean {
    const socket = this.sockets.get(nodeId);
    if (!socket) {
      return false;
    }
    this.sockets.delete(nodeId);
    socket.close(4001, 'node deleted');
    this.logger.log(`agent disconnected: node=${nodeId} (deleted)`);
    return true;
  }

  // 心跳超时扫描：超过阈值未心跳的在线节点置离线
  async sweepStaleNodes(): Promise<void> {
    const settings = await this.settingsService?.getSettings();
    const heartbeatTimeoutMs = (settings?.heartbeatTimeoutSecs ?? 15) * 1000;
    const nodes = await this.prisma.node.findMany({
      where: { status: 'ONLINE' },
      select: { id: true, communicationMode: true, pollIntervalSecs: true, lastSeenAt: true }
    });
    const now = Date.now();
    const staleNodes = nodes
      .filter((node) => {
        if (!node.lastSeenAt) return true;
        const thresholdMs = node.communicationMode === 'HTTP'
          ? Math.max(heartbeatTimeoutMs, node.pollIntervalSecs * 3_000)
          : heartbeatTimeoutMs;
        return now - node.lastSeenAt.getTime() > thresholdMs;
      })
    if (staleNodes.length) {
      await this.enqueueAgentWrite('stale-sweep', () => this.prisma.node.updateMany({
        where: {
          OR: staleNodes.map((node) => ({
            id: node.id,
            status: 'ONLINE',
            lastSeenAt: node.lastSeenAt
          }))
        },
        data: { status: 'OFFLINE', bandwidthRate: null, uploadRate: null, downloadRate: null, kernelRunning: null, cpuUsage: null, memoryUsage: null }
      }));
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.configPushTimer) clearTimeout(this.configPushTimer);
    if (this.singboxDiagnosticTimer) clearInterval(this.singboxDiagnosticTimer);
    this.configPushWaiters.splice(0).forEach((waiter) => waiter(0));
    for (const [, socket] of this.sockets) {
      socket.close(1001, 'server shutdown');
    }
    this.sockets.clear();
    this.pendingTasks.clear();
    this.taskResults.clear();
    this.configCache.clear();
    this.mirrorSessions.clear();
    this.pendingHeartbeats.clear();
    this.versionConfirmations.clear();
    for (const timer of this.heartbeatRetryTimers.values()) clearTimeout(timer);
    this.heartbeatRetryTimers.clear();
    if (this.rateMetricFlushTimer) {
      clearTimeout(this.rateMetricFlushTimer);
      this.rateMetricFlushTimer = undefined;
    }
    if (this.trafficHourlyFlushTimer) {
      clearTimeout(this.trafficHourlyFlushTimer);
      this.trafficHourlyFlushTimer = undefined;
    }
    await Promise.allSettled([
      this.flushRateMetrics(),
      this.flushTrafficHourlyMetrics()
    ]);
    this.rateMetricBuckets.clear();
    this.trafficHourlyBuckets.clear();
  }
}

// 旧名称作为导出别名保留，避免已有测试和扩展模块被无意义地打断。
export { AgentService as AgentGatewayService };
