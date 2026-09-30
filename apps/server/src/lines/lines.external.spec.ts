import { Test } from '@nestjs/testing';
import { LinesService } from './lines.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService } from '../agent-gateway/agent.service';
import { SettingsService } from '../system/settings.service';
import { encryptSecret } from '../common/secret-crypto';
import { buildClashYaml, buildSingboxJson, buildUriList } from '../subscription/builders';
import { parse } from 'yaml';

const upstream = { id: 'up', name: 'Upstream', status: 'ACTIVE', presenceStatus: 'PRESENT', protocolType: 'TROJAN', serverHost: 'up.example.com', serverPort: 443, paramsJson: encryptSecret(JSON.stringify({ password: 'external-secret', tls: { mode: 'tls', serverName: 'sni.example.com' }, transport: { type: 'ws', path: '/upstream' } })), subscription: { id: 'source', name: 'Source', status: 'ACTIVE', userInfoUsedBytes: null, userInfoTotalBytes: null, userInfoExpireAt: null } };
const external = { id: 'line', name: 'External', type: 'EXTERNAL', status: 'ACTIVE', isPublic: false, protocolType: 'TROJAN', upstreamNodeId: upstream.id, upstreamNode: upstream, entryNode: null, entryNodeId: null, entryPort: null, landingNode: null, paramsJson: '{}', tagsJson: '["premium"]', level: 0, trafficRate: 1, speedLimitMbps: 0 };
const plan = { lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]', trafficResetMode: 'NONE' };
const user = { id: 'user', email: 'user@example.com', uuid: '11111111-2222-3333-4444-555555555555', password: 'local-secret', isActive: true, emailVerifiedAt: new Date(), extraLineGrants: [{ lineId: external.id }] };
const subscription = { id: 'sub', userId: user.id, user, plan, status: 'ACTIVE', trafficLimitBytes: 1000n, trafficUsedBytes: 0n, expireAt: null, startedAt: new Date(), subscriptionToken: 'token' };

