import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleDestroy } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService, type MirrorStreamHandlers } from '../agent-gateway/agent.service';
import { RateLimitService } from '../common/rate-limit.service';
import { assertSafeRemoteUrl } from '../common/safe-remote-fetch';
import { MirrorCapacity, type MirrorReservation } from './mirror-capacity';
import { MAX_MIRROR_RESPONSE_BYTES, MirrorResponseStream, MirrorTask } from './mirror-stream';
import { CreateMirrorSiteDto, UpdateMirrorSiteDto } from './dto/mirror-site.dto';

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RESPONSE_BYTES = MAX_MIRROR_RESPONSE_BYTES;
const PUBLIC_RATE_LIMIT = 60;

type MirrorRecord = {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;
  upstreamBaseUrl: string;
  allowedOriginsJson: string;
  nodeId: string;
  accessMode: string;
  shareTokenHash: string | null;
  shareExpiresAt: Date | null;
  shareRotatedAt: Date | null;
  lastRequestAt: Date | null;
  lastStatusCode: number | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  node: { id: string; name: string; status: string; communicationMode: string; capabilitiesJson: string };
};

type MirrorWriteInput = {
  name?: string;
  slug?: string;
  enabled?: boolean;
  upstreamBaseUrl?: string;
  allowedOriginsJson?: string;
  nodeId?: string;
  accessMode?: 'ADMIN' | 'SHARE' | 'PUBLIC';
  shareExpiresAt?: Date | null;
};

