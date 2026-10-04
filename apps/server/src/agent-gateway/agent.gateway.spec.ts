import { AgentGateway } from './agent.gateway';
import { AgentGatewayService } from './agent-gateway.service';
import { parseAgentInboundMessage } from './agent-message';

describe('AgentGateway', () => {
  const gatewayService = {
    isCurrentSocket: jest.fn(() => true),
    handleHeartbeat: jest.fn(),
    handleConfigApplyResult: jest.fn(),
    handleUpgradeResult: jest.fn(),
    handleProbeResult: jest.fn()
  };
  const client = {} as Parameters<AgentGateway['handleMessage']>[0];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function createGateway() {
    const gateway = new AgentGateway(gatewayService as unknown as AgentGatewayService);
    (gateway as unknown as { registry: Map<unknown, string> }).registry.set(client, 'node-1');
    return gateway;
  }

  it('只向业务服务转发通过运行时校验的心跳', async () => {
    const gateway = createGateway();
    await gateway.handleMessage(
      client,
      JSON.stringify({
        type: 'heartbeat',
        data: { protocolVersion: 2, cpuUsage: 12.5, memoryUsage: 20, bandwidthRate: 1024, trafficSnapshots: [] }
      })
    );
    expect(gatewayService.handleHeartbeat).toHaveBeenCalledWith('node-1', {
      protocolVersion: 2,
      cpuUsage: 12.5,
      memoryUsage: 20,
      bandwidthRate: 1024,
      trafficSnapshots: []
    });
  });

  it.each([
    ['invalid JSON', '{'],
    ['missing data', JSON.stringify({ type: 'heartbeat' })],
    ['invalid CPU', JSON.stringify({ type: 'heartbeat', data: { protocolVersion: 2, cpuUsage: '12', memoryUsage: 20, bandwidthRate: 1, trafficSnapshots: [] } })],
    ['unknown type', JSON.stringify({ type: 'heartbeat-malicious', data: {} })],
    ['invalid probe result', JSON.stringify({ type: 'probe_result', data: { taskId: 't1', success: true, results: [{ type: 'shell', target: 'x', success: true }] } })]
  ])('拒绝 %s 消息且不调用业务服务', async (_name, raw) => {
    const gateway = createGateway();
    await gateway.handleMessage(client, raw);
    expect(gatewayService.handleHeartbeat).not.toHaveBeenCalled();
    expect(gatewayService.handleConfigApplyResult).not.toHaveBeenCalled();
    expect(gatewayService.handleUpgradeResult).not.toHaveBeenCalled();
    expect(gatewayService.handleProbeResult).not.toHaveBeenCalled();
  });

  it.each([
    ['protocol v1', { protocolVersion: 1, cpuUsage: 1, memoryUsage: 2, bandwidthRate: 3, trafficSnapshots: [] }],
    ['numeric cumulative value', { protocolVersion: 2, cpuUsage: 1, memoryUsage: 2, bandwidthRate: 3, trafficSnapshots: [{ userUuid: 'u', uploadTotal: 1, downloadTotal: '2' }] }],
    ['leading zero cumulative value', { protocolVersion: 2, cpuUsage: 1, memoryUsage: 2, bandwidthRate: 3, trafficSnapshots: [{ userUuid: 'u', uploadTotal: '01', downloadTotal: '2' }] }],
    ['uint64 overflow', { protocolVersion: 2, cpuUsage: 1, memoryUsage: 2, bandwidthRate: 3, trafficSnapshots: [{ userUuid: 'u', uploadTotal: '18446744073709551616', downloadTotal: '2' }] }]
  ])('拒绝 %s 心跳', (_name, data) => {
    expect(parseAgentInboundMessage(JSON.stringify({ type: 'heartbeat', data }))).toBeNull();
  });

  it('接受大于 Number.MAX_SAFE_INTEGER 的十进制累计值', () => {
    const message = parseAgentInboundMessage(JSON.stringify({
      type: 'heartbeat',
      data: {
        protocolVersion: 2,
        cpuUsage: 1,
        memoryUsage: 2,
        bandwidthRate: 3,
        trafficSnapshots: [{ userUuid: 'u', uploadTotal: '9007199254740993', downloadTotal: '9007199254740994' }]
      }
    }));
    expect(message?.type).toBe('heartbeat');
    if (message?.type === 'heartbeat') {
      expect(message.data.trafficSnapshots[0]).toEqual({
        userUuid: 'u',
        uploadTotal: '9007199254740993',
        downloadTotal: '9007199254740994'
      });
    }
  });

  it('拒绝日志洪泛、超深 metadata 和超大日志批次', () => {
    const manyLogs = Array.from({ length: 51 }, () => ({ level: 'INFO', module: 'Agent', message: 'ok' }));
    expect(parseAgentInboundMessage(JSON.stringify({ type: 'log_report', data: { logs: manyLogs } }))).toBeNull();

    const deepMetadata = { a: { b: { c: { d: { e: { f: 'too-deep' } } } } } };
    expect(parseAgentInboundMessage(JSON.stringify({
      type: 'log_report',
      data: { logs: [{ level: 'INFO', module: 'Agent', message: 'ok', metadata: deepMetadata }] }
    }))).toBeNull();
  });

  it('兼容新旧日志字段并校验发生时间、序号与metadata总大小', () => {
    const item = { level: 'ERROR', module: 'Singbox', message: 'timeout' };
    const parse = (logs: unknown[]) => parseAgentInboundMessage(JSON.stringify({ type: 'log_report', data: { logs } }));
    expect(parse([item])).not.toBeNull();
    expect(parse([{ ...item, occurredAt: '2026-10-04T06:12:00.123456789Z', sequence: 1, agentInstanceId: 'instance' }])).not.toBeNull();
    expect(parse([{ ...item, occurredAt: 'not-a-date' }])).toBeNull();
    expect(parse([{ ...item, sequence: Number.MAX_SAFE_INTEGER + 1 }])).toBeNull();
    expect(parse(Array.from({ length: 50 }, () => ({ ...item, metadata: { detail: 'x'.repeat(4096) } })))).toBeNull();
  });

  it('按连接限制 Agent 消息速率和累计字节数', () => {
    const gateway = createGateway();
    const quotas = (gateway as unknown as { quotas: Map<unknown, { windowStartedAt: number; messages: number; bytes: number }> }).quotas;
    quotas.set(client, { windowStartedAt: Date.now(), messages: 0, bytes: 0 });
    const consumeQuota = (gateway as unknown as { consumeQuota: (socket: unknown, bytes: number) => boolean }).consumeQuota;

    for (let index = 0; index < 120; index += 1) expect(consumeQuota.call(gateway, client, 1)).toBe(true);
    expect(consumeQuota.call(gateway, client, 1)).toBe(false);
  });

  it('按消息类型转发升级与探针回执', async () => {
    const gateway = createGateway();
    await gateway.handleMessage(
      client,
      JSON.stringify({
        type: 'upgrade_result',
        data: { taskId: 'task-1', target: 'singbox', version: '1.11.0', success: true, message: 'ok' }
      })
    );
    await gateway.handleMessage(
      client,
      JSON.stringify({
        type: 'probe_result',
        data: {
          taskId: 'task-2',
          success: true,
          results: [{ type: 'dns', target: 'localhost', success: true, latencyMs: 1 }]
        }
      })
    );
    expect(gatewayService.handleUpgradeResult).toHaveBeenCalledWith('node-1', expect.objectContaining({ taskId: 'task-1' }));
    expect(gatewayService.handleProbeResult).toHaveBeenCalledWith('node-1', expect.objectContaining({ taskId: 'task-2' }));
  });
});
