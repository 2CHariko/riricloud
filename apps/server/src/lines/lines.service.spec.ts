import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentGatewayService } from '../agent-gateway/agent-gateway.service';
import { LinesService } from './lines.service';
import { generateRealityParameters, revealInboundSecrets } from '../common/inbound';

describe('LinesService', () => {
  let service: LinesService;
  const entryNode = { id: 'node-entry', name: '入口节点', serverHost: '198.51.100.10', status: 'ONLINE', isLocal: false };
  const exitNode = { id: 'node-exit', name: '出口节点', serverHost: '198.51.100.20', status: 'ONLINE', isLocal: false };
  const prisma = {
    line: {
      findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), updateMany: jest.fn()
    },
    certificate: { findUnique: jest.fn() },
    node: { findUnique: jest.fn() },
    $transaction: jest.fn(async (operations: unknown[]) => Promise.all(operations as Promise<unknown>[]))
  };
  const gateway = { pushConfigToAll: jest.fn().mockResolvedValue(0) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ providers: [LinesService, { provide: PrismaService, useValue: prisma }, { provide: AgentGatewayService, useValue: gateway }] }).compile();
    service = moduleRef.get(LinesService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.line.findMany.mockResolvedValue([]);
    prisma.line.findFirst.mockResolvedValue(null);
    prisma.line.findUnique.mockReset();
    prisma.certificate.findUnique.mockResolvedValue(null);
    prisma.node.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => where.id === entryNode.id ? entryNode : where.id === exitNode.id ? exitNode : null);
  });

  const rawLine = {
    id: 'line-1', name: '东京 VLESS', tag: 'tokyo-vless', listen: '0.0.0.0', type: 'DIRECT', relayMode: null, protocolType: 'VLESS',
    paramsJson: JSON.stringify({ flow: 'xtls-rprx-vision', transport: { type: 'tcp' }, tls: { enabled: true, mode: 'reality', serverName: 'www.apple.com', reality: { dest: 'www.apple.com:443', serverNames: ['www.apple.com'], privateKey: 'private', publicKey: 'public', shortIds: ['sid'] } } }),
    entryNodeId: entryNode.id, entryPort: 24443, landingNodeId: null, landingPort: null, targetLineId: null,
    certificateId: null, certificate: null,
    endpointOverrideEnabled: false, serverHost: null, serverPort: null, serverName: null, host: null, trafficRate: 1, tagsJson: '["premium"]', level: 0, sortOrder: 0, isPublic: true, status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date(), entryNode, landingNode: null
  };

  it('线路 serializer 不公开严格历史或旧严格数字，目标线路关联同样隔离', async () => {
    const debug = { schemaVersion: 1, subjectType: 'LINE', subjectId: rawLine.id, status: 'SUCCESS', errorCode: null, message: 'PROXY_HTTP_OK', engine: 'MIHOMO', engineVersion: '1.19.30', fallbackReason: null, mihomoCompatibility: 'SUPPORTED', measurement: 'PROXY_HTTP_DELAY', perspective: 'MASTER', routeKind: 'MANAGED_DIRECT', targetId: 'target', targetHost: 'example.com', testedAt: new Date().toISOString(), durationMs: 20, latencyMs: 10, stage: 'DIAL_HTTP', configHash: 'hash', applied: true } as const;
    const target = { ...rawLine, id: 'target', entryNode: exitNode, lastDebugProbeJson: 'private-target-debug', lastProbeJson: JSON.stringify(debug) };
    prisma.line.findUnique.mockResolvedValue({ ...rawLine, lastDebugProbeJson: 'private-debug', lastProbeJson: JSON.stringify(debug), lastLatencyMs: 10, lastTestStatus: 'SUCCESS', targetLine: target });
    const { line } = await service.detail(rawLine.id);
    expect(line).toMatchObject({ lastProbe: null, lastLatencyMs: null, lastTestedAt: null, lastTestStatus: null, lastTestMessage: null });
    expect(line).not.toHaveProperty('lastDebugProbeJson');
    expect(line.targetLine).not.toHaveProperty('lastDebugProbeJson');
    expect(JSON.stringify(line)).not.toContain('private-debug');
    expect(JSON.stringify(line)).not.toContain('private-target-debug');
    expect(JSON.stringify(line)).not.toContain('PROXY_HTTP_DELAY');
    expect(service.toUserSummary({ ...line, lastProbe: debug }).lastProbe).toBeNull();
    expect(service.toUserSummary({ ...line, lastProbe: { ...debug, schemaVersion: 2, measurement: 'MIHOMO_URL_TEST' } }).lastProbe).toMatchObject({ schemaVersion: 2, measurement: 'MIHOMO_URL_TEST', latencyMs: 10 });
  });

  it('创建直连线路时将协议参数归一化并自动绑定同一节点', async () => {
    prisma.line.create.mockResolvedValue(rawLine);
    const result = await service.create({ name: '东京 VLESS', tag: 'tokyo-vless', listen: '127.0.0.1', protocolType: 'VLESS', entryNodeId: entryNode.id, entryPort: 24443, params: { tls: { mode: 'reality' } } });
    expect(prisma.line.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'DIRECT', protocolType: 'VLESS', tag: 'tokyo-vless', listen: '127.0.0.1', entryNodeId: entryNode.id, entryPort: 24443, landingNodeId: null, landingPort: null }) }));
    const params = result.line.params as { tls?: { reality?: Record<string, unknown> } };
    expect(params.tls).toBeDefined();
    expect(params.tls?.reality).not.toHaveProperty('privateKey');
  });

  it('创建双节点盲转发线路时保存独立入口和落地端点', async () => {
    const relay = { ...rawLine, id: 'line-relay', name: '跨节点盲转', type: 'RELAY', relayMode: 'BLIND_FORWARD', entryNodeId: entryNode.id, entryPort: 25001, landingNodeId: exitNode.id, landingPort: 25002, entryNode, landingNode: exitNode };
    prisma.line.create.mockResolvedValue(relay);
    const result = await service.create({ name: relay.name, type: 'RELAY', relayMode: 'BLIND_FORWARD', protocolType: 'VLESS', entryNodeId: entryNode.id, entryPort: 25001, landingNodeId: exitNode.id, landingPort: 25002 });
    expect(result.line.topology.entry?.port).toBe(25001);
    expect(result.line.topology.landing?.port).toBe(25002);
    expect(gateway.pushConfigToAll).toHaveBeenCalled();
  });

  it('桥接已有直连线路时自动复用目标节点和端口', async () => {
    const targetLine = { id: 'line-target', type: 'DIRECT', protocolType: 'SHADOWSOCKS', entryNodeId: exitNode.id, entryPort: 25002, entryNode: exitNode };
    prisma.line.findUnique.mockResolvedValue(targetLine);
    const relay = { ...rawLine, id: 'line-bridge', name: '异构桥接', type: 'RELAY', relayMode: 'TARGET_LINE', protocolType: 'VLESS', entryNodeId: entryNode.id, entryPort: 25001, landingNodeId: null, landingPort: null, targetLineId: targetLine.id, targetLine, entryNode, landingNode: null };
    prisma.line.create.mockResolvedValue(relay);

    const result = await service.create({
      name: relay.name,
      type: 'RELAY',
      relayMode: 'TARGET_LINE',
      protocolType: 'VLESS',
      entryNodeId: entryNode.id,
      entryPort: 25001,
      targetLineId: targetLine.id,
      params: { tls: { mode: 'reality' } }
    });

    expect(prisma.line.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        relayMode: 'TARGET_LINE',
        targetLineId: targetLine.id,
        landingNodeId: null,
        landingPort: null
      })
    }));
    expect(result.line.targetLineId).toBe(targetLine.id);
    expect(result.line.topology.landing?.port).toBe(targetLine.entryPort);
  });

  it('桥接目标必须是其他节点上的直连且支持出站的线路', async () => {
    prisma.line.findUnique.mockResolvedValue({ id: 'relay-target', type: 'RELAY', protocolType: 'VLESS', entryNodeId: exitNode.id, entryPort: 25002 });
    await expect(service.create({
      name: '目标不是直连', type: 'RELAY', relayMode: 'TARGET_LINE', protocolType: 'VLESS',
      entryNodeId: entryNode.id, targetLineId: 'relay-target'
    })).rejects.toThrow('桥接目标必须是直连线路');

    prisma.line.findUnique.mockResolvedValue({ id: 'shadowtls-target', type: 'DIRECT', protocolType: 'SHADOWTLS', entryNodeId: exitNode.id, entryPort: 25002 });
    await expect(service.create({
      name: '目标协议不支持', type: 'RELAY', relayMode: 'TARGET_LINE', protocolType: 'VLESS',
      entryNodeId: entryNode.id, targetLineId: 'shadowtls-target'
    })).rejects.toThrow('目标线路协议不支持作为桥接出口');

    prisma.line.findUnique.mockResolvedValue({ id: 'same-node-target', type: 'DIRECT', protocolType: 'VLESS', entryNodeId: entryNode.id, entryPort: 25002 });
    await expect(service.create({
      name: '目标同节点', type: 'RELAY', relayMode: 'TARGET_LINE', protocolType: 'VLESS',
      entryNodeId: entryNode.id, targetLineId: 'same-node-target'
    })).rejects.toThrow('桥接目标必须位于其他节点');
  });

  it('关联证书时仅保存 certificateId，并允许标准 TLS 省略节点本地路径', async () => {
    prisma.certificate.findUnique.mockResolvedValue({
      id: 'certificate-1', certificatePem: 'CERTIFICATE PEM', privateKeyPem: 'PRIVATE KEY PEM'
    });
    prisma.line.create.mockResolvedValue({ ...rawLine, certificateId: 'certificate-1' });
    const result = await service.create({
      name: '带证书线路',
      protocolType: 'HYSTERIA2',
      entryNodeId: entryNode.id,
      entryPort: 24445,
      certificateId: 'certificate-1',
      params: { tls: { mode: 'tls', serverName: 'example.com' } }
    });
    const createCall = prisma.line.create.mock.calls[0][0] as { data: { certificateId: string; paramsJson: string } };
    expect(createCall.data.certificateId).toBe('certificate-1');
    expect(createCall.data.paramsJson).not.toContain('PRIVATE KEY PEM');
    expect(result.line.certificateId).toBe('certificate-1');
  });

  it('端口被同传输层线路占用时拒绝创建', async () => {
    prisma.line.findMany.mockResolvedValue([{ protocolType: 'VLESS' }]);
    await expect(service.create({ name: '冲突线路', protocolType: 'VLESS', entryNodeId: entryNode.id, entryPort: 24443 })).rejects.toThrow(ConflictException);
    expect(prisma.line.create).not.toHaveBeenCalled();
  });

  it('双栈入站（SHADOWSOCKS 或盲转发入口）与 UDP 协议（HYSTERIA2）同端口时拒绝创建', async () => {
    prisma.line.findMany.mockResolvedValue([
      {
        protocolType: 'HYSTERIA2',
        type: 'DIRECT',
        relayMode: null,
        entryNodeId: entryNode.id,
        entryPort: 21514,
        landingNodeId: null,
        landingPort: null
      }
    ]);
    await expect(service.create({
      name: 'Shadowsocks 冲突',
      protocolType: 'SHADOWSOCKS',
      entryNodeId: entryNode.id,
      entryPort: 21514
    })).rejects.toThrow(ConflictException);

    await expect(service.create({
      name: '盲转发入口冲突',
      type: 'RELAY',
      relayMode: 'BLIND_FORWARD',
      protocolType: 'VLESS',
      entryNodeId: entryNode.id,
      entryPort: 21514,
      landingNodeId: exitNode.id,
      landingPort: 25002
    })).rejects.toThrow(ConflictException);

    expect(prisma.line.create).not.toHaveBeenCalled();
  });

  it('同节点中继线路不得复用相同的入口和落地端口', async () => {
    await expect(service.create({
      name: '同节点盲转',
      type: 'RELAY',
      relayMode: 'BLIND_FORWARD',
      protocolType: 'VLESS',
      entryNodeId: entryNode.id,
      entryPort: 25001,
      landingNodeId: entryNode.id,
      landingPort: 25001
    })).rejects.toThrow(BadRequestException);
    expect(prisma.line.create).not.toHaveBeenCalled();
  });

  it('ShadowTLS 不允许使用协议代理中继', async () => {
    await expect(service.create({
      name: 'ShadowTLS 协议代理',
      type: 'RELAY',
      relayMode: 'PROTOCOL_PROXY',
      protocolType: 'SHADOWTLS',
      entryNodeId: entryNode.id,
      entryPort: 25201,
      landingNodeId: exitNode.id,
      landingPort: 25202,
      params: {
        version: 3,
        handshakeDest: 'gateway.example.com:443',
        inner: { type: 'SHADOWSOCKS', method: '2022-blake3-aes-128-gcm', password: 'inner-password' }
      }
    })).rejects.toThrow('ShadowTLS 仅支持直连或盲转发');
    expect(prisma.line.create).not.toHaveBeenCalled();
  });

  it('套餐线路匹配解耦节点在线状态，即使节点离线依然正常返回', async () => {
    const relayLine = { ...rawLine, type: 'RELAY', relayMode: 'BLIND_FORWARD', landingNode: exitNode };
    const offlineRelayLine = { ...relayLine, id: 'offline-landing', landingNode: { ...exitNode, status: 'OFFLINE' } };
    const offlineEntryLine = { ...rawLine, id: 'offline-entry', entryNode: { ...entryNode, status: 'OFFLINE' } };
    prisma.line.findMany.mockResolvedValue([relayLine, offlineRelayLine, offlineEntryLine]);
    const result = await service.getAvailableForPlan({ lineMatchMode: 'TAGS', lineTagsJson: '["premium"]', lineIdsJson: '[]' });
    expect(result).toHaveLength(3);
    expect(result.map((line) => line.id)).toEqual(['line-1', 'offline-landing', 'offline-entry']);
  });

  it('套餐线路匹配仅根据线路自身的启用状态过滤，禁用线路被剔除', async () => {
    const activeLine = { ...rawLine, id: 'active-1', status: 'ACTIVE' };
    const disabledLine = { ...rawLine, id: 'disabled-1', status: 'DISABLED' };
    prisma.line.findMany.mockResolvedValue([activeLine, disabledLine]);

    const result = await service.getAvailableForPlan({ lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]' });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('active-1');
  });

  it('套餐线路视图会解析对外端点覆盖', async () => {
    prisma.line.findMany.mockResolvedValue([{
      ...rawLine,
      endpointOverrideEnabled: true,
      serverHost: 'edge.example.com',
      serverPort: 8443,
      serverName: 'tls.example.com',
      host: 'cdn.example.com'
    }]);

    const result = await service.getAvailableForPlan({ lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]' });

    expect(result[0]).toMatchObject({
      serverHost: 'edge.example.com',
      serverPort: 8443,
      serverName: 'tls.example.com',
      host: 'cdn.example.com',
      endpointOverrides: {
        serverHost: 'edge.example.com',
        serverPort: 8443,
        serverName: 'tls.example.com',
        host: 'cdn.example.com'
      }
    });
  });

  it('目标直连线路禁用时不返回桥接中继线路', async () => {
    const bridge = { ...rawLine, id: 'bridge', type: 'RELAY', relayMode: 'TARGET_LINE', targetLineId: 'target', entryNode, landingNode: null, targetLine: { id: 'target', status: 'DISABLED' } };
    prisma.line.findMany.mockResolvedValue([bridge]);
    const result = await service.getAvailableForPlan({ lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]' });
    expect(result).toHaveLength(0);
  });

  it('删除被桥接引用的目标线路时拦截操作', async () => {
    prisma.line.findUnique.mockResolvedValue(rawLine);
    prisma.line.findFirst.mockResolvedValue({ id: 'bridge-line' });
    await expect(service.remove(rawLine.id)).rejects.toThrow('该线路正被其他中继线路作为落地目标引用');
    expect(prisma.line.delete).not.toHaveBeenCalled();
  });

  it('套餐线路与额外线路取并集，额外授权可包含隐藏线路但不放行禁用线路', async () => {
    const hidden = { ...rawLine, id: 'hidden', name: '隐藏线路', isPublic: false, tagsJson: '["internal"]' };
    const disabled = { ...rawLine, id: 'disabled', name: '禁用线路', isPublic: false, status: 'DISABLED' };
    prisma.line.findMany.mockResolvedValue([rawLine, hidden, disabled]);

    const result = await service.getAvailableForPlan(
      { lineMatchMode: 'TAGS', lineTagsJson: '["premium"]', lineIdsJson: '[]' },
      ['hidden', 'disabled']
    );

    expect(result.map((line) => line.id)).toEqual(['line-1', 'hidden']);
    expect(prisma.line.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: 'ACTIVE',
        OR: [{ isPublic: true }, { id: { in: ['hidden', 'disabled'] } }]
      }
    }));
  });

  it('线路不存在时抛出 NotFoundException', async () => {
    prisma.line.findUnique.mockResolvedValue(null);
    await expect(service.detail('missing')).rejects.toThrow(NotFoundException);
  });

  describe('update 线路参数更新与多路复用彻底取消', () => {
    it('更新线路取消勾选多路复用时，彻底从 paramsJson 中移除 multiplex 并不残留旧参数', async () => {
      const lineWithMultiplex = {
        ...rawLine,
        id: 'line-ss-1',
        protocolType: 'SHADOWSOCKS',
        paramsJson: JSON.stringify({
          method: '2022-blake3-aes-128-gcm',
          password: 'old-password',
          mode: 'shared',
          multiplex: {
            enabled: true,
            protocol: 'smux',
            padding: true,
            brutal: { enabled: true, upMbps: 50, downMbps: 100 }
          }
        })
      };

      prisma.line.findUnique.mockResolvedValue(lineWithMultiplex);
      prisma.line.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...lineWithMultiplex,
        ...data
      }));

      // 前端取消勾选多路复用时，params 中不再包含 multiplex 键
      await service.update('line-ss-1', {
        name: '更新后的 SS 线路',
        protocolType: 'SHADOWSOCKS',
        params: {
          method: '2022-blake3-aes-128-gcm',
          password: 'old-password',
          mode: 'shared'
        }
      });

      expect(prisma.line.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'line-ss-1' },
        data: expect.objectContaining({
          paramsJson: expect.any(String)
        })
      }));

      const updateCall = prisma.line.update.mock.calls[0][0] as { data: { paramsJson: string } };
      const parsedUpdatedParams = JSON.parse(updateCall.data.paramsJson) as Record<string, unknown>;
      expect(parsedUpdatedParams).not.toHaveProperty('multiplex');
      expect(gateway.pushConfigToAll).toHaveBeenCalled();
    });

    it('编辑 Reality 线路未传入 privateKey 时自动继承原私钥', async () => {
      prisma.line.findUnique.mockResolvedValue(rawLine);
      prisma.line.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...rawLine,
        ...data
      }));

      // 前端编辑时没有私钥，只传了公钥与 dest
      await service.update('line-1', {
        name: '更新的 Reality',
        protocolType: 'VLESS',
        params: {
          flow: 'xtls-rprx-vision',
          transport: { type: 'tcp' },
          tls: {
            enabled: true,
            mode: 'reality',
            serverName: 'www.apple.com',
            reality: { dest: 'www.apple.com:443', serverNames: ['www.apple.com'], publicKey: 'public', shortIds: ['sid'] }
          }
        }
      });

      const updateCall = prisma.line.update.mock.calls[0][0] as { data: { paramsJson: string } };
      const parsedUpdatedParams = JSON.parse(updateCall.data.paramsJson) as {
        tls: { reality: { privateKey: string } }
      };
      expect(parsedUpdatedParams.tls.reality.privateKey).toBeDefined();
    });

    it('显式生成后保存同时替换三个参数，脱敏详情不回显私钥', async () => {
      const parameters = generateRealityParameters();
      prisma.line.findUnique.mockResolvedValue(rawLine);
      prisma.line.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...rawLine, ...data }));
      const result = await service.update(rawLine.id, { params: { tls: { mode: 'reality', reality: parameters } } });
      const call = prisma.line.update.mock.calls[0][0] as { data: { paramsJson: string } };
      const saved = revealInboundSecrets(JSON.parse(call.data.paramsJson));
      expect(saved).toMatchObject({ tls: { reality: parameters } });
      expect(result.line.params).toMatchObject({ tls: { reality: { publicKey: parameters.publicKey, shortIds: parameters.shortIds } } });
      expect(JSON.stringify(result.line.params)).not.toContain(parameters.privateKey);
      expect(gateway.pushConfigToAll).toHaveBeenCalledTimes(1);
    });
    });

    it('中继线路支持落地端点覆盖，并在 toView 与 topology.landing 中反映覆盖后的 host 与 port', async () => {
      const relay = {
        ...rawLine,
        id: 'line-relay-override',
        name: '专线中继',
        type: 'RELAY',
        relayMode: 'BLIND_FORWARD',
        entryNodeId: entryNode.id,
        entryPort: 25001,
        landingNodeId: exitNode.id,
        landingPort: 25002,
        landingEndpointOverrideEnabled: true,
        landingServerHost: '10.200.0.5',
        landingServerPort: 35002,
        entryNode,
        landingNode: exitNode
      };
      prisma.line.create.mockResolvedValue(relay);
      const result = await service.create({
        name: relay.name,
        type: 'RELAY',
        relayMode: 'BLIND_FORWARD',
        protocolType: 'VLESS',
        entryNodeId: entryNode.id,
        entryPort: 25001,
        landingNodeId: exitNode.id,
        landingPort: 25002,
        landingEndpointOverrideEnabled: true,
        landingServerHost: '10.200.0.5',
        landingServerPort: 35002
      });

      expect(result.line.landingEndpointOverrideEnabled).toBe(true);
      expect(result.line.landingServerHost).toBe('10.200.0.5');
      expect(result.line.landingServerPort).toBe(35002);
      expect(result.line.topology.landing?.host).toBe('10.200.0.5');
      expect(result.line.topology.landing?.port).toBe(35002);
    });

    it('桥接线路自动继承目标直连线路自身的有效对外端点覆盖', async () => {
      const targetLine = {
        id: 'line-target-overridden',
        type: 'DIRECT',
        protocolType: 'VLESS',
        entryNodeId: exitNode.id,
        entryPort: 25002,
        endpointOverrideEnabled: true,
        serverHost: 'target-cdn.example.com',
        serverPort: 8443,
        entryNode: exitNode
      };
      prisma.line.findUnique.mockResolvedValue(targetLine);
      const bridge = {
        ...rawLine,
        id: 'line-bridge-inherited',
        type: 'RELAY',
        relayMode: 'TARGET_LINE',
        targetLineId: targetLine.id,
        targetLine,
        entryNode,
        landingNode: null
      };
      prisma.line.create.mockResolvedValue(bridge);

      const result = await service.create({
        name: '自动继承桥接',
        type: 'RELAY',
        relayMode: 'TARGET_LINE',
        protocolType: 'VLESS',
        entryNodeId: entryNode.id,
        entryPort: 25001,
        targetLineId: targetLine.id
      });

      expect(result.line.topology.landing?.host).toBe('target-cdn.example.com');
      expect(result.line.topology.landing?.port).toBe(8443);
    });
});
