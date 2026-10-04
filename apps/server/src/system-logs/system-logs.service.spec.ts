import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { TelemetryPrismaService } from '../prisma/telemetry-prisma.service';
import { SSEHubService } from './sse-hub.service';
import { SystemLogsService } from './system-logs.service';

describe('SystemLogsService', () => {
  let service: SystemLogsService;
  let sseHub: SSEHubService;
  let telemetryPrisma: {
    systemLog: {
      createMany: jest.Mock;
      count: jest.Mock;
      findMany: jest.Mock;
      deleteMany: jest.Mock;
    };
  };
  let prisma: {
    node: { findMany: jest.Mock };
    user: { findMany: jest.Mock };
  };

  beforeEach(async () => {
    telemetryPrisma = {
      systemLog: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(10),
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 5 })
      }
    };
    prisma = {
      node: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) }
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SystemLogsService,
        SSEHubService,
        {
          provide: TelemetryPrismaService,
          useValue: telemetryPrisma
        },
        {
          provide: PrismaService,
          useValue: prisma
        }
      ]
    }).compile();

    service = module.get<SystemLogsService>(SystemLogsService);
    sseHub = module.get<SSEHubService>(SSEHubService);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should enqueue and publish to SSE hub', () => {
    const publishSpy = jest.spyOn(sseHub, 'publish');

    service.enqueue({
      source: 'SERVER',
      level: 'INFO',
      module: 'Auth',
      message: 'User logged in successfully'
    });

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'SERVER',
        level: 'INFO',
        module: 'Auth',
        message: 'User logged in successfully'
      })
    );
  });

  it('should flush buffered logs to SQLite via createMany', async () => {
    service.enqueue({
      source: 'SERVER',
      level: 'ERROR',
      module: 'Database',
      message: 'Connection timeout'
    });

    await service.flush();

    expect(telemetryPrisma.systemLog.createMany).toHaveBeenCalledTimes(1);
    expect(telemetryPrisma.systemLog.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          source: 'SERVER',
          level: 'ERROR',
          module: 'Database',
          message: 'Connection timeout'
        })
      ])
    });
  });

  it('should wait for an in-flight flush before returning', async () => {
    let resolveWrite!: () => void;
    telemetryPrisma.systemLog.createMany.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveWrite = resolve;
    }));
    service.enqueue({ source: 'SERVER', level: 'INFO', module: 'Cleanup', message: 'first' });
    const firstFlush = service.flush();
    service.enqueue({ source: 'SERVER', level: 'INFO', module: 'Cleanup', message: 'second' });
    let secondFinished = false;
    const secondFlush = service.flush().then(() => { secondFinished = true; });

    await Promise.resolve();
    expect(secondFinished).toBe(false);
    resolveWrite();
    await Promise.all([firstFlush, secondFlush]);

    expect(telemetryPrisma.systemLog.createMany).toHaveBeenCalledTimes(2);
  });

  it('should support pagination and filtering in query', async () => {
    telemetryPrisma.systemLog.findMany.mockResolvedValueOnce([
      {
        id: 'log-1',
        source: 'WEB',
        level: 'ERROR',
        module: 'UI',
        message: 'Uncaught TypeError',
        createdAt: new Date()
      }
    ]);
    telemetryPrisma.systemLog.count.mockResolvedValueOnce(1);

    const result = await service.query({
      level: 'ERROR',
      source: 'WEB',
      page: 1,
      pageSize: 10
    });

    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.page).toBe(1);
  });

  it('should clean expired logs by retention days', async () => {
    const result = await service.clean(7, undefined);
    expect(telemetryPrisma.systemLog.deleteMany).toHaveBeenCalled();
    expect(result.deletedCount).toBe(5);
  });

  it('should filter logs below minIngestLevel', () => {
    const publishSpy = jest.spyOn(sseHub, 'publish');

    service.setMinIngestLevel('WARN');

    // INFO 应该被过滤掉，不广播也不入库
    service.enqueue({
      source: 'SERVER',
      level: 'INFO',
      module: 'Http',
      message: 'Routine health check'
    });
    expect(publishSpy).not.toHaveBeenCalled();

    // WARN 达到阈值，正常入库与广播
    service.enqueue({
      source: 'SERVER',
      level: 'WARN',
      module: 'Http',
      message: 'Slow query warning'
    });
    expect(publishSpy).toHaveBeenCalledTimes(1);

    // ERROR 超过阈值，正常入库与广播
    service.enqueue({
      source: 'SERVER',
      level: 'ERROR',
      module: 'Database',
      message: 'Disk write failure'
    });
    expect(publishSpy).toHaveBeenCalledTimes(2);
  });

  it('允许诊断 Sing-box 日志受控绕过全局最低级别', () => {
    const publishSpy = jest.spyOn(sseHub, 'publish');
    service.setMinIngestLevel('ERROR');

    service.enqueue({
      source: 'SINGBOX',
      level: 'INFO',
      module: 'Singbox',
      message: 'diagnostic info',
      bypassMinIngestLevel: true
    });

    expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({ source: 'SINGBOX', level: 'INFO' }));
  });

  it('500条失败批次应有界重试，而不是静默丢弃', async () => {
    jest.spyOn(service, 'flush').mockResolvedValue(undefined);
    for (let i = 0; i < 500; i++) service.enqueue({ source: 'AGENT', level: 'ERROR', module: 'Singbox', message: `failure ${i}` });
    jest.restoreAllMocks();
    telemetryPrisma.systemLog.createMany.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    await service.flush();
    expect(service.getIngestionStatus()).toMatchObject({ pendingEntries: 500, persistenceFailures: 1, dropped: 0 });
    await service.flush();
    expect(service.getIngestionStatus()).toMatchObject({ pendingEntries: 0, persisted: 500, retries: 500 });
  });

  it('持续写库失败重试三次后显式计数并保持队列上限', async () => {
    telemetryPrisma.systemLog.createMany.mockRejectedValue(new Error('disk full'));
    service.enqueue({ source: 'SERVER', level: 'ERROR', module: 'DB', message: 'failure' });
    for (let i = 0; i < 4; i++) await service.flush();
    expect(service.getIngestionStatus()).toMatchObject({ pendingEntries: 0, dropped: 1, persistenceFailures: 3, retries: 2 });
  });

  it('高优先级事件可淘汰低优先级日志，低优先级不淘汰错误', () => {
    jest.spyOn(service, 'flush').mockResolvedValue(undefined);
    for (let i = 0; i < 5000; i++) service.enqueue({ source: 'SERVER', level: 'INFO', module: 'HTTP', message: 'request' });
    service.enqueue({ source: 'AGENT', level: 'ERROR', module: 'Singbox', message: 'important' });
    expect(service.getIngestionStatus()).toMatchObject({ pendingEntries: 5000, dropped: 1 });
    jest.restoreAllMocks();
  });

  it('指标过滤复用日志条件，平均耗时仅来自主控 HTTP', async () => {
    telemetryPrisma.systemLog.findMany.mockResolvedValueOnce([
      { level: 'INFO', source: 'SERVER', module: 'HTTP', metadata: '{"durationMs":10}', createdAt: new Date() },
      { level: 'INFO', source: 'AGENT', module: 'Probe', metadata: '{"durationMs":900}', createdAt: new Date() }
    ]);
    const result = await service.getMetrics(24, { nodeId: 'n1', keyword: 'timeout' });
    expect(result.avgLatencyMs).toBe(10);
    expect(telemetryPrisma.systemLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ nodeId: 'n1', OR: expect.any(Array) }) }));
  });

  it('bundle导出包含截断/完整性清单而普通JSON仍为数组', async () => {
    telemetryPrisma.systemLog.count.mockResolvedValue(5001);
    const bundle = JSON.parse(await service.export({}, 'bundle'));
    expect(bundle).toMatchObject({ schemaVersion: 1, manifest: { matchedCount: 5001, exportedCount: 0, truncated: true, limit: 5000, pending: 0 }, logs: [], nodes: [] });
    expect(Array.isArray(JSON.parse(await service.export({}, 'json')))).toBe(true);
  });
  it('同时间清理仅删除pivot之前，CSV单元格防公式注入', async () => {
    const createdAt = new Date('2026-10-04T00:00:00Z');
    telemetryPrisma.systemLog.findMany.mockResolvedValueOnce([{ id: 'pivot', createdAt }]);
    await service.clean(undefined, 5);
    expect(telemetryPrisma.systemLog.deleteMany).toHaveBeenCalledWith({ where: { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lte: 'pivot' } }] } });
    telemetryPrisma.systemLog.findMany.mockResolvedValueOnce([{ id: 'l1', createdAt, source: 'WEB', level: 'ERROR', module: '=cmd', traceId: '=x', nodeId: null, message: '+cmd', metadata: '{}' }]);
    const csv = await service.export({}, 'csv');
    expect(csv).toContain("'=cmd");
    expect(csv).toContain("'=x");
    expect(csv).toContain("'+cmd");
  });
  it('100字段和超大元数据截断不丢时间质量/任务实例关联', async () => {
    const publish = jest.spyOn(sseHub, 'publish');
    const identity = { receivedAt: '2026-10-04T00:01:00Z', occurredAt: '2026-10-04T00:00:00Z', timeQuality: 'agent-clock', sequence: 7, agentInstanceId: 'agent-1', taskId: 'task-1', event: 'diagnostics_snapshot' };
    const metadata = { ...Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, 'ok'])), ...identity };
    service.enqueue({ source: 'AGENT', level: 'INFO', module: 'NodeDiagnostics', message: 'snapshot', metadata });
    expect(JSON.parse(publish.mock.calls[0][0].metadata)).toMatchObject(identity);
    service.enqueue({ source: 'AGENT', level: 'INFO', module: 'NodeDiagnostics', message: 'snapshot', metadata: { ...metadata, field0: 'x'.repeat(20000) } });
    expect(JSON.parse(publish.mock.calls[1][0].metadata)).toMatchObject({ ...identity, truncated: true });
    await service.flush();
    const written = telemetryPrisma.systemLog.createMany.mock.calls[0][0].data as { metadata: string }[];
    expect(JSON.parse(written[0].metadata)).toMatchObject(identity);
    expect(JSON.parse(written[1].metadata)).toMatchObject(identity);
  });


});
