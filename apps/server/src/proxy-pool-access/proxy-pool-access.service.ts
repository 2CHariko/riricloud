import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../system/settings.service';
import { isLineAuthorized, parseStringArray } from '../common/line-access';
import { getProxyCapabilities } from '../common/proxy-capabilities';
import { getUpstreamUnavailableReason } from '../common/upstream-availability';
import { readUpstreamRelayConnection } from '../common/upstream-relay-connection';
import { applyPlanSnapshot } from '../subscription/plan-snapshot';
import { readLastProbe } from '../probe/probe-result';
import type { ProbeResult } from '../probe/probe.types';
import { lineProbeVersion } from '../probe/probe-resource.service';
import { formatProxyLineUsername, normalizeWhitelistIps, parseWhitelistIps } from '../proxy-pool/proxy-key.util';

export const PROXY_POOL_NODE_BINDING_LIMIT = 512;
export interface ProxyPoolBinding {
  lineId: string;
  keyId: string;
  userId: string;
  username: string;
  password: string;
  whitelistIps: string[];
}
export interface ProxyPoolEndpoint {
  lineId: string; name: string; region: string | null; tags: string[];
  protocol: 'MIXED'; host: string; port: number;
  nodeId: string; nodeName: string; nodeStatus: string; online: boolean;
  routeKind: 'DIRECT' | 'UPSTREAM_RELAY'; lineType: 'DIRECT' | 'RELAY';
  status: 'AVAILABLE' | 'CAPACITY_EXCLUDED'; reason: string | null;
  tls: boolean; serverName: string | null; supportedProtocols: ('http' | 'socks5')[];
  trafficRate: number; lastProbe: ProbeResult | null;
  latencyMs: number | null; lastTestedAt: string | null; lastTestStatus: string | null;
}
export interface ProxyPoolNodeCapacity { nodeId: string; nodeName: string; used: number; limit: number; excluded: number }
export interface ProxyPoolAccessSnapshot {
  eligibleUserIds: Set<string>;
  endpoints: ProxyPoolEndpoint[];
  endpointsByKey: Map<string, ProxyPoolEndpoint[]>;
  bindingsByNode: Map<string, ProxyPoolBinding[]>;
  nodeCapacities: ProxyPoolNodeCapacity[];
}
const lineInclude = {
  entryNode: { select: { id: true, name: true, serverHost: true, status: true, reachability: true, configOverride: true } },
  landingNode: { select: { id: true, serverHost: true, status: true, reachability: true, configOverride: true } },
  certificate: { select: { id: true, updatedAt: true } },
  targetLine: { include: { entryNode: true, certificate: { select: { id: true, updatedAt: true } } } },
  upstreamNode: { include: { subscription: true } }
} satisfies Prisma.LineInclude;
type PoolLine = Prisma.LineGetPayload<{ include: typeof lineInclude }>;
const subscriptionInclude = {
  user: { select: { id: true, isActive: true, role: true, emailVerifiedAt: true, extraLineGrants: { select: { lineId: true } } } },
  plan: true
} satisfies Prisma.SubscriptionInclude;
type PoolSubscription = Prisma.SubscriptionGetPayload<{ include: typeof subscriptionInclude }>;

// 每次重建同一授权/容量快照，不维护另一个配置缓存，也不依赖 Agent。
@Injectable()
export class ProxyPoolAccessService {
  constructor(private readonly prisma: PrismaService, private readonly settingsService: SettingsService) {}

  async getNodeBindings(nodeId: string): Promise<ProxyPoolBinding[]> {
    return (await this.getSnapshot()).bindingsByNode.get(nodeId) ?? [];
  }

