import { Test } from '@nestjs/testing';
import { LinesService } from './lines.service';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService } from '../agent-gateway/agent.service';
import { encryptSecret } from '../common/secret-crypto';

const node = { id: 'entry', name: 'Entry', serverHost: 'example.com', status: 'ONLINE', reachability: 'PUBLIC' };
const upstream = { id: 'up', name: 'Up', status: 'ACTIVE', presenceStatus: 'PRESENT', protocolType: 'HTTP', serverHost: 'example.com', serverPort: 8080, paramsJson: encryptSecret('{"username":"u","password":"p"}'), subscription: { id: 'source', name: 'Source', status: 'ACTIVE', userInfoUsedBytes: null, userInfoTotalBytes: null, userInfoExpireAt: null } };
const raw = { id: 'line', name: 'Pool', type: 'DIRECT', protocolType: 'MIXED', relayMode: null, proxyPoolEnabled: true, paramsJson: '{"usersEnabled":false}', entryNodeId: node.id, entryPort: 1234, entryNode: node, landingNode: null, targetLine: null, upstreamNode: null, certificate: null, status: 'ACTIVE', isPublic: true, tagsJson: '[]', updatedAt: new Date() };
describe('显式代理池线路开关', () => {
  let service: LinesService;
  const prisma = { node: { findUnique: jest.fn() }, line: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() }, upstreamNode: { findUnique: jest.fn() } };
  const agent = { pushConfigToAll: jest.fn() };
  beforeAll(async () => { const module = await Test.createTestingModule({ providers: [LinesService, { provide: PrismaService, useValue: prisma }, { provide: AgentService, useValue: agent }] }).compile(); service = module.get(LinesService); });
  beforeEach(() => {
    jest.clearAllMocks(); prisma.node.findUnique.mockResolvedValue(node); prisma.line.findMany.mockResolvedValue([]); prisma.line.findFirst.mockResolvedValue(null); prisma.line.findUnique.mockResolvedValue(raw); prisma.upstreamNode.findUnique.mockResolvedValue(upstream);
    prisma.line.create.mockImplementation(async ({ data }) => ({ ...raw, ...data, upstreamNode: data.upstreamNodeId ? upstream : null }));
    prisma.line.update.mockImplementation(async ({ data }) => ({ ...raw, ...data }));
  });
  it('新直连默认不接入，显式Mixed开关可保存并复制，副本仍停用', async () => {
    await service.create({ name: 'Pool', entryNodeId: node.id, protocolType: 'MIXED', entryPort: 1234 });
    expect(prisma.line.create.mock.calls[0][0].data.proxyPoolEnabled).toBe(false);
    await service.create({ name: 'Pool', entryNodeId: node.id, protocolType: 'MIXED', entryPort: 1234, proxyPoolEnabled: true });
    expect(prisma.line.create.mock.calls[1][0].data.proxyPoolEnabled).toBe(true);
    await service.duplicate(raw.id);
    expect(prisma.line.create.mock.calls[2][0].data).toMatchObject({ proxyPoolEnabled: true, status: 'DISABLED' });
  });
  it('上游Mixed开启用户鉴权后可接入，禁鉴权仍拒绝', async () => {
    const input = { name: 'Relay', type: 'RELAY' as const, relayMode: 'UPSTREAM_NODE' as const, entryNodeId: node.id, entryPort: 1234, upstreamNodeId: upstream.id, protocolType: 'MIXED' as const, proxyPoolEnabled: true };
    await service.create({ ...input, params: { usersEnabled: true } });
    expect(prisma.line.create.mock.calls[0][0].data.proxyPoolEnabled).toBe(true);
    await expect(service.create({ ...input, params: { usersEnabled: false } })).rejects.toThrow();
    await expect(service.create({ ...input, params: { usersEnabled: true }, landingEndpointOverrideEnabled: true, landingServerHost: 'bad/host' })).rejects.toThrow();
  });
  it('单协议及其他中继不支持代理池，协议切换必须显式关闭开关', async () => {
    await expect(service.create({ name: 'HTTP', entryNodeId: node.id, entryPort: 1234, protocolType: 'HTTP', proxyPoolEnabled: true })).rejects.toThrow();
    await expect(service.create({ name: 'Blind', type: 'RELAY', relayMode: 'BLIND_FORWARD', entryNodeId: node.id, landingNodeId: node.id, protocolType: 'MIXED', proxyPoolEnabled: true })).rejects.toThrow();
    await expect(service.update(raw.id, { protocolType: 'HTTP' })).rejects.toThrow();
    await service.update(raw.id, { protocolType: 'HTTP', proxyPoolEnabled: false });
    expect(prisma.line.update.mock.calls[0][0].data.proxyPoolEnabled).toBe(false);
  });
});
