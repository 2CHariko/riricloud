import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { readUpstreamConnection, getUpstreamUnavailableReason } from '../common/upstream-availability';
import { sanitizeInboundParams } from '../common/inbound';
import { INTERNAL_SPEEDTEST_EMAIL, INTERNAL_SPEEDTEST_SECRET, INTERNAL_SPEEDTEST_UUID } from '../common/constants';
import { bindManagedConnection } from '../subscription/compilers/managed-connection';
import type { UpstreamConnection } from '../common/upstream-connection';
import type { ProbeConnectionRequest, ProbeResult, ProbeSubjectType } from './probe.types';
import { safeProbeResult } from './probe-result';

const certificateVersion = { select: { id: true, updatedAt: true } } as const;
const include = { entryNode: true, landingNode: true, certificate: certificateVersion, upstreamNode: { include: { subscription: true } }, targetLine: { include: { entryNode: true, certificate: certificateVersion } } } as const;
type ProbeLine = Prisma.LineGetPayload<{ include: typeof include }>;
type ProbeNode = Prisma.UpstreamNodeGetPayload<{ include: { subscription: true } }>;
export interface ProbeSelection { id?: string; subscriptionId?: string }
export interface ResourceSnapshot { request: ProbeConnectionRequest; version: string; updatedAt: Date; sequence: number }
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
  reserve(type: ProbeSubjectType, ids: string[]): number {
    const sequence = ++this.nextSequence;
    for (const id of ids) this.launches.set(`${type}:${id}`, sequence);
    return sequence;
  }
  release(type: ProbeSubjectType, ids: string[], sequence: number) {
    for (const id of ids) if (this.launches.get(`${type}:${id}`) === sequence) this.launches.delete(`${type}:${id}`);
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
  async snapshot(type: ProbeSubjectType, id: string, sequence: number, db: Prisma.TransactionClient = this.prisma): Promise<ResourceSnapshot | null> {
    if (type === 'UPSTREAM_NODE') {
      const node = await db.upstreamNode.findUnique({ where: { id }, include: { subscription: true } });
      if (!node || getUpstreamUnavailableReason(node)) return null;
      const version = probeHash(nodeProbeVersion(node));
      return { request: { subjectType: type, subjectId: id, connection: readUpstreamConnection(node), configHash: version, routeKind: 'UPSTREAM_DIRECT' }, version, updatedAt: node.updatedAt, sequence };
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
    const connection = line.type === 'EXTERNAL' ? readUpstreamConnection(line.upstreamNode!) : this.managedConnection(line);
    return { request: { subjectType: type, subjectId: id, connection, configHash: version, routeKind: line.type === 'EXTERNAL' ? 'UPSTREAM_DIRECT' : line.type === 'RELAY' ? 'MANAGED_RELAY' : 'MANAGED_DIRECT', allowPrivateEndpoint: line.type !== 'EXTERNAL' && Boolean(line.allowLanAccess || line.entryNode?.isLocal) }, version, updatedAt: line.updatedAt, sequence };
  }
  private managedConnection(line: ProbeLine): UpstreamConnection {
    const params = sanitizeInboundParams(JSON.parse(line.paramsJson) as Record<string, unknown>);
    return bindManagedConnection({ protocolType: line.protocolType, params, lineId: line.id,
      serverHost: line.endpointOverrideEnabled && line.serverHost ? line.serverHost : line.entryNode!.serverHost,
      serverPort: line.endpointOverrideEnabled && line.serverPort ? line.serverPort : line.entryPort!,
      serverName: line.endpointOverrideEnabled ? line.serverName ?? undefined : undefined,
      host: line.endpointOverrideEnabled ? line.host ?? undefined : undefined
    }, { uuid: INTERNAL_SPEEDTEST_UUID, email: INTERNAL_SPEEDTEST_EMAIL, credential: INTERNAL_SPEEDTEST_SECRET });
  }
  async persist(snapshot: ResourceSnapshot, result: ProbeResult, signal: AbortSignal): Promise<boolean> {
    const { subjectType, subjectId } = snapshot.request;
    const safe = safeProbeResult(result);
    if (!safe || safe.subjectType !== subjectType || safe.subjectId !== subjectId || safe.configHash !== snapshot.request.configHash) return false;
    const currentLaunch = () => !signal.aborted && this.launches.get(`${subjectType}:${subjectId}`) === snapshot.sequence;
    if (!currentLaunch()) return false;
    result = safe;
    const stale = new Error('STALE_PROBE_WRITE');
    try { return await this.prisma.$transaction(async (tx) => {
      const current = await this.snapshot(subjectType, subjectId, snapshot.sequence, tx);
      if (!currentLaunch() || !current || current.version !== snapshot.version || current.updatedAt.getTime() !== snapshot.updatedAt.getTime()) return false;
      const lastProbeJson = JSON.stringify({ ...result, applied: true, resourceVersion: snapshot.version });
      const data = { lastProbeJson, lastTestedAt: new Date(result.testedAt), lastTestStatus: result.status, lastTestMessage: result.message };
      const updated = subjectType === 'LINE'
        ? await tx.line.updateMany({ where: { id: subjectId, updatedAt: snapshot.updatedAt, status: 'ACTIVE' }, data: { ...data, lastLatencyMs: result.status === 'SUCCESS' ? result.latencyMs : null } })
        : await tx.upstreamNode.updateMany({ where: { id: subjectId, updatedAt: snapshot.updatedAt, status: 'ACTIVE', presenceStatus: 'PRESENT' }, data: { ...data, latencyMs: result.status === 'SUCCESS' ? result.latencyMs : null } });
      if (!currentLaunch()) throw stale;
      return updated.count === 1;
    }); } catch (error) { if (error === stale) return false; throw error; }
  }
}
