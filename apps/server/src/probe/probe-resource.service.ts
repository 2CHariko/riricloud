import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { readUpstreamConnection, getUpstreamUnavailableReason } from '../common/upstream-availability';
import { sanitizeInboundParams } from '../common/inbound';
import { evaluateSubscriptionEntitlement } from '../common/subscription-entitlement';
import { applyPlanSnapshot } from '../subscription/plan-snapshot';
import { ProbeSubscriptionError } from './probe-subscription';
import { bindManagedConnection } from '../subscription/compilers/managed-connection';
import type { UpstreamConnection } from '../common/upstream-connection';
import type { ProbeConnectionRequest, ProbeMeasurement, ProbeResult, ProbeSubjectType } from './probe.types';
import { safeProbeResult } from './probe-result';

const certificateVersion = { select: { id: true, updatedAt: true } } as const;
const include = { entryNode: true, landingNode: true, certificate: certificateVersion, upstreamNode: { include: { subscription: true } }, targetLine: { include: { entryNode: true, certificate: certificateVersion } } } as const;
type ProbeLine = Prisma.LineGetPayload<{ include: typeof include }>;
type ProbeNode = Prisma.UpstreamNodeGetPayload<{ include: { subscription: true } }>;
export interface ProbeSelection { id?: string; subscriptionId?: string }
export interface ResourceSnapshot { request: ProbeConnectionRequest; version: string; updatedAt: Date; sequence: number; measurement?: ProbeMeasurement; authorization?: { userId: string; version: string } }
export const probeHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_, item: unknown) => typeof item === 'bigint' ? item.toString() : item)).digest('hex');

// 仅配置与关联状态进入版本，不把 Agent 心跳和探针自身写入作为配置变更。
export function nodeProbeVersion(node: Pick<ProbeNode, 'id' | 'configHash' | 'connectionHash' | 'protocolType' | 'serverHost' | 'serverPort' | 'status' | 'presenceStatus' | 'subscriptionId'> & { subscription: Pick<ProbeNode['subscription'], 'status' | 'updatedAt' | 'userInfoUsedBytes' | 'userInfoTotalBytes' | 'userInfoExpireAt'> | null }) {
  return [node.id, node.configHash, node.connectionHash, node.protocolType, node.serverHost, node.serverPort, node.status, node.presenceStatus, node.subscriptionId, node.subscription?.updatedAt, node.subscription?.status, node.subscription?.userInfoUsedBytes, node.subscription?.userInfoTotalBytes, node.subscription?.userInfoExpireAt];
}
function managedVersion(node: Pick<NonNullable<ProbeLine['entryNode']>, 'id' | 'serverHost' | 'status' | 'reachability' | 'configOverride'> | null) {
  return node ? [node.id, node.serverHost, node.status, node.reachability, node.configOverride] : null;
}
type LineVersionInput = Pick<ProbeLine, 'id' | 'type' | 'status' | 'paramsJson' | 'protocolType' | 'entryNodeId' | 'entryPort' | 'landingNodeId' | 'landingPort' | 'targetLineId' | 'upstreamNodeId' | 'relayMode' | 'endpointOverrideEnabled' | 'serverHost' | 'serverPort' | 'serverName' | 'host' | 'landingEndpointOverrideEnabled' | 'landingServerHost' | 'landingServerPort' | 'certificateId' | 'allowLanAccess' | 'tunnelType' | 'tunnelPort' | 'tunnelSecret'> & {
  egressProxyJson?: string | null;
  certificate: { id: string; updatedAt: Date } | null;
  entryNode: Pick<NonNullable<ProbeLine['entryNode']>, 'id' | 'serverHost' | 'status' | 'reachability' | 'configOverride'> | null;
  landingNode: Pick<NonNullable<ProbeLine['entryNode']>, 'id' | 'serverHost' | 'status' | 'reachability' | 'configOverride'> | null;
  upstreamNode: Parameters<typeof nodeProbeVersion>[0] | null;
  targetLine: Pick<NonNullable<ProbeLine['targetLine']>, 'id' | 'updatedAt' | 'status' | 'protocolType' | 'paramsJson' | 'entryPort' | 'serverHost' | 'serverPort'> & { egressProxyJson?: string | null; entryNode: LineVersionInput['entryNode']; certificate: LineVersionInput['certificate'] } | null;
};
export function lineProbeVersion(line: LineVersionInput): string {
  const { entryNode, landingNode, upstreamNode, targetLine } = line;
  const config = [line.id, line.type, line.status, line.paramsJson, line.protocolType, line.entryNodeId, line.entryPort, line.landingNodeId, line.landingPort, line.targetLineId, line.upstreamNodeId, line.relayMode, line.endpointOverrideEnabled, line.serverHost, line.serverPort, line.serverName, line.host, line.landingEndpointOverrideEnabled, line.landingServerHost, line.landingServerPort, line.certificateId, line.allowLanAccess, line.tunnelType, line.tunnelPort, line.tunnelSecret];
  config.push(line.egressProxyJson ?? null);
  return probeHash([config, line.certificate ? [line.certificate.id, line.certificate.updatedAt] : null, managedVersion(entryNode), managedVersion(landingNode), upstreamNode ? nodeProbeVersion(upstreamNode) : null, targetLine ? [targetLine.id, targetLine.updatedAt, targetLine.status, targetLine.protocolType, targetLine.paramsJson, targetLine.entryPort, targetLine.serverHost, targetLine.serverPort, targetLine.egressProxyJson ?? null, managedVersion(targetLine.entryNode), targetLine.certificate ? [targetLine.certificate.id, targetLine.certificate.updatedAt] : null] : null]);
}

