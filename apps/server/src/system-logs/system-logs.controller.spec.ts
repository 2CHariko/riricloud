import { ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { Response } from 'express';
import { ExportLogsDto } from './dto/query-logs.dto';
import { SSEHubService } from './sse-hub.service';
import { SseTicketService } from './sse-ticket.service';
import { SystemLogsController } from './system-logs.controller';
import { SystemLogsService } from './system-logs.service';
import { RateLimitService } from '../common/rate-limit.service';

describe('SystemLogsController', () => {
  let controller: SystemLogsController;
  let logsService: {
    query: jest.Mock;
    getMetrics: jest.Mock;
    clean: jest.Mock;
    exportWithManifest: jest.Mock;
    enqueue: jest.Mock;
  };
  let sseHub: {
    subscribe: jest.Mock;
  };
  let ticketService: {
    issue: jest.Mock;
    consume: jest.Mock;
  };

  beforeEach(async () => {
    logsService = {
      query: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 50, totalPages: 0 }),
      getMetrics: jest.fn().mockResolvedValue({ totalLogs: 0, errorCount24h: 0, warnCount24h: 0, avgLatencyMs: 0, trend: [] }),
      clean: jest.fn().mockResolvedValue({ deletedCount: 10 }),
      exportWithManifest: jest.fn().mockResolvedValue({ data: 'id,createdAt,source\n1,2026-09-06,SERVER', truncated: false }),
      enqueue: jest.fn()
    };
    sseHub = {
      subscribe: jest.fn()
    };
    ticketService = {
      issue: jest.fn().mockReturnValue({ ticket: 'ticket-1', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      consume: jest.fn().mockReturnValue('admin-1')
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SystemLogsController],
      providers: [
        { provide: SystemLogsService, useValue: logsService },
        { provide: SSEHubService, useValue: sseHub },
        { provide: SseTicketService, useValue: ticketService },
        RateLimitService
      ]
    }).compile();

    controller = module.get<SystemLogsController>(SystemLogsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('为管理员创建一次性 SSE 票据，并在推流入口消费票据', () => {
    expect(controller.issueStreamTicket({ id: 'admin-1' })).toEqual(expect.objectContaining({ ticket: 'ticket-1' }));
    expect(controller.getStreamTicket({ id: 'admin-1' })).toEqual(expect.objectContaining({ ticket: 'ticket-1' }));
    expect(ticketService.issue).toHaveBeenCalledWith('admin-1');

    const stream = { subscribe: true };
    sseHub.subscribe.mockReturnValue(stream);
    expect(controller.streamLogs('ticket-1', {})).toBe(stream);
    expect(ticketService.consume).toHaveBeenCalledWith('ticket-1');
  });

  it('拒绝无效或已消费的 SSE 票据', () => {
    ticketService.consume.mockReturnValue(null);
    expect(() => controller.streamLogs('expired-ticket', {})).toThrow('SSE 票据无效或已过期');
  });

  describe('ValidationPipe with ExportLogsDto', () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true
    });

    it('should successfully validate export query with format=csv and startTime', async () => {
      const rawQuery = {
        format: 'csv',
        startTime: '2026-09-04T16:32:18.838Z'
      };

      const result = await pipe.transform(rawQuery, {
        type: 'query',
        metatype: ExportLogsDto
      });

      expect(result).toBeDefined();
      expect(result.format).toBe('csv');
      expect(result.startTime).toBe('2026-09-04T16:32:18.838Z');
    });

    it('should reject invalid format in ExportLogsDto', async () => {
      const rawQuery = {
        format: 'invalid-format'
      };

      await expect(
        pipe.transform(rawQuery, {
          type: 'query',
          metatype: ExportLogsDto
        })
      ).rejects.toThrow();
    });

    it('should reject unwhitelisted properties in ExportLogsDto', async () => {
      const rawQuery = {
        format: 'csv',
        unknownProp: 'malicious'
      };

      await expect(
        pipe.transform(rawQuery, {
          type: 'query',
          metatype: ExportLogsDto
        })
      ).rejects.toThrow();
    });
  });

  describe('exportLogs', () => {
    it('should set csv content headers and return data', async () => {
      const mockRes = {
        setHeader: jest.fn()
      } as unknown as Response;

      const query: ExportLogsDto = {
        format: 'csv',
        startTime: '2026-09-04T16:32:18.838Z'
      };

      const result = await controller.exportLogs(query, mockRes);

      expect(logsService.exportWithManifest).toHaveBeenCalledWith(query, 'csv');
      expect(mockRes.setHeader).toHaveBeenCalledWith('X-Logs-Truncated', 'false');
      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        expect.stringContaining('attachment; filename="riricloud-logs-')
      );
      expect(result).toBe('id,createdAt,source\n1,2026-09-06,SERVER');
    });

    it('should set json content headers when format is json', async () => {
      logsService.exportWithManifest.mockResolvedValue({ data: '[]', truncated: false });
      const mockRes = {
        setHeader: jest.fn()
      } as unknown as Response;

      const query: ExportLogsDto = {
        format: 'json'
      };

      const result = await controller.exportLogs(query, mockRes);

      expect(logsService.exportWithManifest).toHaveBeenCalledWith(query, 'json');
      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json; charset=utf-8');
      expect(result).toBe('[]');
    });
  });

  describe('cleanLogs', () => {
    it('should delegate to logsService.clean with params', async () => {
      const result = await controller.cleanLogs({ retentionDays: 7, maxRecords: 10000 });
      expect(logsService.clean).toHaveBeenCalledWith(7, 10000);
      expect(result).toEqual({ deletedCount: 10 });
    });
  });
});
