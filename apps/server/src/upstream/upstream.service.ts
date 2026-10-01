import { Injectable, Logger, NotFoundException, BadRequestException, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import type { Prisma, UpstreamSubscription, UpstreamNode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AgentGatewayService } from '../agent-gateway/agent-gateway.service';
import { encryptSecret, decryptSecret, isEncryptedSecret } from '../common/secret-crypto';
import { buildUpstreamOutbound, buildUpstreamUri, buildUpstreamClashProxy, type UpstreamConnection } from '../common/upstream-connection';
import { getUpstreamUnavailableReason } from '../common/upstream-availability';
import { stringify as stringifyYaml } from 'yaml';
import { UpstreamParserService } from './upstream-parser.service';
import { fetchUpstream, validateUpstreamUrl, validateUpstreamHeaders, UPSTREAM_FETCH_LIMITS } from './upstream-fetch';
import { CreateUpstreamDto } from './dto/create-upstream.dto';
import { UpdateUpstreamDto } from './dto/update-upstream.dto';
import { QueryUpstreamDto } from './dto/query-upstream.dto';
import { QueryUpstreamNodeDto } from './dto/query-upstream-node.dto';
import { ExportUpstreamNodesDto } from './dto/export-upstream-nodes.dto';
import type { UpstreamNodeStatus } from '../common/constants';
import type { ParseResult, ParsedUpstreamNode, UpstreamUserInfo } from './upstream.types';
import { readLastProbe } from '../probe/probe-result';
import { nodeProbeVersion, probeHash } from '../probe/probe-resource.service';

type NodeWithRelations = UpstreamNode & {
  subscription?: Pick<UpstreamSubscription, 'id' | 'name' | 'status' | 'updatedAt' | 'userInfoUsedBytes' | 'userInfoTotalBytes' | 'userInfoExpireAt'> | null;
  relayLines?: Array<{ id: string; name: string; status: string }>;
};
type SyncSummary = { success: true; created: number; updated: number; missing: number; nodeCount: number; format: string; diagnostics: ParseResult['diagnostics']; userInfo: { uploadBytes: string | null; downloadBytes: string | null; usedBytes: string | null; totalBytes: string | null; expireAt: string | null } | null };
type SyncPhase = 'QUEUED' | 'FETCHING' | 'PARSING' | 'COMMITTING' | 'IDLE';
const PAGE_BATCH = 100;
const MAX_CONCURRENT_SYNCS = 4;

function seal(value: string): string {
  if (!value || isEncryptedSecret(value)) throw new BadRequestException('秘密字段必须提供非空明文');
  return encryptSecret(value);
}
function unseal(value: string): string {
  if (!isEncryptedSecret(value)) throw new BadRequestException('上游秘密未加密；需要重新导入');
  try { return decryptSecret(value); } catch { throw new BadRequestException('上游秘密解密失败'); }
}
function tagsOf(value: string): string[] {
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []; } catch { return []; }
}

