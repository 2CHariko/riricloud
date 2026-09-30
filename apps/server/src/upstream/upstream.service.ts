import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  OnModuleInit,
  OnModuleDestroy,
  Optional
} from '@nestjs/common';
import * as net from 'net';
import type { Prisma, UpstreamSubscription, UpstreamNode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AgentGatewayService } from '../agent-gateway/agent-gateway.service';
import { UpstreamParserService } from './upstream-parser.service';
import { CreateUpstreamDto } from './dto/create-upstream.dto';
import { UpdateUpstreamDto } from './dto/update-upstream.dto';
import { QueryUpstreamDto } from './dto/query-upstream.dto';
import { QueryUpstreamNodeDto } from './dto/query-upstream-node.dto';
import { ExportUpstreamNodesDto } from './dto/export-upstream-nodes.dto';
import { UpstreamNodeStatus } from '../common/constants';
import type { ParsedUpstreamNode, UpstreamUserInfo } from './upstream.types';

type NodeWithRelations = UpstreamNode & {
  subscription?: { id: string; name: string } | null;
  relayLines?: Array<{ id: string; name: string; status: string }>;
};

@Injectable()
export class UpstreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UpstreamService.name);
  private syncTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly parser: UpstreamParserService,
    @Optional() private readonly agentGateway?: AgentGatewayService
  ) {}

  onModuleInit() {
    // 启动后台定时同步检查（每 60 秒巡检一次）
    this.syncTimer = setInterval(() => {
      void this.checkScheduledSync();
    }, 60 * 1000);
  }

  onModuleDestroy() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
  }

  // ==============================
  // 订阅源管理 (CRUD)
  // ==============================

  async list(query: QueryUpstreamDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where: Prisma.UpstreamSubscriptionWhereInput = {};
    if (query.search) {
      where.name = { contains: query.search };
    }
    if (query.status) {
      where.status = query.status;
    }

    const [rows, total] = await Promise.all([
      this.prisma.upstreamSubscription.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      this.prisma.upstreamSubscription.count({ where })
    ]);

    return {
      data: rows.map((row) => this.toSubscriptionView(row)),
      total,
      page,
      pageSize
    };
  }

  async detail(id: string) {
    const sub = await this.prisma.upstreamSubscription.findUnique({
      where: { id },
      include: {
        _count: { select: { nodes: true } }
      }
    });
    if (!sub) throw new NotFoundException('上游订阅不存在');
    return { subscription: this.toSubscriptionView(sub) };
  }

  async create(dto: CreateUpstreamDto) {
    if (dto.sourceType === 'URL' && !dto.url) {
      throw new BadRequestException('URL 来源的订阅必须提供有效 URL');
    }
    if (dto.sourceType === 'TEXT' && !dto.content) {
      throw new BadRequestException('文本来源的订阅必须提供配置内容');
    }

    const created = await this.prisma.upstreamSubscription.create({
      data: {
        name: dto.name.trim(),
        sourceType: dto.sourceType ?? 'URL',
        format: dto.format ?? 'AUTO',
        url: dto.url?.trim() || null,
        content: dto.content || null,
        customHeadersJson: JSON.stringify(dto.customHeaders || {}),
        autoUpdate: dto.autoUpdate ?? true,
        updateIntervalMins: dto.updateIntervalMins ?? 720,
        status: 'ACTIVE'
      }
    });

    // 异步执行一次首次同步
    void this.sync(created.id).catch((err: Error) => {
      this.logger.warn(`Initial sync failed for upstream ${created.id}: ${err.message}`);
    });

    return { subscription: this.toSubscriptionView(created) };
  }

  async update(id: string, dto: UpdateUpstreamDto) {
    await this.findSubOrThrow(id);
    const data: Prisma.UpstreamSubscriptionUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.sourceType !== undefined) data.sourceType = dto.sourceType;
    if (dto.format !== undefined) data.format = dto.format;
    if (dto.url !== undefined) data.url = dto.url.trim() || null;
    if (dto.content !== undefined) data.content = dto.content || null;
    if (dto.customHeaders !== undefined) data.customHeadersJson = JSON.stringify(dto.customHeaders);
    if (dto.autoUpdate !== undefined) data.autoUpdate = dto.autoUpdate;
    if (dto.updateIntervalMins !== undefined) data.updateIntervalMins = dto.updateIntervalMins;
    if (dto.status !== undefined) data.status = dto.status;

    const updated = await this.prisma.upstreamSubscription.update({
      where: { id },
      data
    });
    return { subscription: this.toSubscriptionView(updated) };
  }

  async remove(id: string) {
    await this.findSubOrThrow(id);
    // 查找该订阅下的所有节点
    const nodes = await this.prisma.upstreamNode.findMany({
      where: { subscriptionId: id },
      select: { id: true, name: true }
    });
    const nodeIds = nodes.map((n) => n.id);

    // 联动治理：若有中继线路使用了这些节点，自动将其置为 DISABLED 并清空 upstreamNodeId
    if (nodeIds.length > 0) {
      const impactedLines = await this.prisma.line.findMany({
        where: { upstreamNodeId: { in: nodeIds } },
        select: { id: true, name: true }
      });
      if (impactedLines.length > 0) {
        await this.prisma.line.updateMany({
          where: { upstreamNodeId: { in: nodeIds } },
          data: { status: 'DISABLED', upstreamNodeId: null }
        });
        this.logger.warn(
          `Upstream ${id} deleted. Automatically disabled ${impactedLines.length} linked relay line(s).`
        );
        this.agentGateway?.pushConfigToAll();
      }
    }

    await this.prisma.upstreamSubscription.delete({ where: { id } });
    return { deleted: true, id };
  }

  // ==============================
  // 同步与解析核心
  // ==============================

  async sync(id: string) {
    const sub = await this.findSubOrThrow(id);
    let rawContent = sub.content || '';
    let userInfo: UpstreamUserInfo | null = null;

    try {
      if (sub.sourceType === 'URL') {
        if (!sub.url) throw new BadRequestException('该订阅未配置 URL，无法在线拉取');
        const headers: Record<string, string> = {
          'User-Agent': 'ClashMeta/v1.18.0 (Sing-box Compatible; RiriCloud)',
          Accept: '*/*'
        };
        try {
          const custom = JSON.parse(sub.customHeadersJson || '{}') as Record<string, string>;
          Object.assign(headers, custom);
        } catch {
          // ignore
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000); // 20s 超时
        try {
          const resp = await fetch(sub.url, {
            headers,
            signal: controller.signal
          });
          if (!resp.ok) {
            throw new Error(`上游 HTTP 错误: 状态码 ${resp.status} ${resp.statusText}`);
          }
          const userinfoHeader = resp.headers.get('subscription-userinfo');
          if (userinfoHeader) {
            userInfo = this.parser.parseUserInfoHeader(userinfoHeader);
          }
          rawContent = await resp.text();
        } finally {
          clearTimeout(timeout);
        }
      }

      // 解析内容
      const parseResult = this.parser.parse(rawContent, sub.format);
      const parsedNodes = parseResult.nodes;

      // 差异比对与持久化 (Diff Engine)
      await this.applyNodesDiff(sub, parsedNodes, rawContent, userInfo, parseResult.format);

      this.logger.log(`Upstream ${sub.name} synced successfully. Parsed ${parsedNodes.length} node(s).`);
      return {
        success: true,
        nodeCount: parsedNodes.length,
        format: parseResult.format,
        userInfo
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : '同步失败';
      this.logger.error(`Upstream sync error for ${sub.name}: ${errMsg}`);
      await this.prisma.upstreamSubscription.update({
        where: { id },
        data: {
          lastSyncAt: new Date(),
          lastSyncStatus: 'FAILED',
          lastSyncMessage: errMsg
        }
      });
      throw new BadRequestException(`上游同步失败: ${errMsg}`);
    }
  }

  private async applyNodesDiff(
    sub: UpstreamSubscription,
    newNodes: ParsedUpstreamNode[],
    rawContent: string,
    userInfo: UpstreamUserInfo | null,
    detectedFormat: string
  ) {
    const existingNodes = await this.prisma.upstreamNode.findMany({
      where: { subscriptionId: sub.id }
    });

    const existingByFp = new Map<string, UpstreamNode>();
    for (const en of existingNodes) {
      existingByFp.set(en.fingerprint, en);
    }

    const matchedExistingIds = new Set<string>();
    let linesNeedSync = false;

    // 1. 处理新增和更新
    for (const pn of newNodes) {
      const matched = existingByFp.get(pn.fingerprint);
      if (matched) {
        matchedExistingIds.add(matched.id);
        // 更新参数
        await this.prisma.upstreamNode.update({
          where: { id: matched.id },
          data: {
            name: pn.name,
            protocolType: pn.protocolType,
            serverHost: pn.serverHost,
            serverPort: pn.serverPort,
            paramsJson: JSON.stringify(pn.params),
            rawConfigJson: typeof pn.rawConfig === 'string' ? pn.rawConfig : JSON.stringify(pn.rawConfig),
            tagsJson: JSON.stringify(pn.tags)
          }
        });
      } else {
        // 创建新节点（默认不直接合并进用户客户端订阅）
        await this.prisma.upstreamNode.create({
          data: {
            subscriptionId: sub.id,
            name: pn.name,
            protocolType: pn.protocolType,
            serverHost: pn.serverHost,
            serverPort: pn.serverPort,
            paramsJson: JSON.stringify(pn.params),
            rawConfigJson: typeof pn.rawConfig === 'string' ? pn.rawConfig : JSON.stringify(pn.rawConfig),
            fingerprint: pn.fingerprint,
            tagsJson: JSON.stringify(pn.tags),
            status: 'ACTIVE',
            isDirectSub: false
          }
        });
      }
    }

    // 2. 检查被删除的节点（现有节点在本次抓取中不复存在）
    const removedNodes = existingNodes.filter((en) => !matchedExistingIds.has(en.id));
    if (removedNodes.length > 0) {
      const removedIds = removedNodes.map((n) => n.id);
      // 联动治理：根据审批通过的决策规则，自动停用所有关联的中转线路
      const affectedLines = await this.prisma.line.findMany({
        where: { upstreamNodeId: { in: removedIds } },
        select: { id: true, name: true, upstreamNodeId: true }
      });

      if (affectedLines.length > 0) {
        await this.prisma.line.updateMany({
          where: { id: { in: affectedLines.map((l) => l.id) } },
          data: { status: 'DISABLED' }
        });
        linesNeedSync = true;
        for (const line of affectedLines) {
          this.logger.warn(`中转线路 [${line.name}] 关联的上游节点已被上游删除，线路已被自动停用`);
        }
      }

      // 删除已失效节点
      await this.prisma.upstreamNode.deleteMany({
        where: { id: { in: removedIds } }
      });
    }

    // 3. 更新上游主表统计
    const updateData: Prisma.UpstreamSubscriptionUpdateInput = {
      lastSyncAt: new Date(),
      lastSyncStatus: 'SUCCESS',
      lastSyncMessage: null,
      nodeCount: newNodes.length,
      content: rawContent
    };
    if (sub.format === 'AUTO' && detectedFormat) {
      updateData.format = detectedFormat;
    }
    if (userInfo) {
      if (userInfo.usedBytes !== undefined) updateData.userInfoUsedBytes = userInfo.usedBytes;
      if (userInfo.totalBytes !== undefined) updateData.userInfoTotalBytes = userInfo.totalBytes;
      if (userInfo.expireAt !== undefined) updateData.userInfoExpireAt = userInfo.expireAt;
    }

    await this.prisma.upstreamSubscription.update({
      where: { id: sub.id },
      data: updateData
    });

    if (linesNeedSync) {
      this.agentGateway?.pushConfigToAll();
    }
  }

  // ==============================
  // 节点管理
  // ==============================

  async listNodes(query: QueryUpstreamNodeDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const where: Prisma.UpstreamNodeWhereInput = {};

    if (query.subscriptionId) where.subscriptionId = query.subscriptionId;
    if (query.search) where.name = { contains: query.search };
    if (query.protocolType) where.protocolType = query.protocolType.toUpperCase();
    if (query.status) where.status = query.status;
    if (query.isDirectSub !== undefined) where.isDirectSub = query.isDirectSub;

    const [rows, total] = await Promise.all([
      this.prisma.upstreamNode.findMany({
        where,
        include: {
          subscription: { select: { id: true, name: true, status: true } },
          relayLines: { select: { id: true, name: true, status: true } }
        },
        orderBy: [{ isDirectSub: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      this.prisma.upstreamNode.count({ where })
    ]);

    let data = rows.map((node) => this.toNodeView(node));
    if (query.tag) {
      const tagLower = query.tag.toLowerCase();
      data = data.filter((node) =>
        node.tags.some((t: string) => t.toLowerCase() === tagLower)
      );
    }

    return { data, total, page, pageSize };
  }

  async setNodeDirectSub(id: string, isDirectSub: boolean) {
    const current = await this.findNodeOrThrow(id);
    const updated = await this.prisma.upstreamNode.update({
      where: { id: current.id },
      data: { isDirectSub }
    });
    return { node: this.toNodeView(updated) };
  }

  async setNodeStatus(id: string, status: UpstreamNodeStatus) {
    const current = await this.findNodeOrThrow(id);
    const updated = await this.prisma.upstreamNode.update({
      where: { id: current.id },
      data: { status }
    });
    // 若禁用节点，联动检查是否有中转线路引用
    if (status === 'DISABLED') {
      const affectedLines = await this.prisma.line.findMany({
        where: { upstreamNodeId: current.id, status: 'ACTIVE' },
        select: { id: true, name: true }
      });
      if (affectedLines.length > 0) {
        await this.prisma.line.updateMany({
          where: { id: { in: affectedLines.map((l) => l.id) } },
          data: { status: 'DISABLED' }
        });
        this.agentGateway?.pushConfigToAll();
      }
    }
    return { node: this.toNodeView(updated) };
  }

  // ==============================
  // 连通性测速 (Probe)
  // ==============================

  async probeNode(id: string) {
    const node = await this.findNodeOrThrow(id);
    const result = await this.measureTcpLatency(node.serverHost, node.serverPort, 3000);

    const updated = await this.prisma.upstreamNode.update({
      where: { id },
      data: {
        latencyMs: result.latencyMs,
        lastTestedAt: new Date(),
        lastTestStatus: result.status,
        lastTestMessage: result.message
      }
    });

    return { probe: result, node: this.toNodeView(updated) };
  }

  async probeAll(subscriptionId?: string) {
    const where: Prisma.UpstreamNodeWhereInput = { status: 'ACTIVE' };
    if (subscriptionId) where.subscriptionId = subscriptionId;

    const nodes = await this.prisma.upstreamNode.findMany({
      where,
      select: { id: true, serverHost: true, serverPort: true },
      take: 200 // 每次最多测速 200 个节点
    });

    // 并发控制为 10
    const concurrency = 10;
    const results: Array<{ id: string; latencyMs: number | null; status: string }> = [];

    for (let i = 0; i < nodes.length; i += concurrency) {
      const chunk = nodes.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(async (n) => {
          const res = await this.measureTcpLatency(n.serverHost, n.serverPort, 3000);
          await this.prisma.upstreamNode.update({
            where: { id: n.id },
            data: {
              latencyMs: res.latencyMs,
              lastTestedAt: new Date(),
              lastTestStatus: res.status,
              lastTestMessage: res.message
            }
          });
          results.push({ id: n.id, latencyMs: res.latencyMs, status: res.status });
        })
      );
    }

    return { total: nodes.length, tested: results.length, results };
  }

  private measureTcpLatency(
    host: string,
    port: number,
    timeoutMs: number
  ): Promise<{ latencyMs: number | null; status: 'SUCCESS' | 'TIMEOUT' | 'ERROR'; message: string | null }> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const socket = new net.Socket();
      let resolved = false;

      const finish = (status: 'SUCCESS' | 'TIMEOUT' | 'ERROR', message: string | null = null) => {
        if (resolved) return;
        resolved = true;
        socket.destroy();
        const latencyMs = status === 'SUCCESS' ? Date.now() - startTime : null;
        resolve({ latencyMs, status, message });
      };

      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish('SUCCESS'));
      socket.once('timeout', () => finish('TIMEOUT', '连接超时'));
      socket.once('error', (err: Error) => finish('ERROR', err.message || '握手失败'));

      try {
        socket.connect(port, host);
      } catch (err: unknown) {
        finish('ERROR', err instanceof Error ? err.message : '连接异常');
      }
    });
  }

  // ==============================
  // 节点导出 (URI / JSON)
  // ==============================

  async exportNodes(dto: ExportUpstreamNodesDto): Promise<{ contentType: string; body: string; count: number }> {
    const where: Prisma.UpstreamNodeWhereInput = { status: 'ACTIVE' };
    if (dto.nodeIds) {
      const ids = dto.nodeIds.split(',').map((id) => id.trim()).filter(Boolean);
      where.id = { in: ids };
    } else if (dto.subscriptionId) {
      where.subscriptionId = dto.subscriptionId;
    }

    const nodes = await this.prisma.upstreamNode.findMany({
      where,
      orderBy: { createdAt: 'desc' }
    });

    if (dto.format === 'json') {
      const jsonList = nodes.map((node) => {
        let raw: Record<string, unknown> = {};
        try {
          raw = JSON.parse(node.rawConfigJson) as Record<string, unknown>;
        } catch {
          raw = { name: node.name, server: node.serverHost, port: node.serverPort };
        }
        return raw;
      });
      return {
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(jsonList, null, 2),
        count: nodes.length
      };
    }

    // URI 格式导出
    const uriList: string[] = [];
    for (const node of nodes) {
      if (typeof node.rawConfigJson === 'string' && node.rawConfigJson.includes('://')) {
        uriList.push(node.rawConfigJson);
      } else {
        // 尝试根据 params 构建
        const uri = this.rebuildNodeUri(node);
        if (uri) uriList.push(uri);
      }
    }

    return {
      contentType: 'text/plain; charset=utf-8',
      body: uriList.join('\n'),
      count: uriList.length
    };
  }

  private rebuildNodeUri(node: UpstreamNode): string | null {
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(node.paramsJson) as Record<string, unknown>;
    } catch {
      return null;
    }
    const nameEnc = encodeURIComponent(node.name);
    const host = node.serverHost;
    const port = node.serverPort;

    switch (node.protocolType) {
      case 'VLESS': {
        const uuid = typeof params.uuid === 'string' ? params.uuid : '';
        return `vless://${uuid}@${host}:${port}?security=none#${nameEnc}`;
      }
      case 'TROJAN': {
        const pass = typeof params.password === 'string' ? params.password : '';
        return `trojan://${pass}@${host}:${port}#${nameEnc}`;
      }
      case 'HYSTERIA2': {
        const pass = typeof params.password === 'string' ? params.password : '';
        return `hy2://${pass}@${host}:${port}#${nameEnc}`;
      }
      case 'SHADOWSOCKS': {
        const cred = `${String(params.method || '')}:${String(params.password || '')}`;
        const b64 = Buffer.from(cred).toString('base64');
        return `ss://${b64}@${host}:${port}#${nameEnc}`;
      }
      default:
        return null;
    }
  }

  // ==============================
  // 巡检调度
  // ==============================

  private async checkScheduledSync() {
    try {
      const activeSubs = await this.prisma.upstreamSubscription.findMany({
        where: {
          status: 'ACTIVE',
          autoUpdate: true,
          sourceType: 'URL'
        }
      });

      const now = Date.now();
      for (const sub of activeSubs) {
        const intervalMs = (sub.updateIntervalMins || 720) * 60 * 1000;
        const lastSync = sub.lastSyncAt ? new Date(sub.lastSyncAt).getTime() : 0;
        if (now - lastSync >= intervalMs) {
          this.logger.log(`Scheduled sync starting for upstream [${sub.name}] (${sub.id})...`);
          await this.sync(sub.id).catch((err: Error) => {
            this.logger.warn(`Scheduled sync failed for ${sub.name}: ${err.message}`);
          });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '未知异常';
      this.logger.error(`Error during upstream checkScheduledSync: ${msg}`);
    }
  }

  // ==============================
  // 序列化视图
  // ==============================

  private toSubscriptionView(sub: UpstreamSubscription & { _count?: { nodes?: number } }) {
    let customHeaders: Record<string, string> = {};
    try {
      customHeaders = JSON.parse(sub.customHeadersJson || '{}') as Record<string, string>;
    } catch {
      // ignore
    }

    return {
      id: sub.id,
      name: sub.name,
      sourceType: sub.sourceType,
      format: sub.format,
      url: sub.url,
      hasContent: Boolean(sub.content),
      customHeaders,
      autoUpdate: sub.autoUpdate,
      updateIntervalMins: sub.updateIntervalMins,
      lastSyncAt: sub.lastSyncAt ? new Date(sub.lastSyncAt).toISOString() : null,
      lastSyncStatus: sub.lastSyncStatus,
      lastSyncMessage: sub.lastSyncMessage,
      userInfoUsedBytes: sub.userInfoUsedBytes !== null ? Number(sub.userInfoUsedBytes) : null,
      userInfoTotalBytes: sub.userInfoTotalBytes !== null ? Number(sub.userInfoTotalBytes) : null,
      userInfoExpireAt: sub.userInfoExpireAt ? new Date(sub.userInfoExpireAt).toISOString() : null,
      nodeCount: sub.nodeCount ?? sub._count?.nodes ?? 0,
      status: sub.status,
      createdAt: new Date(sub.createdAt).toISOString(),
      updatedAt: new Date(sub.updatedAt).toISOString()
    };
  }

  private toNodeView(node: NodeWithRelations) {
    let params: Record<string, unknown> = {};
    let tags: string[] = [];
    try {
      params = JSON.parse(node.paramsJson || '{}') as Record<string, unknown>;
    } catch {
      // ignore
    }
    try {
      tags = JSON.parse(node.tagsJson || '[]') as string[];
    } catch {
      // ignore
    }

    return {
      id: node.id,
      subscriptionId: node.subscriptionId,
      subscription: node.subscription ? { id: node.subscription.id, name: node.subscription.name } : null,
      name: node.name,
      protocolType: node.protocolType,
      serverHost: node.serverHost,
      serverPort: node.serverPort,
      params,
      tags,
      latencyMs: node.latencyMs,
      lastTestedAt: node.lastTestedAt ? new Date(node.lastTestedAt).toISOString() : null,
      lastTestStatus: node.lastTestStatus,
      lastTestMessage: node.lastTestMessage,
      status: node.status,
      isDirectSub: Boolean(node.isDirectSub),
      relayLines: node.relayLines ? node.relayLines.map((l) => ({ id: l.id, name: l.name, status: l.status })) : [],
      createdAt: new Date(node.createdAt).toISOString(),
      updatedAt: new Date(node.updatedAt).toISOString()
    };
  }

  private async findSubOrThrow(id: string) {
    const sub = await this.prisma.upstreamSubscription.findUnique({ where: { id } });
    if (!sub) throw new NotFoundException('上游订阅不存在');
    return sub;
  }

  private async findNodeOrThrow(id: string) {
    const node = await this.prisma.upstreamNode.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('上游节点不存在');
    return node;
  }
}
