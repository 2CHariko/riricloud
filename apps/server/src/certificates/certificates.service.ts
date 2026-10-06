import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { Certificate, Prisma } from '@prisma/client';
import AdmZip from 'adm-zip';
import { AgentService } from '../agent-gateway/agent.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCertificateDto, ParseCertificateDto, UpdateCertificateDto } from './dto/create-certificate.dto';
import { QueryCertificateDto } from './dto/query-certificate.dto';
import { decryptSecret, encryptSecret } from '../common/secret-crypto';
import { SystemLogsService } from '../system-logs/system-logs.service';
import { SettingsService } from '../system/settings.service';
import { CertificateBindingsService } from './certificate-bindings.service';
import { certificateContentHash, parseCertificateChain } from './certificate-validation';
export type CertificateStatus = 'VALID' | 'EXPIRING' | 'EXPIRED' | 'NOT_YET_VALID';
export function getCertificateStatus(from: Date, to: Date, now = new Date(), warningDays = 30): CertificateStatus {
  if (from > now)
    return 'NOT_YET_VALID';
  if (to <= now)
    return 'EXPIRED';
  return to.getTime() <= now.getTime() + warningDays * 86400000 ? 'EXPIRING' : 'VALID';
}
const includeCount = { _count: { select: { lines: true } } } as const;
type Row = Certificate & {
  _count?: {
    lines: number;
  };
};
const pageRows = <T>(rows: T[], query: QueryCertificateDto) => ({ data: rows.slice(((query.page ?? 1) - 1) * (query.pageSize ?? 20), (query.page ?? 1) * (query.pageSize ?? 20)), total: rows.length, page: query.page ?? 1, pageSize: query.pageSize ?? 20 });
@Injectable()
export class CertificatesService {
  constructor(private readonly prisma: PrismaService, private readonly agentGateway: AgentService,
  @Optional()
  private readonly bindings?: CertificateBindingsService,
  @Optional()
  private readonly settings?: SettingsService,
  @Optional()
  private readonly logs?: SystemLogsService) { }
  private audit(event: string, id: string, revision: number, operatorId?: string, result = 'SUCCESS') {
    this.logs?.enqueue({ source: 'SERVER', module: 'Certificate', level: result === 'SUCCESS' ? 'INFO' : 'WARN', userId: operatorId, message: 'Certificate operation: ' + event + ' ' + id, metadata: { event, certificateId: id, revision, result }, bypassMinIngestLevel: true });
  }
  private metadata(pem: string) {
    try {
      const { certificatePem: _pem, leafPem: _leaf, ...metadata } = parseCertificateChain(pem);
      return metadata;
    }
    catch {
      return { chainValidation: 'INVALID' as const, trustValidation: 'NOT_CHECKED' as const, chainLength: 0, chain: [], fingerprint256: null, keyType: null, selfSigned: false };
    }
  }
  private view(row: Row, warningDays = 30) {
    let sans: string[] = [];
    try {
      sans = JSON.parse(row.sansJson) as string[];
    }
    catch { /* 历史数据保留 */ }
    const metadata = row.validationJson ? JSON.parse(row.validationJson) as ReturnType<CertificatesService['metadata']> : this.metadata(row.certificatePem);
    return { id: row.id, name: row.name, subject: row.subject, issuer: row.issuer, serialNumber: row.serialNumber, sans, validFrom: row.validFrom, validTo: row.validTo, status: getCertificateStatus(row.validFrom, row.validTo, new Date(), warningDays), daysUntilExpiry: Math.ceil((row.validTo.getTime() - Date.now()) / 86400000), lineCount: row._count?.lines ?? 0, createdAt: row.createdAt, updatedAt: row.updatedAt, currentRevision: row.currentRevision, ...metadata };
  }
  private async ensure(row: Row): Promise<void> {
    // 历史记录惰性初始化，异常 PEM 保留原内容；密钥统一加密后进入历史。
    if (row.validationJson)
      return;
    let metadata = this.metadata(row.certificatePem);
    let key: string | null = null;
    try {
      key = decryptSecret(row.privateKeyPem);
    }
    catch {
      metadata = { ...metadata, chainValidation: 'INVALID' } as typeof metadata;
    }
    let hash: string | null = null;
    try {
      if (key !== null)
        hash = certificateContentHash(parseCertificateChain(row.certificatePem, key).certificatePem, key);
    }
    catch {
      metadata = { ...metadata, chainValidation: 'INVALID' } as typeof metadata;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.certificateRevision.upsert({ where: { certificateId_revision: { certificateId: row.id, revision: row.currentRevision } }, create: { certificateId: row.id, revision: row.currentRevision, certificatePem: row.certificatePem, privateKeyPem: key === null ? row.privateKeyPem : encryptSecret(key), metadataJson: JSON.stringify(metadata) }, update: {} });
      await tx.certificate.updateMany({ where: { id: row.id, validationJson: null, currentRevision: row.currentRevision }, data: { contentHash: hash, fingerprint256: metadata.fingerprint256, validationJson: JSON.stringify(metadata), updatedAt: row.updatedAt } });
    });
  }
  private async raw(id: string) {
    const row = await this.prisma.certificate.findUnique({ where: { id }, include: includeCount });
    if (!row)
      throw new NotFoundException('证书不存在');
    await this.ensure(row);
    return row.validationJson ? row : this.prisma.certificate.findUniqueOrThrow({ where: { id }, include: includeCount });
  }
  async list(query: QueryCertificateDto) {
    const search = query.search?.trim();
    const warningDays = (await this.settings?.getSettings())?.certificateExpiryWarningDays ?? 30;
    const now = new Date(), cutoff = new Date(now.getTime() + warningDays * 86400000);
    const dates: Record<string, Prisma.CertificateWhereInput> = {
      VALID: { validFrom: { lte: now }, validTo: { gt: cutoff } }, EXPIRING: { validFrom: { lte: now }, validTo: { gt: now, lte: cutoff } }, EXPIRED: { validTo: { lte: now } }, NOT_YET_VALID: { validFrom: { gt: now } }
    };
    const where: Prisma.CertificateWhereInput = { ...(search ? { OR: ['name', 'subject', 'issuer', 'sansJson'].map(key => ({ [key]: { contains: search } })) } : {}), ...(query.status ? dates[query.status] : {}), ...(query.association ? { lines: query.association === 'linked' ? { some: {} } : { none: {} } } : {}) };
    const orderBy: Prisma.CertificateOrderByWithRelationInput = query.sort === 'updated-desc' ? { updatedAt: 'desc' } : { validTo: query.sort === 'expiry-desc' ? 'desc' : 'asc' };
    const [total, rows] = await Promise.all([this.prisma.certificate.count({ where }), this.prisma.certificate.findMany({ where, include: includeCount, orderBy, skip: ((query.page ?? 1) - 1) * (query.pageSize ?? 20), take: query.pageSize ?? 20 })]);
    await Promise.all(rows.map(row => this.ensure(row)));
    return { data: rows.map(row => this.view(row, warningDays)), total, page: query.page ?? 1, pageSize: query.pageSize ?? 20 };
  }
  async summary() {
    const days = (await this.settings?.getSettings())?.certificateExpiryWarningDays ?? 30;
    const rows = await this.prisma.certificate.findMany();
    const result = { total: rows.length, expired: 0, expiring: 0, notYetValid: 0, invalid: 0, needsAttention: 0 };
    for (const row of rows) {
      let invalid = false;
      try {
        const parsed = parseCertificateChain(row.certificatePem, decryptSecret(row.privateKeyPem));
        invalid = parsed.chain.some(cert => cert.validFrom > new Date() || cert.validTo <= new Date()) && getCertificateStatus(row.validFrom, row.validTo, new Date(), days) === 'VALID';
      }
      catch {
        invalid = true;
      }
      if (!invalid && this.bindings)
        invalid = (await this.bindings.lines(row.id, row.certificatePem)).some(line => Boolean(line.validationError));
      const status = getCertificateStatus(row.validFrom, row.validTo, new Date(), days);
      if (status === 'EXPIRED')
        result.expired++;
      if (status === 'EXPIRING')
        result.expiring++;
      if (status === 'NOT_YET_VALID')
        result.notYetValid++;
      if (invalid)
        result.invalid++;
      if (invalid || status !== 'VALID')
        result.needsAttention++;
    }
    return result;
  }
  async detail(id: string, operatorId?: string, publicOnly = false) {
    const row = await this.raw(id);
    if (publicOnly)
      return { certificate: this.view(row, (await this.settings?.getSettings())?.certificateExpiryWarningDays) };
    try {
      const privateKeyPem = decryptSecret(row.privateKeyPem);
      this.audit('PRIVATE_KEY_READ', id, row.currentRevision, operatorId);
      return { certificate: { ...this.view(row, (await this.settings?.getSettings())?.certificateExpiryWarningDays), certificatePem: row.certificatePem, privateKeyPem } };
    }
    catch (error) {
      this.audit('PRIVATE_KEY_READ', id, row.currentRevision, operatorId, 'FAILED');
      throw error;
    }
  }
  async parse(dto: ParseCertificateDto) {
    const { certificatePem: _pem, leafPem: _leaf, ...parsed } = parseCertificateChain(dto.certificatePem, dto.privateKeyPem);
    const candidates = await this.prisma.certificate.findMany({ where: { OR: [{ fingerprint256: parsed.fingerprint256 }, { fingerprint256: null }] }, select: { id: true, name: true, fingerprint256: true, certificatePem: true } });
    const duplicates = candidates.filter(row => (row.fingerprint256 ?? this.metadata(row.certificatePem).fingerprint256) === parsed.fingerprint256).map(row => ({ id: row.id, name: row.name }));
    const warningDays = (await this.settings?.getSettings())?.certificateExpiryWarningDays ?? 30;
    return { ...parsed, status: getCertificateStatus(parsed.validFrom, parsed.validTo, new Date(), warningDays), daysUntilExpiry: Math.ceil((parsed.validTo.getTime() - Date.now()) / 86400000), duplicates };
  }
  async create(dto: CreateCertificateDto, operatorId?: string) {
    const parsed = parseCertificateChain(dto.certificatePem, dto.privateKeyPem), metadata = this.metadata(parsed.certificatePem);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.certificate.create({ data: { name: dto.name.trim(), certificatePem: parsed.certificatePem, privateKeyPem: encryptSecret(dto.privateKeyPem.trim()), subject: parsed.subject, issuer: parsed.issuer, serialNumber: parsed.serialNumber, sansJson: JSON.stringify(parsed.sans), validFrom: parsed.validFrom, validTo: parsed.validTo, contentHash: certificateContentHash(parsed.certificatePem, dto.privateKeyPem), fingerprint256: parsed.fingerprint256, validationJson: JSON.stringify(metadata) } });
      await tx.certificateRevision.create({ data: { certificateId: created.id, revision: 1, certificatePem: created.certificatePem, privateKeyPem: created.privateKeyPem, metadataJson: JSON.stringify(metadata), operatorId } });
      return created;
    });
    this.audit('CREATE', row.id, 1, operatorId);
    return { certificate: this.view(row) };
  }
  async associatedLines(id: string, query: QueryCertificateDto) {
    const row = await this.raw(id);
    return pageRows(await this.bindings!.lines(id, row.certificatePem), query);
  }
  async revisions(id: string, query: QueryCertificateDto) {
    await this.raw(id);
    const where = { certificateId: id };
    const [total, rows] = await Promise.all([this.prisma.certificateRevision.count({ where }), this.prisma.certificateRevision.findMany({ where, orderBy: { revision: 'desc' }, skip: ((query.page ?? 1) - 1) * (query.pageSize ?? 20), take: query.pageSize ?? 20, select: { revision: true, metadataJson: true, createdAt: true, operatorId: true } })]);
    return { data: rows.map(row => ({ ...row, metadataJson: undefined, metadata: JSON.parse(row.metadataJson) as unknown })), total };
  }
  async preview(id: string, dto: UpdateCertificateDto) {
    const row = await this.raw(id);
    const pem = dto.certificatePem ?? row.certificatePem, key = dto.privateKeyPem ?? decryptSecret(row.privateKeyPem);
    const parsed = parseCertificateChain(pem, key);
    return { expectedRevision: row.currentRevision, before: this.metadata(row.certificatePem), after: this.metadata(parsed.certificatePem), lines: await this.bindings!.lines(id, parsed.certificatePem), contentChanged: certificateContentHash(parsed.certificatePem, key) !== row.contentHash };
  }
  async update(id: string, dto: UpdateCertificateDto, operatorId?: string, event = 'UPDATE') {
    const initial = await this.raw(id);
    const result = await this.prisma.$transaction(async (tx) => {
      const row = await tx.certificate.findUniqueOrThrow({ where: { id }, include: includeCount });
      if (dto.expectedRevision !== undefined && dto.expectedRevision !== row.currentRevision)
        throw new ConflictException('证书已被其他管理员更新，请重新加载');
      if (dto.certificatePem === undefined && dto.privateKeyPem === undefined) {
        const updated = await tx.certificate.update({ where: { id }, data: { ...(dto.name !== undefined ? { name: dto.name.trim() } : {}) }, include: includeCount });
        return { row: updated, changed: false, nodeIds: [] as string[] };
      }
      const key = dto.privateKeyPem ?? decryptSecret(row.privateKeyPem), parsed = parseCertificateChain(dto.certificatePem ?? row.certificatePem, key), hash = certificateContentHash(parsed.certificatePem, key);
      if (hash === row.contentHash && event !== 'ROLLBACK')
        return { row: await tx.certificate.update({ where: { id }, data: { ...(dto.name !== undefined ? { name: dto.name.trim() } : {}) }, include: includeCount }), changed: false, nodeIds: [] as string[] };
      const lines = await this.bindings!.assertReplacement(id, parsed.certificatePem, tx);
      const revision = row.currentRevision + 1, metadata = this.metadata(parsed.certificatePem);
      const updated = await tx.certificate.update({ where: { id }, data: { name: dto.name?.trim() ?? row.name, certificatePem: parsed.certificatePem, privateKeyPem: encryptSecret(key.trim()), subject: parsed.subject, issuer: parsed.issuer, serialNumber: parsed.serialNumber, sansJson: JSON.stringify(parsed.sans), validFrom: parsed.validFrom, validTo: parsed.validTo, contentHash: hash, fingerprint256: parsed.fingerprint256, validationJson: JSON.stringify(metadata), currentRevision: revision }, include: includeCount });
      await tx.certificateRevision.create({ data: { certificateId: id, revision, certificatePem: updated.certificatePem, privateKeyPem: updated.privateKeyPem, metadataJson: JSON.stringify(metadata), operatorId } });
      await tx.certificateRevision.deleteMany({ where: { certificateId: id, revision: { lt: revision - 10 } } });
      await tx.certificateDeployment.updateMany({ where: { certificateId: id }, data: { state: 'SUPERSEDED' } });
      await tx.certificateReminder.deleteMany({ where: { certificateId: id, state: { not: 'SENT' } } });
      const nodeIds = [...new Set(lines.filter(line => line.status === 'ACTIVE').flatMap(line => line.hostingNodeIds))];
      await tx.certificateDeployment.createMany({ data: nodeIds.map(nodeId => ({ certificateId: id, revision, nodeId, state: 'WAITING' })) });
      return { row: updated, changed: true, nodeIds };
    }).catch((error: unknown) => {
      this.audit(event, id, initial.currentRevision, operatorId, 'FAILED');
      if (error && typeof error === 'object' && 'code' in error && ['P2034', 'P2028'].includes(String(error.code)))
        throw new ConflictException('并发更新冲突，请重新加载证书');
      throw error;
    });
    this.audit(result.changed ? event === 'UPDATE' ? 'REPLACE' : event : 'RENAME', id, result.row.currentRevision, operatorId);
    const sync = await Promise.all(result.nodeIds.map(async (nodeId) => ({ nodeId, synced: await this.agentGateway.pushConfig(nodeId) })));
    return { certificate: this.view(result.row), contentChanged: result.changed, affectedNodeIds: result.nodeIds, syncedNodeIds: sync.filter(row => row.synced).map(row => row.nodeId), deploymentSummary: { affected: sync.length, requested: sync.filter(row => row.synced).length } };
  }
  async rollback(id: string, revision: number, expectedRevision?: number, operatorId?: string) {
    const current = await this.raw(id);
    if (current.currentRevision === revision)
      throw new BadRequestException('当前版本无需回滚');
    const old = await this.prisma.certificateRevision.findUnique({ where: { certificateId_revision: { certificateId: id, revision } } });
    if (!old)
      throw new NotFoundException('历史版本已清理或不存在');
    const parsed = parseCertificateChain(old.certificatePem, decryptSecret(old.privateKeyPem));
    if (parsed.chain.some(cert => cert.validFrom > new Date() || cert.validTo <= new Date())) {
      this.audit('ROLLBACK', id, current.currentRevision, operatorId, 'FAILED');
      throw new BadRequestException('历史证书已过期或尚未生效，不能回滚');
    }
    return this.update(id, { certificatePem: old.certificatePem, privateKeyPem: decryptSecret(old.privateKeyPem), expectedRevision }, operatorId, 'ROLLBACK');
  }
  async deployments(id: string, query: QueryCertificateDto) {
    await this.raw(id);
    const rows = await this.prisma.certificateDeployment.findMany({ where: { certificateId: id }, orderBy: [{ revision: 'desc' }, { updatedAt: 'desc' }] });
    const nodes = await this.prisma.node.findMany({ where: { id: { in: rows.map(row => row.nodeId) } }, select: { id: true, name: true, status: true, communicationMode: true, pollIntervalSecs: true } });
    return pageRows(rows.map(dep => {
      const node = nodes.find(node => node.id === dep.nodeId), wait = Math.max(120, node?.communicationMode === 'HTTP' ? 3 * node.pollIntervalSecs : 0) * 1000;
      return { ...dep, nodeName: node?.name ?? dep.nodeId, nodeStatus: node?.status ?? 'REMOVED', state: dep.sentAt && ['SENT', 'ACCEPTED'].includes(dep.state) && Date.now() - dep.sentAt.getTime() >= wait ? 'TIMEOUT' : dep.state };
    }), query);
  }
  async retry(id: string, nodeIds?: string[], operatorId?: string) {
    const row = await this.raw(id), lines = await this.bindings!.lines(id, row.certificatePem);
    const eligible = [...new Set(lines.filter(line => line.status === 'ACTIVE').flatMap(line => line.hostingNodeIds))];
    if (nodeIds?.some(nodeId => !eligible.includes(nodeId)))
      throw new BadRequestException('节点不承载该证书');
    const results = await Promise.all((nodeIds ?? eligible).map(async (nodeId) => ({ nodeId, requested: await this.agentGateway.pushConfig(nodeId) })));
    this.audit('RETRY', id, row.currentRevision, operatorId);
    return { results };
  }
  async export(id: string, format: 'leaf' | 'fullchain' | 'private-key' | 'bundle', operatorId?: string) {
    const row = await this.raw(id);
    try {
      const parsed = parseCertificateChain(row.certificatePem);
      const key = format === 'bundle' || format === 'private-key' ? decryptSecret(row.privateKeyPem) : '';
      if (format === 'bundle') {
        const zip = new AdmZip();
        zip.addFile('certificate.pem', Buffer.from(parsed.leafPem));
        zip.addFile('fullchain.pem', Buffer.from(parsed.certificatePem));
        zip.addFile('private-key.pem', Buffer.from(key));
        const content = zip.toBuffer();
        this.audit('EXPORT_' + format.toUpperCase(), id, row.currentRevision, operatorId);
        return { filename: 'certificate-bundle.zip', contentType: 'application/zip', content };
      }
      this.audit('EXPORT_' + format.toUpperCase(), id, row.currentRevision, operatorId);
      return { filename: format + '.pem', contentType: 'application/x-pem-file', content: Buffer.from(format === 'leaf' ? parsed.leafPem : format === 'fullchain' ? parsed.certificatePem : key) };
    }
    catch (error) {
      this.audit('EXPORT_' + format.toUpperCase(), id, row.currentRevision, operatorId, 'FAILED');
      throw error;
    }
  }
  async remove(id: string, operatorId?: string) {
    await this.raw(id);
    const deleted = await this.prisma.$transaction(async (tx) => {
      const row = await tx.certificate.findUniqueOrThrow({ where: { id }, include: includeCount });
      if (row._count.lines)
        throw new ConflictException('证书仍被线路引用，解除关联后才能删除');
      return tx.certificate.delete({ where: { id } });
    });
    this.audit('DELETE', id, deleted.currentRevision, operatorId);
    return { deleted: true, id };
  }
}
