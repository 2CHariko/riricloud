import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService } from '../agent-gateway/agent.service';
import { CreateProxyKeyDto } from './dto/create-proxy-key.dto';
import { QueryAdminProxyKeysDto } from './dto/query-admin-proxy-keys.dto';
import { QueryProxyPoolExportDto } from './dto/query-proxy-pool-export.dto';
import { UpdateProxyKeyDto } from './dto/update-proxy-key.dto';
import {
  generateProxyKeyPassword,
  generateProxyKeyUsername,
  normalizeProxyKeyName,
  normalizeWhitelistIps,
  parseWhitelistIps
} from './proxy-key.util';

// 单个用户可创建的直连代理凭据上限，避免节点配置规模失控
export const PROXY_KEY_PER_USER_LIMIT = 20;

// 用户名唯一约束冲突（Prisma P2002）时的重试次数
const USERNAME_CONFLICT_RETRY = 5;

type ProxyKeyRecord = {
  id: string;
  userId: string;
  name: string;
  username: string;
  password: string;
  whitelistIps: string;
  exportToken: string;
  isActive: boolean;
  trafficUsedBytes: bigint;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type ProxyPoolLineRecord = Prisma.LineGetPayload<{
  include: { entryNode: { select: { id: true; name: true; serverHost: true; status: true } } };
}>;
type ProxyPoolEndpointRecord = ProxyPoolLineRecord & {
  entryNode: NonNullable<ProxyPoolLineRecord['entryNode']>;
  entryPort: number;
};

export interface ProxyKeyView {
  id: string;
  userId: string;
  name: string;
  username: string;
  password: string;
  whitelistIps: string[];
  exportToken: string;
  isActive: boolean;
  trafficUsedBytes: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyPoolEndpointView {
  lineId: string;
  name: string;
  region: string | null;
  tags: string[];
  protocol: 'MIXED';
  host: string;
  port: number;
  nodeId: string;
  nodeName: string;
  nodeStatus: string;
  online: boolean;
  latencyMs: number | null;
  lastTestedAt: string | null;
  lastTestStatus: string | null;
  tls: boolean;
  serverName: string | null;
}

export interface ProxyPoolExportResult {
  contentType: string;
  body: string;
  key: { id: string; name: string; username: string };
  count: number;
}

// 地区标识：仅接受全大写 2-3 位国家/地区代码标签，其余功能性标签（local/relay 等）不参与地区归类
const REGION_TAG_REGEX = /^[A-Z]{2,3}$/;

@Injectable()
export class ProxyPoolService {
  private readonly logger = new Logger(ProxyPoolService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly agentService?: AgentService
  ) {}

  // ==============================
  // 用户侧：Proxy Key 凭据管理
  // ==============================

  async listKeys(userId: string) {
    const keys = await this.prisma.proxyKey.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });
    return {
      keys: keys.map((key) => this.toKeyView(key)),
      limit: PROXY_KEY_PER_USER_LIMIT
    };
  }

  async createKey(userId: string, dto: CreateProxyKeyDto) {
    const name = normalizeProxyKeyName(dto.name);
    const whitelistIps = normalizeWhitelistIps(dto.whitelistIps ?? '');
    const existingCount = await this.prisma.proxyKey.count({ where: { userId } });
    if (existingCount >= PROXY_KEY_PER_USER_LIMIT) {
      throw new ConflictException(`单个账号最多创建 ${PROXY_KEY_PER_USER_LIMIT} 条直连代理凭据`);
    }

    for (let attempt = 0; attempt < USERNAME_CONFLICT_RETRY; attempt += 1) {
      const username = generateProxyKeyUsername();
      try {
        const created = await this.prisma.proxyKey.create({
          data: {
            userId,
            name,
            username,
            password: generateProxyKeyPassword(),
            whitelistIps,
            exportToken: randomUUID()
          }
        });
        this.scheduleConfigSync('create');
        return { key: this.toKeyView(created) };
      } catch (error) {
        if (!this.isUniqueConstraintError(error)) throw error;
        this.logger.warn(`proxy key username collision, retrying: attempt=${attempt + 1}`);
      }
    }
    throw new ConflictException('凭据用户名生成冲突，请重试');
  }

  async updateKey(userId: string, id: string, dto: UpdateProxyKeyDto) {
    const current = await this.requireOwnedKey(userId, id);
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = normalizeProxyKeyName(dto.name);
    if (dto.whitelistIps !== undefined) data.whitelistIps = normalizeWhitelistIps(dto.whitelistIps);
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (!Object.keys(data).length) {
      return { key: this.toKeyView(current) };
    }

    const updated = await this.prisma.proxyKey.update({ where: { id: current.id }, data });
    // 启停与白名单直接决定节点入站用户列表与路由规则，必须重新下发配置
    if (dto.isActive !== undefined || dto.whitelistIps !== undefined) {
      this.scheduleConfigSync('update');
    }
    return { key: this.toKeyView(updated) };
  }

  async deleteKey(userId: string, id: string) {
    const current = await this.requireOwnedKey(userId, id);
    await this.prisma.proxyKey.delete({ where: { id: current.id } });
    this.scheduleConfigSync('delete');
    return { deleted: true, id: current.id };
  }

  async rotatePassword(userId: string, id: string) {
    const current = await this.requireOwnedKey(userId, id);
    const updated = await this.prisma.proxyKey.update({
      where: { id: current.id },
      data: { password: generateProxyKeyPassword() }
    });
    this.scheduleConfigSync('rotate-password');
    return { key: this.toKeyView(updated) };
  }

  async rotateExportToken(userId: string, id: string) {
    const current = await this.requireOwnedKey(userId, id);
    const updated = await this.prisma.proxyKey.update({
      where: { id: current.id },
      data: { exportToken: randomUUID() }
    });
    return { key: this.toKeyView(updated) };
  }

  // ==============================
  // 用户侧：代理池节点检索
  // ==============================

  async listEndpoints(lineIds?: string[]) {
    const lines = await this.loadProxyPoolLines(lineIds);
    return { endpoints: lines.map((line) => this.toEndpointView(line)) };
  }

  // ==============================
  // 用户侧：多格式导出与免登录拉取
  // ==============================

  async exportForUser(userId: string, query: QueryProxyPoolExportDto): Promise<ProxyPoolExportResult> {
    const key = query.keyId
      ? await this.requireOwnedKey(userId, query.keyId)
      : await this.prisma.proxyKey.findFirst({
          where: { userId, isActive: true },
          orderBy: { createdAt: 'desc' }
        });
    if (!key) {
      throw new BadRequestException('尚未创建直连代理凭据，请先创建 Proxy Key');
    }
    if (!key.isActive) {
      throw new ConflictException('该直连代理凭据已停用，无法导出');
    }
    return this.buildExport(key, query);
  }

  // 免登录拉取：以 ProxyKey.exportToken 作为 Bearer 语义的 query 令牌
  async exportForToken(token: string, query: QueryProxyPoolExportDto): Promise<ProxyPoolExportResult> {
    const key = await this.prisma.proxyKey.findUnique({
      where: { exportToken: token },
      include: { user: { select: { id: true, isActive: true } } }
    });
    if (!key || !key.isActive || !key.user.isActive) {
      throw new UnauthorizedException('拉取令牌无效或凭据已停用');
    }
    return this.buildExport(key, query);
  }

  private async buildExport(
    key: ProxyKeyRecord,
    query: QueryProxyPoolExportDto
  ): Promise<ProxyPoolExportResult> {
    const lineIds = query.lineIds
      ? query.lineIds.split(',').map((item) => item.trim()).filter(Boolean)
      : undefined;
    const lines = await this.loadProxyPoolLines(lineIds);
    const endpoints = lines.map((line) => this.toEndpointView(line));
    if (!endpoints.length) {
      throw new NotFoundException('当前没有可用的直连代理节点，请联系管理员配置 Mixed 线路');
    }

    const keySummary = { id: key.id, name: key.name, username: key.username };
    if (query.format === 'json') {
      return {
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          version: 1,
          generatedAt: new Date().toISOString(),
          key: keySummary,
          proxies: endpoints.map((endpoint) => ({
            name: endpoint.name,
            region: endpoint.region,
            tags: endpoint.tags,
            node: endpoint.nodeName,
            nodeId: endpoint.nodeId,
            lineId: endpoint.lineId,
            protocol: 'mixed',
            host: endpoint.host,
            port: endpoint.port,
            username: key.username,
            password: key.password,
            latencyMs: endpoint.latencyMs,
            lastTestStatus: endpoint.lastTestStatus,
            tls: endpoint.tls,
            serverName: endpoint.serverName
          }))
        }),
        key: keySummary,
        count: endpoints.length
      };
    }

    const isHttp = query.protocol === 'http';
    const body = query.format === 'uri'
      ? endpoints
          .map((endpoint) => {
            // HTTP 协议下自动识别节点是否开启 TLS，若是则自动生成标准 https:// 代理 URI
            const scheme = isHttp ? (endpoint.tls ? 'https' : 'http') : 'socks5';
            return `${scheme}://${encodeURIComponent(key.username)}:${encodeURIComponent(key.password)}@${endpoint.host}:${endpoint.port}`;
          })
          .join('\n')
      : endpoints
          .map((endpoint) => `${endpoint.host}:${endpoint.port}:${key.username}:${key.password}`)
          .join('\n');

    return {
      contentType: 'text/plain; charset=utf-8',
      body,
      key: keySummary,
      count: endpoints.length
    };
  }

  // ==============================
  // 管理侧
  // ==============================

  async adminListKeys(query: QueryAdminProxyKeysDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = {
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search } },
              { username: { contains: query.search } },
              { user: { is: { email: { contains: query.search } } } }
            ]
          }
        : {})
    };
    const [rows, total] = await Promise.all([
      this.prisma.proxyKey.findMany({
        where,
        include: { user: { select: { id: true, email: true, uid: true, isActive: true } } },
        orderBy: query.sortBy === 'trafficUsedBytes' ? { trafficUsedBytes: 'desc' } : { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      this.prisma.proxyKey.count({ where })
    ]);
    return {
      data: rows.map((row) => ({
        ...this.toKeyView(row),
        user: { id: row.user.id, email: row.user.email, uid: row.user.uid, isActive: row.user.isActive }
      })),
      total,
      page,
      pageSize
    };
  }

  async adminSetKeyActive(id: string, isActive: boolean) {
    const current = await this.findKeyOrThrow(id);
    const updated = await this.prisma.proxyKey.update({ where: { id: current.id }, data: { isActive } });
    this.scheduleConfigSync('admin-toggle');
    return { key: this.toKeyView(updated) };
  }

  async adminDeleteKey(id: string) {
    const current = await this.findKeyOrThrow(id);
    await this.prisma.proxyKey.delete({ where: { id: current.id } });
    this.scheduleConfigSync('admin-delete');
    return { deleted: true, id: current.id };
  }

  async adminOverview() {
    const [total, active, endpoints] = await Promise.all([
      this.prisma.proxyKey.count(),
      this.prisma.proxyKey.count({ where: { isActive: true } }),
      this.loadProxyPoolLines()
    ]);
    const traffic = await this.prisma.proxyKey.aggregate({ _sum: { trafficUsedBytes: true } });
    return {
      totalKeys: total,
      activeKeys: active,
      disabledKeys: total - active,
      trafficUsedBytes: Number(traffic._sum.trafficUsedBytes ?? 0n),
      endpointCount: endpoints.length,
      endpoints: endpoints.map((line) => this.toEndpointView(line))
    };
  }

  // ==============================
  // 内部工具
  // ==============================

  private async loadProxyPoolLines(lineIds?: string[]): Promise<ProxyPoolEndpointRecord[]> {
    const ids = lineIds?.filter(Boolean) ?? [];
    if (lineIds && !ids.length) return [];
    const lines = await this.prisma.line.findMany({
      where: {
        protocolType: 'MIXED',
        type: 'DIRECT',
        status: 'ACTIVE',
        isPublic: true,
        ...(ids.length ? { id: { in: ids } } : {}),
        entryNode: { status: { not: 'DISABLED' } }
      },
      include: { entryNode: { select: { id: true, name: true, serverHost: true, status: true } } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
    });
    return lines.filter((line): line is ProxyPoolEndpointRecord => Boolean(line.entryNode) && line.entryPort !== null && line.type !== 'EXTERNAL');
  }

  private toEndpointView(line: ProxyPoolEndpointRecord): ProxyPoolEndpointView {
    const tags = this.parseTags(line.tagsJson);
    let tls = false;
    let serverName: string | null = null;
    if (line.paramsJson) {
      try {
        const parsed = JSON.parse(line.paramsJson) as Record<string, unknown>;
        if (parsed.tls && typeof parsed.tls === 'object') {
          const tlsObj = parsed.tls as Record<string, unknown>;
          tls = tlsObj.enabled === true || Boolean(line.certificateId);
          if (typeof tlsObj.serverName === 'string' && tlsObj.serverName.trim()) {
            serverName = tlsObj.serverName.trim();
          }
        } else if (line.certificateId) {
          tls = true;
        }
      } catch {
        tls = Boolean(line.certificateId);
      }
    } else if (line.certificateId) {
      tls = true;
    }
    if (!serverName) {
      serverName = line.serverName || (line.endpointOverrideEnabled && line.serverHost ? line.serverHost : line.entryNode.serverHost);
    }

    return {
      lineId: line.id,
      name: line.name,
      region: tags.find((tag) => REGION_TAG_REGEX.test(tag)) ?? null,
      tags,
      protocol: 'MIXED',
      host: line.endpointOverrideEnabled && line.serverHost ? line.serverHost : line.entryNode.serverHost,
      port: line.endpointOverrideEnabled && line.serverPort ? line.serverPort : line.entryPort,
      nodeId: line.entryNode.id,
      nodeName: line.entryNode.name,
      nodeStatus: line.entryNode.status,
      online: line.entryNode.status === 'ONLINE',
      latencyMs: line.lastLatencyMs ?? null,
      lastTestedAt: line.lastTestedAt ? line.lastTestedAt.toISOString() : null,
      lastTestStatus: line.lastTestStatus ?? null,
      tls,
      serverName
    };
  }

  private parseTags(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    } catch {
      return [];
    }
  }

  private toKeyView(key: ProxyKeyRecord): ProxyKeyView {
    return {
      id: key.id,
      userId: key.userId,
      name: key.name,
      username: key.username,
      password: key.password,
      whitelistIps: parseWhitelistIps(key.whitelistIps),
      exportToken: key.exportToken,
      isActive: key.isActive,
      trafficUsedBytes: Number(key.trafficUsedBytes),
      lastUsedAt: key.lastUsedAt ? key.lastUsedAt.toISOString() : null,
      createdAt: key.createdAt.toISOString(),
      updatedAt: key.updatedAt.toISOString()
    };
  }

  private async requireOwnedKey(userId: string, id: string): Promise<ProxyKeyRecord> {
    const key = await this.prisma.proxyKey.findFirst({ where: { id, userId } });
    if (!key) throw new NotFoundException('直连代理凭据不存在');
    return key;
  }

  private async findKeyOrThrow(id: string): Promise<ProxyKeyRecord> {
    const key = await this.prisma.proxyKey.findUnique({ where: { id } });
    if (!key) throw new NotFoundException('直连代理凭据不存在');
    return key;
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
  }

  // 凭据变动后异步重下发全部在线节点配置（吊销/注入即时生效）
  private scheduleConfigSync(reason: string): void {
    if (!this.agentService) return;
    void this.agentService.pushConfigToAll().catch((error: unknown) => {
      this.logger.warn(`proxy pool config sync failed: reason=${reason} error=${String(error)}`);
    });
  }
}
