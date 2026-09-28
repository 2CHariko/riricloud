import { Test } from '@nestjs/testing';
import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SystemLogsService } from '../system-logs/system-logs.service';
import {
  INTERNAL_RELAY_TRANSIT_EMAIL,
  INTERNAL_RELAY_TRANSIT_SECRET,
  INTERNAL_RELAY_TRANSIT_UUID,
  INTERNAL_SPEEDTEST_EMAIL,
  INTERNAL_SPEEDTEST_UUID
} from '../common/constants';
import { AgentGatewayService } from './agent-gateway.service';
import type { AgentOnlineDeviceReportItem, HeartbeatData } from './agent-message';

describe('AgentGatewayService', () => {
  let service: AgentGatewayService;
  const systemLogEnqueue = jest.fn();
  const txUserFindMany = jest.fn();
  const txTrafficCreateMany = jest.fn(async () => undefined);
  const txUserUpdate = jest.fn(async () => undefined);
  const txSubscriptionFindMany = jest.fn();
  const txSubscriptionUpdate = jest.fn(async () => undefined);
  const txSubscriptionUpdateMany = jest.fn(async () => ({ count: 0 }));
  const txTrafficCursorFindMany = jest.fn();
  const txTrafficCursorUpsert = jest.fn(async () => undefined);
  const txRateFindUnique = jest.fn();
  const txRateCreate = jest.fn(async () => undefined);
  const txRateUpdate = jest.fn(async () => undefined);
  const txLineFindMany = jest.fn();
  const txProxyKeyFindMany = jest.fn();
  const txProxyKeyUpdate = jest.fn(async () => undefined);
  const tx = {
    user: { findMany: txUserFindMany, update: txUserUpdate },
    line: { findMany: txLineFindMany },
    trafficLog: { createMany: txTrafficCreateMany },
    subscription: { findMany: txSubscriptionFindMany, update: txSubscriptionUpdate, updateMany: txSubscriptionUpdateMany },
    trafficCursor: { findMany: txTrafficCursorFindMany, upsert: txTrafficCursorUpsert },
    nodeRateMetric: { findUnique: txRateFindUnique, create: txRateCreate, update: txRateUpdate },
    proxyKey: { findMany: txProxyKeyFindMany, update: txProxyKeyUpdate }
  };
  const deploymentFindUnique = jest.fn();
  const deploymentFindFirst = jest.fn();
  const deploymentFindMany = jest.fn();
  const deploymentCreate = jest.fn();
  const deploymentUpdate = jest.fn();
  const proxyKeyFindMany = jest.fn();
  const userFindUnique = jest.fn();
  const prisma = {
    $transaction: jest.fn(async (callback: (value: typeof tx) => Promise<void>) => callback(tx)),
    node: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    user: { findMany: jest.fn(), findUnique: userFindUnique },
    line: { findFirst: jest.fn(), findMany: jest.fn() },
    proxyKey: { findMany: proxyKeyFindMany },
    nodeRateMetric: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    binaryDeploymentTask: {
      findUnique: deploymentFindUnique,
      findFirst: deploymentFindFirst,
      findMany: deploymentFindMany,
      create: deploymentCreate,
      update: deploymentUpdate
    }
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentGatewayService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemLogsService, useValue: { enqueue: systemLogEnqueue } }
      ]
    }).compile();
    service = moduleRef.get(AgentGatewayService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.node.findUnique.mockReset();
    prisma.node.findUnique.mockResolvedValue(null);
    prisma.node.findFirst.mockReset();
    prisma.node.findFirst.mockImplementation(async ({ where }: { where: { OR?: Array<Record<string, unknown>> } }) => {
      const token = where.OR?.[1]?.agentToken;
      if (token === 'bad-token') return null;
      return { id: token === 'token-node-1' ? 'node-1' : 'poll-node', status: 'ONLINE', communicationMode: 'HTTP', pollIntervalSecs: 15 };
    });
    prisma.user.findMany.mockResolvedValue([]);
    userFindUnique.mockResolvedValue(null);
    prisma.line.findMany.mockResolvedValue([]);
    txUserFindMany.mockResolvedValue([]);
    txSubscriptionFindMany.mockResolvedValue([]);
    txSubscriptionUpdateMany.mockResolvedValue({ count: 0 });
    txTrafficCursorFindMany.mockResolvedValue([]);
    txRateFindUnique.mockResolvedValue(null);
    txLineFindMany.mockResolvedValue([]);
    txProxyKeyFindMany.mockResolvedValue([]);
    txProxyKeyUpdate.mockResolvedValue(undefined);
    proxyKeyFindMany.mockResolvedValue([]);
    prisma.line.findFirst.mockResolvedValue(null);
    deploymentFindUnique.mockResolvedValue(null);
    deploymentFindFirst.mockResolvedValue(null);
    deploymentFindMany.mockResolvedValue([]);
    deploymentCreate.mockResolvedValue(undefined);
    deploymentUpdate.mockResolvedValue(undefined);
    (service as unknown as { nextRateMetricCleanupAt: number }).nextRateMetricCleanupAt = 0;
    (service as unknown as { trafficHourlyBuckets: Map<string, unknown> }).trafficHourlyBuckets?.clear();
    (service as unknown as { rateMetricBuckets: Map<string, unknown> }).rateMetricBuckets?.clear();
    (service as unknown as { onlineDeviceReports: Map<string, Map<string, unknown>> }).onlineDeviceReports?.clear();
    (service as unknown as { deviceEnforcementAt: Map<string, number> }).deviceEnforcementAt?.clear();
    (service as unknown as { sockets: Map<string, unknown> }).sockets?.clear();
    (service as unknown as { pendingTasks: Map<string, unknown[]> }).pendingTasks?.clear();
  });

  const user = { uuid: 'uuid-1', email: 'user@example.com', password: 'secret', isActive: true, expireAt: null, trafficLimitBytes: BigInt(1000), trafficUsedBytes: BigInt(0) };
  const vlessParams = { flow: 'xtls-rprx-vision', transport: { type: 'tcp' }, tls: { enabled: true, mode: 'reality', serverName: 'www.apple.com', reality: { dest: 'www.apple.com:443', serverNames: ['www.apple.com'], privateKey: 'private', publicKey: 'public', shortIds: ['sid'] } } };
  const line = (overrides: Record<string, unknown> = {}) => ({
    id: 'line-1', name: 'VLESS 线路', tag: null, listen: '0.0.0.0', type: 'DIRECT', relayMode: null, protocolType: 'VLESS', paramsJson: JSON.stringify(vlessParams),
    entryNodeId: 'node-1', entryPort: 24443, landingNodeId: null, landingPort: null, targetLineId: null, endpointOverrideEnabled: false, serverHost: null, serverPort: null, serverName: null, host: null,
    status: 'ACTIVE',
    landingNode: { id: 'node-2', serverHost: '198.51.100.20', status: 'ONLINE' },
    ...overrides
  });

  it('按 Line 顶层协议生成 VLESS、Hysteria2 与 Shadowsocks 入站', async () => {
    const lines = [
      line(),
      line({ id: 'line-hy2', protocolType: 'HYSTERIA2', entryPort: 24444, paramsJson: JSON.stringify({ tls: { enabled: true, mode: 'tls', serverName: 'hy.example.com', certificatePath: '/c', keyPath: '/k' } }) }),
      line({ id: 'line-ss', protocolType: 'SHADOWSOCKS', entryPort: 24445, paramsJson: JSON.stringify({ method: 'aes-256-gcm', password: 'shared' }) }),
      line({
        id: 'line-shadowtls',
        protocolType: 'SHADOWTLS',
        entryPort: 24446,
        paramsJson: JSON.stringify({
          version: 3,
          handshakeDest: 'gateway.example.com:443',
          strictMode: true,
          inner: { type: 'SHADOWSOCKS', method: '2022-blake3-aes-128-gcm', password: 'inner-password' }
        })
      })
    ];
    prisma.node.findUnique.mockResolvedValue({ id: 'node-1', serverHost: '198.51.100.10', status: 'ONLINE', configOverride: null, entryLines: lines, landingLines: [] });
    prisma.user.findMany.mockResolvedValue([user]);
    const { singboxConfig } = await service.buildConfigSync('node-1');
    const inbounds = singboxConfig.inbounds as Array<Record<string, unknown>>;
    expect(singboxConfig.experimental).toEqual({
      v2ray_api: {
        listen: '127.0.0.1:10085',
        stats: {
          enabled: true,
          users: ['user@example.com::line-1', INTERNAL_SPEEDTEST_EMAIL, 'user@example.com::line-hy2', 'user@example.com::line-shadowtls'],
          inbounds: ['line-line-1', 'line-line-hy2', 'line-line-ss', 'line-line-shadowtls', 'line-line-shadowtls-inner']
        }
      }
    });
    expect(inbounds).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'vless', listen_port: 24443 }),
      expect.objectContaining({ type: 'hysteria2', listen_port: 24444 }),
      expect.objectContaining({ type: 'shadowsocks', listen_port: 24445 }),
      expect.objectContaining({ type: 'shadowtls', listen_port: 24446, detour: expect.stringContaining('-inner') }),
      expect.objectContaining({ type: 'shadowsocks', listen: '127.0.0.1', listen_port: 0, tag: expect.stringContaining('-inner') })
    ]));
  });

  it('配置同步读取证书关联中的最新 PEM 并以内嵌数组下发', async () => {
    const managed = line({
      id: 'managed-tls',
      protocolType: 'HYSTERIA2',
      entryPort: 24447,
      paramsJson: JSON.stringify({ tls: { enabled: true, mode: 'tls', serverName: 'example.com' } }),
      certificate: { certificatePem: 'CERTIFICATE PEM', privateKeyPem: 'PRIVATE KEY PEM' }
    });
    prisma.node.findUnique.mockResolvedValue({ id: 'node-1', serverHost: '198.51.100.10', status: 'ONLINE', configOverride: null, entryLines: [managed], landingLines: [] });
    prisma.user.findMany.mockResolvedValue([user]);

    const { singboxConfig } = await service.buildConfigSync('node-1');
    const managedInbound = (singboxConfig.inbounds as Array<Record<string, unknown>>).find((inbound) => inbound.tag === 'line-managed-tls');
    expect(managedInbound?.tls).toEqual({
      enabled: true,
      server_name: 'example.com',
      certificate: ['CERTIFICATE PEM'],
      key: ['PRIVATE KEY PEM']
    });
  });

  it('使用线路自定义监听地址和直连 Tag', async () => {
    const custom = line({ id: 'custom', tag: 'public-vless', listen: '127.0.0.1' });
    prisma.node.findUnique.mockResolvedValue({ id: 'node-1', serverHost: '198.51.100.10', status: 'ONLINE', configOverride: null, entryLines: [custom], landingLines: [] });
    prisma.user.findMany.mockResolvedValue([user]);
    const { singboxConfig } = await service.buildConfigSync('node-1');
    expect(singboxConfig.inbounds).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'vless', tag: 'public-vless', listen: '127.0.0.1', listen_port: 24443 })
    ]));
  });

  it('双节点盲转发在入口生成 direct，在出口生成协议入站', async () => {
    const relay = line({ id: 'blind', name: '盲转发', type: 'RELAY', relayMode: 'BLIND_FORWARD', entryNodeId: 'node-1', entryPort: 25001, landingNodeId: 'node-2', landingPort: 25002 });
    prisma.node.findUnique.mockResolvedValue({ id: 'node-1', serverHost: '198.51.100.10', status: 'ONLINE', configOverride: null, entryLines: [relay], landingLines: [] });
    const entryConfig = await service.buildConfigSync('node-1');
    expect(entryConfig.singboxConfig.inbounds).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'direct', listen_port: 25001, override_address: '198.51.100.20', override_port: 25002 })]));

    prisma.node.findUnique.mockResolvedValue({ id: 'node-2', serverHost: '198.51.100.20', status: 'ONLINE', configOverride: null, entryLines: [], landingLines: [{ ...relay, entryNode: { id: 'node-1', status: 'ONLINE' } }] });
    const exitConfig = await service.buildConfigSync('node-2');
    expect(exitConfig.singboxConfig.inbounds).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'vless', listen_port: 25002 })]));
  });

  it('中继线路配置生成解耦对端节点在线状态，落地或入口离线依然正常下发转发规则', async () => {
    const relay = line({ id: 'blind-decoupled', name: '盲转发解耦', type: 'RELAY', relayMode: 'BLIND_FORWARD', entryNodeId: 'node-1', entryPort: 25001, landingNodeId: 'node-2', landingPort: 25002, landingNode: { serverHost: '198.51.100.20', status: 'OFFLINE' } });
    prisma.node.findUnique.mockResolvedValue({ id: 'node-1', serverHost: '198.51.100.10', status: 'ONLINE', configOverride: null, entryLines: [relay], landingLines: [] });
    const entryConfig = await service.buildConfigSync('node-1');
    expect(entryConfig.singboxConfig.inbounds).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'direct', listen_port: 25001, override_address: '198.51.100.20', override_port: 25002 })]));

    prisma.node.findUnique.mockResolvedValue({ id: 'node-2', serverHost: '198.51.100.20', status: 'ONLINE', configOverride: null, entryLines: [], landingLines: [{ ...relay, entryNode: { id: 'node-1', status: 'OFFLINE' } }] });
    const exitConfig = await service.buildConfigSync('node-2');
    expect(exitConfig.singboxConfig.inbounds).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'vless', listen_port: 25002 })]));
  });

  it('协议代理中继生成协议入口、协议出口和路由规则', async () => {
    const relay = line({ id: 'proxy', tag: 'relay-proxy', type: 'RELAY', relayMode: 'PROTOCOL_PROXY', entryNodeId: 'node-1', entryPort: 25101, landingNodeId: 'node-2', landingPort: 25102 });
    prisma.node.findUnique.mockResolvedValue({ id: 'node-1', serverHost: '198.51.100.10', status: 'ONLINE', configOverride: null, entryLines: [relay], landingLines: [] });
    prisma.user.findMany.mockResolvedValue([user]);
    const { singboxConfig } = await service.buildConfigSync('node-1');
    expect(singboxConfig.inbounds).toEqual(expect.arrayContaining([expect.objectContaining({ tag: 'relay-proxy-entry', listen_port: 25101 })]));
    expect(singboxConfig.outbounds).toEqual(expect.arrayContaining([expect.objectContaining({ tag: 'relay-out-proxy', server: '198.51.100.20', server_port: 25102, uuid: INTERNAL_RELAY_TRANSIT_UUID })]));
    expect(singboxConfig.route).toEqual({ rules: [{ inbound: ['relay-proxy-entry'], outbound: 'relay-out-proxy' }] });

    prisma.node.findUnique.mockResolvedValue({
      id: 'node-2',
      serverHost: '198.51.100.20',
      status: 'ONLINE',
      configOverride: null,
      entryLines: [],
      landingLines: [{ ...relay, entryNode: { id: 'node-1', status: 'ONLINE' } }]
    });
    const exitConfig = await service.buildConfigSync('node-2');
    expect(exitConfig.singboxConfig.inbounds).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tag: 'relay-proxy-landing',
        users: [{ uuid: INTERNAL_RELAY_TRANSIT_UUID, name: INTERNAL_RELAY_TRANSIT_EMAIL, flow: 'xtls-rprx-vision' }]
      })
    ]));
    expect((exitConfig.singboxConfig.experimental as { v2ray_api: { stats: { users: string[] } } }).v2ray_api.stats.users)
      .toContain(INTERNAL_RELAY_TRANSIT_EMAIL);
  });

  it('NAT 落地中继正确重定向出口地址至 127.0.0.1、限制入站监听本地、注入局域网防护及下发反向隧道配置', async () => {
    const natRelay = line({
      id: 'nat-line',
      tag: 'relay-nat',
      type: 'RELAY',
      relayMode: 'BLIND_FORWARD',
      entryNodeId: 'entry-node',
      entryPort: 26001,
      landingNodeId: 'nat-node',
      landingPort: 26002,
      tunnelType: 'TCP_MUX',
      tunnelPort: 40001,
      tunnelSecret: 'secret-xyz',
      allowLanAccess: false,
      landingNode: { serverHost: '192.168.1.50', reachability: 'NAT', status: 'ONLINE' }
    });

    // 1. 入口公网 VPS（Server 角色）
    prisma.node.findUnique.mockResolvedValueOnce({
      id: 'entry-node',
      serverHost: 'entry.example.com',
      reachability: 'PUBLIC',
      status: 'ONLINE',
      configOverride: null,
      entryLines: [natRelay],
      landingLines: []
    });
    prisma.user.findMany.mockResolvedValue([user]);

    const entrySync = await service.buildConfigSync('entry-node');
    expect(entrySync.singboxConfig.inbounds).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tag: 'relay-nat-entry',
        listen_port: 26001,
        override_address: '127.0.0.1',
        override_port: 26002
      })
    ]));
    expect(entrySync.tunnelConfigs).toEqual([
      {
        id: 'tunnel-40001',
        role: 'SERVER',
        listenPort: 40001,
        secret: 'secret-xyz',
        mappings: [{ lineId: 'nat-line', localPort: 26002, targetPort: 26002 }]
      }
    ]);

    // 2. 内网落地 NAT 主机（Client 角色）
    prisma.node.findUnique.mockResolvedValueOnce({
      id: 'nat-node',
      serverHost: '192.168.1.50',
      reachability: 'NAT',
      status: 'ONLINE',
      configOverride: null,
      entryLines: [],
      landingLines: [{
        ...natRelay,
        entryNode: { serverHost: 'entry.example.com', status: 'ONLINE', reachability: 'PUBLIC' }
      }]
    });

    const landingSync = await service.buildConfigSync('nat-node');
    expect(landingSync.singboxConfig.inbounds).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tag: 'relay-nat-landing',
        listen: '127.0.0.1',
        listen_port: 26002
      })
    ]));
    expect((landingSync.singboxConfig.route as { rules: Array<Record<string, unknown>> }).rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inbound: ['relay-nat-landing'],
          ip_cidr: expect.arrayContaining(['10.0.0.0/8', '192.168.0.0/16']),
          outbound: 'block'
        })
      ])
    );
    expect(landingSync.singboxConfig.outbounds).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'block', tag: 'block' })
    ]));
    expect(landingSync.tunnelConfigs).toEqual([
      {
        id: 'tunnel-40001',
        role: 'CLIENT',
        serverAddr: 'entry.example.com:40001',
        secret: 'secret-xyz',
        mappings: [{ lineId: 'nat-line', localPort: 26002, targetPort: 26002 }]
      }
    ]);

    // 3. 当线路开启端点覆盖且提供自定义 serverHost 时，隧道客户端优先使用覆盖域名
    prisma.node.findUnique.mockResolvedValueOnce({
      id: 'nat-node',
      serverHost: '192.168.1.50',
      reachability: 'NAT',
      status: 'ONLINE',
      configOverride: null,
      entryLines: [],
      landingLines: [{
        ...natRelay,
        endpointOverrideEnabled: true,
        serverHost: 'tunnel.override.example.com',
        entryNode: { serverHost: 'entry.example.com', status: 'ONLINE', reachability: 'PUBLIC' }
      }]
    });
    const overrideSync = await service.buildConfigSync('nat-node');
    expect(overrideSync.tunnelConfigs).toEqual([
      {
        id: 'tunnel-40001',
        role: 'CLIENT',
        serverAddr: 'tunnel.override.example.com:40001',
        secret: 'secret-xyz',
        mappings: [{ lineId: 'nat-line', localPort: 26002, targetPort: 26002 }]
      }
    ]);
  });

  it('目标线路桥接生成入口协议、目标协议出口，并复用目标直连入站', async () => {
    const targetParams = { tls: { enabled: true, mode: 'tls', serverName: 'target.example.com' }, upMbps: 100, downMbps: 500 };
    const targetLine = line({
      id: 'target',
      name: '落地 Hysteria2',
      type: 'DIRECT',
      relayMode: null,
      protocolType: 'HYSTERIA2',
      paramsJson: JSON.stringify(targetParams),
      entryNodeId: 'node-2',
      entryPort: 25002,
      landingNodeId: null,
      landingPort: null,
      relaySources: [{ id: 'bridge', tagsJson: '[]', isPublic: true, status: 'ACTIVE' }],
      landingNode: null
    });
    const bridge = line({
      id: 'bridge',
      name: 'VLESS 转 Hysteria2',
      tag: 'relay-bridge',
      type: 'RELAY',
      relayMode: 'TARGET_LINE',
      protocolType: 'VLESS',
      entryNodeId: 'node-1',
      entryPort: 25001,
      landingNodeId: null,
      landingPort: null,
      targetLineId: 'target',
      targetLine: {
        id: 'target',
        type: 'DIRECT',
        protocolType: 'HYSTERIA2',
        paramsJson: JSON.stringify(targetParams),
        entryPort: 25002,
        status: 'ACTIVE',
        entryNode: { serverHost: '198.51.100.20', status: 'ONLINE' }
      },
      landingNode: null
    });

    prisma.node.findUnique.mockResolvedValueOnce({
      id: 'node-1', serverHost: '198.51.100.10', status: 'ONLINE', configOverride: null, entryLines: [bridge], landingLines: []
    });
    prisma.user.findMany.mockResolvedValue([user]);
    const entryConfig = await service.buildConfigSync('node-1');
    expect(entryConfig.singboxConfig.inbounds).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'vless', tag: 'relay-bridge-entry', listen_port: 25001 })
    ]));
    expect(entryConfig.singboxConfig.outbounds).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'hysteria2', tag: 'relay-out-bridge', server: '198.51.100.20', server_port: 25002, password: INTERNAL_RELAY_TRANSIT_SECRET })
    ]));
    expect(entryConfig.singboxConfig.route).toEqual({ rules: [{ inbound: ['relay-bridge-entry'], outbound: 'relay-out-bridge' }] });

    prisma.node.findUnique.mockResolvedValueOnce({
      id: 'node-2', serverHost: '198.51.100.20', status: 'ONLINE', configOverride: null, entryLines: [targetLine], landingLines: []
    });
    const exitConfig = await service.buildConfigSync('node-2');
    expect(exitConfig.singboxConfig.inbounds).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'hysteria2',
        listen_port: 25002,
        users: expect.arrayContaining([
          { name: `${user.email}::${targetLine.id}`, password: user.password },
          { name: INTERNAL_RELAY_TRANSIT_EMAIL, password: INTERNAL_RELAY_TRANSIT_SECRET }
        ])
      })
    ]));
    expect(exitConfig.singboxConfig.inbounds).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ listen_port: 25002, tag: 'relay-bridge-exit' })
    ]));
  });

  it('盲转发和协议代理在开启 landingEndpointOverrideEnabled 时使用覆盖的落地地址与端口', async () => {
    const relayWithOverride = line({
      id: 'blind-override',
      name: '盲转发专线覆盖',
      type: 'RELAY',
      relayMode: 'BLIND_FORWARD',
      entryNodeId: 'node-1',
      entryPort: 25001,
      landingNodeId: 'node-2',
      landingPort: 25002,
      landingEndpointOverrideEnabled: true,
      landingServerHost: '10.10.0.2',
      landingServerPort: 35002,
      landingNode: { serverHost: '198.51.100.20', status: 'ONLINE', reachability: 'PUBLIC' }
    });

    prisma.node.findUnique.mockResolvedValueOnce({
      id: 'node-1', serverHost: '198.51.100.10', status: 'ONLINE', configOverride: null, entryLines: [relayWithOverride], landingLines: []
    });
    prisma.user.findMany.mockResolvedValue([user]);

    const entryConfig = await service.buildConfigSync('node-1');
    expect(entryConfig.singboxConfig.inbounds).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'direct',
        listen_port: 25001,
        override_address: '10.10.0.2',
        override_port: 35002
      })
    ]));
  });

  it('目标线路桥接自动继承目标线路端点覆盖，且中继显式配置落地覆盖时优先使用中继自身覆盖', async () => {
    const targetParams = { tls: { enabled: true, mode: 'tls', serverName: 'target.example.com' } };
    const bridgeInherited = line({
      id: 'bridge-inherited',
      name: '继承目标端点',
      tag: 'relay-bridge-inherited',
      type: 'RELAY',
      relayMode: 'TARGET_LINE',
      protocolType: 'VLESS',
      entryNodeId: 'node-1',
      entryPort: 25001,
      targetLineId: 'target-1',
      targetLine: {
        id: 'target-1',
        type: 'DIRECT',
        protocolType: 'TROJAN',
        paramsJson: JSON.stringify(targetParams),
        entryPort: 25002,
        status: 'ACTIVE',
        endpointOverrideEnabled: true,
        serverHost: 'target-edge.example.com',
        serverPort: 9443,
        serverName: 'trojan-sni.example.com',
        entryNode: { serverHost: '198.51.100.20', status: 'ONLINE' }
      },
      landingNode: null
    });

    prisma.node.findUnique.mockResolvedValueOnce({
      id: 'node-1', serverHost: '198.51.100.10', status: 'ONLINE', configOverride: null, entryLines: [bridgeInherited], landingLines: []
    });
    prisma.user.findMany.mockResolvedValue([user]);

    const entryConfig = await service.buildConfigSync('node-1');
    expect(entryConfig.singboxConfig.outbounds).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'trojan',
        server: 'target-edge.example.com',
        server_port: 9443
      })
    ]));
    const bridgeWithOriginIp = line({
      id: 'bridge-origin-ip',
      name: '回源 IP 桥接保持域名 SNI',
      tag: 'relay-bridge-origin-ip',
      type: 'RELAY',
      relayMode: 'TARGET_LINE',
      protocolType: 'VLESS',
      entryNodeId: 'node-1',
      entryPort: 25001,
      targetLineId: 'target-hk',
      landingEndpointOverrideEnabled: true,
      landingServerHost: '10.0.0.88',
      targetLine: {
        id: 'target-hk',
        type: 'DIRECT',
        protocolType: 'TROJAN',
        paramsJson: JSON.stringify({
          tls: { enabled: true, mode: 'tls' },
          transport: { type: 'ws', path: '/ws' }
        }),
        entryPort: 25002,
        status: 'ACTIVE',
        endpointOverrideEnabled: true,
        serverHost: 'hk-domain.example.com',
        serverPort: 443,
        serverName: null,
        host: null,
        entryNode: { serverHost: '203.0.113.10', status: 'ONLINE' }
      },
      landingNode: null
    });

    prisma.node.findUnique.mockResolvedValueOnce({
      id: 'node-1', serverHost: '198.51.100.10', status: 'ONLINE', configOverride: null, entryLines: [bridgeWithOriginIp], landingLines: []
    });
    prisma.user.findMany.mockResolvedValue([user]);

    const originConfig = await service.buildConfigSync('node-1');
    expect(originConfig.singboxConfig.outbounds).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'trojan',
        server: '10.0.0.88',
        server_port: 443,
        tls: expect.objectContaining({
          enabled: true,
          server_name: 'hk-domain.example.com'
        }),
        transport: expect.objectContaining({
          type: 'ws',
          headers: { Host: 'hk-domain.example.com' }
        })
      })
    ]));
  });

  it('心跳遥测独立落库，流量账务在单独事务内完成', async () => {
    txUserFindMany.mockResolvedValue([{ id: 'user-1', uuid: user.uuid, email: user.email }]);
    prisma.line.findFirst.mockResolvedValue({ id: 'line-1' });
    const heartbeat: HeartbeatData = { protocolVersion: 2, cpuUsage: 12, memoryUsage: 30, bandwidthRate: 512, trafficSnapshots: [{ userUuid: user.uuid, uploadTotal: '100', downloadTotal: '200' }] };
    await service.handleHeartbeat('node-1', heartbeat);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.node.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'node-1' },
      data: expect.objectContaining({ cpuUsage: 12, memoryUsage: 30, bandwidthRate: 512 })
    }));
    expect(service.getBufferedTrafficHourlyMetrics()).toEqual([
      expect.objectContaining({ nodeId: 'node-1', userId: 'user-1', lineId: 'line-1', upload: 100n, download: 200n })
    ]);
    expect(txUserUpdate).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { trafficUsedBytes: { increment: BigInt(300) } } });
    expect(txSubscriptionUpdate).not.toHaveBeenCalled();
  });

  it('新 Agent 心跳落库上下行速率并写入五分钟聚合桶', async () => {
    await service.handleHeartbeat('node-1', {
      cpuUsage: 12,
      memoryUsage: 30,
      bandwidthRate: 460,
      uploadRate: 120,
      downloadRate: 340,
      protocolVersion: 2,
      trafficSnapshots: []
    });
    await (service as unknown as { flushRateMetrics: () => Promise<void> }).flushRateMetrics();
    expect(prisma.node.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ uploadRate: 120, downloadRate: 340, bandwidthRate: 460 })
    }));
    expect(txRateCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        nodeId: 'node-1',
        bucketStart: expect.any(Date),
        sampleCount: 1,
        uploadRateSum: 120,
        downloadRateSum: 340,
        uploadRatePeak: 120,
        downloadRatePeak: 340
      })
    });
    expect(prisma.nodeRateMetric.deleteMany).not.toHaveBeenCalled();
  });

  it('订阅存在时扣减 Subscription 并同步 User 镜像', async () => {
    txUserFindMany.mockResolvedValue([{ id: 'user-1', uuid: user.uuid, email: user.email }]);
    prisma.line.findFirst.mockResolvedValue({ id: 'line-1' });
    txSubscriptionFindMany.mockResolvedValue([{ id: 'sub-1', userId: 'user-1' }]);
    const heartbeat: HeartbeatData = {
      cpuUsage: 12,
      memoryUsage: 30,
      bandwidthRate: 512,
      protocolVersion: 2,
      trafficSnapshots: [{ userUuid: user.uuid, uploadTotal: '4503599627370497', downloadTotal: '4503599627370498' }]
    };
    await service.handleHeartbeat('node-1', heartbeat);
    expect(txSubscriptionUpdate).toHaveBeenCalledWith({
      where: { id: 'sub-1' },
      data: { trafficUsedBytes: { increment: BigInt('9007199254740995') } }
    });
    expect(txUserUpdate).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { trafficUsedBytes: { increment: BigInt('9007199254740995') } }
    });
  });

  it('盲转发出口节点优先回退到承载线路并按线路倍率扣费', async () => {
    txUserFindMany.mockResolvedValue([{ id: 'user-1', uuid: user.uuid, email: user.email }]);
    prisma.line.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'blind-line', trafficRate: 1.5 });
    txTrafficCursorFindMany.mockResolvedValue([]);

    await service.handleHeartbeat('node-2', {
      protocolVersion: 2,
      cpuUsage: 1,
      memoryUsage: 2,
      bandwidthRate: 3,
      trafficSnapshots: [{ userUuid: user.uuid, uploadTotal: '100', downloadTotal: '50' }]
    });

    expect(service.getBufferedTrafficHourlyMetrics()).toEqual([
      expect.objectContaining({ nodeId: 'node-2', lineId: 'blind-line', upload: 100n, download: 50n })
    ]);
    expect(txUserUpdate).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { trafficUsedBytes: { increment: 225n } }
    });
  });

  it('内部中继与测速探针凭证只更新游标，不创建流水或扣减任何用户配额', async () => {
    txTrafficCursorFindMany.mockResolvedValue([
      { credential: INTERNAL_RELAY_TRANSIT_EMAIL, uploadTotal: 100n, downloadTotal: 100n },
      { credential: INTERNAL_RELAY_TRANSIT_UUID, uploadTotal: 100n, downloadTotal: 100n },
      { credential: INTERNAL_SPEEDTEST_EMAIL, uploadTotal: 100n, downloadTotal: 100n },
      { credential: INTERNAL_SPEEDTEST_UUID, uploadTotal: 100n, downloadTotal: 100n }
    ]);

    await service.handleHeartbeat('node-2', {
      protocolVersion: 2,
      cpuUsage: 1,
      memoryUsage: 2,
      bandwidthRate: 3,
      trafficSnapshots: [
        { userUuid: INTERNAL_RELAY_TRANSIT_EMAIL, uploadTotal: '10', downloadTotal: '20' },
        { userUuid: INTERNAL_RELAY_TRANSIT_UUID, uploadTotal: '30', downloadTotal: '40' },
        { userUuid: INTERNAL_SPEEDTEST_EMAIL, uploadTotal: '50', downloadTotal: '60' },
        { userUuid: INTERNAL_SPEEDTEST_UUID, uploadTotal: '70', downloadTotal: '80' }
      ]
    });

    expect(txTrafficCreateMany).not.toHaveBeenCalled();
    expect(txUserUpdate).not.toHaveBeenCalled();
    expect(txSubscriptionUpdate).not.toHaveBeenCalled();
    expect(txTrafficCursorUpsert).toHaveBeenCalledTimes(4);
    expect(txTrafficCursorUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { nodeId_credential: { nodeId: 'node-2', credential: INTERNAL_SPEEDTEST_EMAIL } },
      update: { uploadTotal: 50n, downloadTotal: 60n }
    }));
    expect((service as unknown as { trafficCounterResetCount: number }).trafficCounterResetCount).toBe(0);
  });

  it('心跳跨过流量周期边界时先重置再计入新周期，且只重置一次', async () => {
    txUserFindMany.mockResolvedValue([{ id: 'user-1', uuid: user.uuid, email: user.email }]);
    txTrafficCursorFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ credential: user.uuid, uploadTotal: 100n, downloadTotal: 200n }]);
    const now = new Date();
    const currentPeriodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    txSubscriptionFindMany
      .mockResolvedValueOnce([{
        id: 'sub-1',
        userId: 'user-1',
        startedAt: new Date(now.getTime() - 45 * 86400000),
        trafficPeriodStartAt: new Date(currentPeriodStart.getTime() - 86400000),
        plan: { durationDays: 30, trafficResetMode: 'CALENDAR_MONTH' }
      }])
      .mockResolvedValueOnce([{
        id: 'sub-1',
        userId: 'user-1',
        startedAt: new Date(now.getTime() - 45 * 86400000),
        trafficPeriodStartAt: currentPeriodStart,
        plan: { durationDays: 30, trafficResetMode: 'CALENDAR_MONTH' }
      }]);
    txSubscriptionUpdateMany.mockResolvedValue({ count: 1 });

    await service.handleHeartbeat('node-1', {
      protocolVersion: 2,
      cpuUsage: 1,
      memoryUsage: 2,
      bandwidthRate: 3,
      trafficSnapshots: [{ userUuid: user.uuid, uploadTotal: '100', downloadTotal: '200' }]
    });
    await service.handleHeartbeat('node-1', {
      protocolVersion: 2,
      cpuUsage: 1,
      memoryUsage: 2,
      bandwidthRate: 3,
      trafficSnapshots: [{ userUuid: user.uuid, uploadTotal: '101', downloadTotal: '200' }]
    });

    expect(txSubscriptionUpdateMany).toHaveBeenCalledTimes(1);
    expect(txSubscriptionUpdateMany).toHaveBeenCalledWith({
      where: { id: 'sub-1', trafficPeriodStartAt: expect.any(Date) },
      data: { trafficPeriodStartAt: expect.any(Date), trafficUsedBytes: BigInt(0) }
    });
    expect(txUserUpdate).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { trafficUsedBytes: BigInt(0) } });
    expect(txSubscriptionUpdate).toHaveBeenCalledWith({ where: { id: 'sub-1' }, data: { trafficUsedBytes: { increment: BigInt(1) } } });
    expect(txUserUpdate).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { trafficUsedBytes: { increment: BigInt(1) } } });
  });

  it('累计快照只按游标差额计费，重复快照不会重复扣减', async () => {
    txUserFindMany.mockResolvedValue([{ id: 'user-1', uuid: user.uuid, email: user.email }]);
    txTrafficCursorFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ credential: user.uuid, uploadTotal: 100n, downloadTotal: 200n }]);

    await service.handleHeartbeat('node-1', {
      protocolVersion: 2,
      cpuUsage: 1,
      memoryUsage: 2,
      bandwidthRate: 3,
      trafficSnapshots: [{ userUuid: user.uuid, uploadTotal: '100', downloadTotal: '200' }]
    });
    txTrafficCreateMany.mockClear();
    txUserUpdate.mockClear();
    txTrafficCursorUpsert.mockClear();

    await service.handleHeartbeat('node-1', {
      protocolVersion: 2,
      cpuUsage: 1,
      memoryUsage: 2,
      bandwidthRate: 3,
      trafficSnapshots: [{ userUuid: user.uuid, uploadTotal: '100', downloadTotal: '200' }]
    });
    expect(txTrafficCreateMany).not.toHaveBeenCalled();
    expect(txUserUpdate).not.toHaveBeenCalled();
    expect(txTrafficCursorUpsert).toHaveBeenCalledTimes(1);
  });

  it('累计快照支持丢失中间样本并处理单方向计数器重置', async () => {
    txUserFindMany.mockResolvedValue([{ id: 'user-1', uuid: user.uuid, email: user.email }]);
    txTrafficCursorFindMany.mockResolvedValue([
      { credential: user.uuid, uploadTotal: 1000n, downloadTotal: 2000n }
    ]);
    await service.handleHeartbeat('node-1', {
      protocolVersion: 2,
      cpuUsage: 1,
      memoryUsage: 2,
      bandwidthRate: 3,
      trafficSnapshots: [{ userUuid: user.uuid, uploadTotal: '25', downloadTotal: '2500' }]
    });
    expect(service.getBufferedTrafficHourlyMetrics()).toEqual([
      expect.objectContaining({ upload: 25n, download: 500n })
    ]);
  });

  it('未知凭证只建立游标基线，之后只计入新增流量', async () => {
    txUserFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'user-1', uuid: user.uuid, email: user.email }]);
    txTrafficCursorFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ credential: user.uuid, uploadTotal: 100n, downloadTotal: 200n }]);

    await service.handleHeartbeat('node-1', {
      protocolVersion: 2,
      cpuUsage: 1,
      memoryUsage: 2,
      bandwidthRate: 3,
      trafficSnapshots: [{ userUuid: user.uuid, uploadTotal: '100', downloadTotal: '200' }]
    });
    expect(service.getBufferedTrafficHourlyMetrics()).toHaveLength(0);

    await service.handleHeartbeat('node-1', {
      protocolVersion: 2,
      cpuUsage: 1,
      memoryUsage: 2,
      bandwidthRate: 3,
      trafficSnapshots: [{ userUuid: user.uuid, uploadTotal: '150', downloadTotal: '250' }]
    });
    expect(service.getBufferedTrafficHourlyMetrics()).toEqual([
      expect.objectContaining({ upload: 50n, download: 50n })
    ]);
  });

  it('不同节点的累计游标相互隔离', async () => {
    txUserFindMany.mockResolvedValue([{ id: 'user-1', uuid: user.uuid, email: user.email }]);
    txTrafficCursorFindMany.mockResolvedValue([]);
    await Promise.all([
      service.handleHeartbeat('node-1', {
        protocolVersion: 2,
        cpuUsage: 1,
        memoryUsage: 2,
        bandwidthRate: 3,
        trafficSnapshots: [{ userUuid: user.uuid, uploadTotal: '100', downloadTotal: '0' }]
      }),
      service.handleHeartbeat('node-2', {
        protocolVersion: 2,
        cpuUsage: 1,
        memoryUsage: 2,
        bandwidthRate: 3,
        trafficSnapshots: [{ userUuid: user.uuid, uploadTotal: '100', downloadTotal: '0' }]
      })
    ]);
    expect(service.getBufferedTrafficHourlyMetrics()).toHaveLength(2);
  });

  it('同一节点的并发心跳按顺序执行', async () => {
    let releaseFirst!: () => void;
    const firstUpdate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const nodeUpdate = prisma.node.update as jest.Mock;
    nodeUpdate.mockImplementationOnce(async () => firstUpdate);

    const first = service.handleHeartbeat('node-serial', {
      cpuUsage: 1,
      memoryUsage: 2,
      bandwidthRate: 3,
      protocolVersion: 2,
      trafficSnapshots: []
    });
    await new Promise((resolve) => setImmediate(resolve));
    const second = service.handleHeartbeat('node-serial', {
      cpuUsage: 4,
      memoryUsage: 5,
      bandwidthRate: 6,
      protocolVersion: 2,
      trafficSnapshots: []
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(nodeUpdate).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(nodeUpdate).toHaveBeenCalledTimes(2);
  });

  it('速率历史清理按低频周期执行', async () => {
    const deleteMany = prisma.nodeRateMetric.deleteMany as jest.Mock;
    deleteMany.mockResolvedValue({ count: 3 });

    await service.cleanupOldRateMetrics();
    await service.cleanupOldRateMetrics();

    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledWith({ where: { bucketStart: { lt: expect.any(Date) } } });
  });

  it('节点不存在时配置同步抛出 NotFoundException', async () => {
    prisma.node.findUnique.mockResolvedValue(null);
    await expect(service.buildConfigSync('missing')).rejects.toThrow(NotFoundException);
  });

  it('HTTP 轮询鉴权失败时拒绝请求', async () => {
    prisma.node.findUnique.mockResolvedValue(null);
    await expect(service.poll('bad-token', {
      cpuUsage: 1,
      memoryUsage: 2,
      bandwidthRate: 3,
      protocolVersion: 2,
      trafficSnapshots: []
    })).rejects.toThrow(UnauthorizedException);
  });

  it('HTTP 轮询接入会淘汰同节点旧 WS 连接', async () => {
    const socket = { send: jest.fn(), close: jest.fn() };
    prisma.node.update.mockResolvedValue(undefined);
    prisma.node.findUnique
      .mockResolvedValueOnce({ id: 'poll-node', name: 'HTTP 节点', status: 'OFFLINE' })
      .mockResolvedValueOnce({ id: 'poll-node', name: 'HTTP 节点', status: 'ONLINE' })
      .mockResolvedValueOnce({ id: 'poll-node', serverHost: '198.51.100.10', configOverride: null, entryLines: [], landingLines: [] })
      .mockResolvedValueOnce({ pollIntervalSecs: 15 });
    await service.register('poll-node', socket);
    await service.poll('token', { protocolVersion: 2, cpuUsage: 1, memoryUsage: 2, bandwidthRate: 3, trafficSnapshots: [] });
    expect(socket.close).toHaveBeenCalledWith(4002, 'switched to HTTP polling');
    expect(service.isCurrentSocket('poll-node', socket)).toBe(false);
  });

  it('HTTP 轮询只在配置版本落后时返回配置', async () => {
    (service as unknown as { configCache: Map<string, unknown> }).configCache.clear();
    prisma.node.findUnique
      .mockResolvedValueOnce({ id: 'poll-node', serverHost: '198.51.100.10', configOverride: null, entryLines: [], landingLines: [] })
      .mockResolvedValueOnce({ pollIntervalSecs: 15 });
    const first = await service.poll('token', { protocolVersion: 2, cpuUsage: 1, memoryUsage: 2, bandwidthRate: 3, trafficSnapshots: [] });
    expect(first.needUpdate).toBe(true);
    expect(first.singboxConfig).toEqual(expect.objectContaining({ inbounds: [] }));
    expect(first.nextPollSecs).toBe(15);

    prisma.node.findUnique.mockResolvedValueOnce({ pollIntervalSecs: 30 });
    const second = await service.poll('token', {
      cpuUsage: 1,
      memoryUsage: 2,
      bandwidthRate: 3,
      appliedConfigVersion: first.version,
      protocolVersion: 2,
      trafficSnapshots: []
    });
    expect(second.needUpdate).toBe(false);
    expect(second.singboxConfig).toBeNull();
    expect(second.nextPollSecs).toBe(30);
  });

  it('HTTP 节点任务进入队列并在回执后完成', async () => {
    prisma.node.findUnique.mockResolvedValue({ id: 'http-task-node', status: 'ONLINE', communicationMode: 'HTTP' });
    const requested = await service.requestProbe('http-task-node', [{ type: 'dns', target: 'example.com' }]);
    expect(requested.requested).toBe(true);

    (service as unknown as { configCache: Map<string, unknown> }).configCache.clear();
    prisma.node.findUnique
      .mockResolvedValueOnce({ id: 'http-task-node', serverHost: '198.51.100.11', configOverride: null, entryLines: [], landingLines: [] })
      .mockResolvedValueOnce({ pollIntervalSecs: 15 });
    prisma.node.findFirst.mockResolvedValue({ id: 'http-task-node', status: 'ONLINE', communicationMode: 'HTTP', pollIntervalSecs: 15 });
    const response = await service.poll('token', { protocolVersion: 2, cpuUsage: 1, memoryUsage: 2, bandwidthRate: 3, trafficSnapshots: [] });
    expect(response.tasks).toHaveLength(1);
    const taskId = response.tasks[0].data.taskId;

    await service.handleProbeResult('http-task-node', {
      taskId,
      success: true,
      results: [{ type: 'dns', target: 'example.com', success: true, latencyMs: 2 }]
    });
    expect(service.getTaskStatus('http-task-node', taskId)).toEqual(expect.objectContaining({ status: 'COMPLETED', success: true }));
  });

  it('探针回执持久化最近一次结果快照', async () => {
    await service.handleProbeResult('node-1', {
      taskId: 'probe-1',
      success: false,
      results: [{ type: 'dns', target: 'example.com', success: true, latencyMs: 8, addresses: ['93.184.216.34'], packetLossPercent: 0 }]
    });
    expect(prisma.node.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'node-1' },
      data: { lastProbeResult: expect.stringContaining('93.184.216.34') }
    }));
  });

  it('心跳回执落库 Agent 版本与系统架构画像', async () => {
    await service.handleHeartbeat('node-1', {
      cpuUsage: 12,
      memoryUsage: 30,
      bandwidthRate: 512,
      protocolVersion: 2,
      trafficSnapshots: [],
      agentVersion: '0.3.0',
      osArch: 'linux/amd64',
      kernelVersion: '1.11.0'
    });
    expect(prisma.node.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ agentVersion: '0.3.0', osArch: 'linux/amd64', kernelVersion: '1.11.0' })
    }));
  });

  it('WS 与 HTTP 使用不同的离线窗口', async () => {
    const wsLastSeenAt = new Date(Date.now() - 16_000);
    const httpLastSeenAt = new Date(Date.now() - 46_000);
    const httpFreshLastSeenAt = new Date(Date.now() - 44_000);
    prisma.node.findMany.mockResolvedValue([
      { id: 'ws-stale', communicationMode: 'WS', pollIntervalSecs: 15, lastSeenAt: wsLastSeenAt },
      { id: 'http-stale', communicationMode: 'HTTP', pollIntervalSecs: 15, lastSeenAt: httpLastSeenAt },
      { id: 'http-fresh', communicationMode: 'HTTP', pollIntervalSecs: 15, lastSeenAt: httpFreshLastSeenAt }
    ]);
    await service.sweepStaleNodes();
    expect(prisma.node.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        OR: [
          { id: 'ws-stale', status: 'ONLINE', lastSeenAt: wsLastSeenAt },
          { id: 'http-stale', status: 'ONLINE', lastSeenAt: httpLastSeenAt }
        ]
      },
      data: { status: 'OFFLINE', bandwidthRate: null, uploadRate: null, downloadRate: null, kernelRunning: null, cpuUsage: null, memoryUsage: null }
    }));
  });

  it('写入失败时保留最新心跳并安排指数退避重试', async () => {
    prisma.node.update.mockRejectedValue(new Error('database is busy'));

    await expect(service.handleHeartbeat('retry-node', {
      protocolVersion: 2,
      cpuUsage: 1,
      memoryUsage: 2,
      bandwidthRate: 3,
      trafficSnapshots: []
    })).rejects.toThrow('database is busy');

    const pending = (service as unknown as { pendingHeartbeats: Map<string, { data: HeartbeatData }> }).pendingHeartbeats;
    expect(pending.get('retry-node')?.data.cpuUsage).toBe(1);

    service.onModuleDestroy();
    prisma.node.update.mockResolvedValue(undefined);
  });

  it('持久化升级任务在 Master 重启后仍可查询', async () => {
    const task = {
      id: 'task-persisted',
      nodeId: 'node-1',
      assetId: 'asset-1',
      previousAssetId: null,
      releaseId: 'release-1',
      kind: 'SINGBOX',
      operation: 'UPGRADE',
      status: 'DISPATCHED',
      attempts: 1,
      payloadJson: JSON.stringify({ taskId: 'task-persisted', target: 'singbox', version: '1.14.0-r1', url: 'https://panel.example.com/binary', sha256: 'a'.repeat(64) }),
      errorMessage: null,
      requestedById: 'admin-1',
      requestedAt: new Date('2026-09-03T10:00:00.000Z'),
      dispatchedAt: new Date('2026-09-03T10:00:01.000Z'),
      completedAt: null
    };
    deploymentFindFirst.mockResolvedValue(task);

    const restarted = new AgentGatewayService(prisma as never);
    try {
      const result = await restarted.getPersistedTaskStatus('node-1', 'task-persisted');
      expect(result).toEqual(expect.objectContaining({
        taskId: 'task-persisted',
        status: 'DISPATCHED',
        attempts: 1,
        requestedAt: task.requestedAt,
        dispatchedAt: task.dispatchedAt
      }));
    } finally {
      restarted.onModuleDestroy();
    }
  });

  it('升级失败回执持久化为 FAILED 且不会被内存状态误报为完成', async () => {
    const task = {
      id: 'task-failed',
      nodeId: 'node-1',
      assetId: 'asset-1',
      previousAssetId: null,
      releaseId: 'release-1',
      kind: 'SINGBOX',
      operation: 'UPGRADE',
      status: 'DISPATCHED',
      attempts: 1,
      payloadJson: '{}',
      errorMessage: null,
      requestedById: null,
      requestedAt: new Date(),
      dispatchedAt: new Date(),
      completedAt: null
    };
    deploymentFindFirst.mockResolvedValue(task);
    prisma.node.update.mockResolvedValue(undefined);

    await service.handleUpgradeResult('node-1', {
      taskId: task.id,
      target: 'singbox',
      version: '1.14.0-r1',
      success: false,
      message: '启动验证失败'
    });

    expect(deploymentUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: task.id },
      data: expect.objectContaining({ status: 'FAILED', errorMessage: '启动验证失败' })
    }));
    expect(service.getTaskStatus('node-1', task.id)).toEqual(expect.objectContaining({ status: 'FAILED', success: false }));
  });

  it('资源升级任务包含完整文件包并在 HTTP 节点离线时保留为持久待执行任务', async () => {
    prisma.node.findUnique.mockResolvedValue({ status: 'ONLINE', communicationMode: 'HTTP' });
    const payload = {
      resourceId: 'release-1',
      assetId: 'asset-1',
      releaseId: 'release-1',
      files: [
        { name: 'sing-box', role: 'main' as const, url: 'https://panel.example.com/main', sha256: 'a'.repeat(64) },
        { name: 'libcronet.so', role: 'auxiliary' as const, url: 'https://panel.example.com/aux', sha256: 'b'.repeat(64) }
      ]
    };
    deploymentCreate.mockResolvedValue({ id: 'task-resource' });

    const result = await service.requestUpgrade('node-1', 'singbox', '1.14.0-r1', 'https://panel.example.com/main', 'a'.repeat(64), payload);

    expect(result.requested).toBe(true);
    expect(deploymentCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ assetId: 'asset-1', releaseId: 'release-1', status: 'QUEUED', payloadJson: expect.stringContaining('libcronet.so') })
    }));
  });

  it('自定义 URL 升级无关联资产也落库 QUEUED 任务并保留操作人', async () => {
    prisma.node.findUnique.mockResolvedValue({ status: 'ONLINE', communicationMode: 'HTTP' });
    deploymentCreate.mockResolvedValue({ id: 'task-custom' });

    const result = await service.requestUpgrade('node-1', 'agent', '0.7.3', 'https://mirror.example.com/riri-agent', 'c'.repeat(64), { requestedById: 'admin-1' });

    expect(result.requested).toBe(true);
    expect(deploymentCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        assetId: null,
        releaseId: null,
        requestedById: 'admin-1',
        status: 'QUEUED',
        kind: 'AGENT',
        payloadJson: expect.stringContaining('0.7.3')
      })
    }));
  });

  it('自定义 URL 升级成功回执不回写节点资产指针', async () => {
    const task = {
      id: 'task-custom-2',
      nodeId: 'node-1',
      assetId: null,
      previousAssetId: null,
      releaseId: null,
      kind: 'AGENT',
      operation: 'UPGRADE',
      status: 'DISPATCHED',
      attempts: 1,
      payloadJson: JSON.stringify({ taskId: 'task-custom-2', target: 'agent', version: '0.7.3', url: 'https://mirror.example.com/riri-agent', sha256: 'c'.repeat(64) }),
      errorMessage: null,
      requestedById: 'admin-1',
      requestedAt: new Date(),
      dispatchedAt: new Date(),
      completedAt: null
    };
    deploymentFindFirst.mockResolvedValue(task);
    prisma.node.update.mockResolvedValue(undefined);

    await service.handleUpgradeResult('node-1', {
      taskId: task.id,
      target: 'agent',
      version: '0.7.3',
      success: true,
      message: 'ok'
    });

    expect(deploymentUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: task.id },
      data: expect.objectContaining({ status: 'COMPLETED' })
    }));
    // 自定义 URL 无资产指针可回写
    expect(prisma.node.update).not.toHaveBeenCalled();
  });

  it('单节点承载多线路时，心跳上报复合凭证可精确拆分归属并按各线路倍率独立扣除额度', async () => {
    (service as unknown as { configCache: Map<string, unknown> }).configCache.clear();
    prisma.node.findUnique.mockResolvedValue({ id: 'node-1', serverHost: '198.51.100.10', configOverride: null, entryLines: [], landingLines: [] });
    const userOne = { id: 'user-1', uuid: '11111111-1111-4111-8111-111111111111', email: 'one@example.com' };
    const directLine = { id: 'line-direct', trafficRate: 1 };
    const relayLine = { id: 'line-relay', trafficRate: 2 };

    txUserFindMany.mockResolvedValue([userOne]);
    txLineFindMany.mockResolvedValue([directLine, relayLine]);
    txTrafficCursorFindMany.mockResolvedValue([
      { credential: `${userOne.email}::line-direct`, uploadTotal: 100n, downloadTotal: 200n },
      { credential: `${userOne.email}::line-relay`, uploadTotal: 50n, downloadTotal: 50n }
    ]);
    txSubscriptionFindMany.mockResolvedValue([
      { id: 'sub-1', userId: userOne.id, startedAt: new Date('2026-09-01'), trafficPeriodStartAt: new Date('2026-09-01'), plan: { durationDays: 30, trafficResetMode: 'BILLING_CYCLE' } }
    ]);

    await service.poll('token-node-1', {
      protocolVersion: 2,
      cpuUsage: 1,
      memoryUsage: 2,
      bandwidthRate: 3,
      trafficSnapshots: [
        // 直连产生 100 增量（物理 100，倍率 1x -> 计费 100）
        { userUuid: `${userOne.email}::line-direct`, uploadTotal: '150', downloadTotal: '250' },
        // 中继产生 100 增量（物理 100，倍率 2x -> 计费 200）
        { userUuid: `${userOne.email}::line-relay`, uploadTotal: '100', downloadTotal: '100' }
      ]
    });

    expect(service.getBufferedTrafficHourlyMetrics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lineId: 'line-direct', userId: userOne.id, upload: 50n, download: 50n }),
        expect.objectContaining({ lineId: 'line-relay', userId: userOne.id, upload: 50n, download: 50n })
      ])
    );

    // 计费总量：直连 100 * 1 + 中转 100 * 2 = 300
    expect(txUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: userOne.id },
        data: { trafficUsedBytes: { increment: 300n } }
      })
    );
  });

  describe('直连代理池（Mixed + ProxyKey）', () => {
    const mixedLine = () => line({
      id: 'line-mixed',
      name: '直连代理池',
      protocolType: 'MIXED',
      entryPort: 10808,
      paramsJson: JSON.stringify({ allowLan: false, usersEnabled: false })
    });
    const proxyKey = (overrides: Record<string, unknown> = {}) => ({
      id: 'key-1',
      userId: 'user-1',
      username: 'pk_0123456789abcdef01234567',
      password: 'pwd-a',
      whitelistIps: '203.0.113.10',
      user: { uuid: 'uuid-1', isActive: true },
      ...overrides
    });

    it('Mixed 直连线路强制鉴权并注入 ProxyKey 凭据与来源 IP 白名单路由规则', async () => {
      prisma.node.findUnique.mockResolvedValue({ id: 'node-1', serverHost: '198.51.100.10', status: 'ONLINE', configOverride: null, entryLines: [mixedLine()], landingLines: [] });
      prisma.user.findMany.mockResolvedValue([user]);
      proxyKeyFindMany.mockResolvedValue([
        proxyKey(),
        proxyKey({
          id: 'key-2',
          userId: 'user-2',
          username: 'pk_fedcba9876543210fedcba98',
          password: 'pwd-b',
          whitelistIps: '',
          user: { uuid: 'uuid-2', isActive: true }
        })
      ]);

      const { singboxConfig } = await service.buildConfigSync('node-1');
      const inbounds = singboxConfig.inbounds as Array<Record<string, unknown>>;
      const mixed = inbounds.find((inbound) => inbound.type === 'mixed');

      expect(mixed).toBeDefined();
      // usersEnabled=false 也必须强制鉴权：空 users 的 mixed 入站等价于开放代理
      expect(mixed?.users).toEqual(expect.arrayContaining([
        { username: 'user@example.com::line-mixed', password: 'secret' },
        { username: 'pk_0123456789abcdef01234567', password: 'pwd-a' }
      ]));
      // 未具备订阅资格的用户（uuid-2）凭据必须被剔除
      expect(mixed?.users).not.toEqual(expect.arrayContaining([expect.objectContaining({ username: 'pk_fedcba9876543210fedcba98' })]));

      expect((singboxConfig.experimental as { v2ray_api: { stats: { users: string[] } } }).v2ray_api.stats.users).toEqual(
        expect.arrayContaining(['pk_0123456789abcdef01234567'])
      );
      expect(singboxConfig.route).toEqual({
        rules: [
          {
            type: 'logical',
            mode: 'and',
            rules: [
              { inbound: ['line-line-mixed'] },
              { auth_user: ['pk_0123456789abcdef01234567'] },
              { source_ip_cidr: ['203.0.113.10'], invert: true }
            ],
            action: 'reject'
          }
        ]
      });
    });

    it('无可用 ProxyKey 时不生成白名单路由规则，仍保留订阅用户鉴权', async () => {
      prisma.node.findUnique.mockResolvedValue({ id: 'node-1', serverHost: '198.51.100.10', status: 'ONLINE', configOverride: null, entryLines: [mixedLine()], landingLines: [] });
      prisma.user.findMany.mockResolvedValue([user]);
      proxyKeyFindMany.mockResolvedValue([]);

      const { singboxConfig } = await service.buildConfigSync('node-1');
      const mixed = (singboxConfig.inbounds as Array<Record<string, unknown>>).find((inbound) => inbound.type === 'mixed');

      expect(mixed?.users).toEqual(expect.arrayContaining([{ username: 'user@example.com::line-mixed', password: 'secret' }]));
      expect(singboxConfig.route).toBeUndefined();
    });

    it('ProxyKey 凭据流量映射回归属用户并累计到凭据用量', async () => {
      const pushSpy = jest.spyOn(service, 'pushConfigToAll').mockResolvedValue(0);
      txUserFindMany.mockResolvedValue([{ id: 'user-1', uuid: 'uuid-1', email: 'pool@example.com', trafficLimitBytes: 100_000n, trafficUsedBytes: 0n }]);
      txProxyKeyFindMany.mockResolvedValue([{ id: 'key-1', userId: 'user-1', username: 'pk_0123456789abcdef01234567' }]);
      txTrafficCursorFindMany.mockResolvedValue([{ credential: 'pk_0123456789abcdef01234567', uploadTotal: 0n, downloadTotal: 0n }]);

      await service.handleHeartbeat('node-1', {
        protocolVersion: 2,
        cpuUsage: 1,
        memoryUsage: 2,
        bandwidthRate: 3,
        trafficSnapshots: [{ userUuid: 'pk_0123456789abcdef01234567', uploadTotal: '500', downloadTotal: '1500' }]
      });

      expect(txProxyKeyFindMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { username: { in: ['pk_0123456789abcdef01234567'] } }
      }));
      expect(service.getBufferedTrafficHourlyMetrics()).toEqual([
        expect.objectContaining({ userId: 'user-1', proxyKeyId: 'key-1', upload: 500n, download: 1500n })
      ]);
      expect(txUserUpdate).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { trafficUsedBytes: { increment: 2000n } }
      });
      expect(txProxyKeyUpdate).toHaveBeenCalledWith({
        where: { id: 'key-1' },
        data: { trafficUsedBytes: { increment: 2000n }, lastUsedAt: expect.any(Date) }
      });
      pushSpy.mockRestore();
    });

    it('流量耗尽用户凭据时触发全局配置重下发以快速吊销凭据', async () => {
      const pushSpy = jest.spyOn(service, 'pushConfigToAll').mockResolvedValue(0);
      txUserFindMany.mockResolvedValue([{ id: 'user-1', uuid: 'uuid-1', email: 'pool@example.com', trafficLimitBytes: 1000n, trafficUsedBytes: 0n }]);
      txProxyKeyFindMany.mockResolvedValue([{ id: 'key-1', userId: 'user-1', username: 'pk_0123456789abcdef01234567' }]);
      txTrafficCursorFindMany.mockResolvedValue([{ credential: 'pk_0123456789abcdef01234567', uploadTotal: 0n, downloadTotal: 0n }]);

      await service.handleHeartbeat('node-1', {
        protocolVersion: 2,
        cpuUsage: 1,
        memoryUsage: 2,
        bandwidthRate: 3,
        trafficSnapshots: [{ userUuid: 'pk_0123456789abcdef01234567', uploadTotal: '600', downloadTotal: '600' }]
      });

      expect(pushSpy).toHaveBeenCalledTimes(1);
      pushSpy.mockRestore();
    });

    it('普通订阅凭据流量不触发 ProxyKey 查询与累计', async () => {
      txUserFindMany.mockResolvedValue([{ id: 'user-1', uuid: 'uuid-1', email: 'pool@example.com', trafficLimitBytes: 100_000n, trafficUsedBytes: 0n }]);
      txTrafficCursorFindMany.mockResolvedValue([{ credential: 'pool@example.com', uploadTotal: 0n, downloadTotal: 0n }]);

      await service.handleHeartbeat('node-1', {
        protocolVersion: 2,
        cpuUsage: 1,
        memoryUsage: 2,
        bandwidthRate: 3,
        trafficSnapshots: [{ userUuid: 'pool@example.com', uploadTotal: '10', downloadTotal: '20' }]
      });

      expect(txProxyKeyFindMany).not.toHaveBeenCalled();
      expect(txProxyKeyUpdate).not.toHaveBeenCalled();
    });
  });
  describe('升级版本对账', () => {
    const heartbeat = (agentVersion?: string) => ({
      protocolVersion: 2,
      cpuUsage: 1,
      memoryUsage: 2,
      bandwidthRate: 3,
      trafficSnapshots: [],
      ...(agentVersion !== undefined ? { agentVersion } : {})
    });
    const upgradePayload = (taskId: string, version: string) => JSON.stringify({ taskId, target: 'agent', version, url: `https://example.com/${taskId}`, sha256: 'a'.repeat(64) });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('升级成功后心跳上报旧版本超过告警阈值时产生一次性 WARN 系统日志', async () => {
      await service.handleUpgradeResult('reconcile-node', { taskId: 'task-reconcile-1', target: 'agent', version: '0.7.3', success: true, message: 'ok' });
      expect(service.getPendingVersionConfirmation('reconcile-node')).toEqual(expect.objectContaining({ taskId: 'task-reconcile-1', expectedVersion: '0.7.3' }));

      // 清掉升级回执自身的 INFO 日志，专注对账行为断言
      systemLogEnqueue.mockClear();
      await service.handleHeartbeat('reconcile-node', heartbeat('0.7.2'));
      expect(systemLogEnqueue).not.toHaveBeenCalled();

      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60 * 1000);
      await service.handleHeartbeat('reconcile-node', heartbeat('0.7.2'));
      expect(systemLogEnqueue).toHaveBeenCalledWith(expect.objectContaining({
        nodeId: 'reconcile-node',
        level: 'WARN',
        module: 'UpgradeTask',
        message: expect.stringContaining('重启可能失败')
      }));

      // warned 标记生效：继续旧版本心跳不重复告警
      systemLogEnqueue.mockClear();
      await service.handleHeartbeat('reconcile-node', heartbeat('0.7.2'));
      expect(systemLogEnqueue).not.toHaveBeenCalled();
      nowSpy.mockRestore();

      // 目标版本上报后确认并清除待确认状态
      await service.handleHeartbeat('reconcile-node', heartbeat('0.7.3'));
      expect(systemLogEnqueue).toHaveBeenCalledWith(expect.objectContaining({
        nodeId: 'reconcile-node',
        level: 'INFO',
        message: expect.stringContaining('升级版本已确认上报')
      }));
      expect(service.getPendingVersionConfirmation('reconcile-node')).toBeNull();
    });

    it('对账归一化：目标版本带 -r1 后缀时与纯编译版本心跳可确认', async () => {
      await service.handleUpgradeResult('reconcile-node-suffix', { taskId: 'task-reconcile-r1', target: 'agent', version: '0.7.3-r1', success: true, message: 'ok' });
      systemLogEnqueue.mockClear();

      // 心跳上报纯编译版本 0.7.3，任务目标为资源口径 0.7.3-r1：归一化后应直接确认而非告警
      await service.handleHeartbeat('reconcile-node-suffix', heartbeat('0.7.3'));
      expect(systemLogEnqueue).toHaveBeenCalledWith(expect.objectContaining({
        nodeId: 'reconcile-node-suffix',
        level: 'INFO',
        message: expect.stringContaining('升级版本已确认上报 (0.7.3-r1)')
      }));
      expect(service.getPendingVersionConfirmation('reconcile-node-suffix')).toBeNull();
    });

    it('onModuleInit 恢复窗口内已完成任务的对账状态，已达版本节点不恢复', async () => {
      deploymentFindMany.mockResolvedValue([
        {
          id: 'task-hydrate-1', nodeId: 'reconcile-node-hy', kind: 'AGENT', status: 'COMPLETED',
          completedAt: new Date(Date.now() - 2 * 60 * 1000), payloadJson: upgradePayload('task-hydrate-1', '0.7.3')
        },
        {
          id: 'task-hydrate-2', nodeId: 'reconcile-node-hy2', kind: 'AGENT', status: 'COMPLETED',
          completedAt: new Date(Date.now() - 2 * 60 * 1000), payloadJson: upgradePayload('task-hydrate-2', '0.7.4')
        }
      ]);
      prisma.node.findMany.mockResolvedValue([
        { id: 'reconcile-node-hy', agentVersion: '0.7.2' },
        { id: 'reconcile-node-hy2', agentVersion: '0.7.4' }
      ]);
      await service.onModuleInit();
      expect(service.getPendingVersionConfirmation('reconcile-node-hy')).toEqual(expect.objectContaining({ expectedVersion: '0.7.3' }));
      expect(service.getPendingVersionConfirmation('reconcile-node-hy2')).toBeNull();
    });

    it('dispatchQueuedUpgradeTasks 跳过 60 秒内已派发任务', async () => {
      const fakeSocket = { send: jest.fn(), close: jest.fn() };
      await service.register('reconcile-node-dispatch', fakeSocket);
      deploymentFindMany.mockResolvedValue([
        {
          id: 'task-fresh', nodeId: 'reconcile-node-dispatch', kind: 'AGENT', status: 'DISPATCHED',
          dispatchedAt: new Date(), requestedAt: new Date(), payloadJson: upgradePayload('task-fresh', '0.7.3')
        },
        {
          id: 'task-stale', nodeId: 'reconcile-node-dispatch', kind: 'AGENT', status: 'DISPATCHED',
          dispatchedAt: new Date(Date.now() - 2 * 60 * 1000), requestedAt: new Date(), payloadJson: upgradePayload('task-stale', '0.7.3')
        }
      ]);
      await (service as unknown as { dispatchQueuedUpgradeTasks: (nodeId: string) => Promise<void> }).dispatchQueuedUpgradeTasks('reconcile-node-dispatch');
      expect(fakeSocket.send).toHaveBeenCalledTimes(1);
      const frame = JSON.parse(fakeSocket.send.mock.calls[0][0] as string);
      expect(frame).toEqual(expect.objectContaining({ type: 'upgrade_task' }));
      expect(frame.data).toEqual(expect.objectContaining({ taskId: 'task-stale' }));
    });
  });

  it('默认配置使用 warn，并在诊断模式仅覆盖 log.level', async () => {
    prisma.node.findUnique.mockResolvedValue({
      id: 'node-1',
      serverHost: '198.51.100.10',
      status: 'ONLINE',
      configOverride: null,
      singboxLogMode: 'NORMAL',
      singboxLogModeUntil: null,
      entryLines: [],
      landingLines: []
    });
    const normal = await service.buildConfigSync('node-1');
    expect(normal.singboxConfig.log).toEqual({ level: 'warn', timestamp: true });
    expect(normal.singboxLogCaptureLevel).toBe('WARN');

    prisma.node.findUnique.mockResolvedValue({
      id: 'node-1',
      serverHost: '198.51.100.10',
      status: 'ONLINE',
      configOverride: JSON.stringify({ log: { timestamp: false, output: 'file:/tmp/sing-box.log', level: 'error' } }),
      singboxLogMode: 'INFO',
      singboxLogModeUntil: new Date(Date.now() + 10 * 60 * 1000),
      entryLines: [],
      landingLines: []
    });
    const diagnostic = await service.buildConfigSync('node-1');
    expect(diagnostic.singboxConfig.log).toEqual({ level: 'info', timestamp: false, output: 'file:/tmp/sing-box.log' });
    expect(diagnostic.singboxLogCaptureLevel).toBe('INFO');
  });

  it('NORMAL 模式拦截 Sing-box INFO/DEBUG 与 ACCESS，保留真实 WARN/ERROR', async () => {
    prisma.node.findUnique.mockResolvedValue({ singboxLogMode: 'NORMAL', singboxLogModeUntil: null });
    systemLogEnqueue.mockClear();
    await service.handleLogReport('node-1', {
      logs: [
        { source: 'SINGBOX', level: 'INFO', module: 'Singbox', message: 'started' },
        { source: 'SINGBOX', level: 'DEBUG', module: 'Singbox', message: 'details' },
        { source: 'SINGBOX', level: 'WARN', module: 'Singbox', message: 'warning' },
        { source: 'SINGBOX', level: 'ERROR', module: 'Singbox', message: 'failure' },
        { source: 'SINGBOX', level: 'WARN', module: 'Singbox', message: 'accepted', metadata: { category: 'ACCESS' } },
        { source: 'AGENT', level: 'INFO', module: 'Agent', message: 'agent info' }
      ]
    });
    expect(systemLogEnqueue.mock.calls.map(([item]) => `${item.source}:${item.level}:${item.message}`)).toEqual([
      'SINGBOX:WARN:warning',
      'SINGBOX:ERROR:failure',
      'AGENT:INFO:agent info'
    ]);
  });

  it('有效诊断模式按级别放行 Sing-box，并允许受控绕过全局门槛', async () => {
    prisma.node.findUnique.mockResolvedValue({
      singboxLogMode: 'INFO',
      singboxLogModeUntil: new Date(Date.now() + 10 * 60 * 1000)
    });
    systemLogEnqueue.mockClear();
    await service.handleLogReport('node-1', {
      logs: [
        { source: 'SINGBOX', level: 'DEBUG', module: 'Singbox', message: 'debug' },
        { source: 'SINGBOX', level: 'INFO', module: 'Singbox', message: 'info' },
        { source: 'SINGBOX', level: 'WARN', module: 'Singbox', message: 'warn' }
      ]
    });
    expect(systemLogEnqueue).toHaveBeenCalledTimes(2);
    expect(systemLogEnqueue).toHaveBeenCalledWith(expect.objectContaining({ level: 'INFO', bypassMinIngestLevel: true }));
    expect(systemLogEnqueue).toHaveBeenCalledWith(expect.objectContaining({ level: 'WARN', bypassMinIngestLevel: true }));
  });

  it('仅允许在线且声明能力的节点开启固定 30 分钟诊断', async () => {
    const pushSpy = jest.spyOn(service, 'pushConfig').mockResolvedValue(true);
    prisma.node.findUnique.mockResolvedValue({
      id: 'node-1',
      name: '测试节点',
      status: 'ONLINE',
      capabilitiesJson: JSON.stringify(['mirror_proxy', 'singbox_log_capture'])
    });
    prisma.node.update.mockResolvedValue({});
    systemLogEnqueue.mockClear();
    try {
      const result = await service.enableSingboxLogDiagnostics('node-1', 'DEBUG', 'admin-1');
      expect(result).toEqual(expect.objectContaining({ nodeId: 'node-1', enabled: true, level: 'DEBUG', requested: true }));
      expect(new Date(result.expiresAt).getTime() - Date.now()).toBeGreaterThan(29 * 60 * 1000);
      expect(prisma.node.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'node-1' },
        data: expect.objectContaining({ singboxLogMode: 'DEBUG', singboxLogModeUntil: expect.any(Date) })
      }));
      expect(pushSpy).toHaveBeenCalledWith('node-1');
    } finally {
      pushSpy.mockRestore();
    }
  });

  it('拒绝离线节点和旧 Agent 开启诊断', async () => {
    prisma.node.findUnique.mockResolvedValue({ id: 'node-1', name: '离线节点', status: 'OFFLINE', capabilitiesJson: '[]' });
    await expect(service.enableSingboxLogDiagnostics('node-1', 'INFO')).rejects.toThrow(ConflictException);
    prisma.node.findUnique.mockResolvedValue({ id: 'node-1', name: '旧节点', status: 'ONLINE', capabilitiesJson: '[]' });
    await expect(service.enableSingboxLogDiagnostics('node-1', 'INFO')).rejects.toThrow(ConflictException);
  });

  it('诊断过期会清理配置缓存、恢复 NORMAL、推送配置并写审计日志', async () => {
    const cache = (service as unknown as { configCache: Map<string, unknown> }).configCache;
    cache.set('node-1', { version: 1 });
    prisma.node.findMany.mockResolvedValue([{ id: 'node-1', name: '测试节点' }]);
    prisma.node.updateMany.mockResolvedValue({ count: 1 });
    const pushSpy = jest.spyOn(service, 'pushConfig').mockResolvedValue(true);
    systemLogEnqueue.mockClear();
    try {
      await (service as unknown as { expireSingboxDiagnostics: () => Promise<void> }).expireSingboxDiagnostics();
      expect(cache.has('node-1')).toBe(false);
      expect(prisma.node.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: { singboxLogMode: 'NORMAL', singboxLogModeUntil: null }
      }));
      expect(pushSpy).toHaveBeenCalledWith('node-1');
      expect(systemLogEnqueue).toHaveBeenCalledWith(expect.objectContaining({ module: 'NodeDiagnostics', metadata: { reason: 'expired' } }));
    } finally {
      pushSpy.mockRestore();
    }
  });

  it('跨节点按用户与客户端 IP 去重聚合，并支持手动踢出所有相关节点', async () => {
    const now = Math.floor(Date.now() / 1000);
    const userRecord = {
      id: 'u1', uuid: 'uuid-1', email: 'user@example.com', deviceLimit: null, isActive: true,
      subscription: { planSnapshotJson: JSON.stringify({ deviceLimit: 2 }), plan: { deviceLimit: 4 } }
    };
    prisma.user.findMany.mockResolvedValue([userRecord]);
    userFindUnique.mockResolvedValue({ ...userRecord, subscription: userRecord.subscription });
    prisma.node.findMany.mockResolvedValue([{ id: 'node-a', name: '节点 A' }, { id: 'node-b', name: '节点 B' }]);
    prisma.line.findMany.mockResolvedValue([{ id: 'line-a', name: '线路 A' }, { id: 'line-b', name: '线路 B' }]);
    const sendA = jest.fn();
    const sendB = jest.fn();
    const sockets = (service as unknown as { sockets: Map<string, { send: (payload: string) => void }> }).sockets;
    sockets.set('node-a', { send: sendA });
    sockets.set('node-b', { send: sendB });
    const ingest = (service as unknown as { updateOnlineDeviceReports: (nodeId: string, items: AgentOnlineDeviceReportItem[]) => Promise<void> }).updateOnlineDeviceReports.bind(service);

    await ingest('node-a', [{ userUuid: 'user@example.com', ip: '203.0.113.5', lineId: 'line-a', connections: 2, lastSeenAt: now }]);
    await ingest('node-b', [{ userUuid: 'uuid-1', ip: '203.0.113.5', lineId: 'line-b', connections: 3, lastSeenAt: now }]);

    const result = await service.getUserDeviceManagement('u1');
    expect(result).toMatchObject({
      onlineDeviceCount: 1,
      configuredDeviceLimit: 2,
      effectiveDeviceLimit: 2,
      deviceLimitSource: 'PLAN',
      devices: [{ ip: '203.0.113.5', connections: 5, nodes: expect.arrayContaining([
        expect.objectContaining({ nodeId: 'node-a', lineName: '线路 A', connections: 2 }),
        expect.objectContaining({ nodeId: 'node-b', lineName: '线路 B', connections: 3 })
      ]) }]
    });

    await expect(service.kickUserDevices('u1', '203.0.113.5')).resolves.toMatchObject({
      requested: true, notifiedNodes: 2, kickedIps: ['203.0.113.5']
    });
    expect(JSON.parse(sendA.mock.calls[0][0])).toMatchObject({ type: 'kick_devices', data: { items: [{ userUuid: 'user@example.com', ip: '203.0.113.5' }] } });
    expect(JSON.parse(sendB.mock.calls[0][0])).toMatchObject({ type: 'kick_devices', data: { items: [{ userUuid: 'user@example.com', ip: '203.0.113.5' }] } });

    // 手动踢出后服务端在线设备缓存应立即剔除，再次查询立即为 0
    const afterKick = await service.getUserDeviceManagement('u1');
    expect(afterKick.onlineDeviceCount).toBe(0);
    expect(afterKick.devices).toEqual([]);
  });

  it('忽略回环与未指定地址上报，并拒绝踢出回环地址', async () => {
    const now = Math.floor(Date.now() / 1000);
    const userRecord = {
      id: 'u1', uuid: 'uuid-1', email: 'user@example.com', deviceLimit: null, isActive: true,
      subscription: { planSnapshotJson: null, plan: { deviceLimit: 2 } }
    };
    prisma.user.findMany.mockResolvedValue([userRecord]);
    userFindUnique.mockResolvedValue({ ...userRecord, subscription: userRecord.subscription });
    prisma.node.findMany.mockResolvedValue([{ id: 'node-a', name: '节点 A' }]);
    prisma.line.findMany.mockResolvedValue([{ id: 'line-a', name: '线路 A' }]);
    const ingest = (service as unknown as { updateOnlineDeviceReports: (nodeId: string, items: AgentOnlineDeviceReportItem[]) => Promise<void> }).updateOnlineDeviceReports.bind(service);

    await ingest('node-a', [
      { userUuid: 'user@example.com', ip: '127.0.0.1', lineId: 'line-a', connections: 5, lastSeenAt: now },
      { userUuid: 'user@example.com', ip: '::1', lineId: 'line-a', connections: 2, lastSeenAt: now },
      { userUuid: 'user@example.com', ip: '203.0.113.25', lineId: 'line-a', connections: 1, lastSeenAt: now }
    ]);

    const result = await service.getUserDeviceManagement('u1');
    expect(result.onlineDeviceCount).toBe(1);
    expect(result.devices.map((item) => item.ip)).toEqual(['203.0.113.25']);

    await expect(service.kickUserDevices('u1', '127.0.0.1')).rejects.toThrow();
  });

  it('节点 configOverride 自定义 clash_api.external_controller 时保留覆盖地址', async () => {
    prisma.node.findUnique.mockResolvedValue({
      id: 'node-custom-clash',
      serverHost: '198.51.100.10',
      status: 'ONLINE',
      configOverride: JSON.stringify({
        experimental: {
          clash_api: {
            external_controller: '127.0.0.1:19090',
            secret: 'local-token'
          }
        }
      }),
      singboxLogMode: 'NORMAL',
      singboxLogModeUntil: null,
      entryLines: [],
      landingLines: []
    });
    const built = await service.buildConfigSync('node-custom-clash');
    expect((built.singboxConfig.experimental as { clash_api?: Record<string, unknown> })?.clash_api).toEqual({
      external_controller: '127.0.0.1:19090',
      secret: 'local-token'
    });
  });

  it('跨节点超限时仅自动踢出较新的超限 IP', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-25T00:00:00.000Z'));
    try {
      const userRecord = {
        id: 'u1', uuid: 'uuid-1', email: 'user@example.com', deviceLimit: null, isActive: true,
        subscription: { planSnapshotJson: null, plan: { deviceLimit: 1 } }
      };
      prisma.user.findMany.mockResolvedValue([userRecord]);
      const sendA = jest.fn();
      const sendB = jest.fn();
      const sockets = (service as unknown as { sockets: Map<string, { send: (payload: string) => void }> }).sockets;
      sockets.set('node-a', { send: sendA });
      sockets.set('node-b', { send: sendB });
      const ingest = (service as unknown as { updateOnlineDeviceReports: (nodeId: string, items: AgentOnlineDeviceReportItem[]) => Promise<void> }).updateOnlineDeviceReports.bind(service);

      const firstSeen = Math.floor(Date.now() / 1000);
      await ingest('node-a', [{ userUuid: 'user@example.com', ip: '203.0.113.10', lineId: 'line-a', connections: 1, lastSeenAt: firstSeen }]);
      jest.advanceTimersByTime(2000);
      const secondSeen = Math.floor(Date.now() / 1000);
      await ingest('node-b', [
        { userUuid: 'user@example.com', ip: '203.0.113.10', lineId: 'line-b', connections: 1, lastSeenAt: secondSeen },
        { userUuid: 'user@example.com', ip: '203.0.113.11', lineId: 'line-b', connections: 1, lastSeenAt: secondSeen }
      ]);

      expect(sendA).not.toHaveBeenCalled();
      expect(sendB).toHaveBeenCalledTimes(1);
      expect(JSON.parse(sendB.mock.calls[0][0])).toMatchObject({
        type: 'kick_devices',
        data: { items: [{ userUuid: 'user@example.com', ip: '203.0.113.11', blockDurationSecs: 60 }] }
      });
    } finally {
      jest.useRealTimers();
    }
  });

});

