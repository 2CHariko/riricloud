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

const nodeSummary = { select: { id: true, name: true, serverHost: true, status: true, isLocal: true, reachability: true } } as const;
const certificateSummary = {
  select: { id: true, name: true, subject: true, issuer: true, sansJson: true, validFrom: true, validTo: true }
} as const;
const targetLineSummary = {
  select: {
    id: true,
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
    entryNode: nodeSummary
  }
} as const;
const upstreamEntrySummary = {
  select: { id: true, name: true, protocolType: true, server: true, port: true, available: true }
} as const;
const egressLineSummary = {
  select: {
    id: true,
    name: true,
    status: true,
    type: true,
    protocolType: true,
    upstreamEntryId: true,
    upstreamEntry: upstreamEntrySummary,
    // 健康门判定需要最近一次探测结果与时间
    lastTestStatus: true,
    lastTestedAt: true,
    lastLatencyMs: true
  }
} as const;
const lineInclude = {
  entryNode: nodeSummary,
  landingNode: nodeSummary,
  targetLine: targetLineSummary,
  certificate: certificateSummary,
  upstreamEntry: upstreamEntrySummary,
  egressLine: egressLineSummary
} as const;
type LineWithRelations = Prisma.LineGetPayload<{ include: typeof lineInclude }>;

