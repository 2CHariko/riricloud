import { ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma, type LineCredentialRotation } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SystemLogsService } from '../system-logs/system-logs.service';
import type { ConfigApplyResultData, ConfigSyncData, HeartbeatData } from '../agent-gateway/agent-message';
import { proveRelayConfiguration } from './line-credential-config-proof';
import { configDiagnosticSecrets, redactConfigDiagnostic, type ConfigDiagnosticSecrets } from './line-credential-diagnostics';
import { resolveLineTags } from '../common/line-tags';
import { relayLineSelect, relayTopology, type RelayLine } from './line-credential-topology';
import { credentialFingerprint, credentialVersionForRotation, expectedRotationNode, newRelayCredential, revealRelayCredential, ROTATION_STAGE_TIMEOUT_MS, RUNNING_ROTATION_STAGES, type RelayCredentialView } from './line-credential.types';

const credentialLineSelect = { ...relayLineSelect, tag: true, targetLine: { select: { ...relayLineSelect.targetLine.select, tag: true } } } as const;

@Injectable()
export class LineCredentialsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LineCredentialsService.name);
  private dispatcher?: (ids: string[]) => Promise<void>;
  private timer?: NodeJS.Timeout;
  private work?: Promise<void>;
  private stopped = false;
  private readonly lineLocks = new Map<string, Promise<LineCredentialRotation>>();
  private readonly snapshots = new WeakMap<ConfigSyncData, RelayCredentialView[]>();
  private readonly diagnostics = new Map<string, { secrets: ConfigDiagnosticSecrets; bytes: number }>();
  private diagnosticBytes = 0;
  constructor(private readonly prisma: PrismaService, @Optional() private readonly logs?: SystemLogsService) {}
  setDispatcher(dispatcher: (ids: string[]) => Promise<void>) { this.dispatcher = dispatcher; }

  async onModuleInit() {
    // 重启后须重新下发本进程生成的配置；不能凭前一进程未完成的回执推进阶段。
    await this.prisma.lineCredentialRotation.updateMany({ where: { stage: { in: [...RUNNING_ROTATION_STAGES, 'FAILED'] } }, data: { expectedConfigVersion: null, expectedNodeId: null, accepted: false } });
    this.timer = setInterval(() => { if (!this.work) this.work = this.sweep().catch(() => this.logger.warn('Relay credential reconciliation failed')).finally(() => { this.work = undefined; }); }, 5000);
    this.timer.unref();
  }
  async onModuleDestroy() { this.stopped = true; if (this.timer) clearInterval(this.timer); await this.work; this.dispatcher = undefined; this.diagnostics.clear(); }

  private async loadLine(lineId: string) {
    const line = await this.prisma.line.findUnique({ where: { id: lineId }, select: credentialLineSelect });
    if (!line) throw new NotFoundException('LINE_NOT_FOUND');
    return line;
  }
  private audit(row: LineCredentialRotation, event: string) {
    this.logs?.enqueue({ source: 'SERVER', module: 'LineCredential', level: row.stage === 'FAILED' ? 'ERROR' : 'INFO', message: event, metadata: { lineId: row.lineId, operationId: row.operationId, version: row.targetVersion, stage: row.stage, errorCode: row.errorCode, operatorId: row.requestedById } });
  }
  private async dispatch(ids: string[]) {
    if (!this.stopped && this.dispatcher) await this.dispatcher([...new Set(ids)]).catch(() => this.logger.warn('Relay credential configuration dispatch failed'));
  }

  private ensure(line: RelayLine, rotate = false, operatorId?: string): Promise<LineCredentialRotation> {
    const previous = this.lineLocks.get(line.id);
    const task = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => this.ensureUnlocked(line, rotate, operatorId));
    this.lineLocks.set(line.id, task);
    return task.finally(() => { if (this.lineLocks.get(line.id) === task) this.lineLocks.delete(line.id); });
  }
  private async ensureUnlocked(line: RelayLine, rotate = false, operatorId?: string): Promise<LineCredentialRotation> {
    try {
      return await this.prisma.$transaction(async tx => {
        const latest = await tx.line.findUnique({ where: { id: line.id }, select: credentialLineSelect });
        if (!latest) throw new NotFoundException('LINE_NOT_FOUND');
        if (rotate && latest.status !== 'ACTIVE') throw new ConflictException('LINE_CREDENTIAL_LINE_INACTIVE');
        const topology = relayTopology(latest);
        const tags = { entryTag: resolveLineTags(latest).entry!, landingTag: latest.relayMode === 'TARGET_LINE' && latest.targetLine ? resolveLineTags(latest.targetLine).direct! : resolveLineTags(latest).landing! };
        const current = await tx.lineCredentialRotation.findUnique({ where: { lineId: line.id } });
        const topologyChanged = current && (current.entryNodeId !== topology.entryNodeId || current.landingNodeId !== topology.landingNodeId || current.targetLineId !== topology.targetLineId || current.entryTag !== tags.entryTag || current.landingTag !== tags.landingTag);
        if (current && current.stage !== 'CONFIRMED') {
          if (topologyChanged) throw new ConflictException('LINE_CREDENTIAL_TOPOLOGY_CHANGED');
          if (rotate && current.stage === 'FAILED') return tx.lineCredentialRotation.update({ where: { id: current.id }, data: { stage: current.previousEntryNodeId ? 'STOPPING_PREVIOUS_ENTRY' : 'STOPPING_ENTRY', failedStage: null, errorCode: null, accepted: false, entryStopConfirmed: false, expectedNodeId: null, expectedConfigVersion: null, deadlineAt: new Date(Date.now() + ROTATION_STAGE_TIMEOUT_MS), requestedById: operatorId ?? current.requestedById } });
          return current;
        }
        if (current && !rotate && !topologyChanged) return current;
        const version = (current?.targetVersion ?? 0) + 1;
        await tx.lineCredential.create({ data: newRelayCredential(line.id, version) });
        const data = { operationId: randomUUID(), lineId: line.id, fromVersion: current?.targetVersion ?? null, targetVersion: version, landingCredentialVersion: topologyChanged ? null : current?.targetVersion ?? null, ...topology, ...tags, previousEntryTag: topologyChanged ? current.entryTag : null, previousLandingTag: topologyChanged ? current.landingTag : null, previousEntryNodeId: topologyChanged ? current.entryNodeId : null, previousLandingNodeId: topologyChanged ? current.landingNodeId : null, stage: topologyChanged ? 'STOPPING_PREVIOUS_ENTRY' : 'STOPPING_ENTRY', failedStage: null, errorCode: null, accepted: false, entryStopConfirmed: false, expectedNodeId: null, expectedConfigVersion: null, requestedById: operatorId ?? null, deadlineAt: new Date(Date.now() + ROTATION_STAGE_TIMEOUT_MS), confirmedAt: null };
        return current ? tx.lineCredentialRotation.update({ where: { id: current.id }, data }) : tx.lineCredentialRotation.create({ data });
      });
    } catch (error) {
      // 唯一约束裁决并行首次编译；采用获胜事务的同一秘密，不生成进程内替代值。
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code)) {
        const winner = await this.prisma.lineCredentialRotation.findUnique({ where: { lineId: line.id } });
        if (winner) return winner;
      }
      if (error instanceof ConflictException || error instanceof NotFoundException) throw error;
      throw new ConflictException('LINE_CREDENTIAL_INITIALIZATION_FAILED');
    }
  }

  async rotate(lineId: string, operatorId: string) {
    const line = await this.loadLine(lineId);
    if (line.status !== 'ACTIVE') throw new ConflictException('LINE_CREDENTIAL_LINE_INACTIVE');
    const row = await this.ensure(line, true, operatorId);
    if (row.expectedConfigVersion === null) {
      this.audit(row, 'Relay credential maintenance requested');
      await this.dispatch([expectedRotationNode(row)]);
    }
    return this.status(lineId);
  }
  async status(lineId: string) {
    const line = await this.loadLine(lineId);
    let configurationError: string | null = null;
    try { relayTopology(line); } catch (error) { configurationError = error instanceof ConflictException && /^LINE_CREDENTIAL_[A-Z_]+$/.test(error.message) ? error.message : 'LINE_CREDENTIAL_CONFIGURATION_INVALID'; }
    const row = await this.prisma.lineCredentialRotation.findUnique({ where: { lineId } });
    if (!row) return { lineId, operationId: null, state: configurationError ? 'UNAVAILABLE' : 'NOT_INITIALIZED', activeVersion: null, targetVersion: null, errorCode: configurationError, entryStopConfirmed: false, accepted: false, confirmedAt: null };
    return { lineId, operationId: row.operationId, state: row.stage, activeVersion: row.stage === 'CONFIRMED' ? row.targetVersion : row.fromVersion, targetVersion: row.targetVersion, errorCode: configurationError ?? row.errorCode, failedStage: row.failedStage, entryNodeId: row.entryNodeId, landingNodeId: row.landingNodeId, previousEntryNodeId: row.previousEntryNodeId, previousLandingNodeId: row.previousLandingNodeId, entryStopConfirmed: row.entryStopConfirmed, accepted: row.accepted, deadlineAt: row.deadlineAt.toISOString(), confirmedAt: row.confirmedAt?.toISOString() ?? null };
  }

  async prepare(lineIds: string[], nodeId?: string): Promise<Map<string, RelayCredentialView>> {
    const relevant = nodeId ? await this.prisma.lineCredentialRotation.findMany({ where: { stage: { not: 'CONFIRMED' }, OR: [{ entryNodeId: nodeId }, { landingNodeId: nodeId }, { previousEntryNodeId: nodeId }, { previousLandingNodeId: nodeId }] }, select: { lineId: true } }) : [];
    const ids = [...new Set([...lineIds, ...relevant.map(row => row.lineId)])];
    const views = new Map<string, RelayCredentialView>();
    if (!ids.length) return views;
    const lines = await this.prisma.line.findMany({ where: { id: { in: ids } }, select: credentialLineSelect });
    const existing = await this.prisma.lineCredentialRotation.findMany({ where: { lineId: { in: ids } } });
    const rotations = new Map(existing.map(row => [row.lineId, row]));
    for (const line of lines) {
      try {
        const topology = relayTopology(line);
        const previous = rotations.get(line.id);
        if (!previous || previous.entryNodeId !== topology.entryNodeId || previous.landingNodeId !== topology.landingNodeId || previous.targetLineId !== topology.targetLineId || previous.entryTag !== resolveLineTags(line).entry || previous.landingTag !== (line.relayMode === 'TARGET_LINE' && line.targetLine ? resolveLineTags(line.targetLine).direct : resolveLineTags(line).landing)) rotations.set(line.id, await this.ensure(line));
      } catch {
        const previous = rotations.get(line.id);
        if (previous && previous.stage !== 'FAILED') rotations.set(line.id, await this.fail(previous, 'LINE_CREDENTIAL_CONFIGURATION_INVALID'));
      }
    }
    const records = await this.prisma.lineCredential.findMany({ where: { lineId: { in: ids }, status: { not: 'REVOKED' } } });
    const credentials = new Map(records.map(record => [record.lineId + ':' + record.version, record]));
    for (const original of rotations.values()) {
      let row = original;
      let credential = null;
      const version = credentialVersionForRotation(row);
      if (version !== null) {
        try { const record = credentials.get(row.lineId + ':' + version); if (!record) throw new Error(); credential = revealRelayCredential(record); }
        catch { if (row.stage !== 'FAILED') row = await this.fail(row, 'LINE_CREDENTIAL_UNAVAILABLE'); }
      }
      views.set(row.lineId, { lineId: row.lineId, rotationId: row.id, operationId: row.operationId, stage: row.stage, targetVersion: row.targetVersion, entryNodeId: row.entryNodeId, landingNodeId: row.landingNodeId, targetLineId: row.targetLineId, previousEntryNodeId: row.previousEntryNodeId, previousLandingNodeId: row.previousLandingNodeId, entryEnabled: row.stage === 'RESTORING_ENTRY' || row.stage === 'CONFIRMED', credential });
    }
    return views;
  }

  remember(payload: ConfigSyncData, views: Iterable<RelayCredentialView>) { this.snapshots.set(payload, [...views]); }
  async capture(nodeId: string, payload: ConfigSyncData) {
    const views = this.snapshots.get(payload) ?? [];
    const verified: RelayCredentialView[] = [];
    for (const view of views) {
      const row = await this.prisma.lineCredentialRotation.findUnique({ where: { id: view.rotationId } });
      if (!row || row.operationId !== view.operationId || row.stage !== view.stage || row.targetVersion !== view.targetVersion) return false;
      if (view.stage === 'CONFIRMED' || expectedRotationNode(view) !== nodeId) continue;
      let oldCredential = null;
      if (row.stage === 'RETIRING_PREVIOUS_LANDING' && row.fromVersion !== null) {
        const old = await this.prisma.lineCredential.findUnique({ where: { lineId_version: { lineId: row.lineId, version: row.fromVersion } } });
        if (old) { try { oldCredential = revealRelayCredential(old); } catch { /* 无法证明撤销时保持失败关闭 */ } }
      }
      if (!proveRelayConfiguration(payload.singboxConfig, row, view, oldCredential)) {
        const failed = await this.fail(row, 'LINE_CREDENTIAL_CONFIGURATION_INVALID');
        if (!failed.transitionApplied) return false;
        throw new ConflictException('LINE_CREDENTIAL_CONFIGURATION_INVALID');
      }
      verified.push(view);
    }
    if (!await this.recordConfig(nodeId, payload.version, verified)) return false;
    const key = nodeId + ':' + payload.version;
    const secrets = configDiagnosticSecrets(payload.singboxConfig);
    const bytes = secrets.values.reduce((total, value) => total + Buffer.byteLength(value, 'utf8'), 0);
    this.diagnosticBytes -= this.diagnostics.get(key)?.bytes ?? 0;
    this.diagnostics.delete(key);
    this.diagnostics.set(key, { secrets, bytes });
    this.diagnosticBytes += bytes;
    // 历史配置按发生版本保护延迟日志；超过有界缓存的版本只能输出安全摘要。
    while (this.diagnostics.size > 4096 || this.diagnosticBytes > 8 * 1024 * 1024) {
      const oldest = this.diagnostics.keys().next().value!;
      this.diagnosticBytes -= this.diagnostics.get(oldest)!.bytes;
      this.diagnostics.delete(oldest);
    }
    return true;
  }
  sanitizeDiagnostic(nodeId: string, version: number, message: string) {
    const known = this.diagnostics.get(nodeId + ':' + version);
    return redactConfigDiagnostic(message, known?.secrets);
  }

  async recordConfig(nodeId: string, version: number, views: Iterable<RelayCredentialView>) {
    for (const view of views) {
      if (view.stage === 'CONFIRMED') continue;
      const expectedNode = expectedRotationNode(view);
      if (nodeId !== expectedNode) continue;
      const updated = await this.prisma.lineCredentialRotation.updateMany({ where: { id: view.rotationId, operationId: view.operationId, stage: view.stage, targetVersion: view.targetVersion, OR: [{ expectedConfigVersion: null }, { expectedConfigVersion: { lt: BigInt(version) } }] }, data: { expectedNodeId: nodeId, expectedConfigVersion: BigInt(version), accepted: false } });
      if (!updated.count) {
        const current = await this.prisma.lineCredentialRotation.findUnique({ where: { id: view.rotationId } });
        if (!current || current.operationId !== view.operationId || current.stage !== view.stage || current.targetVersion !== view.targetVersion || current.expectedNodeId !== nodeId || current.expectedConfigVersion !== BigInt(version)) return false;
      }
    }
    return true;
  }
  sanitizeLog(nodeId: string, message: string, configVersion?: unknown) {
    const known = typeof configVersion === 'number' && Number.isSafeInteger(configVersion) ? this.diagnostics.get(nodeId + ':' + configVersion) : undefined;
    return known ? redactConfigDiagnostic(message, known.secrets) : 'Agent diagnostic unavailable for an unrecognized configuration version';
  }
  sanitizeLogMetadata(nodeId: string, metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!metadata) return undefined;
    const version = metadata.configVersion;
    const known = typeof version === 'number' && Number.isSafeInteger(version) ? this.diagnostics.get(nodeId + ':' + version) : undefined;
    if (!known?.secrets.complete) return undefined;
    try {
      const json = JSON.stringify(metadata);
      if (json.length > 16_384) return { truncated: true };
      // 先按实际秘密替换JSON字符串；替代文字不含引号，保持JSON结构有效。
      let safe = json;
      for (const secret of known.secrets.values) safe = safe.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]');
      return JSON.parse(safe) as Record<string, unknown>;
    } catch { return undefined; }
  }
  async accepted(nodeId: string, result: ConfigApplyResultData) {
    if (!Number.isSafeInteger(result.version) || result.version < 0) return;
    const rows = await this.prisma.lineCredentialRotation.findMany({ where: { expectedNodeId: nodeId, expectedConfigVersion: BigInt(result.version), stage: { not: 'CONFIRMED' } } });
    for (const row of rows) {
      if (!result.success) {
        if (row.stage !== 'FAILED') {
          const failure = await this.fail(row, 'AGENT_REJECTED');
          if (failure.transitionApplied) await this.dispatch([row.entryNodeId, ...(row.previousEntryNodeId ? [row.previousEntryNodeId] : [])]);
        }
      }
      else await this.prisma.lineCredentialRotation.updateMany({ where: { id: row.id, operationId: row.operationId, stage: row.stage, expectedConfigVersion: BigInt(result.version) }, data: { accepted: true } });
    }
  }
  async heartbeat(nodeId: string, data: HeartbeatData) {
    if (data.appliedConfigVersion === undefined || !Number.isSafeInteger(data.appliedConfigVersion) || data.appliedConfigVersion < 0 || data.kernelRunning === undefined) return;
    const rows = await this.prisma.lineCredentialRotation.findMany({ where: { expectedNodeId: nodeId, expectedConfigVersion: BigInt(data.appliedConfigVersion), accepted: true, stage: { not: 'CONFIRMED' } } });
    const dispatch = new Set<string>();
    for (const row of rows) {
      if (row.stage !== 'FAILED' && row.deadlineAt.getTime() <= Date.now()) { const failed = await this.fail(row, 'STAGE_TIMEOUT'); if (failed.transitionApplied) { dispatch.add(row.entryNodeId); if (row.previousEntryNodeId) dispatch.add(row.previousEntryNodeId); } continue; }
      if (!data.kernelRunning || data.lastError) { if (row.stage !== 'FAILED') { const failed = await this.fail(row, 'KERNEL_NOT_RUNNING'); if (failed.transitionApplied) { dispatch.add(row.entryNodeId); if (row.previousEntryNodeId) dispatch.add(row.previousEntryNodeId); } } continue; }
      if (row.stage === 'FAILED') {
        await this.prisma.lineCredentialRotation.updateMany({ where: { id: row.id, operationId: row.operationId, stage: 'FAILED', expectedConfigVersion: BigInt(data.appliedConfigVersion) }, data: { entryStopConfirmed: true } });
        continue;
      }
      const changed = await this.advance(row);
      if (changed && changed.stage !== 'CONFIRMED') dispatch.add(expectedRotationNode(changed));
    }
    if (dispatch.size) await this.dispatch([...dispatch]);
  }

  private async advance(row: LineCredentialRotation) {
    return this.prisma.$transaction(async tx => {
      const next = row.stage === 'STOPPING_PREVIOUS_ENTRY' ? 'RETIRING_PREVIOUS_LANDING' : row.stage === 'RETIRING_PREVIOUS_LANDING' ? 'STOPPING_ENTRY' : row.stage === 'STOPPING_ENTRY' ? 'APPLYING_LANDING' : row.stage === 'APPLYING_LANDING' ? 'RESTORING_ENTRY' : 'CONFIRMED';
      const changed = await tx.lineCredentialRotation.updateMany({ where: { id: row.id, operationId: row.operationId, stage: row.stage, expectedConfigVersion: row.expectedConfigVersion, accepted: true, deadlineAt: { gt: new Date() } }, data: { stage: next, ...(next === 'APPLYING_LANDING' ? { landingCredentialVersion: row.targetVersion } : {}), accepted: false, expectedNodeId: null, expectedConfigVersion: null, entryStopConfirmed: next === 'APPLYING_LANDING', deadlineAt: new Date(Date.now() + ROTATION_STAGE_TIMEOUT_MS), confirmedAt: next === 'CONFIRMED' ? new Date() : null } });
      if (!changed.count) return null;
      if (next === 'CONFIRMED') {
        await tx.lineCredential.updateMany({ where: { lineId: row.lineId, version: { not: row.targetVersion }, status: { not: 'REVOKED' } }, data: { status: 'REVOKED', encryptedPayload: null, revokedAt: new Date() } });
        await tx.lineCredential.update({ where: { lineId_version: { lineId: row.lineId, version: row.targetVersion } }, data: { status: 'ACTIVE', activatedAt: new Date() } });
      }
      return tx.lineCredentialRotation.findUniqueOrThrow({ where: { id: row.id } });
    }).then(updated => { if (updated) this.audit(updated, 'Relay credential maintenance advanced'); return updated; });
  }
  private async fail(row: LineCredentialRotation, code: string) {
    const changed = await this.prisma.lineCredentialRotation.updateMany({ where: { id: row.id, operationId: row.operationId, stage: row.stage, expectedNodeId: row.expectedNodeId, expectedConfigVersion: row.expectedConfigVersion, deadlineAt: code === 'STAGE_TIMEOUT' ? { equals: row.deadlineAt, lte: new Date() } : row.deadlineAt }, data: { stage: 'FAILED', failedStage: row.stage, errorCode: code, accepted: false, expectedNodeId: null, expectedConfigVersion: null, entryStopConfirmed: row.stage === 'APPLYING_LANDING' && row.entryStopConfirmed } });
    const current = await this.prisma.lineCredentialRotation.findUniqueOrThrow({ where: { id: row.id } });
    if (changed.count) this.audit(current, 'Relay credential maintenance failed');
    return { ...current, transitionApplied: changed.count > 0 };
  }
  async sweep() {
    const rows = await this.prisma.lineCredentialRotation.findMany({ where: { stage: { not: 'CONFIRMED' } } });
    const targets = new Set<string>();
    for (const row of rows) {
      if (row.stage !== 'FAILED' && row.deadlineAt.getTime() <= Date.now()) { const failed = await this.fail(row, 'STAGE_TIMEOUT'); if (failed.transitionApplied) { targets.add(row.entryNodeId); if (row.previousEntryNodeId) targets.add(row.previousEntryNodeId); } }
      else if (row.expectedConfigVersion === null) targets.add(expectedRotationNode(row));
    }
    if (targets.size) await this.dispatch([...targets]);
  }
  async internalFingerprints(nodeId: string) {
    const records = await this.prisma.lineCredential.findMany({ where: { line: { OR: [{ landingNodeId: nodeId }, { targetLine: { entryNodeId: nodeId } }] } }, select: { uuidHash: true, nameHash: true, lineId: true, line: { select: { targetLineId: true } } } });
    return new Set(records.flatMap(record => [record.uuidHash, record.nameHash].map(hash => (record.line.targetLineId ?? record.lineId) + ':' + hash)));
  }
  isInternalCredential(fingerprints: Set<string>, credential: string, lineId: string | null) { return lineId !== null && fingerprints.has(lineId + ':' + credentialFingerprint(credential)); }
  async assertNodeEditable(nodeId: string, tx: Prisma.TransactionClient = this.prisma) {
    const active = await tx.lineCredentialRotation.findFirst({ where: { stage: { in: [...RUNNING_ROTATION_STAGES, 'FAILED'] }, OR: [{ entryNodeId: nodeId }, { landingNodeId: nodeId }, { previousEntryNodeId: nodeId }, { previousLandingNodeId: nodeId }] }, select: { id: true } });
    if (active) throw new ConflictException('LINE_CREDENTIAL_MAINTENANCE_IN_PROGRESS');
  }
  async assertEditable(lineId: string, topologyChange = false, tx: Prisma.TransactionClient = this.prisma) {
    const active = await tx.lineCredentialRotation.findFirst({ where: { OR: [{ lineId }, { targetLineId: lineId }], stage: { in: topologyChange ? [...RUNNING_ROTATION_STAGES, 'FAILED'] : RUNNING_ROTATION_STAGES } }, select: { id: true } });
    if (active) throw new ConflictException('LINE_CREDENTIAL_MAINTENANCE_IN_PROGRESS');
  }
}
