import { Injectable, Optional } from '@nestjs/common';
import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { decryptSecret } from '../common/secret-crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SystemLogsService } from '../system-logs/system-logs.service';
import { resolveLineTags } from '../common/line-tags';
import type { ConfigApplyResultData, ConfigSyncData, HeartbeatData } from '../agent-gateway/agent-message';
type Dependency = {
  id: string;
  revision: number;
  controlled: boolean;
};
type ConfigCertificateLine = {
  id: string;
  tag?: string | null;
  type: string;
  relayMode?: string | null;
  entryNodeId: string | null;
  landingNodeId: string | null;
  certificateId?: string | null;
  certificate?: {
    id?: string;
    currentRevision?: number;
    certificatePem: string;
    privateKeyPem: string;
  } | null;
};
function normalizedPem(value: unknown): string {
  try {
    return (Array.isArray(value) ? value.join('\n') : String(value)).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)?.map(pem => new X509Certificate(pem).raw.toString('base64')).join(':') ?? '';
  }
  catch {
    return '';
  }
}
function matchingKey(value: unknown, encrypted: string): boolean {
  try {
    const key = Array.isArray(value) ? value.join('\n') : String(value);
    return createPublicKey(createPrivateKey(key)).export({ type: 'spki', format: 'der' }).equals(createPublicKey(createPrivateKey(decryptSecret(encrypted))).export({ type: 'spki', format: 'der' }));
  }
  catch {
    return false;
  }
}
@Injectable()
export class CertificateTrackingService {
  private readonly sources = new WeakMap<ConfigSyncData, ConfigCertificateLine[]>();
  constructor(private readonly prisma: PrismaService,
  @Optional()
  private readonly logs?: SystemLogsService) { }
  remember(payload: ConfigSyncData, lines: ConfigCertificateLine[]) { this.sources.set(payload, lines); }
  async capture(nodeId: string, payload: ConfigSyncData) {
    const lines = this.sources.get(payload) ?? await this.prisma.line.findMany({ where: { certificateId: { not: null }, status: 'ACTIVE', OR: [{ entryNodeId: nodeId }, { landingNodeId: nodeId }] }, include: { certificate: true } });
    const inbounds = payload.singboxConfig.inbounds as Array<{
      tag?: string;
      tls?: {
        certificate?: unknown;
        key?: unknown;
      };
    }> ?? [];
    const deps = new Map<string, Dependency>();
    for (const line of lines) {
      if (!line.certificate)
        continue;
      const tags = resolveLineTags(line);
      const tag = line.type === 'DIRECT' ? tags.direct : line.entryNodeId === nodeId ? tags.entry : tags.landing;
      // 盲转发入口不终止 TLS，不能计为承载证书的节点。
      if (line.relayMode === 'BLIND_FORWARD' && line.entryNodeId === nodeId)
        continue;
      if (!tag)
        continue;
      const inbound = inbounds.find(row => row.tag === tag);
      const controlled = Boolean(inbound && normalizedPem(inbound.tls?.certificate) && normalizedPem(inbound.tls?.certificate) === normalizedPem(line.certificate.certificatePem) && matchingKey(inbound.tls?.key, line.certificate.privateKeyPem));
      const id = line.certificateId ?? line.certificate.id;
      if (!id || !line.certificate.currentRevision)
        continue;
      const old = deps.get(id);
      deps.set(id, { id, revision: line.certificate.currentRevision, controlled: controlled && (old?.controlled ?? true) });
    }
    const dependencies = [...deps.values()];
    await this.prisma.certificateConfigSnapshot.upsert({ where: { nodeId_configVersion: { nodeId, configVersion: payload.version } }, create: { nodeId, configVersion: payload.version, dependenciesJson: JSON.stringify(dependencies) }, update: {} });
    await this.prisma.certificateDeployment.updateMany({ where: { nodeId, certificateId: { notIn: dependencies.map(dep => dep.id) }, OR: [{ configVersion: null }, { configVersion: { lt: payload.version } }] }, data: { state: 'SUPERSEDED' } });
    for (const dep of dependencies) {
      const current = await this.prisma.certificate.findUnique({ where: { id: dep.id }, select: { currentRevision: true } });
      if (current?.currentRevision !== dep.revision)
        continue;
      const existing = await this.prisma.certificateDeployment.findUnique({ where: { certificateId_revision_nodeId: { certificateId: dep.id, revision: dep.revision, nodeId } } });
      if (existing?.configVersion !== null && existing?.configVersion !== undefined && existing.configVersion >= payload.version)
        continue;
      await this.prisma.certificateDeployment.updateMany({ where: { certificateId: dep.id, nodeId, revision: { not: dep.revision } }, data: { state: 'SUPERSEDED' } });
      await this.prisma.certificateDeployment.upsert({ where: { certificateId_revision_nodeId: { certificateId: dep.id, revision: dep.revision, nodeId } }, create: { certificateId: dep.id, revision: dep.revision, nodeId, configVersion: payload.version, state: dep.controlled ? 'WAITING' : 'UNMANAGED' }, update: { configVersion: payload.version, state: dep.controlled ? 'WAITING' : 'UNMANAGED', error: null, sentAt: null, confirmedAt: null } });
    }
    // 每节点只保留最近 100 个无秘密映射；未完成分发关联快照不能清除。
    const old = await this.prisma.certificateConfigSnapshot.findMany({ where: { nodeId }, orderBy: { configVersion: 'desc' }, skip: 100, select: { id: true, configVersion: true } });
    if (old.length) {
      const pending = await this.prisma.certificateDeployment.findMany({ where: { nodeId, state: { in: ['WAITING', 'SENT', 'ACCEPTED', 'TIMEOUT'] } }, select: { configVersion: true } });
      await this.prisma.certificateConfigSnapshot.deleteMany({ where: { id: { in: old.filter(row => !pending.some(dep => dep.configVersion === row.configVersion)).map(row => row.id) } } });
    }
  }
  async sent(nodeId: string, version: number) {
    await this.prisma.certificateDeployment.updateMany({ where: { nodeId, configVersion: version, state: 'WAITING' }, data: { state: 'SENT', sentAt: new Date() } });
  }
  async accepted(nodeId: string, result: ConfigApplyResultData) {
    const failures = !result.success ? await this.prisma.certificateDeployment.findMany({ where: { nodeId, configVersion: result.version, state: { in: ['SENT', 'ACCEPTED', 'TIMEOUT', 'UNCONFIRMED'] } }, select: { certificateId: true, revision: true } }) : [];
    await this.prisma.certificateDeployment.updateMany({ where: { nodeId, configVersion: result.version, state: { in: ['SENT', 'ACCEPTED', 'TIMEOUT', 'UNCONFIRMED'] } }, data: { state: result.success ? 'ACCEPTED' : 'FAILED', error: result.success ? null : 'Agent rejected the node configuration' } });
    for (const dep of failures)
      this.logs?.enqueue({ source: 'SERVER', module: 'Certificate', level: 'WARN', nodeId, message: 'Certificate configuration rejected: ' + dep.certificateId, metadata: { certificateId: dep.certificateId, revision: dep.revision, configVersion: result.version, result: 'FAILED' } });
  }
  async heartbeat(nodeId: string, data: HeartbeatData) {
    if (data.appliedConfigVersion === undefined || data.kernelRunning === undefined) {
      await this.prisma.certificateDeployment.updateMany({ where: { nodeId, state: { in: ['SENT', 'ACCEPTED'] } }, data: { state: 'UNCONFIRMED' } });
      return;
    }
    const snapshot = await this.prisma.certificateConfigSnapshot.findUnique({ where: { nodeId_configVersion: { nodeId, configVersion: data.appliedConfigVersion } } });
    if (!snapshot)
      return;
    const deps = JSON.parse(snapshot.dependenciesJson) as Dependency[];
    for (const dep of deps.filter(row => row.controlled)) {
      const current = await this.prisma.certificate.findUnique({ where: { id: dep.id }, select: { currentRevision: true } });
      if (current?.currentRevision !== dep.revision)
        continue;
      const previous = await this.prisma.certificateDeployment.findUnique({ where: { certificateId_revision_nodeId: { certificateId: dep.id, revision: dep.revision, nodeId } }, select: { state: true, configVersion: true } });
      await this.prisma.certificateDeployment.updateMany({ where: { certificateId: dep.id, revision: dep.revision, nodeId, configVersion: data.appliedConfigVersion, state: { notIn: ['SUPERSEDED', 'UNMANAGED'] } }, data: { state: data.kernelRunning && !data.lastError ? 'CONFIRMED' : 'FAILED', confirmedAt: data.kernelRunning && !data.lastError ? new Date() : null, error: data.lastError || !data.kernelRunning ? 'Kernel runtime not confirmed' : null } });
      if ((!data.kernelRunning || data.lastError) && previous && previous.configVersion === data.appliedConfigVersion && !['FAILED', 'SUPERSEDED', 'UNMANAGED'].includes(previous.state))
        this.logs?.enqueue({ source: 'SERVER', module: 'Certificate', level: 'WARN', nodeId, message: 'Certificate runtime failed: ' + dep.id, metadata: { certificateId: dep.id, revision: dep.revision, configVersion: data.appliedConfigVersion, result: 'FAILED' } });
    }
  }
}