type LineInput = {
  name?: string;
  tag?: string | null;
  listen?: string;
  type?: LineType;
  protocolType?: ProtocolType;
  params?: Record<string, unknown>;
  relayMode?: RelayMode | null;
  entryNodeId?: string | null;
  entryPort?: number | null;
  landingNodeId?: string | null;
  landingPort?: number | null;
  targetLineId?: string | null;
  certificateId?: string | null;
  egressLineId?: string | null;
  upstreamHealthGate?: boolean;
  upstreamHealthMaxAgeSecs?: number | null;
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

const UDP_PROTOCOLS = new Set<ProtocolType>(['HYSTERIA2', 'TUIC']);
// 本地代理入站协议：由 Sing-box mixed/socks/http 承载，无法承载 UDP 语义
const LAND_PROXY_PROTOCOLS = new Set<ProtocolType>(['MIXED', 'SOCKS', 'HTTP']);

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
    const line = await this.prisma.line.update({ where: { id }, data: prepared as Prisma.LineUncheckedUpdateInput, include: lineInclude });
    void this.agentGateway.pushConfigToAll();
    return { line: this.toView(line) };
  }

  async remove(id: string) {
    const current = await this.findRaw(id);
    const referencingLine = await this.prisma.line.findFirst({ where: { targetLineId: id }, select: { id: true } });
    if (referencingLine) {
      throw new BadRequestException('该线路正被其他中继线路作为落地目标引用，请先解除引用后再删除');
    }
    // 上游出口线路被引用时数据库外键为 Restrict，不先拦截会抛出难以理解的 Prisma 错误
    if (current.upstreamEntryId) {
      const egressDependent = await this.prisma.line.findFirst({
        where: { egressLineId: id },
        select: { id: true, name: true }
      });
      if (egressDependent) {
        throw new BadRequestException(`该上游出口线路正被线路「${egressDependent.name}」引用，请先解除出口绑定后再删除`);
      }
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
      protocolType: current.protocolType as ProtocolType,
      params: this.parseObject(current.paramsJson),
      certificateId: current.certificateId,
      relayMode: current.relayMode as RelayMode | null,
      entryNodeId: current.entryNodeId,
      landingNodeId: current.landingNodeId,
      targetLineId: current.targetLineId,
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
      status: 'DISABLED'
    });
    const line = await this.prisma.line.create({ data: prepared as Prisma.LineUncheckedCreateInput, include: lineInclude });
    void this.agentGateway.pushConfigToAll();
    return { line: this.toView(line) };
  }

  async batchStatus(dto: BatchLineStatusDto) {
    const result = await this.prisma.line.updateMany({ where: { id: { in: dto.ids } }, data: { status: dto.status } });
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
      entry: { nodeId: line.entryNodeId, nodeName: line.entryNode.name, port: line.entryPort },
      landing: view.topology.landing
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
    const healthGateEnabled = settings?.upstreamHealthGateEnabled !== false;
    const globalMaxAgeSecs = settings?.upstreamHealthMaxAgeSecs ?? 1800;
    return rows
      .filter((line) => line.status === undefined || line.status === 'ACTIVE')
      .filter((line) => line.relayMode !== 'TARGET_LINE' || line.targetLine?.status === 'ACTIVE')
      .filter((line) => this.isEgressHealthy(line, healthGateEnabled, globalMaxAgeSecs))
      .filter((line) => isLineAuthorized(plan, line, extraIds))
      .map((line) => this.toView(line));
  }

  /**
   * 上游出口健康门。
   *
   * 上游线路默认参与套餐公开列表，因此一条挂掉的上游必须被拦在下发之外，
   * 否则所有用户都会看到一个连不通的节点。判定只影响"是否下发"，
   * **不修改线路自身的 status**，管理员仍能在管理端看到并修复它。
   */
  private isEgressHealthy(
    line: { egressLineId?: string | null; upstreamHealthGate?: boolean; upstreamHealthMaxAgeSecs?: number | null },
    gateEnabled: boolean,
    globalMaxAgeSecs: number
  ): boolean {
    if (!line.egressLineId) return true;
    if (!gateEnabled || line.upstreamHealthGate === false) return true;
    const egress = (line as { egressLine?: { lastTestStatus?: string | null; lastTestedAt?: Date | null } | null }).egressLine;
    // 出口缺失（已删除或停用）时不出现在订阅中
    if (!egress) return false;
    if (egress.lastTestStatus !== 'SUCCESS' || !egress.lastTestedAt) return false;
    const maxAgeSecs = line.upstreamHealthMaxAgeSecs ?? globalMaxAgeSecs;
    return Date.now() - egress.lastTestedAt.getTime() <= maxAgeSecs * 1000;
  }

  private async findRaw(id: string): Promise<LineWithRelations> {
    const line = await this.prisma.line.findUnique({ where: { id }, include: lineInclude });
    if (!line) throw new NotFoundException('线路不存在');
    return line;
  }

  private async prepare(input: LineInput, current?: LineWithRelations): Promise<Prisma.LineUncheckedCreateInput | Prisma.LineUncheckedUpdateInput> {
    const type = input.type ?? (current?.type as LineType | undefined) ?? 'DIRECT';
    if (!LINE_TYPES.includes(type)) throw new BadRequestException('线路类型无效');

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
    if (type === 'RELAY' && relayMode === 'PROTOCOL_PROXY' && protocolType === 'SHADOWTLS') {
      throw new BadRequestException('ShadowTLS 仅支持直连或盲转发，不支持协议代理中继');
    }

    const entryNodeId = input.entryNodeId !== undefined ? input.entryNodeId : current?.entryNodeId;
    if (!entryNodeId) throw new BadRequestException('必须指定入口节点');

    const egressLineId = await this.resolveEgressLineId(input, current, protocolType);

    let landingNodeId: string | null = null;
    let landingPort: number | null = null;
    let targetLineId: string | null = null;
    let targetLine: { id: string; type: string; protocolType: string; entryNodeId: string; entryPort: number } | null = null;

    if (type === 'DIRECT') {
      landingNodeId = null;
      landingPort = null;
      targetLineId = null;
    } else if (type === 'RELAY') {
      if (relayMode === 'TARGET_LINE') {
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
      } else {
        landingNodeId = input.landingNodeId !== undefined ? input.landingNodeId : current?.landingNodeId ?? null;
        if (!landingNodeId) throw new BadRequestException('中继线路必须指定落地节点');
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

    const entryPort = input.entryPort !== undefined && input.entryPort !== null
      ? input.entryPort
      : current?.entryPort ?? await this.findAvailablePort(entryNodeId, protocolType, current?.id);

    if (type === 'RELAY' && relayMode !== 'TARGET_LINE' && landingNodeId) {
      const requestedLandingPort = input.landingPort !== undefined && input.landingPort !== null ? input.landingPort : current?.landingPort;
      landingPort = requestedLandingPort ?? await this.findAvailablePort(landingNodeId, protocolType, current?.id);
      if (entryNodeId === landingNodeId && entryPort === landingPort) {
        throw new BadRequestException('同节点中继线路的入口与落地端口必须不同');
      }
      await this.assertPortAvailable(landingNodeId, landingPort, protocolType, current?.id);
    }
    await this.assertPortAvailable(entryNodeId, entryPort, protocolType, current?.id);

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

    return {
      name,
      tag: customTag,
      listen,
      type,
      relayMode,
      protocolType,
      paramsJson: JSON.stringify(params),
      entryNodeId,
      entryPort,
      landingNodeId,
      landingPort,
      targetLineId,
      certificateId,
      egressLineId,
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
      upstreamHealthGate: input.upstreamHealthGate ?? current?.upstreamHealthGate ?? true,
      upstreamHealthMaxAgeSecs: input.upstreamHealthMaxAgeSecs !== undefined
        ? input.upstreamHealthMaxAgeSecs
        : current?.upstreamHealthMaxAgeSecs ?? null,
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
      status: input.status ?? current?.status ?? 'ACTIVE'
    };
  }

  /**
   * 校验并解析线路的上游出口引用。
   *
   * 规则（单跳 = 入口节点自己出上游；双跳 = 落地节点出上游，两者都支持）：
   * 1) 出口必须指向一条"上游出口线路"（`upstreamEntryId != null`）；
   * 2) 上游出口线路自身不可再挂出口（第一版禁止链式嵌套，避免环路与出站层层套娃）；
   * 3) 上游出口线路不支持中继机制（它不监听入站，落地概念对其无意义）；
   * 4) 本地代理入站（mixed/socks/http）无法承载 UDP，禁止直连纯 UDP 上游协议。
   */
  private async resolveEgressLineId(
    input: LineInput,
    current: LineWithRelations | undefined,
    protocolType: ProtocolType
  ): Promise<string | null> {
    const requested = input.egressLineId !== undefined ? input.egressLineId : current?.egressLineId ?? null;
    if (!requested) return null;
    if (current?.upstreamEntryId) {
      throw new BadRequestException('上游出口线路自身不能再指定出口');
    }
    const egress = await this.prisma.line.findUnique({
      where: { id: requested },
      select: {
        id: true,
        name: true,
        status: true,
        type: true,
        relayMode: true,
        protocolType: true,
        upstreamEntryId: true,
        egressLineId: true,
        upstreamEntry: { select: { protocolType: true, available: true } }
      }
    });
    if (!egress) throw new NotFoundException('上游出口线路不存在');
    if (!egress.upstreamEntryId) {
      throw new BadRequestException('出口必须指向一条上游出口线路');
    }
    if (egress.egressLineId) {
      throw new BadRequestException('上游出口线路自身不能再指定出口（不支持链式出口）');
    }
    if (egress.type === 'RELAY' || egress.relayMode) {
      throw new BadRequestException('上游出口线路不支持中继机制');
    }
    const upstreamProtocol = egress.upstreamEntry?.protocolType;
    if (upstreamProtocol && UDP_PROTOCOLS.has(upstreamProtocol as ProtocolType) && LAND_PROXY_PROTOCOLS.has(protocolType)) {
      throw new BadRequestException('本地代理入站（MIXED/SOCKS/HTTP）无法承载 UDP，不能直连 Hysteria2/TUIC 上游');
    }
    return requested;
  }

  private async assertPortAvailable(nodeId: string, port: number, protocolType: ProtocolType, currentId?: string) {
    const rows = await this.prisma.line.findMany({
      where: {
        ...(currentId ? { id: { not: currentId } } : {}),
        // 上游出口线路不监听任何入站，其 entryPort 只是满足 schema 非空约束的占位值，
        // 因此不参与端口占用判定，避免出现"幽灵端口占用"。
        upstreamEntryId: null,
        OR: [{ entryNodeId: nodeId, entryPort: port }, { landingNodeId: nodeId, landingPort: port }]
      },
      select: { protocolType: true }
    });
    const wantsUdp = UDP_PROTOCOLS.has(protocolType);
    if (rows.some((line) => UDP_PROTOCOLS.has(line.protocolType as ProtocolType) === wantsUdp)) {
      throw new ConflictException(`节点 ${nodeId} 的端口 ${port} 已被同传输层线路占用`);
    }
  }

  private async findAvailablePort(nodeId: string, protocolType: ProtocolType, currentId?: string) {
    try {
      return await findAvailableRandomPort(async (port) => {
        const rows = await this.prisma.line.findMany({
          where: {
            ...(currentId ? { id: { not: currentId } } : {}),
            upstreamEntryId: null,
            OR: [{ entryNodeId: nodeId, entryPort: port }, { landingNodeId: nodeId, landingPort: port }]
          },
          select: { protocolType: true }
        });
        const wantsUdp = UDP_PROTOCOLS.has(protocolType);
        return !rows.some((line) => UDP_PROTOCOLS.has(line.protocolType as ProtocolType) === wantsUdp);
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
      if (tags.direct) existingTags.set(line.entryNodeId, tags.direct);
      if (tags.entry) existingTags.set(line.entryNodeId, tags.entry);
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

  private toView(line: LineWithRelations) {
    const serverHost = line.endpointOverrideEnabled && line.serverHost ? line.serverHost : line.entryNode.serverHost;
    const serverPort = line.endpointOverrideEnabled && line.serverPort ? line.serverPort : line.entryPort;
    const params = sanitizeInboundParams(this.sanitizeCorruptParams(this.parseObject(line.paramsJson)));
    const isNatLanding = line.landingNode?.reachability === 'NAT';
    const hasLandingOverride = line.type === 'RELAY' && !isNatLanding && Boolean(line.landingEndpointOverrideEnabled && line.landingServerHost);
    const landing = line.type === 'RELAY'
      ? (line.relayMode === 'TARGET_LINE' && line.targetLine
          ? {
              node: line.targetLine.entryNode,
              host: hasLandingOverride
                ? line.landingServerHost!
                : (line.targetLine.endpointOverrideEnabled && line.targetLine.serverHost
                    ? line.targetLine.serverHost
                    : line.targetLine.entryNode.serverHost),
              port: hasLandingOverride && line.landingServerPort
                ? line.landingServerPort
                : (line.targetLine.endpointOverrideEnabled && line.targetLine.serverPort
                    ? line.targetLine.serverPort
                    : line.targetLine.entryPort)
            }
          : line.landingNode && line.landingPort
            ? {
                node: line.landingNode,
                host: hasLandingOverride ? line.landingServerHost! : line.landingNode.serverHost,
                port: hasLandingOverride && line.landingServerPort ? line.landingServerPort : line.landingPort
              }
            : null)
      : null;
    return {
      ...line,
      protocolType: line.protocolType as ProtocolType,
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
      // 上游订阅出口编排：上游出口线路暴露自身条目；普通线路暴露它引用的出口摘要。
      // upstreamEntrySummary / egressLineSummary 只 select 非敏感字段，
      // 不含 paramsJson，因此上游 uuid/password 天然不会进入任何管理端响应。
      upstreamEntry: line.upstreamEntry
        ? { ...line.upstreamEntry, isEgressLine: true as const }
        : null,
      egress: line.egressLine
        ? {
            lineId: line.egressLine.id,
            name: line.egressLine.name,
            status: line.egressLine.status,
            protocolType: line.egressLine.protocolType,
            entry: line.egressLine.upstreamEntry
          }
        : null,
      topology: {
        entry: { node: line.entryNode, port: line.entryPort },
        landing
      },
      targetInbound: landing ? {
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