@Injectable()
export class UpstreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UpstreamService.name);
  private syncTimer?: NodeJS.Timeout;
  private stopping = false;
  private sweeping = false;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly syncs = new Map<string, Promise<SyncSummary>>();
  private readonly phases = new Map<string, SyncPhase>();
  private readonly controllers = new Set<AbortController>();
  private activeSyncs = 0;
  private readonly slots: Array<() => void> = [];
  private readonly expired = new Set<string>();

  constructor(private readonly prisma: PrismaService, private readonly parser: UpstreamParserService, @Optional() private readonly agentGateway?: AgentGatewayService) {}

  onModuleInit() {
    void this.checkScheduledSync();
    this.syncTimer = setInterval(() => { void this.checkScheduledSync(); }, 60_000);
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.syncTimer) clearInterval(this.syncTimer);
    for (const controller of this.controllers) controller.abort();
    while (this.slots.length) this.slots.shift()!();
    await Promise.allSettled([...this.locks.values()]);
  }

  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => {
      if (this.stopping) throw new BadRequestException('上游服务正在关闭');
      return operation();
    });
    this.locks.set(id, task);
    void task.finally(() => { if (this.locks.get(id) === task) this.locks.delete(id); }).catch(() => undefined);
    return task;
  }
  private async acquireSlot() {
    if (this.activeSyncs >= MAX_CONCURRENT_SYNCS) await new Promise<void>((resolve) => this.slots.push(resolve));
    else this.activeSyncs++;
    if (this.stopping) { this.releaseSlot(); throw new BadRequestException('上游服务正在关闭'); }
  }
  private releaseSlot() {
    const next = this.slots.shift();
    if (next) next(); else this.activeSyncs = Math.max(0, this.activeSyncs - 1);
  }
  private notify() {
    try { void this.agentGateway?.pushConfigToAll()?.catch(() => this.logger.error('Upstream configuration notification failed after commit')); } catch { this.logger.error('Upstream configuration notification failed after commit'); }
  }

  async list(query: QueryUpstreamDto) {
    const page = query.page ?? 1, pageSize = query.pageSize ?? 20;
    const where: Prisma.UpstreamSubscriptionWhereInput = { ...(query.search ? { name: { contains: query.search } } : {}), ...(query.status ? { status: query.status } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.upstreamSubscription.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.upstreamSubscription.count({ where })
    ]);
    return { data: rows.map((row) => this.toSubscriptionView(row)), total, page, pageSize };
  }
  async detail(id: string) { return { subscription: this.toSubscriptionView(await this.findSubOrThrow(id), true) }; }
  async syncStatus(id: string) {
    const sub = await this.findSubOrThrow(id);
    return { phase: this.phases.get(id) ?? 'IDLE', lastSyncAt: sub.lastSyncAt, lastSuccessAt: sub.lastSuccessAt, lastSyncStatus: sub.lastSyncStatus, lastSyncMessage: sub.lastSyncMessage };
  }

  private validateSource(sourceType: string, url: string | null, content: string | null, headers: Record<string, string>) {
    try {
      if (sourceType === 'URL') { if (!url) throw new Error('URL 来源必须提供 URL'); validateUpstreamUrl(url); }
      else if (sourceType === 'TEXT') { if (!content?.trim()) throw new Error('文本来源必须提供非空内容'); }
      else throw new Error('来源类型无效');
      if (content && Buffer.byteLength(content) > UPSTREAM_FETCH_LIMITS.maxBytes) throw new Error('源内容超限');
      validateUpstreamHeaders(headers);
    } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : '来源配置无效'); }
  }
  async create(dto: CreateUpstreamDto) {
    const sourceType = dto.sourceType ?? 'URL';
    const url = dto.url?.trim() || null, content = dto.content || null, customHeaders = dto.customHeaders ?? {};
    if (!dto.name.trim()) throw new BadRequestException('订阅名称不能为空');
    this.validateSource(sourceType, url, content, customHeaders);
    const created = await this.prisma.upstreamSubscription.create({ data: {
      name: dto.name.trim(), sourceType, format: dto.format ?? 'AUTO',
      url: sourceType === 'URL' ? seal(url!) : null, content: sourceType === 'TEXT' ? seal(content!) : null,
      customHeadersJson: seal(JSON.stringify(customHeaders)), autoUpdate: dto.autoUpdate ?? true,
      updateIntervalMins: dto.updateIntervalMins ?? 720, status: dto.status ?? 'ACTIVE'
    } });
    if (created.status === 'ACTIVE') void this.sync(created.id).catch(() => this.logger.warn(`Initial upstream sync failed: ${created.id}`));
    return { subscription: this.toSubscriptionView(created) };
  }
  update(id: string, dto: UpdateUpstreamDto) {
    return this.serial(id, async () => {
      const current = await this.findSubOrThrow(id);
      const sourceType = dto.sourceType ?? current.sourceType;
      const url = dto.url !== undefined ? dto.url.trim() || null : current.url ? unseal(current.url) : null;
      const content = dto.content !== undefined ? dto.content : current.content ? unseal(current.content) : null;
      const headers = dto.customHeaders ?? JSON.parse(unseal(current.customHeadersJson)) as Record<string, string>;
      this.validateSource(sourceType, url, content, headers);
      if (dto.content !== undefined && !dto.content.trim()) throw new BadRequestException('替换内容不能为空；请省略以保留原内容');
      const data: Prisma.UpstreamSubscriptionUpdateInput = {};
      if (dto.name !== undefined) { if (!dto.name.trim()) throw new BadRequestException('订阅名称不能为空'); data.name = dto.name.trim(); }
      if (dto.sourceType !== undefined) { data.sourceType = sourceType; if (sourceType === 'TEXT') data.url = null; }
      if (sourceType !== current.sourceType) {
        data.userInfoUsedBytes = null; data.userInfoTotalBytes = null; data.userInfoExpireAt = null;
      }
      if (dto.format !== undefined) data.format = dto.format;
      if (dto.url !== undefined) data.url = sourceType === 'URL' ? seal(url!) : null;
      if (dto.content !== undefined) data.content = content ? seal(content) : null;
      if (dto.customHeaders !== undefined) data.customHeadersJson = seal(JSON.stringify(headers));
      if (dto.autoUpdate !== undefined) data.autoUpdate = dto.autoUpdate;
      if (dto.updateIntervalMins !== undefined) data.updateIntervalMins = dto.updateIntervalMins;
      if (dto.status !== undefined) data.status = dto.status;
      const updated = await this.prisma.upstreamSubscription.update({ where: { id }, data });
      if ((dto.status !== undefined && dto.status !== current.status) || sourceType !== current.sourceType) this.notify();
      return { subscription: this.toSubscriptionView(updated) };
    });
  }
  remove(id: string) {
    return this.serial(id, async () => {
      await this.findSubOrThrow(id);
      await this.prisma.$transaction(async (tx) => {
        await tx.line.updateMany({ where: { upstreamNode: { subscriptionId: id } }, data: { status: 'DISABLED', upstreamNodeId: null } });
        await tx.upstreamSubscription.delete({ where: { id } });
      });
      this.notify(); this.phases.delete(id); this.expired.delete(id);
      return { deleted: true, id };
    });
  }

  sync(id: string): Promise<SyncSummary> {
    const active = this.syncs.get(id);
    if (active) return active;
    this.phases.set(id, 'QUEUED');
    const task = this.serial(id, async () => {
      await this.acquireSlot();
      try { return await this.performSync(id); } finally { this.releaseSlot(); }
    });
    this.syncs.set(id, task);
    void task.finally(() => { if (this.syncs.get(id) === task) this.syncs.delete(id); this.phases.set(id, 'IDLE'); }).catch(() => undefined);
    return task;
  }
  private async performSync(id: string): Promise<SyncSummary> {
    const sub = await this.findSubOrThrow(id);
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      if (sub.status !== 'ACTIVE') throw new BadRequestException('禁用的上游源不能同步');
      let raw = sub.content ? unseal(sub.content) : '';
      let userInfo: UpstreamUserInfo | null = null;
      if (sub.sourceType === 'URL') {
        this.phases.set(id, 'FETCHING');
        if (!sub.url) throw new BadRequestException('上游源未配置 URL');
        const response = await fetchUpstream(unseal(sub.url), JSON.parse(unseal(sub.customHeadersJson)) as Record<string, string>, controller.signal);
        raw = response.content;
        userInfo = this.parser.parseUserInfoHeader(response.userInfo);
      }
      if (this.stopping) throw new BadRequestException('上游服务正在关闭');
      this.phases.set(id, 'PARSING');
      const parsed = this.parser.parse(raw, sub.format);
      this.phases.set(id, 'COMMITTING');
      const result = await this.commitSnapshot(sub, parsed, raw, userInfo);
      if (result.notify) this.notify();
      this.expired.delete(id);
      return { success: true, ...result.counts, nodeCount: parsed.nodes.length, format: parsed.format, diagnostics: parsed.diagnostics,
        userInfo: userInfo ? { uploadBytes: userInfo.uploadBytes?.toString() ?? null, downloadBytes: userInfo.downloadBytes?.toString() ?? null, usedBytes: userInfo.usedBytes?.toString() ?? null, totalBytes: userInfo.totalBytes?.toString() ?? null, expireAt: userInfo.expireAt?.toISOString() ?? null } : null };
    } catch (error) {
      // 只允许本域已脱敏的解析诊断进入 API；底层异常（含 URL/数据库参数）统一隐藏。
      const message = error instanceof BadRequestException ? error.message : '上游拉取或快照提交失败';
      await this.prisma.upstreamSubscription.update({ where: { id }, data: { lastSyncAt: new Date(), lastSyncStatus: 'FAILED', lastSyncMessage: message } });
      this.logger.warn(`Upstream sync failed: ${id}`);
      throw new BadRequestException(message);
    } finally { this.controllers.delete(controller); }
  }

  private matchSnapshot(existing: UpstreamNode[], incoming: ParsedUpstreamNode[]) {
    const matches = new Map<ParsedUpstreamNode, UpstreamNode>();
    const used = new Set<string>();
    const stages: Array<(node: ParsedUpstreamNode | UpstreamNode) => string | null> = [
      (node) => node.sourceKey || null,
      (node) => node.connectionHash,
      (node) => `${node.protocolType}\0${node.name}`
    ];
    for (const [stage, keyOf] of stages.entries()) {
      const oldGroups = new Map<string, UpstreamNode[]>(), newGroups = new Map<string, ParsedUpstreamNode[]>();
      for (const node of existing) { const key = keyOf(node); if (key && !used.has(node.id)) oldGroups.set(key, [...(oldGroups.get(key) ?? []), node]); }
      for (const node of incoming) { const key = keyOf(node); if (key && !matches.has(node)) newGroups.set(key, [...(newGroups.get(key) ?? []), node]); }
      for (const [key, nodes] of newGroups) {
        const candidates = oldGroups.get(key) ?? [];
        if (stage === 2 && candidates.length && (incoming.filter((node) => keyOf(node) === key).length !== 1 || existing.filter((node) => keyOf(node) === key).length !== 1)) throw new BadRequestException('节点名称匹配存在歧义；快照未提交');
        if (candidates.length && (nodes.length !== 1 || candidates.length !== 1)) throw new BadRequestException('节点身份匹配存在歧义；快照未提交');
        if (candidates.length === 1) { matches.set(nodes[0], candidates[0]); used.add(candidates[0].id); }
      }
    }
    const sourceKeys = incoming.map((node) => node.sourceKey).filter(Boolean);
    if (new Set(sourceKeys).size !== sourceKeys.length) throw new BadRequestException('源内节点 ID 存在歧义；快照未提交');
    return { matches, missing: existing.filter((node) => !used.has(node.id) && node.presenceStatus !== 'MISSING') };
  }
  private commitSnapshot(sub: UpstreamSubscription, parsed: ParseResult, raw: string, userInfo: UpstreamUserInfo | null) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.upstreamNode.findMany({ where: { subscriptionId: sub.id } });
      const { matches, missing } = this.matchSnapshot(existing, parsed.nodes);
      const counts = { created: 0, updated: 0, missing: missing.length };
      let notify = missing.length > 0;
      for (const node of parsed.nodes) {
        const old = matches.get(node);
        const data = { name: node.name, protocolType: node.protocolType, serverHost: node.serverHost, serverPort: node.serverPort,
          sourceKey: node.sourceKey ?? null, connectionHash: node.connectionHash, configHash: node.configHash,
          paramsJson: seal(JSON.stringify(node.params)), rawConfigJson: seal(JSON.stringify(node.rawConfig)), tagsJson: JSON.stringify(node.tags), presenceStatus: 'PRESENT', missingSince: null };
        if (old) {
          if (old.configHash !== node.configHash || old.presenceStatus !== 'PRESENT' || old.sourceKey !== data.sourceKey) {
            await tx.upstreamNode.update({ where: { id: old.id }, data: { ...data, lastProbeJson: null, latencyMs: null, lastTestStatus: null, lastTestMessage: null, lastTestedAt: null } }); counts.updated++;
            await tx.line.updateMany({ where: { upstreamNodeId: old.id }, data: { lastProbeJson: null, lastLatencyMs: null, lastTestStatus: null, lastTestMessage: null, lastTestedAt: null } });
          }
          if (old.connectionHash !== node.connectionHash || old.presenceStatus !== 'PRESENT') notify = true;
        } else { await tx.upstreamNode.create({ data: { subscriptionId: sub.id, ...data, status: 'ACTIVE' } }); counts.created++; notify = true; }
      }
      if (missing.length) {
        for (let offset = 0; offset < missing.length; offset += PAGE_BATCH) {
          const ids = missing.slice(offset, offset + PAGE_BATCH).map((node) => node.id);
          await tx.upstreamNode.updateMany({ where: { id: { in: ids } }, data: { presenceStatus: 'MISSING', missingSince: new Date(), lastProbeJson: null, latencyMs: null, lastTestStatus: null, lastTestMessage: null, lastTestedAt: null } });
          await tx.line.updateMany({ where: { upstreamNodeId: { in: ids } }, data: { status: 'DISABLED' } });
        }
      }
      const used = userInfo?.usedBytes ?? null, total = userInfo?.totalBytes ?? null, expire = userInfo?.expireAt ?? null;
      if (sub.userInfoUsedBytes !== used || sub.userInfoTotalBytes !== total || sub.userInfoExpireAt?.getTime() !== expire?.getTime()) notify = true;
      const now = new Date();
      await tx.upstreamSubscription.update({ where: { id: sub.id }, data: { content: seal(raw), detectedFormat: parsed.format, lastSyncAt: now, lastSuccessAt: now,
        lastSyncStatus: 'SUCCESS', lastSyncMessage: null, nodeCount: parsed.nodes.length, userInfoUsedBytes: used, userInfoTotalBytes: total, userInfoExpireAt: expire } });
      return { counts, notify };
    }, { isolationLevel: 'Serializable', timeout: 10_000 });
  }

  async listNodes(query: QueryUpstreamNodeDto) {
    const page = query.page ?? 1, pageSize = query.pageSize ?? 50;
    const where: Prisma.UpstreamNodeWhereInput = {};
    if (query.subscriptionId) where.subscriptionId = query.subscriptionId;
    if (query.search) where.name = { contains: query.search };
    if (query.protocolType) where.protocolType = query.protocolType.toUpperCase();
    if (query.status) where.status = query.status;
    if (query.presenceStatus) where.presenceStatus = query.presenceStatus;
    let filteredTotal: number | undefined;
    if (query.tag) {
      // 精确扫描标签后仅用本页 ID 查询，避免大型 IN 超过 SQLite 参数上限。
      const ids: string[] = [];
      let cursor: string | undefined;
      filteredTotal = 0;
      const start = (page - 1) * pageSize;
      while (true) {
        const batch = await this.prisma.upstreamNode.findMany({ where, select: { id: true, tagsJson: true }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: PAGE_BATCH, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
        for (const node of batch) {
          if (!tagsOf(node.tagsJson).some((tag) => tag.toLowerCase() === query.tag!.toLowerCase())) continue;
          if (filteredTotal >= start && ids.length < pageSize) ids.push(node.id);
          filteredTotal++;
        }
        if (batch.length < PAGE_BATCH) break;
        cursor = batch[batch.length - 1].id;
      }
      where.id = { in: ids };
    }
    const [rows, total] = await Promise.all([
      this.prisma.upstreamNode.findMany({ where, include: { subscription: { select: { id: true, name: true, status: true, updatedAt: true, userInfoUsedBytes: true, userInfoTotalBytes: true, userInfoExpireAt: true } }, relayLines: { select: { id: true, name: true, status: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: filteredTotal === undefined ? (page - 1) * pageSize : 0, take: pageSize }),
      filteredTotal ?? this.prisma.upstreamNode.count({ where })
    ]);
    return { data: rows.map((node) => this.toNodeView(node)), total, page, pageSize };
  }
  async setNodeStatus(id: string, status: UpstreamNodeStatus) {
    if (!['ACTIVE', 'DISABLED'].includes(status)) throw new BadRequestException('节点状态无效');
    const node = await this.findNodeOrThrow(id);
    return this.serial(node.subscriptionId, async () => {
      const updated = await this.prisma.$transaction(async (tx) => {
        const current = await tx.upstreamNode.findUnique({ where: { id } });
        if (!current) throw new NotFoundException('上游节点不存在');
        const result = await tx.upstreamNode.update({ where: { id }, data: { status, lastProbeJson: null, latencyMs: null, lastTestedAt: null, lastTestStatus: null, lastTestMessage: null } });
        if (status === 'DISABLED') await tx.line.updateMany({ where: { upstreamNodeId: id }, data: { status: 'DISABLED' } });
        return result;
      });
      this.notify(); return { node: this.toNodeView(updated) };
    });
  }


  async exportNodes(dto: ExportUpstreamNodesDto): Promise<{ contentType: string; body: string; count: number }> {
    const where: Prisma.UpstreamNodeWhereInput = { status: 'ACTIVE', presenceStatus: 'PRESENT' };
    if (dto.nodeIds) where.id = { in: dto.nodeIds.split(',').map((id) => id.trim()) };
    if (dto.subscriptionId) where.subscriptionId = dto.subscriptionId;
    const nodes = await this.prisma.upstreamNode.findMany({ where, include: { subscription: true }, orderBy: { createdAt: 'desc' } });
    const connections = nodes.filter((node) => !getUpstreamUnavailableReason(node)).map((node) => ({ node, connection: { protocolType: node.protocolType, serverHost: node.serverHost, serverPort: node.serverPort, params: JSON.parse(unseal(node.paramsJson)) as Record<string, unknown> } satisfies UpstreamConnection }));
    if (dto.nodeIds && connections.length !== new Set(dto.nodeIds.split(',').map((id) => id.trim())).size) throw new BadRequestException('选定节点不存在或不可用');
    try {
      if (dto.format === 'json') return { contentType: 'application/json; charset=utf-8', body: JSON.stringify({ outbounds: connections.map(({ node, connection }) => buildUpstreamOutbound(connection, node.name)) }, null, 2), count: connections.length };
      if (dto.format === 'clash') return { contentType: 'application/yaml; charset=utf-8', body: stringifyYaml({ proxies: connections.map(({ node, connection }) => buildUpstreamClashProxy(connection, node.name)) }), count: connections.length };
      return { contentType: 'text/plain; charset=utf-8', body: connections.map(({ node, connection }) => buildUpstreamUri(connection, node.name)).join('\n'), count: connections.length };
    } catch { throw new BadRequestException('选定节点不支持所请求导出格式'); }
  }

  private async checkScheduledSync() {
    if (this.sweeping || this.stopping) return;
    this.sweeping = true;
    try {
      const active = await this.prisma.upstreamSubscription.findMany({ where: { status: 'ACTIVE' } });
      const now = Date.now();
      for (const sub of active) {
        if (sub.userInfoExpireAt && sub.userInfoExpireAt.getTime() <= now && !this.expired.has(sub.id)) { this.expired.add(sub.id); this.notify(); }
      }
      const due = active.filter((sub) => sub.sourceType === 'URL' && sub.autoUpdate && !this.syncs.has(sub.id) && now - (sub.lastSyncAt?.getTime() ?? 0) >= sub.updateIntervalMins * 60_000);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_SYNCS, due.length) }, async () => {
        while (next < due.length && !this.stopping) { const sub = due[next++]; await this.sync(sub.id).catch(() => undefined); }
      }));
    } catch { this.logger.error('Upstream scheduled sweep failed'); } finally { this.sweeping = false; }
  }

  private toSubscriptionView(sub: UpstreamSubscription, reveal = false) {
    const headers = JSON.parse(unseal(sub.customHeadersJson)) as Record<string, string>;
    return {
      id: sub.id, name: sub.name, sourceType: sub.sourceType, format: sub.format, detectedFormat: sub.detectedFormat,
      url: sub.url ? reveal ? unseal(sub.url) : '***' : null, hasContent: Boolean(sub.content),
      ...(reveal ? { content: sub.content ? unseal(sub.content) : null } : {}),
      customHeaders: reveal ? headers : Object.fromEntries(Object.keys(headers).map((key) => [key, '***'])),
      autoUpdate: sub.autoUpdate, updateIntervalMins: sub.updateIntervalMins,
      lastSyncAt: sub.lastSyncAt?.toISOString() ?? null, lastSuccessAt: sub.lastSuccessAt?.toISOString() ?? null,
      lastSyncStatus: sub.lastSyncStatus, lastSyncMessage: sub.lastSyncMessage,
      userInfoUsedBytes: sub.userInfoUsedBytes?.toString() ?? null, userInfoTotalBytes: sub.userInfoTotalBytes?.toString() ?? null,
      userInfoExpireAt: sub.userInfoExpireAt?.toISOString() ?? null, nodeCount: sub.nodeCount, status: sub.status,
      createdAt: sub.createdAt.toISOString(), updatedAt: sub.updatedAt.toISOString()
    };
  }
  private toNodeView(node: NodeWithRelations) {
    const source = node.subscription;
    const available = node.status === 'ACTIVE' && node.presenceStatus === 'PRESENT' && source?.status === 'ACTIVE' && (!source.userInfoExpireAt || source.userInfoExpireAt.getTime() > Date.now()) && !(source.userInfoTotalBytes !== null && source.userInfoTotalBytes > 0n && source.userInfoUsedBytes !== null && source.userInfoUsedBytes >= source.userInfoTotalBytes);
    const lastProbe = readLastProbe(node.lastProbeJson, available, probeHash(nodeProbeVersion({ ...node, subscription: source ?? null })));
    return { id: node.id, subscriptionId: node.subscriptionId, subscription: node.subscription ? { id: node.subscription.id, name: node.subscription.name, status: node.subscription.status } : null,
      name: node.name, protocolType: node.protocolType, serverHost: node.serverHost, serverPort: node.serverPort, tags: tagsOf(node.tagsJson),
      sourceKey: node.sourceKey, presenceStatus: node.presenceStatus, missingSince: node.missingSince?.toISOString() ?? null,
      lastProbe, latencyMs: lastProbe?.latencyMs ?? null, lastTestedAt: lastProbe?.testedAt ?? null, lastTestStatus: lastProbe?.status ?? null, lastTestMessage: lastProbe?.message ?? null,
      status: node.status, relayLines: node.relayLines?.map((line) => ({ id: line.id, name: line.name, status: line.status })) ?? [],
      createdAt: node.createdAt.toISOString(), updatedAt: node.updatedAt.toISOString() };
  }
  private async findSubOrThrow(id: string) { const sub = await this.prisma.upstreamSubscription.findUnique({ where: { id } }); if (!sub) throw new NotFoundException('上游订阅不存在'); return sub; }
  private async findNodeOrThrow(id: string) { const node = await this.prisma.upstreamNode.findUnique({ where: { id } }); if (!node) throw new NotFoundException('上游节点不存在'); return node; }
}
