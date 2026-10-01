import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ProxyPoolAccessService, type ProxyPoolAccessSnapshot, type ProxyPoolEndpoint } from '../proxy-pool-access/proxy-pool-access.service';
import { parseProxyPoolLineIds, QueryProxyPoolNodesDto } from './dto/query-proxy-pool-nodes.dto';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService } from '../agent-gateway/agent.service';
import { CreateProxyKeyDto } from './dto/create-proxy-key.dto';
import { QueryAdminProxyKeysDto } from './dto/query-admin-proxy-keys.dto';
import { QueryProxyPoolExportDto } from './dto/query-proxy-pool-export.dto';
import { UpdateProxyKeyDto } from './dto/update-proxy-key.dto';
import {
  formatProxyLineUsername,
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

export type ProxyPoolEndpointView = ProxyPoolEndpoint;

export interface ProxyPoolExportResult {
  contentType: string;
  body: string;
  key: { id: string; name: string; username: string };
  count: number;
  excludedCount: number;
}


@Injectable()
export class ProxyPoolService {
  private readonly logger = new Logger(ProxyPoolService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accessService: ProxyPoolAccessService,
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

  async listEndpoints(userId: string, query: QueryProxyPoolNodesDto = {}) {
    const ids = parseProxyPoolLineIds(query.lineIds);
    const snapshot = await this.accessService.getSnapshot();
    this.requireEligibility(snapshot, userId);
    const key = await this.selectKey(userId, query.keyId);
    if (!key) return { keyId: null, endpoints: [], excludedCount: 0 };
    this.requireActiveKey(key);
    const endpoints = (snapshot.endpointsByKey.get(key.id) ?? []).filter((endpoint) => !ids || ids.includes(endpoint.lineId));
    return { keyId: key.id, endpoints, excludedCount: endpoints.filter((endpoint) => endpoint.status === 'CAPACITY_EXCLUDED').length };
  }

  // ==============================
  // 用户侧：多格式导出与免登录拉取
  // ==============================

  async exportForUser(userId: string, query: QueryProxyPoolExportDto): Promise<ProxyPoolExportResult> {
    parseProxyPoolLineIds(query.lineIds);
    const snapshot = await this.accessService.getSnapshot();
    this.requireEligibility(snapshot, userId);
    const key = await this.selectKey(userId, query.keyId);
    if (!key) throw new BadRequestException('尚未创建直连代理凭据，请先创建 Proxy Key');
    this.requireActiveKey(key);
    return this.buildExport(key, query, snapshot);
  }

  async exportForToken(token: string, query: QueryProxyPoolExportDto): Promise<ProxyPoolExportResult> {
    parseProxyPoolLineIds(query.lineIds);
    const key = await this.prisma.proxyKey.findUnique({ where: { exportToken: token } });
    if (!key || !key.isActive) throw new UnauthorizedException('拉取令牌无效或凭据已停用');
    if (query.keyId !== undefined && query.keyId !== key.id) throw new NotFoundException('直连代理凭据不存在');
    const snapshot = await this.accessService.getSnapshot();
    this.requireEligibility(snapshot, key.userId);
    return this.buildExport(key, query, snapshot);
  }

  private buildExport(key: ProxyKeyRecord, query: QueryProxyPoolExportDto, snapshot: ProxyPoolAccessSnapshot): ProxyPoolExportResult {
    const ids = parseProxyPoolLineIds(query.lineIds);
    const format = query.format ?? 'text';
    const protocol = query.protocol ?? 'socks5';
    const candidates = snapshot.endpointsByKey.get(key.id) ?? [];
    const compatible = (endpoint: ProxyPoolEndpoint): boolean => endpoint.status === 'AVAILABLE'
      && endpoint.supportedProtocols.includes(protocol)
      && (format !== 'text' || !endpoint.tls);
    if (ids) {
      const unavailable = ids.filter((id) => !candidates.some((endpoint) => endpoint.lineId === id && compatible(endpoint)));
      if (unavailable.length) throw new ConflictException({ code: 'PROXY_POOL_SELECTION_UNAVAILABLE', lineIds: unavailable });
    }
    const selected = candidates.filter((endpoint) => !ids || ids.includes(endpoint.lineId));
    const endpoints = selected.filter(compatible);
    const excludedCount = selected.length - endpoints.length;
    if (!endpoints.length) throw new NotFoundException('当前没有可导出的代理池端点');
    const keySummary = { id: key.id, name: key.name, username: key.username };
    const proxies = endpoints.map((endpoint) => ({ ...endpoint, username: formatProxyLineUsername(key.username, endpoint.lineId), password: key.password }));
    if (format === 'json') return {
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ version: 2, generatedAt: new Date().toISOString(), key: keySummary, proxies, excludedCount }),
      key: keySummary, count: proxies.length, excludedCount
    };
    const body = proxies.map((endpoint) => {
      const host = endpoint.host.includes(':') && !endpoint.host.startsWith('[') ? `[${endpoint.host}]` : endpoint.host;
      if (format === 'text') return `${host}:${endpoint.port}:${endpoint.username}:${endpoint.password}`;
      const scheme = protocol === 'http' ? (endpoint.tls ? 'https' : 'http') : 'socks5';
      return `${scheme}://${encodeURIComponent(endpoint.username)}:${encodeURIComponent(endpoint.password)}@${host}:${endpoint.port}`;
    }).join('\n');
    return { contentType: 'text/plain; charset=utf-8', body, key: keySummary, count: proxies.length, excludedCount };
  }

  private selectKey(userId: string, keyId?: string): Promise<ProxyKeyRecord | null> {
    return keyId !== undefined ? this.requireOwnedKey(userId, keyId) : this.prisma.proxyKey.findFirst({
      where: { userId, isActive: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    });
  }

  private requireEligibility(snapshot: ProxyPoolAccessSnapshot, userId: string): void {
    if (!snapshot.eligibleUserIds.has(userId)) throw new ForbiddenException({ code: 'PROXY_POOL_ACCESS_DENIED', message: '当前账号没有有效代理池权益' });
  }

  private requireActiveKey(key: ProxyKeyRecord): void {
    if (!key.isActive) throw new ConflictException({ code: 'PROXY_POOL_KEY_DISABLED', message: '该直连代理凭据已停用' });
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
    const [total, active, snapshot] = await Promise.all([
      this.prisma.proxyKey.count(),
      this.prisma.proxyKey.count({ where: { isActive: true } }),
      this.accessService.getSnapshot()
    ]);
    const traffic = await this.prisma.proxyKey.aggregate({ _sum: { trafficUsedBytes: true } });
    return {
      totalKeys: total,
      activeKeys: active,
      disabledKeys: total - active,
      trafficUsedBytes: Number(traffic._sum.trafficUsedBytes ?? 0n),
      endpointCount: snapshot.endpoints.length,
      endpoints: snapshot.endpoints,
      nodeCapacities: snapshot.nodeCapacities
    };
  }

  // ==============================
  // 内部工具
  // ==============================


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
    void this.agentService.pushConfigToAll().catch(() => {
      this.logger.warn(`proxy pool config sync failed: reason=${reason}`);
    });
  }
}
