import { Test } from '@nestjs/testing';
import type { SystemLog } from '@prisma/telemetry-client';
import { PrismaService } from '../prisma/prisma.service';
import { TelemetryPrismaService } from '../prisma/telemetry-prisma.service';
import { SSEHubService, type SystemLogEntry } from './sse-hub.service';
import { SystemLogsService } from './system-logs.service';
import type { MailLogInput } from './mail-log';

const mail: MailLogInput = { level: 'INFO', userId: 'user-1', metadata: { event: 'MAIL_SEND_ACCEPTED', operationId: 'operation-1',
  mailType: 'SMTP_TEST', to: 'to@example.com', from: 'from@example.com', subject: 'SMTP 测试', smtpHost: 'smtp.example.com',
  smtpPort: 465, smtpSecure: true, durationMs: 20, messageId: '<12345678-1234-1234-1234-123456789abc@example.com>',
  smtpResponse: '250 accepted by smtp.example.com 192.0.2.1', accepted: ['to@example.com'], rejected: [] } };

describe('SystemLogsService mail channel', () => {
  let service: SystemLogsService;
  let hub: SSEHubService;
  let rows: SystemLog[];
  const systemLog = { createMany: jest.fn(), count: jest.fn(), findMany: jest.fn() };

  beforeEach(async () => {
    rows = [];
    jest.clearAllMocks();
    systemLog.createMany.mockImplementation(async ({ data }: { data: SystemLog[] }) => { rows.push(...data); return { count: data.length }; });
    systemLog.count.mockImplementation(async () => rows.length);
    systemLog.findMany.mockImplementation(async () => [...rows]);
    const module = await Test.createTestingModule({ providers: [SystemLogsService, SSEHubService,
      { provide: TelemetryPrismaService, useValue: { systemLog } },
      { provide: PrismaService, useValue: { node: { findMany: jest.fn().mockResolvedValue([]) },
        user: { findMany: jest.fn().mockResolvedValue([{ id: 'user-1', email: 'to@example.com' }]) } } } ] }).compile();
    service = module.get(SystemLogsService);
    hub = module.get(SSEHubService);
  });
  afterEach(async () => { jest.restoreAllMocks(); await service.onModuleDestroy(); });

  it('实际 enqueue -> SSE -> flush/query/export 保留相同邮件证据并复用过滤条件', async () => {
    const streamed: SystemLogEntry[] = [];
    const subscription = hub.subscribe({ source: 'SERVER', module: 'Mail', traceId: 'operation-1', userId: 'user-1', keyword: 'to@example.com' })
      .subscribe((event) => streamed.push(event.data as SystemLogEntry));
    service.enqueueMail(mail);
    expect(streamed).toHaveLength(1);
    expect(systemLog.createMany).not.toHaveBeenCalled();
    expect(streamed[0]).toMatchObject({ source: 'SERVER', module: 'Mail', level: 'INFO', traceId: 'operation-1', userId: 'user-1', nodeId: null });
    expect(JSON.parse(streamed[0].metadata)).toEqual(mail.metadata);
    expect(streamed[0].message).toBe('Mail submission accepted by SMTP server');
    const filters = { source: 'SERVER', module: 'Mail', traceId: 'operation-1', userId: 'user-1', keyword: 'to@example.com' } as const;
    const result = await service.query(filters);
    expect(result.items[0]).toMatchObject({ ...streamed[0], user: { id: 'user-1', email: 'to@example.com' } });
    expect(rows).toEqual(streamed);
    expect(systemLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ source: 'SERVER', traceId: 'operation-1', userId: 'user-1' }) }));
    expect(JSON.parse(await service.export(filters))).toEqual(JSON.parse(JSON.stringify(streamed)));
    expect(await service.export(filters, 'csv')).toContain('to@example.com');
    expect(JSON.parse(await service.export(filters, 'bundle')).logs).toEqual(JSON.parse(JSON.stringify(streamed)));
    expect(service.getIngestionStatus()).toMatchObject({ pendingEntries: 0, persisted: 1 });
    subscription.unsubscribe();
  });

  it('邮件遵循采集门槛且不能从运行时附加字段越权；超限内容在 SSE 前已清理', async () => {
    const publish = jest.spyOn(hub, 'publish');
    service.setMinIngestLevel('ERROR');
    service.enqueueMail(Object.assign({}, mail, { bypassMinIngestLevel: true }));
    expect(publish).not.toHaveBeenCalled();
    service.enqueueMail({ ...mail, level: 'ERROR', metadata: { ...mail.metadata, event: 'MAIL_SEND_FAILED', stage: 'SEND',
      error: { message: 'Failure at smtp.example.com password=secret', code: 'EAUTH' }, subject: '大'.repeat(20000),
      ...{ body: 'body-content', verificationCode: '123456' } } });
    expect(publish).toHaveBeenCalledTimes(1);
    const entry = publish.mock.calls[0][0];
    expect(Buffer.byteLength(entry.metadata, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect(entry.message).toBe('Mail send failed');
    expect(JSON.parse(entry.metadata)).toMatchObject({ event: 'MAIL_SEND_FAILED', operationId: 'operation-1', mailType: 'SMTP_TEST',
      to: 'to@example.com', stage: 'SEND', truncated: true, error: { code: 'EAUTH' } });
    for (const value of ['secret', 'body-content', '123456']) expect(entry.metadata).not.toContain(value);
    await service.flush();
    expect(rows[0]).toEqual(entry);
    expect(service.getIngestionStatus()).toMatchObject({ filtered: 1, persisted: 1 });
  });

  it('邮件 sweep 错误使用静态消息，普通 enqueue 不能借 Mail 模块保留目标明文', () => {
    const publish = jest.spyOn(hub, 'publish');
    service.enqueueMail({ level: 'ERROR', metadata: { event: 'MAIL_SWEEP_FAILED', operationId: 'sweep-1', mailType: 'SUBSCRIPTION_SWEEP', stage: 'SWEEP' } });
    expect(publish.mock.calls[0][0]).toMatchObject({ source: 'SERVER', module: 'Mail', message: 'Mail sweep failed', traceId: 'sweep-1' });
    service.enqueue({ source: 'SERVER', module: 'Mail', level: 'INFO', message: 'to@example.com smtp.example.com 192.0.2.1', metadata: { ...mail.metadata } });
    const generic = publish.mock.calls[1][0];
    for (const target of ['to@example.com', 'smtp.example.com', '192.0.2.1']) {
      expect(generic.message).not.toContain(target);
      expect(generic.metadata).not.toContain(target);
    }
  });

  it('邮件共用容量限制和失败重试，不提前广播被丢弃的条目', async () => {
    const flush = jest.spyOn(service, 'flush').mockResolvedValue(undefined);
    const publish = jest.spyOn(hub, 'publish');
    for (let i = 0; i < 5000; i++) service.enqueueMail(mail);
    service.enqueueMail(mail);
    expect(service.getIngestionStatus()).toMatchObject({ pendingEntries: 5000, dropped: 1 });
    expect(publish).toHaveBeenCalledTimes(5000);
    flush.mockRestore();
    systemLog.createMany.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    await service.flush();
    expect(service.getIngestionStatus()).toMatchObject({ pendingEntries: 5000, persistenceFailures: 1, retries: 500 });
    await service.flush();
    expect(service.getIngestionStatus()).toMatchObject({ pendingEntries: 0, persisted: 5000, dropped: 1 });
  });
});
