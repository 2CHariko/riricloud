import { Test } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentGatewayService } from '../agent-gateway/agent-gateway.service';
import { BinariesService } from '../binaries/binaries.service';
import { BinariesInstallerService } from '../binaries/installer.service';
import { SystemLogsService } from '../system-logs/system-logs.service';
import { NodesService } from './nodes.service';

describe('NodesService', () => {
  let service: NodesService;
  const baseNode = { id: 'node-1', name: '东京节点', serverHost: '198.51.100.10', isLocal: false, configOverride: null, agentToken: 'token', status: 'ONLINE', communicationMode: 'WS', pollIntervalSecs: 15, lastSeenAt: null, cpuUsage: 1, memoryUsage: 2, bandwidthRate: 3, kernelRunning: true, configError: null, lastProbeResult: null, agentVersion: null, osArch: null, kernelVersion: null, createdAt: new Date(), updatedAt: new Date() };
  const nodeWithLines = { ...baseNode, entryLines: [], landingLines: [] };
  const prisma = {
    node: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    binaryDeploymentTask: { findMany: jest.fn(), count: jest.fn() }
  };
  const systemLogsService = { enqueue: jest.fn() };
  const gateway = { pushConfig: jest.fn().mockResolvedValue(false), pushConfigToAll: jest.fn().mockResolvedValue(0), disconnectNode: jest.fn(), requestUpgrade: jest.fn(), requestProbe: jest.fn(), enableSingboxLogDiagnostics: jest.fn(), disableSingboxLogDiagnostics: jest.fn(), getPendingVersionConfirmation: jest.fn().mockReturnValue(null) };
  const binaries = { resolveForNode: jest.fn() };
  const installer = {
    renderShellScript: jest.fn().mockResolvedValue('#!/bin/sh\n# shell'),
    renderPowershellScript: jest.fn().mockResolvedValue('# powershell'),
    renderWindowsInstallBat: jest.fn().mockResolvedValue('@echo off\r\n# bat')
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        NodesService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemLogsService, useValue: systemLogsService },
        { provide: AgentGatewayService, useValue: gateway },
        { provide: BinariesService, useValue: binaries },
        { provide: BinariesInstallerService, useValue: installer }
      ]
    }).compile();
    service = moduleRef.get(NodesService);
  });

  beforeEach(() => jest.clearAllMocks());

  it('节点列表返回线路反向列表和派生端口，而不是可编辑入站', async () => {
    const line = { id: 'line-1', name: '跨节点线路', type: 'RELAY', relayMode: 'BLIND_FORWARD', protocolType: 'VLESS', entryNodeId: baseNode.id, entryPort: 25001, landingNodeId: 'node-2', landingPort: 25002, serverHost: null, serverPort: null, trafficRate: 1, tagsJson: '[]', level: 0, sortOrder: 0, isPublic: true, status: 'ACTIVE', entryNode: baseNode, landingNode: { ...baseNode, id: 'node-2', name: '香港节点' } };
    prisma.node.findMany.mockResolvedValue([{ ...nodeWithLines, entryLines: [line] }]);
    const [result] = await service.list();
    expect(result.lines).toHaveLength(1);
    expect(result.servicePorts).toEqual(expect.arrayContaining([{ lineId: 'line-1', lineName: '跨节点线路', protocolType: 'VLESS', role: 'TRANSIT', port: 25001 }]));
    expect(result).not.toHaveProperty('inbounds');
  });

  it('外部线路没有节点监听端口，不加入节点承载列表', async () => {
    prisma.node.findMany.mockResolvedValue([{ ...nodeWithLines, entryLines: [{ id: 'external', type: 'EXTERNAL', entryNodeId: null, entryPort: null }] }]);
    const [result] = await service.list();
    expect(result.lines).toEqual([]);
    expect(result.servicePorts).toEqual([]);
  });

  it('安装命令按目标操作系统区分并覆盖免安装模式', async () => {
    prisma.node.create.mockResolvedValue(nodeWithLines);
    const result = await service.create({ name: '新节点', serverHost: '203.0.113.10' }, 'admin', 'https://panel.example.com');
    expect(result.installCommands.native.windows.ws).toContain('riri-agent-installer/windows-amd64');
    expect(result.installCommands.native.windows.ws).toContain('curl.exe');
    // 原生安装改为拉取主控渲染的安装脚本（CMD 与 PowerShell 通用执行命令，拉取 .bat 执行）
    expect(result.installCommands.native.windows.ws).toContain('downloads/agent-installer?token=');
    expect(result.installCommands.native.windows.ws).toContain('format=bat');
    expect(result.installCommands.native.windows.ws).toContain('powershell -NoProfile -ExecutionPolicy Bypass -Command');
    expect(result.installCommands.native.windows.ws).toContain('riri-install.bat');
    expect(result.installCommands.native.macos.ws).toContain('riri-agent-installer/macos-amd64');
    expect(result.installCommands.native.macos.ws).toContain('downloads/agent-installer?token=');
    expect(result.installCommands.native.linux.ws).toContain('riri-agent-installer/linux-amd64');
    expect(result.installCommands.native.linux.ws).toContain('sudo sh /tmp/riri-agent-install.sh');
    expect(result.installCommands.portable.linux.ws).toContain('RIRICLOUD_DATA_DIR="$HOME/.riri-cloud"');
    expect(result.installCommands.portable.linux.ws).toContain("MASTER_URL='wss://panel.example.com/ws/agent'");
    expect(result.installCommands.portable.linux.ws).toMatch(/\/tmp\/riri-agent-download run$/);
    expect(result.installCommands.portable.windows.ws).toContain('$env:LOCALAPPDATA\\RiriCloud');
    expect(result.installCommands.portable.windows.ws).toContain('riri-agent.exe\' run');
    expect(result.installCommands.portable.windows.http).toContain("$env:MASTER_URL = 'https://panel.example.com'");
    expect(result.windowsUninstallCommand).toContain('uninstall --purge --yes');
  });

  it('节点上报的架构复用到目标 OS 匹配的命令，不匹配时回退 amd64', async () => {
    prisma.node.create.mockResolvedValue({ ...nodeWithLines, osArch: 'macos/arm64' });
    const result = await service.create({ name: '新节点', serverHost: '203.0.113.10' }, 'admin', 'https://panel.example.com');
    expect(result.installCommands.native.macos.ws).toContain('riri-agent-installer/macos-arm64');
    expect(result.installCommands.native.linux.ws).toContain('riri-agent-installer/linux-amd64');
    expect(result.installCommands.native.windows.ws).toContain('riri-agent-installer/windows-amd64');
  });

  it('创建节点返回使用当前访问域名的 AgentToken 与安装命令', async () => {
    prisma.node.create.mockResolvedValue(nodeWithLines);
    const result = await service.create({ name: '新节点', serverHost: '203.0.113.10' }, 'admin', 'https://panel.example.com');
    expect(result.agentToken).toMatch(/^[a-f0-9]{64}$/);
    expect(result.node).not.toHaveProperty('agentToken');
    expect(result.installCommand).toContain('--token=');
    expect(result.installCommands.ws).toContain('https://panel.example.com/api/v1/downloads/agent');
    expect(result.installCommands.ws).toContain('--master=wss://panel.example.com/ws/agent');
    expect(result.installCommands.http).toContain('--master=https://panel.example.com');
    expect(result.installCommands.dockerWs).toContain('docker run -d --name riri-agent');
    expect(result.installCommands.dockerWs).toContain('-v /var/lib/riri-agent:/var/lib/riri-agent');
    expect(result.installCommands.dockerWs).toContain("AGENT_MASTER_URL='wss://panel.example.com/ws/agent'");
    expect(result.installCommands.dockerHttp).toContain("AGENT_MASTER_URL='https://panel.example.com'");
    expect(result.installCommands.ws).not.toContain('<master-domain>');
    expect(result.node).toHaveProperty('lines', []);
  });

  it('节点详情按当前请求域名生成安装命令', async () => {
    prisma.node.findUnique.mockResolvedValue(nodeWithLines);
    const result = await service.detail(baseNode.id, 'https://panel.example.com');
    expect(result.node.installCommands.ws).toContain('https://panel.example.com/api/v1/downloads/agent');
    expect(result.node.installCommands.ws).toContain('--master=wss://panel.example.com/ws/agent');
    expect(result.node.pendingVersionConfirm).toBeNull();
  });

  it('任务列表版本摘要优先资源版本，自定义 URL 任务回退 payload 版本', async () => {
    prisma.node.findUnique.mockResolvedValue(nodeWithLines);
    prisma.binaryDeploymentTask.findMany.mockResolvedValue([
      {
        id: 'task-managed', nodeId: baseNode.id, assetId: 'asset-1', previousAssetId: null, releaseId: 'release-1', kind: 'AGENT',
        operation: 'UPGRADE', status: 'COMPLETED', attempts: 1, payloadJson: JSON.stringify({ version: '0.7.3' }), errorMessage: null,
        requestedAt: new Date(), dispatchedAt: new Date(), completedAt: new Date(),
        asset: { id: 'asset-1', target: 'agent-linux-amd64', size: 1024, release: { id: 'release-1', kind: 'AGENT', upstreamVersion: '0.7.2', revision: 1 } }
      },
      {
        id: 'task-custom', nodeId: baseNode.id, assetId: null, previousAssetId: null, releaseId: null, kind: 'AGENT',
        operation: 'UPGRADE', status: 'QUEUED', attempts: 0, payloadJson: JSON.stringify({ taskId: 'task-custom', version: '0.7.3' }), errorMessage: null,
        requestedAt: new Date(), dispatchedAt: null, completedAt: null, asset: null
      }
    ]);
    prisma.binaryDeploymentTask.count.mockResolvedValue(2);
    const result = await service.listTasks(baseNode.id);
    expect(result.data).toHaveLength(2);
    // AGENT 资源 revision=1 展示纯版本号（与管理端 formatBinaryVersion 口径一致）
    expect(result.data[0].version).toBe('0.7.2');
    expect(result.data[1].version).toBe('0.7.3');
  });

  it('节点详情透出升级版本待确认信息', async () => {
    prisma.node.findUnique.mockResolvedValue(nodeWithLines);
    gateway.getPendingVersionConfirmation.mockReturnValue({ taskId: 'task-1', expectedVersion: '0.7.3', completedAt: '2026-09-14T00:00:00.000Z' });
    const result = await service.detail(baseNode.id, 'https://panel.example.com');
    expect(result.node.pendingVersionConfirm).toEqual({ taskId: 'task-1', expectedVersion: '0.7.3', completedAt: '2026-09-14T00:00:00.000Z' });
  });

  it('轮换远程节点 AgentToken 并返回一次性安装命令', async () => {
    prisma.node.findUnique.mockResolvedValue({ ...baseNode, osArch: 'linux/amd64' });
    prisma.node.update.mockResolvedValue({ ...baseNode, status: 'OFFLINE' });

    const result = await service.rotateToken(baseNode.id, 'admin-1', 'https://panel.example.com');

    expect(result.agentToken).toMatch(/^[a-f0-9]{64}$/);
    expect(result.installCommands.ws).toContain('https://panel.example.com/api/v1/downloads/agent');
    expect(result.installCommands.ws).toContain('--master=wss://panel.example.com/ws/agent');
    expect(result.installCommands.http).toContain('--master=https://panel.example.com');
    expect(result.installCommands.dockerWs).toContain('docker run -d --name riri-agent');
    expect(result.installCommands.dockerWs).toContain('-v /var/lib/riri-agent:/var/lib/riri-agent');
    expect(result.installCommand).toBe(result.installCommands.ws);
    expect(result.installCommand).not.toContain(result.agentToken);
    expect(result.uninstallCommand).toContain('riri-agent uninstall');
    expect(prisma.node.update).toHaveBeenCalledWith({
      where: { id: baseNode.id },
      data: expect.objectContaining({
        agentToken: expect.stringMatching(/^enc:v1:/),
        agentTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        status: 'OFFLINE'
      })
    });
    expect(gateway.disconnectNode).toHaveBeenCalledWith(baseNode.id);
    expect(systemLogsService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: baseNode.id,
        metadata: { nodeId: baseNode.id, operatorId: 'admin-1' }
      })
    );
  });

  it('本机节点禁止通过节点管理轮换 AgentToken', async () => {
    prisma.node.findUnique.mockResolvedValue({ ...baseNode, isLocal: true });

    await expect(service.rotateToken(baseNode.id, 'admin-1', 'https://panel.example.com')).rejects.toThrow(ConflictException);
    expect(prisma.node.update).not.toHaveBeenCalled();
    expect(gateway.disconnectNode).not.toHaveBeenCalled();
  });

  it('批量升级按各节点架构创建任务，并区分下发与排队状态', async () => {
    const nodes = [
      { ...baseNode, id: 'linux-node', osArch: 'linux/amd64', status: 'ONLINE', communicationMode: 'WS' },
      { ...baseNode, id: 'windows-node', osArch: 'windows/amd64', status: 'ONLINE', communicationMode: 'HTTP' },
      { ...baseNode, id: 'offline-node', osArch: 'macos/arm64', status: 'OFFLINE', communicationMode: 'WS' }
    ];
    prisma.node.findUnique.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(nodes.find((node) => node.id === where.id) ?? null));
    let taskNumber = 0;
    gateway.requestUpgrade.mockImplementation(async () => ({ taskId: `task-${++taskNumber}`, requested: true }));
    const resolveForNode = jest.fn(async (_kind: string, osArch: string) => ({
      version: `agent-${osArch}`,
      url: 'https://master.example.com/download',
      sha256: 'a'.repeat(64),
      resourceId: 'resource-1',
      assetId: `asset-${osArch}`,
      files: []
    }));
    (service as unknown as { resources?: { resolveForNode: typeof resolveForNode } }).resources = { resolveForNode };

    const result = await service.requestBatchUpgrade({ ids: nodes.map((node) => node.id), resourceId: 'resource-1' });

    expect(result).toMatchObject({ total: 3, succeeded: 3, failed: 0 });
    expect(result.results.map(({ status }) => status)).toEqual(['DISPATCHED', 'QUEUED', 'QUEUED']);
    expect(resolveForNode).toHaveBeenCalledWith('agent', 'linux/amd64', baseNode.agentToken, undefined, 'resource-1', expect.any(Object));
    expect(resolveForNode).toHaveBeenCalledWith('agent', 'windows/amd64', baseNode.agentToken, undefined, 'resource-1', expect.any(Object));
    expect(resolveForNode).toHaveBeenCalledWith('agent', 'macos/arm64', baseNode.agentToken, undefined, 'resource-1', expect.any(Object));
    expect(gateway.requestUpgrade).toHaveBeenCalledTimes(3);
    (service as unknown as { resources?: undefined }).resources = undefined;
  });

  it('批量升级逐项隔离成功、禁用节点、不存在节点与无匹配资源', async () => {
    const nodes = [
      { ...baseNode, id: 'good-node', osArch: 'linux/amd64', status: 'ONLINE', communicationMode: 'WS' },
      { ...baseNode, id: 'unsupported-node', osArch: 'linux/arm64', status: 'ONLINE' },
      { ...baseNode, id: 'disabled-node', status: 'DISABLED' }
    ];
    prisma.node.findUnique.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(nodes.find((node) => node.id === where.id) ?? null));
    const resolveForNode = jest.fn(async (_kind: string, osArch: string) => {
      if (osArch === 'linux/arm64') throw new Error('所选二进制资源不存在、未启用或不支持该节点架构');
      return { version: '0.9.6', url: 'https://master.example.com/download', sha256: 'd'.repeat(64), files: [] };
    });
    (service as unknown as { resources?: { resolveForNode: typeof resolveForNode } }).resources = { resolveForNode };
    gateway.requestUpgrade.mockResolvedValue({ taskId: 'task-good', requested: true });

    const result = await service.requestBatchUpgrade({ ids: ['good-node', 'unsupported-node', 'disabled-node', 'missing-node'], resourceId: 'resource-1' });

    expect(result).toMatchObject({ total: 4, succeeded: 1, failed: 3 });
    expect(result.results.map(({ status }) => status)).toEqual(['DISPATCHED', 'FAILED', 'FAILED', 'FAILED']);
    expect(result.results.map(({ message }) => message)).toEqual(expect.arrayContaining([
      '节点已禁用，未下发升级任务',
      '节点不存在',
      '所选二进制资源不存在、未启用或不支持该节点架构'
    ]));
    expect(gateway.requestUpgrade).toHaveBeenCalledTimes(1);
    (service as unknown as { resources?: undefined }).resources = undefined;
  });

  it('批量升级最多以四个并发解析节点资源', async () => {
    const ids = Array.from({ length: 6 }, (_, index) => `batch-node-${index}`);
    const nodes = ids.map((id) => ({ ...baseNode, id, osArch: 'linux/amd64', status: 'ONLINE' }));
    prisma.node.findUnique.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(nodes.find((node) => node.id === where.id) ?? null));
    let active = 0;
    let peak = 0;
    const resolveForNode = jest.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { version: '0.9.6', url: 'https://master.example.com/download', sha256: 'c'.repeat(64), files: [] };
    });
    (service as unknown as { resources?: { resolveForNode: typeof resolveForNode } }).resources = { resolveForNode };
    gateway.requestUpgrade.mockImplementation(async (nodeId: string) => ({ taskId: `task-${nodeId}`, requested: true }));

    const result = await service.requestBatchUpgrade({ ids });

    expect(result).toMatchObject({ total: 6, succeeded: 6, failed: 0 });
    expect(peak).toBe(4);
    (service as unknown as { resources?: undefined }).resources = undefined;
  });

  it('未提供自定义地址时使用主控内置二进制', async () => {
    prisma.node.findUnique.mockResolvedValue({ ...baseNode, osArch: 'linux/amd64' });
    binaries.resolveForNode.mockResolvedValue({ version: '0.3.0', url: 'http://master/api/v1/downloads/binaries/agent-linux-amd64', sha256: 'a'.repeat(64) });
    gateway.requestUpgrade.mockResolvedValue({ taskId: 'task-1', requested: true });
    const result = await service.requestUpgrade(baseNode.id, { target: 'agent' });
    expect(binaries.resolveForNode).toHaveBeenCalledWith('agent', 'linux/amd64', baseNode.agentToken, undefined);
    expect(gateway.requestUpgrade).toHaveBeenCalledWith(baseNode.id, 'agent', '0.3.0', expect.stringContaining('/downloads/binaries/'), 'a'.repeat(64), { previousAssetId: undefined, operation: 'UPGRADE', requestedById: undefined });
    expect(result).toEqual({ taskId: 'task-1', requested: true });
  });

  it('更新节点后触发配置推送', async () => {
    prisma.node.findUnique.mockResolvedValue(baseNode);
    prisma.node.update.mockResolvedValue(nodeWithLines);
    await service.update(baseNode.id, { name: '更新节点' });
    expect(gateway.pushConfig).toHaveBeenCalledWith(baseNode.id);
  });

  it('节点地址变更后向全部节点防抖推送配置', async () => {
    prisma.node.findUnique.mockResolvedValue(baseNode);
    prisma.node.update.mockResolvedValue(nodeWithLines);
    await service.update(baseNode.id, { serverHost: '198.51.100.11' });
    expect(gateway.pushConfigToAll).toHaveBeenCalledTimes(1);
    expect(gateway.pushConfig).not.toHaveBeenCalled();
  });

  it('本机节点禁止删除', async () => {
    prisma.node.findUnique.mockResolvedValue({ ...baseNode, isLocal: true });
    await expect(service.remove(baseNode.id)).rejects.toThrow(ConflictException);
    expect(prisma.node.delete).not.toHaveBeenCalled();
  });

  it('节点不存在时抛出 NotFoundException', async () => {
    prisma.node.findUnique.mockResolvedValue(null);
    await expect(service.detail('missing')).rejects.toThrow(NotFoundException);
  });

  it('generateInstallScript 为指定平台和格式渲染带凭据的专属脚本', async () => {
    prisma.node.findUnique.mockResolvedValue(baseNode);
    const winResult = await service.generateInstallScript(baseNode.id, 'windows-amd64', 'bat', 'https://panel.example.com');
    expect(winResult.filename).toBe('riri-install.bat');
    expect(winResult.content).toContain('@echo off');

    const psResult = await service.generateInstallScript(baseNode.id, 'windows-amd64', 'ps1', 'https://panel.example.com');
    expect(psResult.filename).toBe('riri-install.ps1');

    const linuxResult = await service.generateInstallScript(baseNode.id, 'linux-amd64', 'sh', 'https://panel.example.com');
    expect(linuxResult.filename).toBe('riri-install.sh');
    expect(linuxResult.content).toContain('#!/bin/sh');
  });
});