@Injectable()
export class ProbeResourceService {
  private nextSequence = 0;
  private readonly launches = new Map<string, number>();
  constructor(private readonly prisma: PrismaService) {}
  reserve(type: ProbeSubjectType, ids: string[], measurement: ProbeMeasurement = 'MIHOMO_URL_TEST'): number {
    const sequence = ++this.nextSequence;
    for (const id of ids) this.launches.set(`${type}:${id}:${measurement}`, sequence);
    return sequence;
  }
  release(type: ProbeSubjectType, ids: string[], sequence: number, measurement: ProbeMeasurement = 'MIHOMO_URL_TEST') {
    for (const id of ids) if (this.launches.get(`${type}:${id}:${measurement}`) === sequence) this.launches.delete(`${type}:${id}:${measurement}`);
  }
  async listIds(type: ProbeSubjectType, selection: ProbeSelection): Promise<string[]> {
    if (selection.id) {
      const row = type === 'LINE' ? await this.prisma.line.findUnique({ where: { id: selection.id }, select: { id: true } }) : await this.prisma.upstreamNode.findUnique({ where: { id: selection.id }, select: { id: true } });
      if (!row) throw new NotFoundException('探针资源不存在');
      return [row.id];
    }
    const ids: string[] = [];
    let cursor: string | undefined;
    while (true) {
      const pagination = { select: { id: true }, orderBy: { id: 'asc' as const }, take: 200, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) };
      const batch = type === 'LINE'
        ? await this.prisma.line.findMany({ ...pagination, where: { status: 'ACTIVE' } })
        : await this.prisma.upstreamNode.findMany({ ...pagination, where: { status: 'ACTIVE', presenceStatus: 'PRESENT', subscription: { status: 'ACTIVE' }, ...(selection.subscriptionId ? { subscriptionId: selection.subscriptionId } : {}) } });
      ids.push(...batch.map((row) => row.id));
      if (ids.length > 10000) throw new BadRequestException('单个探针任务最多包含 10000 个资源');
      if (batch.length < 200) return ids;
      cursor = batch[batch.length - 1].id;
    }
  }
  async snapshot(type: ProbeSubjectType, id: string, sequence: number, db: Prisma.TransactionClient = this.prisma, measurement: ProbeMeasurement = 'MIHOMO_URL_TEST', expectedUserId?: string | null): Promise<ResourceSnapshot | null> {
    if (type === 'UPSTREAM_NODE') {
      const node = await db.upstreamNode.findUnique({ where: { id }, include: { subscription: true } });
      if (!node || getUpstreamUnavailableReason(node)) return null;
      const version = probeHash(nodeProbeVersion(node));
      return { request: { subjectType: type, subjectId: id, connection: readUpstreamConnection(node), configHash: version, routeKind: 'UPSTREAM_DIRECT' }, version, updatedAt: node.updatedAt, sequence, measurement };
    }
    const line = await db.line.findUnique({ where: { id }, include });
    if (!line || line.status !== 'ACTIVE') return null;
    if ((line.type === 'EXTERNAL' || line.relayMode === 'UPSTREAM_NODE') && (!line.upstreamNode || getUpstreamUnavailableReason(line.upstreamNode))) return null;
    if (line.type !== 'EXTERNAL' && (!line.entryNode || line.entryNode.status === 'DISABLED' || !line.entryPort)) return null;
    if (line.type === 'RELAY') {
      if (line.relayMode === 'TARGET_LINE' && (!line.targetLine || line.targetLine.status !== 'ACTIVE' || !line.targetLine.entryNode || line.targetLine.entryNode.status === 'DISABLED' || !line.targetLine.entryPort)) return null;
      if (!['TARGET_LINE', 'UPSTREAM_NODE'].includes(line.relayMode ?? '') && (!line.landingNode || line.landingNode.status === 'DISABLED' || !line.landingPort)) return null;
    }
    const version = lineProbeVersion(line);
    const identity = line.type === 'EXTERNAL' ? undefined : await this.managedIdentity(db, line, expectedUserId);
    const connection = identity ? this.managedConnection(line, identity.user) : readUpstreamConnection(line.upstreamNode!);
    return { request: { subjectType: type, subjectId: id, connection, configHash: version, routeKind: line.type === 'EXTERNAL' ? 'UPSTREAM_DIRECT' : line.type === 'RELAY' ? 'MANAGED_RELAY' : 'MANAGED_DIRECT', allowPrivateEndpoint: line.type !== 'EXTERNAL' && Boolean(line.allowLanAccess || line.entryNode?.isLocal) }, version, updatedAt: line.updatedAt, sequence, measurement, ...(identity ? { authorization: identity.authorization } : {}) };
  }
  private async managedIdentity(db: Prisma.TransactionClient, line: ProbeLine, expectedUserId?: string | null) {
    // 直接使用同一数据库/事务读取设置和权益，结果写回不依赖缓存或 User 兼容配额字段。
    const rows = await db.systemSetting.findMany({ where: { key: { in: ['lineSpeedtestUserId', 'enforceEmailVerification', 'publicLinesEnabled'] } } });
    const settings = new Map(rows.map((row) => [row.key, row.value.trim()]));
    const userId = settings.get('lineSpeedtestUserId');
    if (!userId || userId === 'undefined') throw new ProbeSubscriptionError('SPEEDTEST_USER_NOT_CONFIGURED');
    if (expectedUserId !== undefined && userId !== expectedUserId) throw new ProbeSubscriptionError('SPEEDTEST_IDENTITY_CHANGED');
    const enforceEmailVerification = ['true', '1'].includes(settings.get('enforceEmailVerification')?.toLowerCase() ?? '');
    if (['false', '0'].includes(settings.get('publicLinesEnabled')?.toLowerCase() ?? '')) throw new ProbeSubscriptionError('SPEEDTEST_LINE_UNAUTHORIZED');
    const subscription = await db.subscription.findUnique({ where: { userId }, include: { user: { include: { extraLineGrants: { select: { lineId: true } } } }, plan: true } });
    const entitlement = evaluateSubscriptionEntitlement(subscription, { enforceEmailVerification, line });
    if (!entitlement.allowed) throw new ProbeSubscriptionError(entitlement.reason === 'LINE_UNAUTHORIZED' ? 'SPEEDTEST_LINE_UNAUTHORIZED' : 'SPEEDTEST_USER_UNAVAILABLE');
    if (!subscription?.plan || !subscription.user.uuid) throw new ProbeSubscriptionError('SPEEDTEST_USER_UNAVAILABLE');
    const effective = applyPlanSnapshot(subscription);
    const user = { uuid: subscription.user.uuid, email: subscription.user.email, credential: subscription.user.password ?? subscription.user.uuid };
    // 正常流量累计不能使快照失效，但每次写回仍重新判定是否已耗尽配额。
    const version = probeHash([userId, user, subscription.id, subscription.status, subscription.expireAt, subscription.trafficLimitBytes,
      enforceEmailVerification, subscription.user.role, subscription.user.emailVerifiedAt,
      effective.plan.lineMatchMode, effective.plan.lineTagsJson, effective.plan.lineIdsJson,
      subscription.user.extraLineGrants.map((grant) => grant.lineId).sort(), line.isPublic, line.tagsJson]);
    return { user, authorization: { userId, version } };
  }
  private managedConnection(line: ProbeLine, user: { uuid: string; email: string; credential: string }): UpstreamConnection {
    const params = sanitizeInboundParams(JSON.parse(line.paramsJson) as Record<string, unknown>);
    // 旧线路残留的单用户字段不能绕过专用订阅身份；共享密钥协议仍由订阅编译器处理。
    if (['VLESS', 'VLESS_REALITY', 'VMESS', 'TUIC'].includes(line.protocolType)) params.uuid = user.uuid;
    if (['TROJAN', 'HYSTERIA2', 'TUIC'].includes(line.protocolType)) params.password = user.credential;
    return bindManagedConnection({ protocolType: line.protocolType, params, lineId: line.id,
      serverHost: line.endpointOverrideEnabled && line.serverHost ? line.serverHost : line.entryNode!.serverHost,
      serverPort: line.endpointOverrideEnabled && line.serverPort ? line.serverPort : line.entryPort!,
      serverName: line.endpointOverrideEnabled ? line.serverName ?? undefined : undefined,
      host: line.endpointOverrideEnabled ? line.host ?? undefined : undefined
    }, user);
  }
  async persist(snapshot: ResourceSnapshot, result: ProbeResult, signal: AbortSignal): Promise<boolean> {
    const { subjectType, subjectId } = snapshot.request;
    const measurement = snapshot.measurement ?? 'MIHOMO_URL_TEST';
    const safe = safeProbeResult(result);
    if (!safe || safe.measurement !== measurement || safe.subjectType !== subjectType || safe.subjectId !== subjectId || safe.configHash !== snapshot.request.configHash) return false;
    const currentLaunch = () => !signal.aborted && this.launches.get(`${subjectType}:${subjectId}:${measurement}`) === snapshot.sequence;
    if (!currentLaunch()) return false;
    result = safe;
    const stale = new Error('STALE_PROBE_WRITE');
    try { return await this.prisma.$transaction(async (tx) => {
      const current = await this.snapshot(subjectType, subjectId, snapshot.sequence, tx, measurement, snapshot.authorization?.userId);
      if (!currentLaunch() || !current || current.version !== snapshot.version || current.authorization?.version !== snapshot.authorization?.version || current.updatedAt.getTime() !== snapshot.updatedAt.getTime()) return false;
      const json = JSON.stringify({ ...result, applied: true, resourceVersion: snapshot.version });
      // 测量元数据不推进配置时间，避免两种测量互相使快照失效；仍按原配置时间条件写入。
      const data = measurement === 'PROXY_HTTP_DELAY'
        ? { lastDebugProbeJson: json, updatedAt: snapshot.updatedAt }
        : { lastProbeJson: json, lastTestedAt: new Date(result.testedAt), lastTestStatus: result.status, lastTestMessage: result.message, updatedAt: snapshot.updatedAt };
      const latency = result.status === 'SUCCESS' ? result.latencyMs : null;
      const updated = subjectType === 'LINE'
        ? await tx.line.updateMany({ where: { id: subjectId, updatedAt: snapshot.updatedAt, status: 'ACTIVE' }, data: { ...data, ...(measurement === 'MIHOMO_URL_TEST' ? { lastLatencyMs: latency } : {}) } })
        : await tx.upstreamNode.updateMany({ where: { id: subjectId, updatedAt: snapshot.updatedAt, status: 'ACTIVE', presenceStatus: 'PRESENT' }, data: { ...data, ...(measurement === 'MIHOMO_URL_TEST' ? { latencyMs: latency } : {}) } });
      if (!currentLaunch()) throw stale;
      return updated.count === 1;
    }); } catch (error) { if (error === stale || error instanceof ProbeSubscriptionError) return false; throw error; }
  }
}