  async getSnapshot(): Promise<ProxyPoolAccessSnapshot> {
    const [settings, rawSubscriptions, keys, rawLines] = await Promise.all([
      this.settingsService.getSettings(),
      this.prisma.subscription.findMany({ where: { status: { in: ['ACTIVE', 'CANCELED'] } }, include: subscriptionInclude }),
      this.prisma.proxyKey.findMany({ where: { isActive: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      this.prisma.line.findMany({
        where: { proxyPoolEnabled: true, status: 'ACTIVE', protocolType: 'MIXED', OR: [{ type: 'DIRECT' }, { type: 'RELAY', relayMode: 'UPSTREAM_NODE' }] },
        include: lineInclude, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
      })
    ]);
    const now = new Date();
    const subscriptions = new Map<string, PoolSubscription>();
    for (const raw of rawSubscriptions) {
      const sub = applyPlanSnapshot(raw);
      if (this.isEligible(sub, settings.enforceEmailVerification, now)) subscriptions.set(sub.user.id, sub);
    }
    const lines = settings.publicLinesEnabled === true ? rawLines.filter((line) => this.isCandidate(line, now)) : [];
    const endpoints = lines.map((line) => this.toEndpoint(line));
    const capacities = new Map<string, ProxyPoolNodeCapacity>();
    for (const endpoint of endpoints) {
      capacities.set(endpoint.nodeId, capacities.get(endpoint.nodeId) ?? { nodeId: endpoint.nodeId, nodeName: endpoint.nodeName, used: 0, limit: PROXY_POOL_NODE_BINDING_LIMIT, excluded: 0 });
    }
    const snapshot: ProxyPoolAccessSnapshot = {
      eligibleUserIds: new Set(subscriptions.keys()), endpoints, endpointsByKey: new Map(), bindingsByNode: new Map(), nodeCapacities: []
    };
    for (const key of keys) {
      const sub = subscriptions.get(key.userId);
      if (!sub || !key.isActive) continue;
      let whitelistIps: string[];
      try { whitelistIps = parseWhitelistIps(normalizeWhitelistIps(key.whitelistIps)); } catch { continue; }
      const authorized: ProxyPoolEndpoint[] = [];
      const extraIds = sub.user.extraLineGrants.map((grant) => grant.lineId);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!isLineAuthorized(sub.plan, line, extraIds)) continue;
        let username: string;
        try { username = formatProxyLineUsername(key.username, line.id); } catch { continue; }
        const endpoint = endpoints[index];
        const capacity = capacities.get(endpoint.nodeId)!;
        if (capacity.used >= capacity.limit) {
          capacity.excluded += 1;
          authorized.push({ ...endpoint, status: 'CAPACITY_EXCLUDED', reason: 'PROXY_POOL_NODE_CAPACITY_EXCEEDED' });
          continue;
        }
        capacity.used += 1;
        authorized.push(endpoint);
        const bindings = snapshot.bindingsByNode.get(endpoint.nodeId) ?? [];
        bindings.push({ lineId: line.id, keyId: key.id, userId: key.userId, username, password: key.password, whitelistIps });
        snapshot.bindingsByNode.set(endpoint.nodeId, bindings);
      }
      snapshot.endpointsByKey.set(key.id, authorized);
    }
    snapshot.nodeCapacities = [...capacities.values()];
    return snapshot;
  }

  private isEligible(sub: PoolSubscription, enforceEmail: boolean, now: Date): boolean {
    return Boolean(sub.plan && ['ALL', 'TAGS', 'EXPLICIT'].includes(sub.plan.lineMatchMode)
      && ['ACTIVE', 'CANCELED'].includes(sub.status) && sub.user.isActive
      && (!enforceEmail || sub.user.emailVerifiedAt || sub.user.role === 'ADMIN')
      && sub.trafficLimitBytes > sub.trafficUsedBytes && (!sub.expireAt || sub.expireAt > now));
  }

  private isCandidate(line: PoolLine, now: Date): boolean {
    if (!line.proxyPoolEnabled || line.status !== 'ACTIVE' || line.protocolType !== 'MIXED'
      || !line.entryNode || line.entryNode.status === 'DISABLED' || line.entryNode.reachability === 'NAT'
      || !Number.isInteger(line.entryPort) || !line.entryPort || line.entryPort < 1 || line.entryPort > 65535) return false;
    const params = this.params(line.paramsJson);
    if (!params) return false;
    const host = line.endpointOverrideEnabled && line.serverHost ? line.serverHost : line.entryNode.serverHost;
    const port = line.endpointOverrideEnabled && line.serverPort ? line.serverPort : line.entryPort;
    if (!host || /[\s/@?#%\\]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return false;
    // DIRECT Mixed 入站由 Agent 强制鉴权；只有中继要求显式开启逐用户鉴权。
    if (line.type === 'DIRECT') return true;
    if (line.type !== 'RELAY' || line.relayMode !== 'UPSTREAM_NODE' || params.usersEnabled !== true || params.users_enabled === false || !line.upstreamNode) return false;
    try {
      return !getUpstreamUnavailableReason(line.upstreamNode, now) && getProxyCapabilities(readUpstreamRelayConnection(line, line.upstreamNode)).singbox.supported;
    } catch { return false; }
  }

  private params(json: string): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(json);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch { return null; }
  }

  private toEndpoint(line: PoolLine): ProxyPoolEndpoint {
    const node = line.entryNode!;
    const params = this.params(line.paramsJson)!;
    const tlsParams = params.tls && typeof params.tls === 'object' ? params.tls as Record<string, unknown> : {};
    const tls = Boolean(line.certificateId) || tlsParams.enabled === true
      || (tlsParams.enabled !== false && ['tls', 'acme'].includes(String(tlsParams.mode)));
    const host = line.endpointOverrideEnabled && line.serverHost ? line.serverHost : node.serverHost;
    const tags = parseStringArray(line.tagsJson);
    const lastProbe = readLastProbe(line.lastProbeJson, true, lineProbeVersion(line));
    return {
      lineId: line.id, name: line.name, region: tags.find((tag) => /^[A-Z]{2,3}$/.test(tag)) ?? null, tags,
      protocol: 'MIXED', host, port: (line.endpointOverrideEnabled && line.serverPort ? line.serverPort : line.entryPort)!,
      nodeId: node.id, nodeName: node.name, nodeStatus: node.status, online: node.status === 'ONLINE',
      routeKind: line.type === 'DIRECT' ? 'DIRECT' : 'UPSTREAM_RELAY', lineType: line.type === 'DIRECT' ? 'DIRECT' : 'RELAY',
      status: 'AVAILABLE', reason: null, tls,
      serverName: line.serverName || (typeof tlsParams.serverName === 'string' ? tlsParams.serverName : host),
      supportedProtocols: tls ? ['http'] : ['http', 'socks5'], trafficRate: line.trafficRate,
      lastProbe, latencyMs: lastProbe?.latencyMs ?? null,
      lastTestedAt: lastProbe?.testedAt ?? null, lastTestStatus: lastProbe?.status ?? null
    };
  }
}