@Injectable()
export class MirrorService implements OnModuleDestroy {
  private readonly logger = new Logger(MirrorService.name);
  private readonly activeTaskIds = new Map<string, Map<string, () => void>>();
  private configRevision = 0;
  private readonly capacity = new MirrorCapacity();

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentService,
    private readonly rateLimit: RateLimitService
  ) {}

  async list(page = 1, pageSize = 50) {
    const [sites, total] = await Promise.all([
      this.prisma.mirrorSite.findMany({
        include: { node: { select: { id: true, name: true, status: true, communicationMode: true, capabilitiesJson: true } } },
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      this.prisma.mirrorSite.count()
    ]);
    return { items: sites.map((site) => this.sanitize(site as MirrorRecord)), total, page, pageSize };
  }

  async detail(id: string) {
    const site = await this.findById(id);
    return { mirror: this.sanitize(site) };
  }

  async create(dto: CreateMirrorSiteDto) {
    const normalized = await this.normalizeInput(dto);
    if (!normalized.nodeId || !normalized.name || !normalized.slug || !normalized.upstreamBaseUrl || !normalized.allowedOriginsJson || !normalized.accessMode) throw new BadRequestException('镜像站参数不完整');
    await this.requireNode(normalized.nodeId);
    const share = normalized.accessMode === 'SHARE' ? this.newShareToken() : undefined;
    try {
      const site = await this.prisma.mirrorSite.create({
        data: {
          name: normalized.name,
          slug: normalized.slug,
          enabled: normalized.enabled ?? false,
          upstreamBaseUrl: normalized.upstreamBaseUrl,
          allowedOriginsJson: normalized.allowedOriginsJson,
          nodeId: normalized.nodeId,
          accessMode: normalized.accessMode,
          ...(normalized.shareExpiresAt ? { shareExpiresAt: normalized.shareExpiresAt } : {}),
          ...(share ? { shareTokenHash: share.hash, shareRotatedAt: new Date() } : {})
        },
        include: { node: { select: { id: true, name: true, status: true, communicationMode: true, capabilitiesJson: true } } }
      });
      return { mirror: this.sanitize(site as MirrorRecord), ...(share ? { shareToken: share.token } : {}) };
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('镜像 slug 已存在');
      throw error;
    }
  }

  async update(id: string, dto: UpdateMirrorSiteDto) {
    const current = await this.findById(id);
    const input = await this.normalizeInput(dto, current);
    if (input.nodeId) await this.requireNode(input.nodeId);
    const switchingToShare = input.accessMode === 'SHARE' && current.accessMode !== 'SHARE';
    const disablingShare = input.accessMode && input.accessMode !== 'SHARE';
    const share = switchingToShare ? this.newShareToken() : undefined;
    const site = await this.prisma.mirrorSite.update({
      where: { id },
      data: {
        ...input,
        ...(disablingShare ? { shareTokenHash: null, shareExpiresAt: null } : {}),
        ...(share ? { shareTokenHash: share.hash, shareRotatedAt: new Date() } : {})
      },
      include: { node: { select: { id: true, name: true, status: true, communicationMode: true, capabilitiesJson: true } } }
    }).catch((error: unknown) => {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('镜像 slug 已存在');
      throw error;
    });
    this.configRevision += 1;
    this.cancelActiveTasks(current.id);
    return { mirror: this.sanitize(site as MirrorRecord), ...(share ? { shareToken: share.token } : {}) };
  }

  async remove(id: string) {
    await this.findById(id);
    await this.prisma.mirrorSite.delete({ where: { id } });
    this.configRevision += 1;
    this.cancelActiveTasks(id);
    return { deleted: true, id };
  }

  async rotateShareToken(id: string) {
    const site = await this.findById(id);
    if (site.accessMode !== 'SHARE') throw new BadRequestException('只有 SHARE 模式可以轮换分享 Token');
    const share = this.newShareToken();
    await this.prisma.mirrorSite.update({ where: { id }, data: { shareTokenHash: share.hash, shareRotatedAt: new Date() } });
    this.configRevision += 1;
    this.cancelActiveTasks(id);
    return { mirrorId: id, shareToken: share.token };
  }

  async test(id: string, user?: { id?: string; role?: string }, ip?: string) {
    const reservation = this.capacity.reserve();
    try { return await this.testReserved(id, reservation, user, ip); }
    catch (error) { reservation.abandon(); throw error; }
  }

  private async testReserved(id: string, reservation: MirrorReservation, user?: { id?: string; role?: string }, ip?: string) {
    const site = await this.findById(id);
    this.ensureNodeAvailable(site);
    const taskId = randomUUID();
    reservation.bindNode(site.nodeId);
    this.enforceRateLimit(site.id, ip, user?.id);
    const payload = this.buildRequest(site, 'HEAD', '/', {}, taskId);
    const startedAt = Date.now();
    return new Promise<Record<string, unknown>>((resolve) => {
      let metadata: Record<string, unknown> = {};
      const task = new MirrorTask(30_000, () => this.agent.cancelMirrorTask(taskId), (outcome) => {
        this.untrackTask(site.id, taskId);
        reservation.finish();
        resolve({ ...metadata, ...outcome, latencyMs: Date.now() - startedAt, nodeId: site.nodeId });
      });
      const handlers: MirrorStreamHandlers = {
        onHeaders: (headers) => { metadata = { finalHost: headers.finalHost }; task.finish({ success: true, statusCode: headers.statusCode }); },
        onChunk: () => undefined,
        onEnd: (end) => { metadata = { bytes: end.bytes }; task.finish({ success: end.success }); },
        onError: (error) => task.finish({ success: false, code: error.code, message: '镜像测试未完成' })
      };
      this.trackTask(site.id, taskId, () => task.finish({ success: false, code: 'REVOKED' }));
      void this.agent.startMirrorTask(site.nodeId, payload, handlers)
        .then((stop) => task.attachStop(stop))
        .catch(() => task.finish({ success: false, code: 'START_FAILED', message: '无法启动镜像测试' }))
        .finally(() => reservation.started());
    });
  }

  async proxy(siteSlug: string, shareToken: string | undefined, request: Request, response: Response, user?: { id?: string; role?: string }) {
    const reservation = this.capacity.reserve();
    try { await this.proxyReserved(siteSlug, shareToken, request, response, reservation, user); }
    catch (error) { reservation.abandon(); throw error; }
  }

  private async proxyReserved(siteSlug: string, shareToken: string | undefined, request: Request, response: Response, reservation: MirrorReservation, user?: { id?: string; role?: string }) {
    // 异步读取期间发生撤销时重读，避免在撤销之后用旧配置启动新流。
    let revision: number;
    let site: MirrorRecord;
    do {
      revision = this.configRevision;
      site = shareToken ? await this.findByShareToken(shareToken) : await this.findBySlug(siteSlug);
    } while (revision !== this.configRevision);
    this.checkAccess(site, shareToken, user);
    if (!site.enabled && user?.role !== 'ADMIN') throw new NotFoundException('镜像站不存在');
    if (!['GET', 'HEAD'].includes(request.method)) throw new BadRequestException('镜像站只支持 GET 和 HEAD');
    const ip = request.ip || request.socket.remoteAddress || 'unknown';
    this.enforceRateLimit(site.id, ip, user?.id);
    this.ensureNodeAvailable(site);
    reservation.bindNode(site.nodeId);
    const taskId = randomUUID();
    const startedAt = Date.now();
    const requestHeaders = this.forwardRequestHeaders(request);
    const path = Array.isArray(request.params?.path) ? request.params.path.join('/') : request.params?.path ?? '';
    const target = this.buildTargetUrl(site, path, request.originalUrl.includes('?') ? request.originalUrl.slice(request.originalUrl.indexOf('?')) : '');
    const stream = new MirrorResponseStream(response, request.method, (outcome) => task.finish(outcome));
    const remaining = site.accessMode === 'SHARE' && site.shareExpiresAt ? site.shareExpiresAt.getTime() - Date.now() : REQUEST_TIMEOUT_MS;
    const task = new MirrorTask(Math.min(REQUEST_TIMEOUT_MS, Math.max(0, remaining)), () => this.agent.cancelMirrorTask(taskId), (outcome) => {
      this.untrackTask(site.id, taskId);
      reservation.finish();
      stream.close(outcome);
      void this.prisma.mirrorSite.update({ where: { id: site.id }, data: { lastRequestAt: new Date(), lastStatusCode: outcome.statusCode ?? null, lastErrorCode: outcome.code ?? (outcome.success ? null : 'UPSTREAM_ERROR') } }).catch(() => undefined);
      this.loggerRequest(site, outcome.statusCode, outcome.code, Date.now() - startedAt, stream.finalHost, stream.bytesSent);
    }, remaining < REQUEST_TIMEOUT_MS ? 'TOKEN_EXPIRED' : 'TIMEOUT');
    this.trackTask(site.id, taskId, () => task.finish({ success: false, statusCode: 403, code: 'REVOKED' }));
    if (response.destroyed) { task.finish({ success: false, code: 'CLIENT_DISCONNECTED' }); reservation.started(); return; }
    try {
      const stop = await this.agent.startMirrorTask(site.nodeId, { taskId, method: request.method as 'GET' | 'HEAD', url: target, allowedHosts: this.parseOrigins(site.allowedOriginsJson), requestHeaders, timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES }, stream.handlers);
      task.attachStop(stop);
    } catch {
      task.finish({ success: false, statusCode: 502, code: 'START_FAILED', message: '无法启动镜像请求' });
    } finally { reservation.started(); }
  }

  onModuleDestroy() {
    this.capacity.close();
    for (const siteId of [...this.activeTaskIds.keys()]) this.cancelActiveTasks(siteId);
  }

  private enforceRateLimit(siteId: string, ip?: string, userId?: string) {
    const keys = ['mirror:site:' + siteId];
    if (ip) keys.push('mirror:ip:' + ip, siteId + ':' + ip);
    if (userId) keys.push('mirror:user:' + userId);
    if (keys.some((key) => !this.rateLimit.consume(key, PUBLIC_RATE_LIMIT, 60_000))) throw new ForbiddenException('镜像请求过于频繁');
  }

  private loggerRequest(site: MirrorRecord, statusCode: number | undefined, errorCode: string | undefined, durationMs: number, finalHost: string, bytes: number) {
    const fields = `site=${site.id} node=${site.nodeId} host=${finalHost} status=${statusCode ?? 'none'} bytes=${bytes} durationMs=${durationMs} error=${errorCode ?? 'none'}`;
    if (errorCode) this.logger.warn(`mirror request failed ${fields}`);
    else this.logger.log(`mirror request completed ${fields}`);
  }

  private trackTask(siteId: string, taskId: string, cancel: () => void) {
    const tasks = this.activeTaskIds.get(siteId) ?? new Map<string, () => void>();
    tasks.set(taskId, cancel);
    this.activeTaskIds.set(siteId, tasks);
  }

  private untrackTask(siteId: string, taskId: string) {
    const tasks = this.activeTaskIds.get(siteId);
    if (!tasks) return;
    tasks.delete(taskId);
    if (!tasks.size) this.activeTaskIds.delete(siteId);
  }

  private cancelActiveTasks(siteId: string) {
    const tasks = this.activeTaskIds.get(siteId);
    if (!tasks) return;
    for (const cancel of [...tasks.values()]) cancel();
    this.activeTaskIds.delete(siteId);
  }

  private async normalizeInput(dto: CreateMirrorSiteDto | UpdateMirrorSiteDto, current?: MirrorRecord): Promise<MirrorWriteInput> {
    const candidate = current ? plainToInstance(UpdateMirrorSiteDto, dto) : plainToInstance(CreateMirrorSiteDto, dto);
    if (validateSync(candidate, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true }).length) throw new BadRequestException('镜像站参数无效');
    const result: MirrorWriteInput = {};
    if ('name' in dto && dto.name !== undefined) { const name = dto.name.trim(); if (!name) throw new BadRequestException('镜像名称不能为空'); result.name = name; }
    if ('slug' in dto && dto.slug !== undefined) result.slug = dto.slug.trim().toLowerCase();
    if ('upstreamBaseUrl' in dto && dto.upstreamBaseUrl !== undefined) result.upstreamBaseUrl = this.normalizeBaseUrl(dto.upstreamBaseUrl);
    if ('allowedOrigins' in dto && dto.allowedOrigins !== undefined) result.allowedOriginsJson = JSON.stringify(this.normalizeOrigins(dto.allowedOrigins));
    if ('nodeId' in dto && dto.nodeId !== undefined) result.nodeId = dto.nodeId;
    if ('accessMode' in dto && dto.accessMode !== undefined) result.accessMode = dto.accessMode;
    if ('enabled' in dto && dto.enabled !== undefined) result.enabled = dto.enabled;
    if ('shareExpiresAt' in dto && dto.shareExpiresAt !== undefined) result.shareExpiresAt = dto.shareExpiresAt ? new Date(dto.shareExpiresAt) : null;
    const upstream = result.upstreamBaseUrl ?? current?.upstreamBaseUrl;
    if (upstream) {
      try { await assertSafeRemoteUrl(upstream, true); }
      catch (error) {
        const message = error instanceof Error && error.message === 'remote URL resolves to a private or metadata address' ? error.message : '上游 URL 公网或 DNS 校验失败';
        throw new BadRequestException(message);
      }
      const parsed = new URL(upstream);
      const origins = result.allowedOriginsJson ? this.parseOrigins(result.allowedOriginsJson) : current ? this.parseOrigins(current.allowedOriginsJson) : [parsed.hostname];
      if (!origins.includes(parsed.hostname.toLowerCase())) throw new BadRequestException('允许域名必须包含上游基址域名');
    }
    if (!current && (!result.name || !result.slug || !result.upstreamBaseUrl || !result.allowedOriginsJson || !result.nodeId || !result.accessMode)) throw new BadRequestException('镜像站参数不完整');
    if ((result.accessMode ?? current?.accessMode) === 'SHARE' && result.shareExpiresAt && result.shareExpiresAt.getTime() <= Date.now()) throw new BadRequestException('分享 Token 过期时间必须在未来');
    return result;
  }

  private normalizeBaseUrl(raw: string): string {
    let parsed: URL;
    try { parsed = new URL(raw.trim()); } catch { throw new BadRequestException('上游基址不是合法 URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new BadRequestException('上游基址必须是无凭据的 HTTP/HTTPS URL');
    if (this.productionLike() && parsed.protocol !== 'https:') throw new BadRequestException('生产环境镜像上游必须使用 HTTPS');
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    return parsed.toString().replace(/\/$/, '');
  }

  private normalizeOrigins(origins: string[]): string[] {
    const result = [...new Set(origins.map((origin) => origin.trim().toLowerCase().replace(/^\*\./, '')).filter(Boolean))];
    if (!result.length || result.some((origin) => origin.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(origin))) throw new BadRequestException('允许域名格式无效');
    return result;
  }

  private buildTargetUrl(site: MirrorRecord, path: string, query: string): string {
    let decoded = path;
    for (let depth = 0; depth < 8; depth += 1) {
      if (Array.from(decoded).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === '\\') || decoded.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(decoded) || decoded.split('/').some((part) => part === '.' || part === '..')) throw new BadRequestException('镜像路径无效');
      let next: string;
      try { next = decodeURIComponent(decoded.replace(/%(?![0-9a-f]{2})/gi, '%25')); } catch { throw new BadRequestException('镜像路径编码无效'); }
      if (next === decoded) break;
      if (depth === 7) throw new BadRequestException('镜像路径编码过深');
      decoded = next;
    }
    const target = new URL(site.upstreamBaseUrl);
    const basePath = target.pathname.endsWith('/') ? target.pathname : target.pathname + '/';
    target.pathname = basePath + path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
    target.search = query || '';
    return target.toString();
  }

  private buildRequest(site: MirrorRecord, method: 'GET' | 'HEAD', path: string, headers: Record<string, string>, taskId: string) {
    return { taskId, method, url: this.buildTargetUrl(site, path, ''), allowedHosts: this.parseOrigins(site.allowedOriginsJson), requestHeaders: headers, timeoutMs: 30_000, maxBytes: MAX_RESPONSE_BYTES };
  }

  private forwardRequestHeaders(request: Request): Record<string, string> {
    const result: Record<string, string> = {};
    const nominated = new Set((request.headers.connection ?? '').toLowerCase().split(',').map((part) => part.trim()));
    for (const key of ['range', 'if-none-match', 'if-modified-since', 'if-range', 'accept', 'accept-encoding']) {
      const value = request.headers[key];
      if (typeof value === 'string' && !nominated.has(key)) result[key] = value.slice(0, 4096);
    }
    return result;
  }

  private checkAccess(site: MirrorRecord, token: string | undefined, user?: { role?: string }) {
    if (!['ADMIN', 'SHARE', 'PUBLIC'].includes(site.accessMode)) throw new ForbiddenException('镜像访问模式无效');
    if (token && (site.accessMode !== 'SHARE' || site.shareTokenHash !== this.hashToken(token))) throw new ForbiddenException('分享地址已失效');
    if (site.accessMode === 'ADMIN' && user?.role !== 'ADMIN') throw new ForbiddenException('需要管理员权限');
    if (site.accessMode === 'SHARE' && (!token || !site.shareTokenHash || site.shareExpiresAt && site.shareExpiresAt.getTime() <= Date.now())) throw new ForbiddenException('分享地址已失效');
  }

  private ensureNodeAvailable(site: MirrorRecord) {
    if (site.node.status !== 'ONLINE' || site.node.communicationMode !== 'WS' || !this.parseCapabilities(site.node.capabilitiesJson).includes('mirror_proxy')) throw new ConflictException('指定节点未在线或不支持镜像代理');
  }

  private async findById(id: string): Promise<MirrorRecord> {
    const site = await this.prisma.mirrorSite.findUnique({ where: { id }, include: { node: { select: { id: true, name: true, status: true, communicationMode: true, capabilitiesJson: true } } } });
    if (!site) throw new NotFoundException('镜像站不存在');
    return site as MirrorRecord;
  }

  private async findBySlug(slug: string): Promise<MirrorRecord> {
    const site = await this.prisma.mirrorSite.findUnique({ where: { slug }, include: { node: { select: { id: true, name: true, status: true, communicationMode: true, capabilitiesJson: true } } } });
    if (!site) throw new NotFoundException('镜像站不存在');
    return site as MirrorRecord;
  }

  private async findByShareToken(token: string): Promise<MirrorRecord> {
    const hash = this.hashToken(token);
    const site = await this.prisma.mirrorSite.findUnique({ where: { shareTokenHash: hash }, include: { node: { select: { id: true, name: true, status: true, communicationMode: true, capabilitiesJson: true } } } });
    if (!site) throw new ForbiddenException('分享地址已失效');
    return site as MirrorRecord;
  }

  private async requireNode(id: string) {
    const node = await this.prisma.node.findUnique({ where: { id }, select: { id: true, status: true, communicationMode: true, capabilitiesJson: true } });
    if (!node) throw new BadRequestException('指定节点不存在');
    if (node.status !== 'ONLINE' || node.communicationMode !== 'WS' || !this.parseCapabilities(node.capabilitiesJson).includes('mirror_proxy')) {
      throw new ConflictException('指定节点未在线或不支持镜像代理');
    }
  }

  private sanitize(site: MirrorRecord) {
    return {
      id: site.id, name: site.name, slug: site.slug, enabled: site.enabled, upstreamBaseUrl: site.upstreamBaseUrl,
      allowedOrigins: this.parseOrigins(site.allowedOriginsJson), nodeId: site.nodeId, accessMode: site.accessMode,
      shareExpiresAt: site.shareExpiresAt, shareRotatedAt: site.shareRotatedAt, lastRequestAt: site.lastRequestAt,
      lastStatusCode: site.lastStatusCode, lastErrorCode: site.lastErrorCode, createdAt: site.createdAt, updatedAt: site.updatedAt,
      node: { ...site.node, capabilities: this.parseCapabilities(site.node.capabilitiesJson), supportsMirrorProxy: this.parseCapabilities(site.node.capabilitiesJson).includes('mirror_proxy') }
    };
  }

  private parseOrigins(raw: string): string[] { try { const value: unknown = JSON.parse(raw); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; } catch { return []; } }
  private parseCapabilities(raw: string): string[] { try { const value: unknown = JSON.parse(raw); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; } catch { return []; } }
  private hashToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
  private newShareToken() { const token = randomBytes(32).toString('base64url'); return { token, hash: this.hashToken(token) }; }
  private productionLike() { return process.env.NODE_ENV === 'production' || process.env.RIRICLOUD_ENV === 'production'; }
}
