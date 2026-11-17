import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, type Prisma } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentService } from '../agent-gateway/agent.service';
import { LineCredentialsService } from '../line-credentials/line-credentials.service';
import { RUNNING_ROTATION_STAGES } from '../line-credentials/line-credential.types';
import { PrismaService } from '../prisma/prisma.service';
import { NodesService } from './nodes.service';
import type { UpdateNodeDto } from './dto/update-node.dto';

const protectedNodes = ['entry', 'landing', 'previous-entry', 'previous-landing'];
const criticalChanges: Array<[string, UpdateNodeDto]> = [
  ['serverHost', { serverHost: 'new-endpoint.example.test' }],
  ['reachability', { reachability: 'NAT' }],
  ['configOverride', { configOverride: '{"log":{"level":"debug"}}' }],
  ['clear override', { configOverride: null }],
  ['communicationMode', { communicationMode: 'HTTP' }],
  ['pollIntervalSecs', { pollIntervalSecs: 30 }]
];

describe('Node credential maintenance protection (SQLite)', () => {
  jest.setTimeout(120_000);
  let directory: string;
  let prisma: PrismaClient;
  let credentials: LineCredentialsService;
  let nodes: NodesService;
  const gateway = {
    pushConfig: jest.fn(async () => false), pushConfigToAll: jest.fn(async () => 0), disconnectNode: jest.fn()
  };
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'riricloud-node-maintenance-'));
    const url = 'file:' + join(directory, 'main.db').split(String.fromCharCode(92)).join('/');
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    await prisma.$executeRawUnsafe('PRAGMA user_version = 0');
    await prisma.$disconnect();
    try {
      execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', resolve('prisma/schema.prisma')], {
        cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe'
      });
    } catch (error) {
      const output = error as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(String(output.stdout) + String(output.stderr));
    }
    await prisma.$connect();
    credentials = new LineCredentialsService(prisma as PrismaService);
    const module = await Test.createTestingModule({ providers: [
      NodesService, { provide: PrismaService, useValue: prisma }, { provide: AgentService, useValue: gateway },
      { provide: LineCredentialsService, useValue: credentials }
    ] }).compile();
    nodes = module.get(NodesService);
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    await prisma.lineCredentialRotation.deleteMany();
    await prisma.lineCredential.deleteMany();
    await prisma.line.deleteMany();
    await prisma.node.deleteMany();
    await prisma.node.createMany({ data: [...protectedNodes, 'unrelated'].map(id => ({
      id, name: id, serverHost: 'original.example.test', agentToken: id + '-isolated-fixture', status: 'ONLINE',
      configOverride: '{"log":{"level":"warn"}}'
    })) });
    await prisma.line.create({ data: {
      id: 'relay', name: 'relay', type: 'RELAY', relayMode: 'PROTOCOL_PROXY', protocolType: 'VMESS',
      entryNodeId: 'entry', landingNodeId: 'landing', entryPort: 24500, landingPort: 24501,
      paramsJson: JSON.stringify({ tls: { enabled: false, mode: 'none' } })
    } });
  });
  afterAll(async () => {
    await credentials?.onModuleDestroy();
    await prisma?.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function maintenance(stage = 'STOPPING_ENTRY') {
    return prisma.lineCredentialRotation.create({ data: {
      id: 'rotation', operationId: 'operation', lineId: 'relay', fromVersion: 1, targetVersion: 2,
      stage, failedStage: stage === 'FAILED' ? 'STOPPING_PREVIOUS_ENTRY' : null,
      entryNodeId: 'entry', landingNodeId: 'landing', previousEntryNodeId: 'previous-entry', previousLandingNodeId: 'previous-landing',
      entryTag: 'line-relay-entry', landingTag: 'line-relay-landing',
      previousEntryTag: 'old-entry-tag', previousLandingTag: 'old-landing-tag',
      deadlineAt: new Date(Date.now() + 120_000)
    } });
  }

  it.each(protectedNodes)('blocks all runtime changes to current or previous node %s', async nodeId => {
    await maintenance();
    for (const [_name, dto] of criticalChanges) {
      await expect(nodes.update(nodeId, dto)).rejects.toThrow('LINE_CREDENTIAL_MAINTENANCE_IN_PROGRESS');
    }
    const saved = await prisma.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(saved.serverHost).toBe('original.example.test');
    expect(saved.configOverride).toBe('{"log":{"level":"warn"}}');
    expect(saved.communicationMode).toBe('WS');
    expect(gateway.pushConfig).not.toHaveBeenCalled();
    expect(gateway.pushConfigToAll).not.toHaveBeenCalled();
  });

  it.each([...RUNNING_ROTATION_STAGES, 'FAILED'])('keeps critical edits frozen in %s', async stage => {
    await maintenance(stage);
    await expect(nodes.update('previous-landing', { serverHost: 'replacement.example.test' })).rejects.toThrow('LINE_CREDENTIAL_MAINTENANCE_IN_PROGRESS');
  });

  it.each(protectedNodes)('blocks deletion of %s before disconnect or foreign-key effects', async nodeId => {
    await maintenance('FAILED');
    await expect(nodes.remove(nodeId)).rejects.toThrow('LINE_CREDENTIAL_MAINTENANCE_IN_PROGRESS');
    expect(await prisma.node.findUnique({ where: { id: nodeId } })).not.toBeNull();
    expect(await prisma.lineCredentialRotation.count()).toBe(1);
    expect(gateway.disconnectNode).not.toHaveBeenCalled();
  });

  it('blocks token rotation that would revoke the agent connection during maintenance', async () => {
    await maintenance();
    const before = await prisma.node.findUniqueOrThrow({ where: { id: 'entry' } });
    await expect(nodes.rotateToken('entry', 'operator', 'https://panel.example.test')).rejects.toThrow('LINE_CREDENTIAL_MAINTENANCE_IN_PROGRESS');
    expect((await prisma.node.findUniqueOrThrow({ where: { id: 'entry' } })).agentToken).toBe(before.agentToken);
    expect(gateway.disconnectNode).not.toHaveBeenCalled();
  });

  it('allows metadata-only and no-op runtime fields from the existing name form', async () => {
    await maintenance('FAILED');
    const check = jest.spyOn(credentials, 'assertNodeEditable');
    await nodes.update('entry', { name: 'renamed' });
    await nodes.update('entry', { name: 'renamed again', serverHost: '  original.example.test  ', reachability: 'PUBLIC', configOverride: '{"log":{"level":"warn"}}' });
    expect((await prisma.node.findUniqueOrThrow({ where: { id: 'entry' } })).name).toBe('renamed again');
    expect(check).not.toHaveBeenCalled();
  });

  it('allows unrelated nodes and confirmed operations without weakening existing behavior', async () => {
    await maintenance();
    const unrelated = await nodes.update('unrelated', { serverHost: 'unrelated.example.test' });
    expect(unrelated.node.serverHost).toBe('unrelated.example.test');
    await prisma.lineCredentialRotation.update({ where: { id: 'rotation' }, data: { stage: 'CONFIRMED' } });
    await nodes.update('landing', { serverHost: 'new.example.test', communicationMode: 'HTTP', pollIntervalSecs: 30 });
    expect(gateway.pushConfigToAll).toHaveBeenCalledTimes(2);
    await nodes.remove('previous-landing');
    expect(gateway.disconnectNode).toHaveBeenCalledWith('previous-landing');
  });

  it.each(['update', 'remove', 'rotateToken'])('rechecks a maintenance race inside the same transaction for %s', async operation => {
    const original = credentials.assertNodeEditable.bind(credentials);
    const clients: Array<Prisma.TransactionClient | undefined> = [];
    jest.spyOn(credentials, 'assertNodeEditable').mockImplementation(async (id, tx) => {
      clients.push(tx);
      await original(id, tx);
      if (clients.length === 1) await maintenance();
    });
    const action = operation === 'update' ? nodes.update('entry', { serverHost: 'raced.example.test' }) :
      operation === 'remove' ? nodes.remove('entry') : nodes.rotateToken('entry', 'operator', 'https://panel.example.test');
    await expect(action).rejects.toThrow('LINE_CREDENTIAL_MAINTENANCE_IN_PROGRESS');
    expect(clients).toHaveLength(2);
    expect(clients[1]).toBeDefined();
    expect(clients[1]).not.toBe(prisma);
    expect((await prisma.node.findUniqueOrThrow({ where: { id: 'entry' } })).serverHost).toBe('original.example.test');
    expect(gateway.disconnectNode).not.toHaveBeenCalled();
    expect(gateway.pushConfigToAll).not.toHaveBeenCalled();
  });

  it('revalidates no-op runtime fields against a fresh transactional node snapshot', async () => {
    await maintenance();
    const original = prisma.node.findUnique.bind(prisma.node);
    let first = true;
    jest.spyOn(prisma.node, 'findUnique').mockImplementation((async (args: Prisma.NodeFindUniqueArgs) => {
      const value = await original(args);
      if (first) { first = false; await prisma.node.update({ where: { id: 'entry' }, data: { serverHost: 'concurrently-edited.example.test' } }); }
      return value;
    }) as unknown as typeof prisma.node.findUnique);
    await expect(nodes.update('entry', { name: 'rename', serverHost: 'original.example.test' })).rejects.toThrow('LINE_CREDENTIAL_MAINTENANCE_IN_PROGRESS');
    expect((await prisma.node.findUniqueOrThrow({ where: { id: 'entry' } })).serverHost).toBe('concurrently-edited.example.test');
  });

  it('rolls back node deletion before any agent disconnect on a database failure', async () => {
    const check = credentials.assertNodeEditable.bind(credentials);
    jest.spyOn(credentials, 'assertNodeEditable').mockImplementation(async (id, tx) => {
      await check(id, tx);
      if (tx && tx !== prisma) throw new Error('isolated transaction failure');
    });
    await expect(nodes.remove('unrelated')).rejects.toThrow('isolated transaction failure');
    expect(await prisma.node.findUnique({ where: { id: 'unrelated' } })).not.toBeNull();
    expect(gateway.disconnectNode).not.toHaveBeenCalled();
  });

  it('retains NAT-entry, egress-override and local-node protections', async () => {
    await expect(nodes.update('entry', { reachability: 'NAT' })).rejects.toThrow('该节点正在作为直连线路或中继入口节点使用');
    await prisma.line.update({ where: { id: 'relay' }, data: { egressProxyJson: 'enc:v1:fixture' } });
    await expect(nodes.update('landing', { configOverride: '{"route":{}}' })).rejects.toThrow(/高级覆盖/);
    await prisma.node.update({ where: { id: 'unrelated' }, data: { isLocal: true } });
    await expect(nodes.remove('unrelated')).rejects.toThrow(ConflictException);
    await expect(nodes.remove('missing')).rejects.toThrow(NotFoundException);
    expect(gateway.disconnectNode).not.toHaveBeenCalled();
  });

  it('does not introduce a status mutation through the existing node update API', async () => {
    await maintenance();
    await prisma.node.update({ where: { id: 'entry' }, data: { status: 'DISABLED' } });
    await expect(nodes.update('entry', { serverHost: 'blocked.example.test' })).rejects.toThrow('LINE_CREDENTIAL_MAINTENANCE_IN_PROGRESS');
    await nodes.update('entry', { name: 'metadata only', status: 'ONLINE' } as UpdateNodeDto);
    expect((await prisma.node.findUniqueOrThrow({ where: { id: 'entry' } })).status).toBe('DISABLED');
  });
});