describe('EXTERNAL unified authorization and projection', () => {
  const prisma = { line: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() }, upstreamNode: { findUnique: jest.fn(), findMany: jest.fn() }, node: { findUnique: jest.fn() }, subscription: { findUnique: jest.fn() } };
  const settings = { getSettings: jest.fn() };
  let lines: LinesService;
  let subs: SubscriptionService;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ providers: [LinesService, SubscriptionService, { provide: PrismaService, useValue: prisma }, { provide: AgentService, useValue: { pushConfigToAll: jest.fn(), getUserDeviceManagement: jest.fn() } }, { provide: SettingsService, useValue: settings }] }).compile();
    lines = module.get(LinesService); subs = module.get(SubscriptionService);
  });
  beforeEach(() => {
    jest.clearAllMocks(); settings.getSettings.mockResolvedValue({});
    prisma.line.findMany.mockResolvedValue([external]); prisma.line.findUnique.mockResolvedValue(external);
    prisma.upstreamNode.findUnique.mockResolvedValue(upstream);
    prisma.line.create.mockImplementation(async ({ data }) => ({ ...external, ...data }));
    prisma.subscription.findUnique.mockResolvedValue(subscription);
  });
  it('creates private disabled lines with no listeners or credential copies', async () => {
    const result = await lines.create({ name: 'External', type: 'EXTERNAL', upstreamNodeId: upstream.id });
    expect(prisma.line.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'DISABLED', isPublic: false, entryNodeId: null, entryPort: null, paramsJson: '{}' }) }));
    expect(result.line.topology.entry).toBeNull();
    expect(JSON.stringify(result)).not.toContain('external-secret');
    expect(prisma.node.findUnique).not.toHaveBeenCalled();
  });
  it.each([{ entryNodeId: 'node' }, { certificateId: 'cert' }, { params: { password: 'bad' } }, { speedLimitMbps: 10 }, { tcpFastOpen: true }])('rejects conflicting local options %j', async (options) => {
    await expect(lines.create({ name: 'Bad', type: 'EXTERNAL', upstreamNodeId: upstream.id, ...options })).rejects.toThrow();
  });
  it('copies the upstream binding and does not allocate an entry port', async () => {
    await lines.duplicate(external.id);
    expect(prisma.line.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ upstreamNodeId: upstream.id, status: 'DISABLED', entryPort: null }) }));
  });
  it('applies ALL/TAGS/EXPLICIT and extra grants equally', async () => {
    expect(await lines.getAvailableForPlan(plan)).toHaveLength(0);
    expect(await lines.getAvailableForPlan(plan, [external.id])).toHaveLength(1);
    prisma.line.findMany.mockResolvedValue([{ ...external, isPublic: true }]);
    for (const rule of [plan, { ...plan, lineMatchMode: 'TAGS', lineTagsJson: '["premium"]' }, { ...plan, lineMatchMode: 'EXPLICIT', lineIdsJson: '["line"]' }]) expect(await lines.getAvailableForPlan(rule)).toHaveLength(1);
    expect(await lines.getAvailableForPlan({ ...plan, lineMatchMode: 'EXPLICIT' })).toHaveLength(0);
  });
  it('user summary never includes nested secrets and all formats use upstream credentials', async () => {
    const result = await subs.getForUser(user.id);
    expect(result.lines[0].capabilities).toEqual({ trafficMetered: false, localLimitsSupported: false, credentialRevocable: false });
    expect(JSON.stringify(result)).not.toMatch(/external-secret|params|upstreamNode|rawConfig/);
    const resources = await lines.getAvailableForPlan(plan, [external.id]);
    const [resource] = resources;
    const source = { id: resource.id, name: resource.name, type: resource.type, protocolType: resource.protocolType, serverHost: resource.serverHost, serverPort: resource.serverPort, externalConnection: resource.externalConnection };
    const local = { ...user, credential: 'local-secret' };
    expect(buildUriList(local, [source])[0]).toContain('external-secret');
    expect(parse(buildClashYaml(local, [source])).proxies[0].password).toBe('external-secret');
    expect(JSON.parse(buildSingboxJson(local, [source])).outbounds.find((out: { tag: string }) => out.tag === source.name).password).toBe('external-secret');
    expect(prisma.upstreamNode.findMany).not.toHaveBeenCalled();
  });
  it.each([{ status: 'EXPIRED' }, { trafficUsedBytes: 1000n }, { expireAt: new Date(0) }, { user: { ...user, isActive: false } }, { user: { ...user, emailVerifiedAt: null } }])('returns no resources without entitlement %#', async (overrides) => {
    settings.getSettings.mockResolvedValue({ enforceEmailVerification: true });
    prisma.subscription.findUnique.mockResolvedValue({ ...subscription, ...overrides });
    expect((await subs.getForUser(user.id)).lines).toEqual([]);
    expect(prisma.line.findMany).not.toHaveBeenCalled();
  });
  it('blocks missing/disabled source resources and enabling', async () => {
    prisma.line.findMany.mockResolvedValue([{ ...external, upstreamNode: { ...upstream, presenceStatus: 'MISSING' } }]);
    expect(await lines.getAvailableForPlan(plan, [external.id])).toEqual([]);
    prisma.upstreamNode.findUnique.mockResolvedValue({ ...upstream, subscription: { ...upstream.subscription, status: 'DISABLED' } });
    await expect(lines.batchStatus({ ids: [external.id], status: 'ACTIVE' })).rejects.toThrow();
    expect(prisma.line.updateMany).not.toHaveBeenCalled();
  });
  it('actual export uses the same authorized EXTERNAL resource and no local badges', async () => {
    settings.getSettings.mockResolvedValue({ appendSubscriptionSpeedBadge: true });
    prisma.subscription.findUnique.mockResolvedValue({ ...subscription, plan: { ...plan, speedLimitMbps: 10 } });
    const result = await subs.getSubscription('token', { type: 'singbox' });
    expect(JSON.stringify(result)).toContain('external-secret');
    expect(JSON.stringify(result)).not.toContain('[10');
  });
});
