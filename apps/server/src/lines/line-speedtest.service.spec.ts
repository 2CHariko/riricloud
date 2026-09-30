import * as net from 'node:net';
import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../system/settings.service';
import { LineSpeedtestService } from './line-speedtest.service';

describe('LineSpeedtestService', () => {
  let service: LineSpeedtestService;

  const entryNode = { id: 'node-1', name: '香港入口', serverHost: '1.2.3.4', status: 'ONLINE', isLocal: false };
  const exitNode = { id: 'node-2', name: '香港出口', serverHost: '1.2.3.5', status: 'ONLINE', isLocal: false };

  const rawLine = {
    id: 'line-1',
    name: '香港直连 01',
    tag: 'hk-direct-01',
    listen: '0.0.0.0',
    type: 'DIRECT',
    relayMode: null,
    protocolType: 'VLESS',
    paramsJson: JSON.stringify({ transport: { type: 'tcp' } }),
    entryNodeId: entryNode.id,
    entryPort: 20001,
    landingNodeId: exitNode.id,
    landingPort: 20001,
    targetLineId: null,
    certificateId: null,
    endpointOverrideEnabled: false,
    serverHost: null,
    serverPort: null,
    serverName: null,
    host: null,
    trafficRate: 1,
    tagsJson: '["hk"]',
    level: 0,
    sortOrder: 0,
    isPublic: true,
    status: 'ACTIVE',
    lastLatencyMs: null,
    lastTestedAt: null,
    lastTestStatus: null,
    lastTestMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    entryNode,
    exitNode
  };

  const prisma = {
    line: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn()
    }
  };

  const settingsService = {
    getSettings: jest.fn().mockResolvedValue({
      lineSpeedtestEnabled: true,
      lineSpeedtestIntervalMins: 30,
      lineSpeedtestTargetUrl: 'http://cp.cloudflare.com/generate_204',
      lineSpeedtestTimeoutMs: 3000
    })
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        LineSpeedtestService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettingsService, useValue: settingsService }
      ]
    }).compile();

    service = moduleRef.get(LineSpeedtestService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    service.onModuleDestroy();
  });

  it('当线路不存在时抛出 NotFoundException', async () => {
    prisma.line.findUnique.mockResolvedValue(null);
    await expect(service.testLine('non-existent')).rejects.toThrow(NotFoundException);
  });

  it('当主控缺少 sing-box 内核时，全链路测速判定为 ERROR 且延迟置空为 null', async () => {
    prisma.line.findUnique.mockResolvedValue(rawLine);
    prisma.line.update.mockResolvedValue({ ...rawLine, lastLatencyMs: null, lastTestStatus: 'ERROR' });

    type MockableSpeedtest = {
      resolveSingboxBinary: () => Promise<string | null>;
      tcpPing: (...args: unknown[]) => Promise<number>;
    };

    const resolveSpy = jest.spyOn(service as unknown as MockableSpeedtest, 'resolveSingboxBinary')
      .mockResolvedValue(null);
    const tcpPingSpy = jest.spyOn(service as unknown as MockableSpeedtest, 'tcpPing')
      .mockResolvedValue(45);

    const result = await service.testLine(rawLine.id);

    expect(result.status).toBe('ERROR');
    expect(result.latencyMs).toBeNull();
    expect(result.stages.find((s) => s.id === 'master_ready')?.status).toBe('FAILED');
    expect(result.stages.find((s) => s.id === 'entry_handshake')?.status).toBe('SUCCESS');
    expect(result.stages.find((s) => s.id === 'target_http')?.status).toBe('FAILED');
    expect(prisma.line.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: rawLine.id },
        data: expect.objectContaining({
          lastLatencyMs: null,
          lastTestStatus: 'ERROR'
        })
      })
    );

    resolveSpy.mockRestore();
    tcpPingSpy.mockRestore();
  });

  it('测试线路全链路四阶段均成功时，返回 SUCCESS 与真实端到端延迟', async () => {
    prisma.line.findUnique.mockResolvedValue(rawLine);
    prisma.line.update.mockResolvedValue({ ...rawLine, lastLatencyMs: 38, lastTestStatus: 'SUCCESS' });

    type MockableSpeedtest = {
      resolveSingboxBinary: () => Promise<string | null>;
      runSingboxProbe: (...args: unknown[]) => Promise<{ latencyMs: number; statusCode: number }>;
      tcpPing: (...args: unknown[]) => Promise<number>;
    };

    const resolveSpy = jest.spyOn(service as unknown as MockableSpeedtest, 'resolveSingboxBinary')
      .mockResolvedValue('/usr/local/bin/sing-box');
    const tcpPingSpy = jest.spyOn(service as unknown as MockableSpeedtest, 'tcpPing')
      .mockResolvedValue(20);
    const runSingboxSpy = jest.spyOn(service as unknown as MockableSpeedtest, 'runSingboxProbe')
      .mockResolvedValue({ latencyMs: 38, statusCode: 204 });

    const result = await service.testLine(rawLine.id);

    expect(result.status).toBe('SUCCESS');
    expect(result.mode).toBe('END_TO_END');
    expect(result.latencyMs).toBe(38);
    expect(result.stages.find((s) => s.id === 'master_ready')?.status).toBe('SUCCESS');
    expect(result.stages.find((s) => s.id === 'entry_handshake')?.status).toBe('SUCCESS');
    expect(result.stages.find((s) => s.id === 'target_http')?.status).toBe('SUCCESS');
    expect(prisma.line.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: rawLine.id },
        data: expect.objectContaining({
          lastLatencyMs: 38,
          lastTestStatus: 'SUCCESS'
        })
      })
    );

    resolveSpy.mockRestore();
    tcpPingSpy.mockRestore();
    runSingboxSpy.mockRestore();
  });

  it('当入口握手成功但端到端探测失败时，绝不降级为 TCP 成功，必须判定为失败且延迟置空', async () => {
    prisma.line.findUnique.mockResolvedValue(rawLine);
    prisma.line.update.mockResolvedValue({ ...rawLine, lastLatencyMs: null, lastTestStatus: 'ERROR' });

    type MockableSpeedtest = {
      resolveSingboxBinary: () => Promise<string | null>;
      runSingboxProbe: (...args: unknown[]) => Promise<number>;
      tcpPing: (...args: unknown[]) => Promise<number>;
    };

    const resolveSpy = jest.spyOn(service as unknown as MockableSpeedtest, 'resolveSingboxBinary')
      .mockResolvedValue('/usr/local/bin/sing-box');
    const tcpPingSpy = jest.spyOn(service as unknown as MockableSpeedtest, 'tcpPing')
      .mockResolvedValue(25);
    const runSingboxSpy = jest.spyOn(service as unknown as MockableSpeedtest, 'runSingboxProbe')
      .mockRejectedValue(new Error('目标响应非预期状态码 HTTP 502 Bad Gateway'));

    const result = await service.testLine(rawLine.id);

    expect(result.status).toBe('ERROR');
    expect(result.latencyMs).toBeNull();
    expect(result.stages.find((s) => s.id === 'entry_handshake')?.status).toBe('SUCCESS');
    expect(result.stages.find((s) => s.id === 'entry_handshake')?.latencyMs).toBe(25);
    expect(result.stages.find((s) => s.id === 'target_http')?.status).toBe('FAILED');
    expect(result.message).toContain('502 Bad Gateway');
    expect(prisma.line.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: rawLine.id },
        data: expect.objectContaining({
          lastLatencyMs: null,
          lastTestStatus: 'ERROR'
        })
      })
    );

    resolveSpy.mockRestore();
    tcpPingSpy.mockRestore();
    runSingboxSpy.mockRestore();
  });

  it('测试超时或网络错误时正确持久化 TIMEOUT 状态并清空 latency', async () => {
    prisma.line.findUnique.mockResolvedValue(rawLine);
    prisma.line.update.mockResolvedValue({ ...rawLine, lastLatencyMs: null, lastTestStatus: 'TIMEOUT' });

    type MockableSpeedtest = {
      resolveSingboxBinary: () => Promise<string | null>;
      tcpPing: (...args: unknown[]) => Promise<number>;
    };

    const resolveSpy = jest.spyOn(service as unknown as MockableSpeedtest, 'resolveSingboxBinary')
      .mockResolvedValue('/usr/local/bin/sing-box');
    const tcpPingSpy = jest.spyOn(service as unknown as MockableSpeedtest, 'tcpPing')
      .mockRejectedValue(new Error('连接超时（3000ms）'));

    const result = await service.testLine(rawLine.id);

    expect(result.status).toBe('TIMEOUT');
    expect(result.latencyMs).toBeNull();
    expect(result.stages.find((s) => s.id === 'entry_handshake')?.status).toBe('FAILED');
    expect(result.stages.find((s) => s.id === 'target_http')?.status).toBe('FAILED');
    expect(prisma.line.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: rawLine.id },
        data: expect.objectContaining({
          lastLatencyMs: null,
          lastTestStatus: 'TIMEOUT'
        })
      })
    );

    resolveSpy.mockRestore();
    tcpPingSpy.mockRestore();
  });

  it('当中继线路落地节点离线时，中继阶段直接报错且不跑后续端到端探测', async () => {
    const relayLine = {
      ...rawLine,
      id: 'line-relay-offline',
      type: 'RELAY',
      relayMode: 'BLIND_FORWARD',
      landingNode: { ...exitNode, status: 'OFFLINE' }
    };
    prisma.line.findUnique.mockResolvedValue(relayLine);
    prisma.line.update.mockResolvedValue({ ...relayLine, lastLatencyMs: null, lastTestStatus: 'ERROR' });

    type MockableSpeedtest = {
      resolveSingboxBinary: () => Promise<string | null>;
      tcpPing: (...args: unknown[]) => Promise<number>;
      runSingboxProbe: (...args: unknown[]) => Promise<number>;
    };

    const resolveSpy = jest.spyOn(service as unknown as MockableSpeedtest, 'resolveSingboxBinary')
      .mockResolvedValue('/usr/local/bin/sing-box');
    const tcpPingSpy = jest.spyOn(service as unknown as MockableSpeedtest, 'tcpPing')
      .mockResolvedValue(15);
    const runSingboxSpy = jest.spyOn(service as unknown as MockableSpeedtest, 'runSingboxProbe');

    const result = await service.testLine(relayLine.id);

    expect(result.status).toBe('ERROR');
    expect(result.latencyMs).toBeNull();
    expect(result.stages.find((s) => s.id === 'relay_transit')?.status).toBe('FAILED');
    expect(result.stages.find((s) => s.id === 'relay_transit')?.message).toContain('离线');
    expect(result.stages.find((s) => s.id === 'target_http')?.status).toBe('FAILED');
    expect(runSingboxSpy).not.toHaveBeenCalled();

    resolveSpy.mockRestore();
    tcpPingSpy.mockRestore();
    runSingboxSpy.mockRestore();
  });

  it('当中继线路桥接目标线路已停用时，中继阶段报错拦截', async () => {
    const targetBridgeLine = {
      ...rawLine,
      id: 'line-bridge-disabled',
      type: 'RELAY',
      relayMode: 'TARGET_LINE',
      targetLine: {
        id: 'target-1',
        name: '目标直连',
        status: 'DISABLED',
        protocolType: 'VLESS',
        entryPort: 20002,
        entryNode: { id: 'node-exit', name: '出口节点', status: 'ONLINE', serverHost: '2.2.2.2' }
      }
    };
    prisma.line.findUnique.mockResolvedValue(targetBridgeLine);
    prisma.line.update.mockResolvedValue({ ...targetBridgeLine, lastLatencyMs: null, lastTestStatus: 'ERROR' });

    type MockableSpeedtest = {
      resolveSingboxBinary: () => Promise<string | null>;
      tcpPing: (...args: unknown[]) => Promise<number>;
    };

    const resolveSpy = jest.spyOn(service as unknown as MockableSpeedtest, 'resolveSingboxBinary')
      .mockResolvedValue('/usr/local/bin/sing-box');
    const tcpPingSpy = jest.spyOn(service as unknown as MockableSpeedtest, 'tcpPing')
      .mockResolvedValue(22);

    const result = await service.testLine(targetBridgeLine.id);

    expect(result.status).toBe('ERROR');
    expect(result.latencyMs).toBeNull();
    expect(result.stages.find((s) => s.id === 'relay_transit')?.status).toBe('FAILED');
    expect(result.stages.find((s) => s.id === 'relay_transit')?.message).toContain('未启用');

    resolveSpy.mockRestore();
    tcpPingSpy.mockRestore();
  });

  it('当中继线路对接的第三方上游节点已停用时，中继阶段报错拦截', async () => {
    const upstreamRelayLine = {
      ...rawLine,
      id: 'line-upstream-disabled',
      type: 'RELAY',
      relayMode: 'UPSTREAM_NODE',
      upstreamNodeId: 'up-1',
      upstreamNode: {
        id: 'up-1',
        name: '机场落地节点 01',
        status: 'DISABLED',
        protocolType: 'VMESS',
        serverHost: 'up.example.com',
        serverPort: 443
      }
    };
    prisma.line.findUnique.mockResolvedValue(upstreamRelayLine);
    prisma.line.update.mockResolvedValue({ ...upstreamRelayLine, lastLatencyMs: null, lastTestStatus: 'ERROR' });

    type MockableSpeedtest = {
      resolveSingboxBinary: () => Promise<string | null>;
      tcpPing: (...args: unknown[]) => Promise<number>;
    };

    const resolveSpy = jest.spyOn(service as unknown as MockableSpeedtest, 'resolveSingboxBinary')
      .mockResolvedValue('/usr/local/bin/sing-box');
    const tcpPingSpy = jest.spyOn(service as unknown as MockableSpeedtest, 'tcpPing')
      .mockResolvedValue(18);

    const result = await service.testLine(upstreamRelayLine.id);

    expect(result.status).toBe('ERROR');
    expect(result.latencyMs).toBeNull();
    expect(result.stages.find((s) => s.id === 'relay_transit')?.status).toBe('FAILED');
    expect(result.stages.find((s) => s.id === 'relay_transit')?.message).toContain('未启用');
    expect(result.topology.landingNode).toEqual({
      id: 'up-1',
      name: '[上游] 机场落地节点 01',
      host: 'up.example.com',
      port: 443
    });

    resolveSpy.mockRestore();
    tcpPingSpy.mockRestore();
  });

  it('当中继线路对接的第三方上游节点已启用时，正确通过中继校验并完成端到端探测', async () => {
    const upstreamRelayLine = {
      ...rawLine,
      id: 'line-upstream-active',
      type: 'RELAY',
      relayMode: 'UPSTREAM_NODE',
      upstreamNodeId: 'up-2',
      upstreamNode: {
        id: 'up-2',
        name: '机场落地节点 02',
        status: 'ACTIVE',
        protocolType: 'VMESS',
        serverHost: 'up2.example.com',
        serverPort: 8443
      }
    };
    prisma.line.findUnique.mockResolvedValue(upstreamRelayLine);
    prisma.line.update.mockResolvedValue({ ...upstreamRelayLine, lastLatencyMs: 52, lastTestStatus: 'SUCCESS' });

    type MockableSpeedtest = {
      resolveSingboxBinary: () => Promise<string | null>;
      tcpPing: (...args: unknown[]) => Promise<number>;
      runSingboxProbe: (...args: unknown[]) => Promise<{ latencyMs: number; statusCode: number }>;
    };

    const resolveSpy = jest.spyOn(service as unknown as MockableSpeedtest, 'resolveSingboxBinary')
      .mockResolvedValue('/usr/local/bin/sing-box');
    const tcpPingSpy = jest.spyOn(service as unknown as MockableSpeedtest, 'tcpPing')
      .mockResolvedValue(18);
    const runSingboxSpy = jest.spyOn(service as unknown as MockableSpeedtest, 'runSingboxProbe')
      .mockResolvedValue({ latencyMs: 52, statusCode: 204 });

    const result = await service.testLine(upstreamRelayLine.id);

    expect(result.status).toBe('SUCCESS');
    expect(result.latencyMs).toBe(52);
    expect(result.stages.find((s) => s.id === 'relay_transit')?.status).toBe('SUCCESS');
    expect(result.stages.find((s) => s.id === 'relay_transit')?.message).toContain('机场落地节点 02');
    expect(result.topology.landingNode).toEqual({
      id: 'up-2',
      name: '[上游] 机场落地节点 02',
      host: 'up2.example.com',
      port: 8443
    });

    resolveSpy.mockRestore();
    tcpPingSpy.mockRestore();
    runSingboxSpy.mockRestore();
  });

  it('当线路为 Hysteria 2 纯 UDP 且端到端探测失败时，跳过 TCP 握手直接报错', async () => {
    const hy2Line = {
      ...rawLine,
      id: 'line-hy2',
      protocolType: 'HYSTERIA2'
    };
    prisma.line.findUnique.mockResolvedValue(hy2Line);
    prisma.line.update.mockResolvedValue({ ...hy2Line, lastLatencyMs: null, lastTestStatus: 'TIMEOUT' });

    type MockableSpeedtest = {
      resolveSingboxBinary: () => Promise<string | null>;
      runSingboxProbe: (...args: unknown[]) => Promise<number>;
      tcpPing: (...args: unknown[]) => Promise<number>;
    };

    jest.spyOn(service as unknown as MockableSpeedtest, 'resolveSingboxBinary').mockResolvedValue('/usr/local/bin/sing-box');
    const runSingboxProbeSpy = jest.spyOn(service as unknown as MockableSpeedtest, 'runSingboxProbe')
      .mockRejectedValue(new Error('代理探测连接超时（3000ms）'));
    const tcpPingSpy = jest.spyOn(service as unknown as MockableSpeedtest, 'tcpPing');

    const result = await service.testLine(hy2Line.id);

    expect(result.status).toBe('TIMEOUT');
    expect(result.mode).toBe('END_TO_END');
    expect(result.latencyMs).toBeNull();
    expect(result.stages.find((s) => s.id === 'entry_handshake')?.status).toBe('SKIPPED');
    expect(result.message).toContain('代理探测连接超时');
    // 纯 UDP 线路绝不调用 tcpPing，避免报 ECONNREFUSED
    expect(tcpPingSpy).not.toHaveBeenCalled();

    runSingboxProbeSpy.mockRestore();
    tcpPingSpy.mockRestore();
  });

  it('当 Master 本机节点测试失败时，在错误信息中追加诊断提示', async () => {
    const localLine = {
      ...rawLine,
      id: 'line-local',
      protocolType: 'HYSTERIA2',
      entryNode: { ...entryNode, isLocal: true }
    };
    prisma.line.findUnique.mockResolvedValue(localLine);
    prisma.line.update.mockResolvedValue({ ...localLine, lastLatencyMs: null, lastTestStatus: 'ERROR' });

    type MockableSpeedtest = {
      resolveSingboxBinary: () => Promise<string | null>;
    };

    jest.spyOn(service as unknown as MockableSpeedtest, 'resolveSingboxBinary').mockResolvedValue(null);

    const result = await service.testLine(localLine.id);

    expect(result.status).toBe('ERROR');
    expect(result.latencyMs).toBeNull();
    expect(result.message).toContain('Master 本机节点');
  });

  it('批量测试所有已启用线路', async () => {
    const lines = [
      { id: 'line-1', name: 'Line 1' },
      { id: 'line-2', name: 'Line 2' }
    ];
    prisma.line.findMany.mockResolvedValue(lines);

    const testLineSpy = jest.spyOn(service, 'testLine').mockResolvedValue({
      lineId: 'line-1',
      lineName: 'Line 1',
      latencyMs: 60,
      status: 'SUCCESS',
      message: '204 OK (端到端 60ms)',
      testedAt: new Date(),
      mode: 'END_TO_END',
      targetUrl: 'http://cp.cloudflare.com/generate_204',
      protocolType: 'VLESS',
      topology: {
        isRelay: false,
        relayMode: null,
        masterHost: 'Master 主控',
        entryNode: { id: 'node-1', name: 'Node 1', host: '1.2.3.4', port: 20001 },
        landingNode: null
      },
      stages: []
    });

    const summary = await service.testAllActiveLines();

    expect(summary.total).toBe(2);
    expect(summary.success).toBe(2);
    expect(testLineSpy).toHaveBeenCalledTimes(2);

    testLineSpy.mockRestore();
  });

  describe('httpGetViaHttpProxy 严格状态码校验', () => {
    let mockProxy: net.Server;
    let proxyPort: number;

    afterEach(() => {
      if (mockProxy) {
        mockProxy.close();
      }
    });

    const createMockServer = (responsePayload: string): Promise<number> => {
      return new Promise((resolve) => {
        mockProxy = net.createServer((sock) => {
          sock.on('data', () => {
            sock.write(responsePayload);
          });
        });
        mockProxy.listen(0, '127.0.0.1', () => {
          const addr = mockProxy.address() as net.AddressInfo;
          proxyPort = addr.port;
          resolve(proxyPort);
        });
      });
    };

    it('当代理返回 HTTP 204 时判定成功并返回延迟', async () => {
      await createMockServer('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n');
      type PrivateMethods = {
        httpGetViaHttpProxy: (host: string, port: number, url: string, timeout: number, getStderr: () => string) => Promise<{ latencyMs: number; statusCode: number }>;
      };
      const result = await (service as unknown as PrivateMethods).httpGetViaHttpProxy(
        '127.0.0.1',
        proxyPort,
        'http://cp.cloudflare.com/generate_204',
        1000,
        () => ''
      );
      expect(result.statusCode).toBe(204);
      expect(result.latencyMs).toBeGreaterThanOrEqual(1);
    });

    it('当代理返回 HTTP 200 时同样判定成功', async () => {
      await createMockServer('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
      type PrivateMethods = {
        httpGetViaHttpProxy: (host: string, port: number, url: string, timeout: number, getStderr: () => string) => Promise<{ latencyMs: number; statusCode: number }>;
      };
      const result = await (service as unknown as PrivateMethods).httpGetViaHttpProxy(
        '127.0.0.1',
        proxyPort,
        'http://example.com/generate_204',
        1000,
        () => ''
      );
      expect(result.statusCode).toBe(200);
      expect(result.latencyMs).toBeGreaterThanOrEqual(1);
    });

    it('当代理返回 HTTP 502 Bad Gateway 时必须判定失败', async () => {
      await createMockServer('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      type PrivateMethods = {
        httpGetViaHttpProxy: (host: string, port: number, url: string, timeout: number, getStderr: () => string) => Promise<{ latencyMs: number; statusCode: number }>;
      };
      await expect(
        (service as unknown as PrivateMethods).httpGetViaHttpProxy(
          '127.0.0.1',
          proxyPort,
          'http://cp.cloudflare.com/generate_204',
          1000,
          () => ''
        )
      ).rejects.toThrow('502 Bad Gateway');
    });

    it('当代理返回 HTTP 403 时必须判定失败', async () => {
      await createMockServer('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      type PrivateMethods = {
        httpGetViaHttpProxy: (host: string, port: number, url: string, timeout: number, getStderr: () => string) => Promise<{ latencyMs: number; statusCode: number }>;
      };
      await expect(
        (service as unknown as PrivateMethods).httpGetViaHttpProxy(
          '127.0.0.1',
          proxyPort,
          'http://cp.cloudflare.com/generate_204',
          1000,
          () => ''
        )
      ).rejects.toThrow('403 Forbidden');
    });
  });
});
