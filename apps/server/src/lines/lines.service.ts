import { assertEgressNotLoop, assertEgressOverride, canConfigureEgress, readEgressProxy, safeEgressProxy, saveEgressProxy, type EgressProxyInput } from '../common/line-egress';
import { getUpstreamUnavailableReason, readUpstreamConnection, isMeteredUpstreamEntry } from '../common/upstream-availability';
import type { SubLine } from '../subscription/builders';
import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AgentService } from '../agent-gateway/agent.service';
import { normalizeInboundParams, protectInboundSecrets, sanitizeInboundParams, revealInboundSecrets } from '../common/inbound';
import {
  LINE_TYPES,
  PROTOCOL_TYPES,
  PROTOCOL_PROXY_TARGET_TYPES,
  RELAY_MODES,
  LineStatus,
  LineType,
  ProtocolType,
  RelayMode
} from '../common/constants';
import { DEFAULT_INBOUND_LISTEN, findAvailableRandomPort } from '../common/ports';
import { resolveLineTags } from '../common/line-tags';
import { generateAgentToken } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';
import { BatchLineStatusDto } from './dto/batch-line-status.dto';
import { CreateLineDto } from './dto/create-line.dto';
import { QueryLineDto } from './dto/query-line.dto';
import { ReorderLinesDto } from './dto/reorder-lines.dto';
import { UpdateLineDto } from './dto/update-line.dto';
import { SettingsService } from '../system/settings.service';
import { isLineAuthorized } from '../common/line-access';
import { readLastProbe, safeProbeResult } from '../probe/probe-result';
import { lineProbeVersion } from '../probe/probe-resource.service';
import type { ProbeResult } from '../probe/probe.types';
import { buildUpstreamOutbound } from '../common/upstream-connection';
import { readUpstreamRelayConnection } from '../common/upstream-relay-connection';

const nodeSummary = { select: { id: true, name: true, serverHost: true, status: true, isLocal: true, reachability: true, configOverride: true } } as const;
const certificateSummary = {
  select: { id: true, name: true, subject: true, issuer: true, sansJson: true, validFrom: true, validTo: true, updatedAt: true }
} as const;
const targetLineSummary = {
  select: {
    id: true,
    updatedAt: true,
    paramsJson: true,
    egressProxyJson: true,
    name: true,
    type: true,
    protocolType: true,
    status: true,
    entryNodeId: true,
    entryPort: true,
    landingNodeId: true,
    landingPort: true,
    endpointOverrideEnabled: true,
    serverHost: true,
    serverPort: true,
    serverName: true,
    host: true,
    certificate: { select: { id: true, updatedAt: true } },
    entryNode: nodeSummary
  }
} as const;
const upstreamNodeSummary = {
  select: {
    id: true,
    name: true,
    protocolType: true,
    serverHost: true,
    serverPort: true,
    status: true,
    latencyMs: true,
    lastTestStatus: true,
    subscriptionId: true,
    configHash: true,
    connectionHash: true,
    paramsJson: true,
    presenceStatus: true,
    subscription: { select: { id: true, name: true, status: true, updatedAt: true, userInfoUsedBytes: true, userInfoTotalBytes: true, userInfoExpireAt: true } }
  }
} as const;
const lineInclude = { entryNode: nodeSummary, landingNode: nodeSummary, targetLine: targetLineSummary, certificate: certificateSummary, upstreamNode: upstreamNodeSummary } as const;
type LineWithRelations = Prisma.LineGetPayload<{ include: typeof lineInclude }>;

type LineInput = {
  name?: string;
  tag?: string | null;
  listen?: string;
  type?: LineType;
  protocolType?: ProtocolType;
  params?: Record<string, unknown>;
  egressProxy?: EgressProxyInput | null;
  relayMode?: RelayMode | null;
  entryNodeId?: string | null;
  entryPort?: number | null;
  landingNodeId?: string | null;
  landingPort?: number | null;
  targetLineId?: string | null;
  upstreamNodeId?: string | null;
  certificateId?: string | null;
  endpointOverrideEnabled?: boolean;
  serverHost?: string | null;
  serverPort?: number | null;
  serverName?: string | null;
  host?: string | null;
  landingEndpointOverrideEnabled?: boolean;
  landingServerHost?: string | null;
  landingServerPort?: number | null;
  trafficRate?: number;
  tags?: string[];
  level?: number;
  sortOrder?: number;
  isPublic?: boolean;
  proxyPoolEnabled?: boolean;
  status?: LineStatus;
  allowLanAccess?: boolean;
  tunnelType?: string | null;
  tunnelPort?: number | null;
  tunnelSecret?: string | null;
  speedLimitMbps?: number | null;
  tcpFastOpen?: boolean;
  tcpMultiPath?: boolean;
  udpFragment?: boolean | null;
  udpTimeout?: string | null;
  proxyProtocol?: boolean;
  proxyProtocolAcceptNoHeader?: boolean;
};

type PortTransportUsage = { tcp: boolean; udp: boolean };
type PortEndpointContext = {
  role?: 'entry' | 'landing';
  type?: LineType;
  relayMode?: RelayMode | null;
  params?: Record<string, unknown>;
};

const UDP_ONLY_PROTOCOLS = new Set<ProtocolType>(['HYSTERIA2', 'TUIC']);
const DUAL_STACK_PROTOCOLS = new Set<ProtocolType>(['SHADOWSOCKS', 'DIRECT']);

