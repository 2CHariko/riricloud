import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { HeartbeatData } from '../agent-gateway/agent-message';
import { AgentService } from '../agent-gateway/agent-gateway.service';
import { LineCredentialsService } from './line-credentials.service';
import { revealRelayCredential } from './line-credential.types';

const heartbeat = (version: number, running = true) => ({ appliedConfigVersion: version, kernelRunning: running }) as HeartbeatData;
describe('Line credential durable maintenance (SQLite)', () => {
  jest.setTimeout(120_000);
  let directory: string;
  let prisma: PrismaClient;
  let service: LineCredentialsService;
  const dispatch = jest.fn(async () => undefined);
  let sequence = 10_000;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'riricloud-credential-tests-'));
    const url = 'file:' + join(directory, 'main.db').split(String.fromCharCode(92)).join('/');
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    await prisma.$executeRawUnsafe('PRAGMA user_version = 0');
    await prisma.$disconnect();
    try { execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', resolve('prisma/schema.prisma')], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' }); } catch (error) { const output = error as { stdout?: Buffer; stderr?: Buffer }; throw new Error(String(output.stdout) + String(output.stderr)); }
    await prisma.$connect();
  });
  beforeEach(async () => {
    await prisma.lineCredentialRotation.deleteMany();
    await prisma.lineCredential.deleteMany();
    await prisma.line.deleteMany();
    await prisma.node.deleteMany();
    await prisma.node.createMany({ data: [{ id: 'entry', name: 'Entry', serverHost: 'entry.fixture.example', agentToken: 'entry-fixture', status: 'ONLINE' }, { id: 'landing', name: 'Landing', serverHost: 'landing.fixture.example', agentToken: 'landing-fixture', status: 'ONLINE' }] });
    await prisma.line.createMany({ data: ['relay-a', 'relay-b'].map((id, index) => ({ id, name: id, type: 'RELAY', relayMode: 'PROTOCOL_PROXY', protocolType: 'VLESS', paramsJson: JSON.stringify({ tls: { enabled: true, mode: 'tls', serverName: 'landing.fixture.example' } }), entryNodeId: 'entry', landingNodeId: 'landing', entryPort: 24000 + index, landingPort: 25000 + index })) });
    service = new LineCredentialsService(prisma as PrismaService);
    service.setDispatcher(dispatch);
    dispatch.mockClear();
  });
  afterEach(async () => { await service?.onModuleDestroy(); });
  afterAll(async () => { await prisma?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });
  async function stage(nodeId: string, lineId = 'relay-a') {
    const views = await service.prepare([lineId]);
    const version = ++sequence;
    await service.recordConfig(nodeId, version, views.values());
    await service.accepted(nodeId, { version, success: true, message: 'applied' });
    await service.heartbeat(nodeId, heartbeat(version));
  }
  async function complete(lineId = 'relay-a') { await service.prepare([lineId]); await stage('entry', lineId); await stage('landing', lineId); await stage('entry', lineId); }

  it('initializes per-line encrypted random identities and keeps entry stopped until both runtimes confirm', async () => {
    const views = await service.prepare(['relay-a', 'relay-b']);
    expect([...views.values()].every(view => !view.entryEnabled && view.credential === null)).toBe(true);
    const records = await prisma.lineCredential.findMany();
    expect(records).toHaveLength(2);
    expect(records.every(row => row.encryptedPayload?.startsWith('enc:v1:'))).toBe(true);
    const materials = records.map(revealRelayCredential);
    expect(materials[0].uuid).not.toBe(materials[1].uuid);
    expect(materials[0].credential).not.toBe(materials[1].credential);
    const version = ++sequence;
    await service.recordConfig('entry', version, views.values());
    await service.heartbeat('entry', heartbeat(version));
    expect((await service.status('relay-a')).state).toBe('STOPPING_ENTRY');
    await service.accepted('entry', { version: version - 1, success: true, message: 'applied' });
    await service.heartbeat('entry', heartbeat(version));
    expect((await service.status('relay-a')).state).toBe('STOPPING_ENTRY');
    await service.accepted('entry', { version, success: true, message: 'applied' });
    await service.heartbeat('entry', heartbeat(version));
    expect((await service.status('relay-a')).state).toBe('APPLYING_LANDING');
    expect((await service.prepare(['relay-a'])).get('relay-a')?.entryEnabled).toBe(false);
    await stage('landing');
    expect((await service.prepare(['relay-a'])).get('relay-a')?.entryEnabled).toBe(true);
    await stage('entry');
    expect((await service.status('relay-a')).state).toBe('CONFIRMED');
  });

  it('deduplicates concurrent rotations and revokes the old ciphertext only after final runtime confirmation', async () => {
    await complete();
    const old = await prisma.lineCredential.findFirstOrThrow({ where: { lineId: 'relay-a', version: 1 } });
    const oldMaterial = revealRelayCredential(old);
    const results = await Promise.all([service.rotate('relay-a', 'operator'), service.rotate('relay-a', 'operator')]);
    expect(results[0].operationId).toBe(results[1].operationId);
    expect(await prisma.lineCredential.count({ where: { lineId: 'relay-a' } })).toBe(2);
    expect((await service.prepare(['relay-a'])).get('relay-a')?.credential?.uuid).toBe(oldMaterial.uuid);
    await stage('entry');
    const candidate = (await service.prepare(['relay-a'])).get('relay-a')?.credential;
    expect(candidate?.uuid).not.toBe(oldMaterial.uuid);
    await stage('landing');
    expect((await prisma.lineCredential.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('ACTIVE');
    await stage('entry');
    const revoked = await prisma.lineCredential.findUniqueOrThrow({ where: { id: old.id } });
    expect(revoked.status).toBe('REVOKED');
    expect(revoked.encryptedPayload).toBeNull();
    expect(() => revealRelayCredential(revoked)).toThrow('LINE_CREDENTIAL_UNAVAILABLE');
  });

  it('rejects stale acknowledgement, holds failure closed and retries the existing candidate', async () => {
    await service.prepare(['relay-a']);
    await stage('entry');
    const before = await service.status('relay-a');
    const views = await service.prepare(['relay-a']);
    const version = ++sequence;
    await service.recordConfig('landing', version, views.values());
    await service.accepted('landing', { version, success: false, message: 'must not retain arbitrary error data' });
    expect((await service.status('relay-a')).errorCode).toBe('AGENT_REJECTED');
    expect((await service.prepare(['relay-a'])).get('relay-a')?.entryEnabled).toBe(false);
    await service.accepted('landing', { version, success: true, message: 'applied' });
    await service.heartbeat('landing', heartbeat(version));
    expect((await service.status('relay-a')).state).toBe('FAILED');
    const retry = await service.rotate('relay-a', 'operator');
    expect(retry.operationId).toBe(before.operationId);
    expect(retry.targetVersion).toBe(before.targetVersion);
    expect(retry.state).toBe('STOPPING_ENTRY');
    expect(await prisma.lineCredential.count()).toBe(1);
  });

  it('does not let a late heartbeat advance an expired stage', async () => {
    const views = await service.prepare(['relay-a']);
    const version = ++sequence;
    await service.recordConfig('entry', version, views.values());
    await service.accepted('entry', { version, success: true, message: 'applied' });
    await prisma.lineCredentialRotation.update({ where: { lineId: 'relay-a' }, data: { deadlineAt: new Date(Date.now() - 1) } });
    await service.heartbeat('entry', heartbeat(version));
    expect(await service.status('relay-a')).toMatchObject({ state: 'FAILED', errorCode: 'STAGE_TIMEOUT' });
  });

  it('recovers the same candidate across restart and requires a fresh generated version', async () => {
    await service.prepare(['relay-a']);
    await stage('entry');
    const before = await service.prepare(['relay-a']);
    const material = before.get('relay-a')?.credential;
    const obsolete = ++sequence;
    await service.recordConfig('landing', obsolete, before.values());
    await service.onModuleDestroy();
    service = new LineCredentialsService(prisma as PrismaService);
    service.setDispatcher(dispatch);
    await service.onModuleInit();
    await service.accepted('landing', { version: obsolete, success: true, message: 'applied' });
    await service.heartbeat('landing', heartbeat(obsolete));
    expect((await service.status('relay-a')).state).toBe('APPLYING_LANDING');
    expect((await service.prepare(['relay-a'])).get('relay-a')?.credential).toEqual(material);
    await stage('landing'); await stage('entry');
    expect((await service.status('relay-a')).state).toBe('CONFIRMED');
  });

  it('rejects plaintext/corrupted credentials without exposing secrets in status', async () => {
    await service.prepare(['relay-a']); await stage('entry');
    await prisma.lineCredential.updateMany({ where: { lineId: 'relay-a' }, data: { encryptedPayload: 'plain-secret-that-must-not-leak' } });
    const view = (await service.prepare(['relay-a'])).get('relay-a');
    expect(view).toMatchObject({ stage: 'FAILED', credential: null, entryEnabled: false });
    const result = JSON.stringify(await service.status('relay-a'));
    expect(result).not.toContain('plain-secret');
    expect(result).not.toContain('encryptedPayload');
  });

  it('recognizes only database-registered identities scoped to the landing node', async () => {
    await complete();
    const record = await prisma.lineCredential.findFirstOrThrow({ where: { lineId: 'relay-a' } });
    const material = revealRelayCredential(record);
    expect(service.isInternalCredential(await service.internalFingerprints('landing'), material.email, 'relay-a')).toBe(true);
    expect(service.isInternalCredential(await service.internalFingerprints('entry'), material.email, 'relay-a')).toBe(false);
    expect(service.isInternalCredential(await service.internalFingerprints('landing'), material.email, 'relay-b')).toBe(false);
    expect(service.isInternalCredential(await service.internalFingerprints('landing'), material.email, null)).toBe(false);
    expect(service.isInternalCredential(await service.internalFingerprints('landing'), 'relay-unregistered', 'relay-a')).toBe(false);
  });

  it('rejects public plaintext transit and protects a running rotation against topology edits', async () => {
    await prisma.line.update({ where: { id: 'relay-a' }, data: { paramsJson: JSON.stringify({ tls: { enabled: false } }) } });
    await expect(service.rotate('relay-a', 'operator')).rejects.toThrow('LINE_CREDENTIAL_PUBLIC_TLS_REQUIRED');
    await service.prepare(['relay-b']);
    await expect(service.assertEditable('relay-b')).rejects.toThrow('LINE_CREDENTIAL_MAINTENANCE_IN_PROGRESS');
    await complete('relay-b');
    await expect(service.assertEditable('relay-b')).resolves.toBeUndefined();
  });
  it('confirms removal on the previous topology before bringing a moved relay back', async () => {
    await complete();
    await prisma.node.createMany({ data: [{ id: 'new-entry', name: 'New entry', serverHost: 'new-entry.fixture.example', agentToken: 'new-entry-fixture' }, { id: 'new-landing', name: 'New landing', serverHost: 'new-landing.fixture.example', agentToken: 'new-landing-fixture' }] });
    await prisma.line.update({ where: { id: 'relay-a' }, data: { entryNodeId: 'new-entry', landingNodeId: 'new-landing' } });
    await service.prepare(['relay-a']);
    expect((await service.status('relay-a')).state).toBe('STOPPING_PREVIOUS_ENTRY');
    const previousViews = await service.prepare([], 'entry');
    expect(previousViews.has('relay-a')).toBe(true);
    const version = ++sequence;
    await service.recordConfig('new-entry', version, previousViews.values());
    await service.accepted('new-entry', { version, success: true, message: 'applied' });
    await service.heartbeat('new-entry', heartbeat(version));
    expect((await service.status('relay-a')).state).toBe('STOPPING_PREVIOUS_ENTRY');
    await stage('entry');
    expect((await service.status('relay-a')).state).toBe('RETIRING_PREVIOUS_LANDING');
    await stage('landing');
    expect((await service.status('relay-a')).state).toBe('STOPPING_ENTRY');
    await stage('new-entry'); await stage('new-landing'); await stage('new-entry');
    expect((await service.status('relay-a')).state).toBe('CONFIRMED');
  });

  it('never registers an empty or incorrect rendered landing configuration as proof', async () => {
    await service.prepare(['relay-a']); await stage('entry');
    const views = await service.prepare(['relay-a']);
    const payload = { version: ++sequence, singboxConfig: { inbounds: [], outbounds: [] } };
    service.remember(payload, views.values());
    await expect(service.capture('landing', payload)).rejects.toThrow('LINE_CREDENTIAL_CONFIGURATION_INVALID');
    expect(await service.status('relay-a')).toMatchObject({ state: 'FAILED', errorCode: 'LINE_CREDENTIAL_CONFIGURATION_INVALID' });
    const rotation = await prisma.lineCredentialRotation.findUniqueOrThrow({ where: { lineId: 'relay-a' } });
    expect(rotation.expectedConfigVersion).toBeNull();
  });

  it('does not allow an old failure snapshot to replace a newer expected configuration', async () => {
    const views = await service.prepare(['relay-a']);
    await service.recordConfig('entry', ++sequence, views.values());
    const old = await prisma.lineCredentialRotation.findUniqueOrThrow({ where: { lineId: 'relay-a' } });
    const nextVersion = ++sequence;
    await service.recordConfig('entry', nextVersion, views.values());
    await (service as unknown as { fail: (row: typeof old, code: string) => Promise<unknown> }).fail(old, 'AGENT_REJECTED');
    const current = await prisma.lineCredentialRotation.findUniqueOrThrow({ where: { lineId: 'relay-a' } });
    expect(current.stage).toBe('STOPPING_ENTRY');
    expect(current.expectedConfigVersion).toBe(BigInt(nextVersion));
  });

  it('does not expire a retried task using a stale sweep snapshot', async () => {
    await service.prepare(['relay-a']);
    await prisma.lineCredentialRotation.update({ where: { lineId: 'relay-a' }, data: { deadlineAt: new Date(Date.now() - 1000) } });
    const expired = await prisma.lineCredentialRotation.findUniqueOrThrow({ where: { lineId: 'relay-a' } });
    await service.sweep();
    await service.rotate('relay-a', 'operator');
    await (service as unknown as { fail: (row: typeof expired, code: string) => Promise<unknown> }).fail(expired, 'STAGE_TIMEOUT');
    expect((await service.status('relay-a')).state).toBe('STOPPING_ENTRY');
  });

  it('captures actual gateway configurations for each maintenance stage without a hidden public user', async () => {
    const gateway = new AgentService(prisma as PrismaService, undefined, undefined, undefined, undefined, undefined, service);
    service.setDispatcher(dispatch);
    async function apply(nodeId: string) {
      const payload = await gateway.buildConfigSync(nodeId);
      await service.capture(nodeId, payload);
      await service.accepted(nodeId, { version: payload.version, success: true, message: 'applied' });
      await service.heartbeat(nodeId, heartbeat(payload.version));
      return payload;
    }
    const stopped = await apply('entry');
    expect(stopped.singboxConfig.inbounds).toEqual([]);
    const landing = await apply('landing');
    const users = (landing.singboxConfig.inbounds as Array<{ users: Array<{ uuid: string }> }>).flatMap(inbound => inbound.users ?? []);
    expect(users).toHaveLength(2);
    expect(users[0].uuid).not.toBe(users[1].uuid);
    expect(JSON.stringify(landing.singboxConfig)).not.toContain('__riricloud_');
    await apply('entry');
    expect((await service.status('relay-a')).state).toBe('CONFIRMED');
    expect((await service.status('relay-b')).state).toBe('CONFIRMED');
  });

  it('repeated rotate requests do not invalidate an already sent maintenance configuration', async () => {
    await service.rotate('relay-a', 'operator');
    const view = await service.prepare(['relay-a']);
    const version = ++sequence;
    await service.recordConfig('entry', version, view.values());
    dispatch.mockClear();
    const first = await service.status('relay-a');
    const again = await service.rotate('relay-a', 'operator');
    expect(again.operationId).toBe(first.operationId);
    expect(dispatch).not.toHaveBeenCalled();
    expect((await prisma.lineCredentialRotation.findUniqueOrThrow({ where: { lineId: 'relay-a' } })).expectedConfigVersion).toBe(BigInt(version));
  });

  it('discards previously confirmed snapshots after a rotation begins', async () => {
    await complete();
    const staleView = await service.prepare(['relay-a']);
    const payload = { version: ++sequence, singboxConfig: { inbounds: [], outbounds: [] } };
    service.remember(payload, staleView.values());
    await service.rotate('relay-a', 'operator');
    expect(await service.capture('entry', payload)).toBe(false);
    expect((await service.status('relay-a')).state).toBe('STOPPING_ENTRY');
  });

});