@Injectable()
export class LinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentGateway: AgentService,
    @Optional() private readonly settingsService?: SettingsService
  ) {}

  async list(query: QueryLineDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where: Prisma.LineWhereInput = {
      ...(query.search ? { OR: [{ name: { contains: query.search } }, { serverHost: { contains: query.search } }] } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.isPublic !== undefined ? { isPublic: query.isPublic } : {})
    };
    const rows = await this.prisma.line.findMany({
      where,
      include: lineInclude,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
    });
    const filtered = query.tag ? rows.filter((line) => this.parseTags(line.tagsJson).includes(query.tag!.trim())) : rows;
    const data = filtered.slice((page - 1) * pageSize, page * pageSize).map((line) => this.toView(line));
    return { data, total: filtered.length, page, pageSize };
  }

  async detail(id: string) {
    return { line: this.toView(await this.findRaw(id)) };
  }

  async create(dto: CreateLineDto) {
    const prepared = await this.prepare(dto);
    const line = await this.prisma.line.create({ data: prepared as Prisma.LineUncheckedCreateInput, include: lineInclude });
    void this.agentGateway.pushConfigToAll();
    return { line: this.toView(line) };
  }

  async update(id: string, dto: UpdateLineDto) {
    const current = await this.findRaw(id);
    const prepared = await this.prepare(dto, current);
    const line = await this.prisma.line.update({ where: { id }, data: { ...prepared as Prisma.LineUncheckedUpdateInput, lastProbeJson: null, lastLatencyMs: null, lastTestedAt: null, lastTestStatus: null, lastTestMessage: null }, include: lineInclude });
    void this.agentGateway.pushConfigToAll();
    return { line: this.toView(line) };
  }

  async remove(id: string) {
    await this.findRaw(id);
    const referencingLine = await this.prisma.line.findFirst({ where: { targetLineId: id }, select: { id: true } });
    if (referencingLine) {
      throw new BadRequestException('该线路正被其他中继线路作为落地目标引用，请先解除引用后再删除');
    }
    await this.prisma.line.delete({ where: { id } });
    void this.agentGateway.pushConfigToAll();
    return { deleted: true, id };
  }

  async duplicate(id: string) {
    const current = await this.findRaw(id);
    const prepared = await this.prepare({
      name: `${current.name} 副本`,
      type: current.type as LineType,
      ...(current.type === 'EXTERNAL' ? {} : { protocolType: current.protocolType as ProtocolType }),
      params: this.parseObject(current.paramsJson),
      egressProxy: readEgressProxy(current.egressProxyJson),
      certificateId: current.certificateId,
      relayMode: current.relayMode as RelayMode | null,
      entryNodeId: current.entryNodeId,
      landingNodeId: current.landingNodeId,
      targetLineId: current.targetLineId,
      upstreamNodeId: current.upstreamNodeId,
      endpointOverrideEnabled: current.endpointOverrideEnabled,
      serverHost: current.serverHost,
      serverPort: current.serverPort,
      serverName: current.serverName,
      host: current.host,
      landingEndpointOverrideEnabled: current.landingEndpointOverrideEnabled,
      landingServerHost: current.landingServerHost,
      landingServerPort: current.landingServerPort,
      tags: this.parseTags(current.tagsJson),
      trafficRate: current.trafficRate,
      level: current.level,
      sortOrder: current.sortOrder + 1,
      isPublic: current.isPublic,
      proxyPoolEnabled: current.proxyPoolEnabled,
      status: 'DISABLED'
    });
    const line = await this.prisma.line.create({ data: prepared as Prisma.LineUncheckedCreateInput, include: lineInclude });
    void this.agentGateway.pushConfigToAll();
    return { line: this.toView(line) };
  }

  async batchStatus(dto: BatchLineStatusDto) {
    if (dto.status === 'ACTIVE') {
      for (const id of dto.ids) {
        const line = await this.findRaw(id);
        await this.validateEgress(line.egressProxyJson, line);
        if (line.type === 'EXTERNAL') await this.assertUpstreamAvailable(line.upstreamNodeId);
        if (line.relayMode === 'UPSTREAM_NODE') {
          const upstream = await this.assertUpstreamAvailable(line.upstreamNodeId);
          try { buildUpstreamOutbound(readUpstreamRelayConnection(line, upstream), 'validate-agent'); } catch { throw new BadRequestException('上游节点或落地覆盖不支持 Sing-box 中继出站'); }
        }
        if (line.relayMode === 'UPSTREAM_NODE' && !isMeteredUpstreamEntry(line.protocolType, this.parseObject(line.paramsJson))) throw new BadRequestException('上游中继入口必须支持用户鉴权与流量归属');
        if (line.proxyPoolEnabled) this.assertProxyPoolConfiguration(line.type, line.protocolType, line.relayMode, this.parseObject(line.paramsJson));
      }
    }
    const result = await this.prisma.line.updateMany({ where: { id: { in: dto.ids } }, data: { status: dto.status, lastProbeJson: null, lastLatencyMs: null, lastTestStatus: null, lastTestMessage: null, lastTestedAt: null } });
    void this.agentGateway.pushConfigToAll();
    return { updated: result.count, status: dto.status };
  }

  async reorder(dto: ReorderLinesDto) {
    await this.prisma.$transaction(
      dto.items.map((item) => this.prisma.line.update({ where: { id: item.id }, data: { sortOrder: item.sortOrder } }))
    );
    void this.agentGateway.pushConfigToAll();
    return { updated: dto.items.length };
  }

  async testResolve(id: string) {
    const line = await this.findRaw(id);
    const view = this.toView(line);
    return {
      line: view,
      endpoint: { serverHost: view.serverHost, serverPort: view.serverPort, serverName: view.serverName, host: view.host },
      entry: line.entryNode ? { nodeId: line.entryNodeId, nodeName: line.entryNode.name, port: line.entryPort } : null,
      landing: view.topology.landing?.node
        ? {
            nodeId: view.topology.landing.node.id,
            nodeName: view.topology.landing.node.name,
            host: view.topology.landing.host,
            port: view.topology.landing.port
          }
        : null
    };
  }

  async getAvailableForPlan(
    plan: { lineMatchMode: string; lineTagsJson: string; lineIdsJson: string },
    extraLineIds: string[] = []
  ) {
    const settings = await this.settingsService?.getSettings();
    if (settings?.publicLinesEnabled === false) return [];
    const extraIds = [...new Set(extraLineIds)];
    const rows = await this.prisma.line.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { isPublic: true },
          ...(extraIds.length ? [{ id: { in: extraIds } }] : [])
        ]
      },
      include: lineInclude,
      orderBy: [{ sortOrder: 'asc' }, { level: 'desc' }, { createdAt: 'asc' }]
    });
    return rows
      .filter((line) => line.status === undefined || line.status === 'ACTIVE')
      .filter((line) => line.relayMode !== 'TARGET_LINE' || line.targetLine?.status === 'ACTIVE')
      .filter((line) => isLineAuthorized(plan, line, extraIds))
      .filter((line) => (line.type !== 'EXTERNAL' && line.relayMode !== 'UPSTREAM_NODE') || (line.upstreamNode && !getUpstreamUnavailableReason(line.upstreamNode)))
      .filter((line) => line.relayMode !== 'UPSTREAM_NODE' || isMeteredUpstreamEntry(line.protocolType, this.parseObject(line.paramsJson)))
      .map((line) => {
        const view = this.toView(line);
        return {
          id: view.id, name: view.name, type: view.type, status: view.status, isPublic: view.isPublic,
          protocolType: view.protocolType, relayMode: view.relayMode, params: view.params,
          serverHost: view.serverHost, serverPort: view.serverPort, serverName: view.serverName, host: view.host,
          endpointOverrideEnabled: view.endpointOverrideEnabled, endpointOverrides: view.endpointOverrides,
          trafficRate: view.trafficRate, speedLimitMbps: view.speedLimitMbps, tags: view.tags, level: view.level,
          lastProbe: view.lastProbe,
          ...(line.type === 'EXTERNAL' && line.upstreamNode ? { externalConnection: readUpstreamConnection(line.upstreamNode) } : {})
        };
      });
  }

  toUserSummary(line: Pick<SubLine, 'id' | 'name' | 'type' | 'protocolType' | 'serverHost' | 'serverPort' | 'tags' | 'level' | 'trafficRate' | 'speedLimitMbps'> & { status?: string; lastProbe?: ProbeResult | null }) {
    const external = line.type === 'EXTERNAL';
    const lastProbe = safeProbeResult(line.lastProbe);
    return {
      id: line.id, name: line.name, type: line.type, protocolType: line.protocolType,
      serverHost: line.serverHost, serverPort: line.serverPort, status: line.status,
      lastProbe: lastProbe?.measurement === 'MIHOMO_URL_TEST' ? lastProbe : null,
      tags: line.tags ?? [], level: line.level,
      trafficRate: external ? 0 : line.trafficRate,
      speedLimitMbps: external ? null : line.speedLimitMbps,
      capabilities: { trafficMetered: !external, localLimitsSupported: !external, credentialRevocable: !external },
      topology: { entry: null, landing: null }
    };
  }

  private async assertUpstreamAvailable(id: string | null | undefined) {
    if (!id) throw new BadRequestException('必须指定上游节点');
    const node = await this.prisma.upstreamNode.findUnique({ where: { id }, include: { subscription: true } });
    if (!node) throw new NotFoundException('上游节点不存在');
    const reason = getUpstreamUnavailableReason(node);
    if (reason) throw new BadRequestException(reason);
    return node;
  }

  private async prepareExternal(input: LineInput, current?: LineWithRelations): Promise<Prisma.LineUncheckedCreateInput> {
    if (input.egressProxy != null) throw new BadRequestException('EXTERNAL 不支持最终代理出站');
    const nullable = ['entryNodeId', 'entryPort', 'landingNodeId', 'landingPort', 'targetLineId', 'relayMode', 'certificateId', 'serverHost', 'serverPort', 'serverName', 'host', 'landingServerHost', 'landingServerPort', 'tunnelType', 'tunnelPort', 'tunnelSecret', 'udpTimeout'] as const;
    for (const key of nullable) if (input[key] !== undefined && input[key] !== null && input[key] !== '') throw new BadRequestException(`EXTERNAL 不支持 ${key}`);
    const toggles = ['proxyPoolEnabled', 'endpointOverrideEnabled', 'landingEndpointOverrideEnabled', 'allowLanAccess', 'tcpFastOpen', 'tcpMultiPath', 'udpFragment', 'proxyProtocol', 'proxyProtocolAcceptNoHeader'] as const;
    for (const key of toggles) if (input[key] === true) throw new BadRequestException(`EXTERNAL 不支持 ${key}`);
    if ((input.params && Object.keys(input.params).length) || (input.listen && input.listen !== DEFAULT_INBOUND_LISTEN) || (input.speedLimitMbps && input.speedLimitMbps !== 0) || (input.trafficRate !== undefined && input.trafficRate !== 1)) throw new BadRequestException('EXTERNAL 不支持本地协议、监听或限速参数');
    const upstreamNodeId = input.upstreamNodeId !== undefined ? input.upstreamNodeId : current?.upstreamNodeId;
    const node = await this.assertUpstreamAvailable(upstreamNodeId);
    if (current && current.type !== 'EXTERNAL') throw new BadRequestException('请新建 EXTERNAL 线路，不允许隐式转换本地入口');
    if (input.protocolType && input.protocolType !== node.protocolType) throw new BadRequestException('EXTERNAL 协议由上游节点决定');
    const name = (input.name ?? current?.name)?.trim();
    if (!name) throw new BadRequestException('线路名称不能为空');
    return {
      name, type: 'EXTERNAL', upstreamNodeId: node.id, protocolType: node.protocolType,
      paramsJson: '{}', entryNodeId: null, entryPort: null, landingNodeId: null, landingPort: null,
      egressProxyJson: null,
      targetLineId: null, relayMode: null, certificateId: null, listen: DEFAULT_INBOUND_LISTEN,
      tag: input.tag !== undefined ? input.tag?.trim() || null : current?.tag ?? null,
      tagsJson: input.tags ? JSON.stringify(input.tags.map((tag) => tag.trim()).filter(Boolean)) : current?.tagsJson ?? '[]',
      sortOrder: input.sortOrder ?? current?.sortOrder ?? 0, level: input.level ?? current?.level ?? 0,
      isPublic: input.isPublic ?? current?.isPublic ?? false, status: input.status ?? current?.status ?? 'DISABLED',
      proxyPoolEnabled: false,
      trafficRate: 1, speedLimitMbps: 0, endpointOverrideEnabled: false, landingEndpointOverrideEnabled: false,
      serverHost: null, serverPort: null, serverName: null, host: null, landingServerHost: null, landingServerPort: null,
      allowLanAccess: false, tunnelType: null, tunnelPort: null, tunnelSecret: null,
      tcpFastOpen: false, tcpMultiPath: false, udpFragment: null, udpTimeout: null, proxyProtocol: false, proxyProtocolAcceptNoHeader: false
    };
  }

  private async findRaw(id: string): Promise<LineWithRelations> {
    const line = await this.prisma.line.findUnique({ where: { id }, include: lineInclude });
    if (!line) throw new NotFoundException('线路不存在');
    return line;
  }

  private async prepare(input: LineInput, current?: LineWithRelations): Promise<Prisma.LineUncheckedCreateInput | Prisma.LineUncheckedUpdateInput> {
    const type = input.type ?? (current?.type as LineType | undefined) ?? 'DIRECT';
    if (!LINE_TYPES.includes(type)) throw new BadRequestException('线路类型无效');
    if (type === 'EXTERNAL') return this.prepareExternal(input, current);
    if (current?.type === 'EXTERNAL') throw new BadRequestException('请新建本地线路，不允许隐式转换 EXTERNAL');

    const protocolType = input.protocolType ?? (current?.protocolType as ProtocolType | undefined) ?? 'VLESS';
    if (!PROTOCOL_TYPES.includes(protocolType)) throw new BadRequestException('线路协议无效');
    const existingParams = current ? this.sanitizeCorruptParams(revealInboundSecrets(this.parseObject(current.paramsJson))) : {};
    const certificateId = input.certificateId !== undefined ? input.certificateId : current?.certificateId ?? null;
    const certificate = certificateId
      ? await this.prisma.certificate.findUnique({ where: { id: certificateId } })
      : null;
    if (certificateId && !certificate) throw new NotFoundException('证书不存在');
    const targetParams = this.mergeParamsWithSecrets(input.params, existingParams, protocolType);
    if (certificate) {
      targetParams.tls = {
        ...this.parseObjectValue(targetParams.tls),
        certificate: [certificate.certificatePem],
        key: [certificate.privateKeyPem]
      };
    }
    const params = protectInboundSecrets(normalizeInboundParams(protocolType, targetParams));
    if (certificateId && (params.tls as { mode?: string } | undefined)?.mode !== 'tls') {
      throw new BadRequestException('证书只能关联标准 TLS 安全模式');
    }
    if (certificateId && params.tls && typeof params.tls === 'object') {
      delete (params.tls as Record<string, unknown>).certificate;
      delete (params.tls as Record<string, unknown>).key;
    }

    const relayMode = type === 'RELAY' ? (input.relayMode ?? current?.relayMode) as RelayMode | null : null;
    if (type === 'RELAY' && (!relayMode || !RELAY_MODES.includes(relayMode))) {
      throw new BadRequestException('中继线路必须指定有效的中继机制');
    }
    const proxyPoolEnabled = input.proxyPoolEnabled ?? current?.proxyPoolEnabled ?? false;
    if (proxyPoolEnabled) this.assertProxyPoolConfiguration(type, protocolType, relayMode, params);
    if (type === 'RELAY' && relayMode === 'PROTOCOL_PROXY' && protocolType === 'SHADOWTLS') {
      throw new BadRequestException('ShadowTLS 仅支持直连或盲转发，不支持协议代理中继');
    }

    const entryNodeId = input.entryNodeId !== undefined ? input.entryNodeId : current?.entryNodeId;
    if (!entryNodeId) throw new BadRequestException('必须指定入口节点');

    let landingNodeId: string | null = null;
    let landingPort: number | null = null;
    let targetLineId: string | null = null;
    let targetLine: { id: string; type: string; protocolType: string; entryNodeId: string | null; entryPort: number | null } | null = null;
    let upstreamNodeId: string | null = null;

    if (type === 'DIRECT') {
      landingNodeId = null;
      landingPort = null;
      targetLineId = null;
      upstreamNodeId = null;
    } else if (type === 'RELAY') {
      if (relayMode === 'UPSTREAM_NODE') {
        upstreamNodeId = input.upstreamNodeId !== undefined ? input.upstreamNodeId : current?.upstreamNodeId ?? null;
        if (!upstreamNodeId) throw new BadRequestException('上游节点中继线路必须指定上游节点');
        const upstream = await this.assertUpstreamAvailable(upstreamNodeId);
        try { buildUpstreamOutbound(readUpstreamRelayConnection({ landingEndpointOverrideEnabled: input.landingEndpointOverrideEnabled ?? current?.landingEndpointOverrideEnabled, landingServerHost: input.landingServerHost !== undefined ? input.landingServerHost : current?.landingServerHost, landingServerPort: input.landingServerPort !== undefined ? input.landingServerPort : current?.landingServerPort }, upstream), 'validate-agent'); } catch { throw new BadRequestException('上游节点或落地覆盖不支持 Sing-box 中继出站'); }
        if (!isMeteredUpstreamEntry(protocolType, params)) throw new BadRequestException('上游中继入口必须支持用户鉴权与流量归属');
        landingNodeId = null;
        landingPort = null;
        targetLineId = null;
      } else if (relayMode === 'TARGET_LINE') {
        targetLineId = input.targetLineId !== undefined ? input.targetLineId : current?.targetLineId ?? null;
        if (!targetLineId) throw new BadRequestException('桥接中继线路必须指定目标线路');
        targetLine = await this.prisma.line.findUnique({
          where: { id: targetLineId },
          select: { id: true, type: true, protocolType: true, entryNodeId: true, entryPort: true }
        });
        if (!targetLine) throw new NotFoundException('目标线路不存在');
        if (targetLine.type !== 'DIRECT') throw new BadRequestException('桥接目标必须是直连线路');
        if (!PROTOCOL_PROXY_TARGET_TYPES.includes(targetLine.protocolType as (typeof PROTOCOL_PROXY_TARGET_TYPES)[number])) {
          throw new BadRequestException('目标线路协议不支持作为桥接出口');
        }
        if (targetLine.entryNodeId === entryNodeId) throw new BadRequestException('桥接目标必须位于其他节点');
        landingNodeId = null;
        landingPort = null;
        upstreamNodeId = null;
      } else {
        landingNodeId = input.landingNodeId !== undefined ? input.landingNodeId : current?.landingNodeId ?? null;
        if (!landingNodeId) throw new BadRequestException('中继线路必须指定落地节点');
        upstreamNodeId = null;
      }
    }

    const [entryNode, landingNode] = await Promise.all([
      this.prisma.node.findUnique({ where: { id: entryNodeId } }),
      landingNodeId ? this.prisma.node.findUnique({ where: { id: landingNodeId } }) : Promise.resolve(null)
    ]);
    if (!entryNode) throw new NotFoundException('入口节点不存在');
    if (landingNodeId && !landingNode) throw new NotFoundException('落地节点不存在');

    if (entryNode.reachability === 'NAT') {
      if (type === 'DIRECT') {
        throw new BadRequestException('NAT 节点（无公网 IP）不支持作为直连线路节点，仅支持作为中继落地节点');
      }
      throw new BadRequestException('NAT 节点（无公网 IP）不支持作为中继入口节点，仅支持作为中继落地节点');
    }

    let tunnelType: string | null = null;
    let tunnelPort: number | null = null;
    let tunnelSecret: string | null = null;

    if (type === 'RELAY' && landingNode?.reachability === 'NAT') {
      if (relayMode === 'TARGET_LINE') {
        throw new BadRequestException('NAT 落地节点不支持桥接目标线路');
      }
      tunnelType = input.tunnelType ?? current?.tunnelType ?? 'TCP_MUX';
      const existingTunnelLine = await this.prisma.line.findFirst({
        where: {
          entryNodeId,
          landingNodeId,
          tunnelPort: { not: null },
          ...(current?.id ? { id: { not: current.id } } : {})
        },
        select: { tunnelPort: true, tunnelSecret: true, tunnelType: true }
      });

      if (existingTunnelLine?.tunnelPort && existingTunnelLine?.tunnelSecret) {
        tunnelPort = input.tunnelPort ?? existingTunnelLine.tunnelPort;
        tunnelSecret = input.tunnelSecret ?? existingTunnelLine.tunnelSecret;
        tunnelType = existingTunnelLine.tunnelType ?? tunnelType;
      } else {
        tunnelPort = input.tunnelPort !== undefined && input.tunnelPort !== null
          ? input.tunnelPort
          : current?.tunnelPort ?? await this.findAvailablePort(entryNodeId, 'VLESS', current?.id);
        tunnelSecret = input.tunnelSecret ?? current?.tunnelSecret ?? generateAgentToken();
      }
    }
    const allowLanAccess = input.allowLanAccess !== undefined ? Boolean(input.allowLanAccess) : current?.allowLanAccess ?? false;

    const entryPortContext: PortEndpointContext = { role: 'entry', type, relayMode, params };
    const landingPortContext: PortEndpointContext = { role: 'landing', type, relayMode, params };
    const entryPort = input.entryPort !== undefined && input.entryPort !== null
      ? input.entryPort
      : current?.entryPort ?? await this.findAvailablePort(entryNodeId, protocolType, current?.id, entryPortContext);

    if (type === 'RELAY' && relayMode !== 'TARGET_LINE' && landingNodeId) {
      const requestedLandingPort = input.landingPort !== undefined && input.landingPort !== null ? input.landingPort : current?.landingPort;
      landingPort = requestedLandingPort ?? await this.findAvailablePort(landingNodeId, protocolType, current?.id, landingPortContext);
      if (entryNodeId === landingNodeId && entryPort === landingPort) {
        throw new BadRequestException('同节点中继线路的入口与落地端口必须不同');
      }
      await this.assertPortAvailable(landingNodeId, landingPort, protocolType, current?.id, landingPortContext);
    }
    await this.assertPortAvailable(entryNodeId, entryPort, protocolType, current?.id, entryPortContext);

    const name = input.name !== undefined ? input.name.trim() : current?.name;
    if (!name) throw new BadRequestException('线路名称不能为空');
    const optionalText = (value: string | null | undefined, fallback: string | null | undefined) => {
      if (value === undefined) return fallback ?? null;
      if (value === null) return null;
      const trimmed = value.trim();
      return trimmed || null;
    };
    const tags = input.tags !== undefined
      ? input.tags.map((tag) => tag.trim()).filter(Boolean)
      : current ? this.parseTags(current.tagsJson) : [];
    const customTag = input.tag !== undefined
      ? input.tag?.trim() || null
      : current?.tag ?? null;
    const listen = input.listen !== undefined
      ? input.listen.trim()
      : current?.listen ?? DEFAULT_INBOUND_LISTEN;
    if (!listen) throw new BadRequestException('监听地址不能为空');
    await this.assertLineTagsAvailable({
      id: current?.id,
      tag: customTag,
      type,
      entryNodeId,
      landingNodeId
    });
    const egressProxyJson = saveEgressProxy(input.egressProxy, current?.egressProxyJson);
    await this.validateEgress(egressProxyJson, { id: current?.id, type, relayMode, entryNodeId, entryPort, landingNodeId, landingPort });

    return {
      name,
      tag: customTag,
      listen,
      type,
      relayMode,
      protocolType,
      paramsJson: JSON.stringify(params),
      egressProxyJson,
      entryNodeId,
      entryPort,
      landingNodeId,
      landingPort,
      targetLineId,
      upstreamNodeId,
      certificateId,
      allowLanAccess,
      tunnelType,
      tunnelPort,
      tunnelSecret,
      endpointOverrideEnabled: input.endpointOverrideEnabled ?? current?.endpointOverrideEnabled ?? false,
      serverHost: optionalText(input.serverHost, current?.serverHost),
      serverPort: input.serverPort !== undefined ? input.serverPort : current?.serverPort,
      serverName: optionalText(input.serverName, current?.serverName),
      host: optionalText(input.host, current?.host),
      landingEndpointOverrideEnabled: type === 'RELAY'
        ? Boolean(input.landingEndpointOverrideEnabled ?? current?.landingEndpointOverrideEnabled ?? false)
        : false,
      landingServerHost: type === 'RELAY'
        ? optionalText(input.landingServerHost, current?.landingServerHost)
        : null,
      landingServerPort: type === 'RELAY'
        ? (input.landingServerPort !== undefined ? input.landingServerPort : current?.landingServerPort ?? null)
        : null,
      trafficRate: input.trafficRate ?? current?.trafficRate ?? 1,
      tagsJson: JSON.stringify(tags),
      speedLimitMbps: input.speedLimitMbps !== undefined ? input.speedLimitMbps : current?.speedLimitMbps ?? 0,
      tcpFastOpen: input.tcpFastOpen ?? current?.tcpFastOpen ?? false,
      tcpMultiPath: input.tcpMultiPath ?? current?.tcpMultiPath ?? false,
      udpFragment: input.udpFragment !== undefined ? input.udpFragment : current?.udpFragment,
      udpTimeout: optionalText(input.udpTimeout, current?.udpTimeout),
      proxyProtocol: Boolean(input.proxyProtocol ?? current?.proxyProtocol ?? false),
      proxyProtocolAcceptNoHeader: Boolean(input.proxyProtocolAcceptNoHeader ?? current?.proxyProtocolAcceptNoHeader ?? false),
      level: input.level ?? current?.level ?? 0,
      sortOrder: input.sortOrder ?? current?.sortOrder ?? 0,
      isPublic: input.isPublic ?? current?.isPublic ?? true,
      proxyPoolEnabled,
      status: input.status ?? current?.status ?? 'ACTIVE'
    };
  }

  private assertProxyPoolConfiguration(type: string, protocol: string, relayMode: string | null, params: Record<string, unknown>) {
    if (protocol !== 'MIXED' || !(type === 'DIRECT' || (type === 'RELAY' && relayMode === 'UPSTREAM_NODE'))) throw new BadRequestException('代理池仅支持 MIXED 直连或上游中继，请先关闭代理池开关');
    if (type === 'RELAY' && !isMeteredUpstreamEntry(protocol, params)) throw new BadRequestException('代理池上游中继必须开启用户鉴权');
  }

  private getPortTransportUsage(protocolType: ProtocolType, context?: PortEndpointContext): PortTransportUsage {
    if (context?.role === 'entry' && context?.type === 'RELAY' && context?.relayMode === 'BLIND_FORWARD') {
      return { tcp: true, udp: true };
    }
    if (DUAL_STACK_PROTOCOLS.has(protocolType)) {
      return { tcp: true, udp: true };
    }
    if (UDP_ONLY_PROTOCOLS.has(protocolType)) {
      return { tcp: false, udp: true };
    }
    if (protocolType === 'NAIVE') {
      const network = typeof context?.params?.network === 'string' ? context.params.network.trim().toLowerCase() : 'tcp';
      if (network === 'udp' || network === 'quic') {
        return { tcp: false, udp: true };
      }
    }
    return { tcp: true, udp: false };
  }

  private getExistingRowPortUsage(
    row: {
      protocolType: string;
      type?: string | null;
      relayMode?: string | null;
      entryNodeId?: string | null;
      entryPort?: number | null;
      landingNodeId?: string | null;
      landingPort?: number | null;
      paramsJson?: string | null;
    },
    nodeId: string,
    port: number
  ): PortTransportUsage {
    const params = row.paramsJson ? this.parseObject(row.paramsJson) : undefined;
    const hasEndpointFields = row.entryNodeId !== undefined || row.landingNodeId !== undefined;
    const isEntry = !hasEndpointFields || (row.entryNodeId === nodeId && row.entryPort === port);
    const isLanding = hasEndpointFields && row.landingNodeId === nodeId && row.landingPort === port;
    const lineType = (row.type as LineType | undefined) ?? 'DIRECT';
    const relayMode = (row.relayMode as RelayMode | null | undefined) ?? null;
    const protocolType = row.protocolType as ProtocolType;
    let tcp = false;
    let udp = false;
    if (isEntry) {
      const usage = this.getPortTransportUsage(protocolType, { role: 'entry', type: lineType, relayMode, params });
      tcp = tcp || usage.tcp;
      udp = udp || usage.udp;
    }
    if (isLanding) {
      const usage = this.getPortTransportUsage(protocolType, { role: 'landing', type: lineType, relayMode, params });
      tcp = tcp || usage.tcp;
      udp = udp || usage.udp;
    }
    return { tcp, udp };
  }

  private hasPortTransportConflict(a: PortTransportUsage, b: PortTransportUsage): boolean {
    return (a.tcp && b.tcp) || (a.udp && b.udp);
  }

  private async assertPortAvailable(
    nodeId: string,
    port: number,
    protocolType: ProtocolType,
    currentId?: string,
    context?: PortEndpointContext
  ) {
    const rows = await this.prisma.line.findMany({
      where: {
        ...(currentId ? { id: { not: currentId } } : {}),
        OR: [{ entryNodeId: nodeId, entryPort: port }, { landingNodeId: nodeId, landingPort: port }]
      },
      select: {
        protocolType: true,
        type: true,
        relayMode: true,
        entryNodeId: true,
        entryPort: true,
        landingNodeId: true,
        landingPort: true,
        paramsJson: true
      }
    });
    const candidateUsage = this.getPortTransportUsage(protocolType, context);
    if (rows.some((line) => this.hasPortTransportConflict(candidateUsage, this.getExistingRowPortUsage(line, nodeId, port)))) {
      throw new ConflictException(`节点 ${nodeId} 的端口 ${port} 已被同传输层线路占用`);
    }
  }

  private async findAvailablePort(
    nodeId: string,
    protocolType: ProtocolType,
    currentId?: string,
    context?: PortEndpointContext
  ) {
    const candidateUsage = this.getPortTransportUsage(protocolType, context);
    try {
      return await findAvailableRandomPort(async (port) => {
        const rows = await this.prisma.line.findMany({
          where: {
            ...(currentId ? { id: { not: currentId } } : {}),
            OR: [{ entryNodeId: nodeId, entryPort: port }, { landingNodeId: nodeId, landingPort: port }]
          },
          select: {
            protocolType: true,
            type: true,
            relayMode: true,
            entryNodeId: true,
            entryPort: true,
            landingNodeId: true,
            landingPort: true,
            paramsJson: true
          }
        });
        return !rows.some((line) => this.hasPortTransportConflict(candidateUsage, this.getExistingRowPortUsage(line, nodeId, port)));
      });
    } catch {
      throw new ConflictException('没有可用的随机线路端口');
    }
  }

  private async assertLineTagsAvailable(input: {
    id?: string;
    tag: string | null;
    type: LineType;
    entryNodeId: string;
    landingNodeId?: string | null;
  }) {
    if (!input.tag) return;
    const existing = await this.prisma.line.findMany({
      where: input.id ? { id: { not: input.id } } : undefined,
      select: { id: true, tag: true, type: true, entryNodeId: true, landingNodeId: true }
    });
    const candidate = resolveLineTags({ id: input.id ?? 'pending', tag: input.tag, type: input.type });
    const candidateTags = new Map<string, string>();
    if (candidate.direct) candidateTags.set(input.entryNodeId, candidate.direct);
    if (candidate.entry) candidateTags.set(input.entryNodeId, candidate.entry);
    if (candidate.landing && input.landingNodeId) candidateTags.set(input.landingNodeId, candidate.landing);

    for (const line of existing) {
      const tags = resolveLineTags(line);
      const existingTags = new Map<string, string>();
      if (tags.direct && line.entryNodeId) existingTags.set(line.entryNodeId, tags.direct);
      if (tags.entry && line.entryNodeId) existingTags.set(line.entryNodeId, tags.entry);
      if (tags.landing && line.landingNodeId) existingTags.set(line.landingNodeId, tags.landing);
      for (const [nodeId, tag] of candidateTags) {
        if (existingTags.get(nodeId) === tag) {
          throw new ConflictException(`节点 ${nodeId} 的线路 Tag「${tag}」已被占用`);
        }
      }
    }
  }

  private parseObject(value: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  private parseObjectValue(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private parseTags(value: string) {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  private sanitizeCorruptParams(params: Record<string, unknown>): Record<string, unknown> {
    if (params.multiplex && typeof params.multiplex === 'object' && !Array.isArray(params.multiplex)) {
      const m = params.multiplex as Record<string, unknown>;
      if (m.brutal && typeof m.brutal === 'object' && !Array.isArray(m.brutal)) {
        const b = m.brutal as Record<string, unknown>;
        const up = Number(b.upMbps ?? b.up_mbps ?? 0);
        const down = Number(b.downMbps ?? b.down_mbps ?? 0);
        if (b.enabled === true && (up <= 0 || down <= 0)) {
          delete m.brutal;
        }
      }
    }
    return params;
  }

  private mergeParamsWithSecrets(
    inputParams: Record<string, unknown> | undefined,
    existingParams: Record<string, unknown>,
    protocolType: ProtocolType
  ): Record<string, unknown> {
    if (inputParams === undefined) {
      return { ...existingParams };
    }
    const target = { ...inputParams };

    // 继承敏感密钥（若入参未提供且历史已存在）：
    // 1. Reality 场景：前端脱敏不持有私钥，若未生成新密钥则继承历史 Reality 私钥
    if (target.tls && typeof target.tls === 'object' && !Array.isArray(target.tls)) {
      const tls = target.tls as Record<string, unknown>;
      if (tls.mode === 'reality' && tls.reality && typeof tls.reality === 'object' && !Array.isArray(tls.reality)) {
        const reality = tls.reality as Record<string, unknown>;
        if (!reality.privateKey && existingParams.tls && typeof existingParams.tls === 'object') {
          const existingTls = existingParams.tls as Record<string, unknown>;
          const existingReality = existingTls.reality as Record<string, unknown> | undefined;
          if (existingReality?.privateKey) {
            reality.privateKey = existingReality.privateKey;
          }
        }
      }
    }

    // 2. ShadowTLS 场景：内层 Shadowsocks 密码继承
    if (protocolType === 'SHADOWTLS' && target.inner && typeof target.inner === 'object' && !Array.isArray(target.inner)) {
      const inner = target.inner as Record<string, unknown>;
      if (!inner.password && existingParams.inner && typeof existingParams.inner === 'object') {
        const existingInner = existingParams.inner as Record<string, unknown>;
        if (existingInner.password) {
          inner.password = existingInner.password;
        }
      }
    }

    // 3. Shadowsocks 密码继承（若未填新密码则继承旧密码）
    if (protocolType === 'SHADOWSOCKS' && !target.password && existingParams.password) {
      target.password = existingParams.password;
    }

    return target;
  }

  private async validateEgress(stored: string | null | undefined, line: { id?: string; type: string; relayMode?: string | null; entryNodeId: string | null; entryPort: number | null; landingNodeId: string | null; landingPort: number | null }) {
    if (stored == null) return;
    if (!canConfigureEgress(line.type, line.relayMode)) throw new BadRequestException('该线路模式不支持独立最终出站，请显式清除已有配置');
    const nodeId = line.type === 'DIRECT' ? line.entryNodeId : line.landingNodeId;
    const node = await this.prisma.node.findUnique({ where: { id: nodeId! } });
    if (!node) throw new NotFoundException('最终出站执行节点不存在');
    assertEgressOverride(node.configOverride, line.id);
    const rows = await this.prisma.line.findMany({ where: { OR: [{ entryNodeId: nodeId }, { landingNodeId: nodeId }] }, select: { entryNodeId: true, entryPort: true, landingNodeId: true, landingPort: true } });
    const ports = rows.flatMap(row => [row.entryNodeId === nodeId ? row.entryPort : null, row.landingNodeId === nodeId ? row.landingPort : null]);
    if (line.entryNodeId === nodeId) ports.push(line.entryPort);
    if (line.landingNodeId === nodeId) ports.push(line.landingPort);
    assertEgressNotLoop(readEgressProxy(stored)!, node.serverHost, ports);
  }

  private toView(line: LineWithRelations) {
    const external = line.type === 'EXTERNAL';
    const serverHost = external ? line.upstreamNode?.serverHost ?? '' : line.endpointOverrideEnabled && line.serverHost ? line.serverHost : line.entryNode?.serverHost ?? '';
    const serverPort = external ? line.upstreamNode?.serverPort ?? 0 : line.endpointOverrideEnabled && line.serverPort ? line.serverPort : line.entryPort ?? 0;
    const params = external ? {} : sanitizeInboundParams(this.sanitizeCorruptParams(this.parseObject(line.paramsJson)));
    const available = line.status === 'ACTIVE' && (!line.entryNode || line.entryNode.status !== 'DISABLED') && (!line.landingNode || line.landingNode.status !== 'DISABLED') && (line.relayMode !== 'TARGET_LINE' || line.targetLine?.status === 'ACTIVE') && ((!external && line.relayMode !== 'UPSTREAM_NODE') || Boolean(line.upstreamNode && !getUpstreamUnavailableReason(line.upstreamNode)));
    const lastProbe = readLastProbe(line.lastProbeJson, available, lineProbeVersion(line));
    const upstreamNode = line.upstreamNode ? { id: line.upstreamNode.id, name: line.upstreamNode.name, protocolType: line.upstreamNode.protocolType, serverHost: line.upstreamNode.serverHost, serverPort: line.upstreamNode.serverPort, status: line.upstreamNode.status, presenceStatus: line.upstreamNode.presenceStatus, subscription: { id: line.upstreamNode.subscription.id, name: line.upstreamNode.subscription.name } } : null;
    const safeNode = <T extends { configOverride?: string | null }>(node: T | null) => node ? { ...node, configOverride: undefined } : null;
    const isNatLanding = line.landingNode?.reachability === 'NAT';
    const hasLandingOverride = line.type === 'RELAY' && !isNatLanding && Boolean(line.landingEndpointOverrideEnabled && line.landingServerHost);
    const landing = line.type === 'RELAY'
      ? (line.relayMode === 'TARGET_LINE' && line.targetLine
          ? {
              node: safeNode(line.targetLine.entryNode),
              host: hasLandingOverride
                ? line.landingServerHost!
                : (line.targetLine.endpointOverrideEnabled && line.targetLine.serverHost
                    ? line.targetLine.serverHost
                    : line.targetLine.entryNode?.serverHost ?? ''),
              port: hasLandingOverride && line.landingServerPort
                ? line.landingServerPort
                : (line.targetLine.endpointOverrideEnabled && line.targetLine.serverPort
                    ? line.targetLine.serverPort
                    : line.targetLine.entryPort)
            }
          : line.relayMode === 'UPSTREAM_NODE' && line.upstreamNode
            ? {
                node: {
                  id: line.upstreamNode.id,
                  name: `[上游] ${line.upstreamNode.name}`,
                  serverHost: line.upstreamNode.serverHost,
                  status: line.upstreamNode.status,
                  isLocal: false,
                  reachability: 'PUBLIC'
                },
                host: line.upstreamNode.serverHost,
                port: line.upstreamNode.serverPort,
                upstreamSummary: upstreamNode
              }
            : line.landingNode && line.landingPort
            ? {
                node: safeNode(line.landingNode),
                host: hasLandingOverride ? line.landingServerHost! : line.landingNode.serverHost,
                port: hasLandingOverride && line.landingServerPort ? line.landingServerPort : line.landingPort
              }
            : null)
      : null;
    const { upstreamNode: _upstreamNode, egressProxyJson: _egressProxyJson, lastDebugProbeJson: _lastDebugProbeJson, ...safeLine } = line;
    const safeTarget = <T extends object>(target: T) => {
      const { lastProbeJson: _lastProbeJson, lastDebugProbeJson: _lastDebugProbeJson, ...safe } = target as T & { lastProbeJson?: string | null; lastDebugProbeJson?: string | null };
      return safe;
    };
    const source = line.relayMode === 'TARGET_LINE' ? line.targetLine : line;
    const egressProxy = safeEgressProxy(line.egressProxyJson);
    const effectiveEgress = source && (canConfigureEgress(source.type, line.relayMode === 'TARGET_LINE' ? null : line.relayMode))
      ? { sourceLineId: source.id, nodeId: source.type === 'DIRECT' ? source.entryNodeId : line.landingNodeId, inherited: line.relayMode === 'TARGET_LINE', proxy: safeEgressProxy(source.egressProxyJson) }
      : null;
    return {
      ...safeLine,
      egressProxy,
      effectiveEgress,
      entryNode: safeNode(line.entryNode),
      landingNode: safeNode(line.landingNode),
      lastProbeJson: undefined,
      lastProbe,
      targetLine: line.targetLine ? { ...safeTarget(line.targetLine), paramsJson: undefined, egressProxyJson: undefined, egressProxy: safeEgressProxy(line.targetLine.egressProxyJson), entryNode: safeNode(line.targetLine.entryNode) } : null,
      lastLatencyMs: lastProbe?.latencyMs ?? null,
      lastTestedAt: lastProbe?.testedAt ?? null,
      lastTestStatus: lastProbe?.status ?? null,
      lastTestMessage: lastProbe?.message ?? null,
      upstreamNodeId: line.upstreamNodeId ?? null,
      upstreamSummary: upstreamNode,
      protocolType: (external ? line.upstreamNode?.protocolType ?? line.protocolType : line.protocolType) as ProtocolType,
      params,
      serverHost,
      serverPort,
      serverName: line.endpointOverrideEnabled ? line.serverName : null,
      host: line.endpointOverrideEnabled ? line.host : null,
      landingEndpointOverrideEnabled: Boolean(line.landingEndpointOverrideEnabled),
      landingServerHost: line.landingEndpointOverrideEnabled ? (line.landingServerHost ?? null) : null,
      landingServerPort: line.landingEndpointOverrideEnabled ? (line.landingServerPort ?? null) : null,
      endpointOverrides: {
        serverHost: line.serverHost,
        serverPort: line.serverPort,
        serverName: line.serverName,
        host: line.host,
        landingServerHost: line.landingServerHost ?? null,
        landingServerPort: line.landingServerPort ?? null
      },
      tags: this.parseTags(line.tagsJson),
      topology: {
        entry: line.entryNode ? { node: safeNode(line.entryNode), port: line.entryPort } : null,
        landing
      },
      targetInbound: landing?.node ? {
        id: line.id,
        nodeId: landing.node.id,
        type: line.targetLine?.protocolType ?? line.protocolType,
        tag: resolveLineTags(line).landing ?? resolveLineTags(line).direct ?? `line-${line.id}`,
        listen: line.listen,
        port: landing.port,
        params,
        node: landing.node
      } : null,
      certificate: line.certificate ? {
        id: line.certificate.id,
        name: line.certificate.name,
        subject: line.certificate.subject,
        issuer: line.certificate.issuer,
        sans: this.parseTags(line.certificate.sansJson),
        validFrom: line.certificate.validFrom,
        validTo: line.certificate.validTo
      } : null,
      tagsJson: undefined,
      paramsJson: undefined
    };
  }
}
