import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  type MessageEvent,
  Post,
  Query,
  Req,
  Res,
  Sse
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { Public } from '../auth/public.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { RateLimitService } from '../common/rate-limit.service';
import { CreateFrontendLogsDto } from './dto/create-frontend-logs.dto';
import { CleanLogsDto, ExportLogsDto, LogMetricsQueryDto, QueryLogsDto } from './dto/query-logs.dto';
import { SSEHubService } from './sse-hub.service';
import { SystemLogsService } from './system-logs.service';
import { SseTicketService } from './sse-ticket.service';
import { IsOptional, IsString, MaxLength } from 'class-validator';

class StreamLogsQueryDto extends QueryLogsDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  ticket?: string;
}

@ApiTags('system-logs')
@Controller('logs')
export class SystemLogsController {
  constructor(
    private readonly logsService: SystemLogsService,
    private readonly sseHub: SSEHubService,
    private readonly ticketService: SseTicketService,
    private readonly rateLimit: RateLimitService
  ) {}

  @Get()
  @ApiBearerAuth()
  @Roles('ADMIN')
  @ApiOperation({ summary: '分页查询系统日志' })
  queryLogs(@Query() query: QueryLogsDto) {
    return this.logsService.query(query);
  }

  @Get('metrics')
  @ApiBearerAuth()
  @Roles('ADMIN')
  @ApiOperation({ summary: '获取日志大盘指标统计与趋势' })
  @ApiQuery({ name: 'hours', required: false, type: Number, description: '统计过去多少小时，默认 24' })
  getMetrics(@Query() query: LogMetricsQueryDto) {
    return this.logsService.getMetrics(query.hours ?? 24, query);
  }

  @Post('stream-ticket')
  @ApiBearerAuth()
  @Roles('ADMIN')
  @ApiOperation({ summary: '创建一次性 SSE 实时日志票据' })
  issueStreamTicket(@CurrentUser() user: { id: string }) {
    return this.ticketService.issue(user.id);
  }

  @Get('stream-ticket')
  @ApiBearerAuth()
  @Roles('ADMIN')
  @ApiOperation({ summary: '获取一次性 SSE 实时日志票据（GET 兼容通道）' })
  getStreamTicket(@CurrentUser() user: { id: string }) {
    return this.issueStreamTicket(user);
  }

  @Public()
  @Sse('stream')
  @ApiOperation({ summary: 'SSE 实时日志流推流通道（一次性短期票据）' })
  streamLogs(
    @Query('ticket') ticket: string | undefined,
    @Query() query: StreamLogsQueryDto
  ): Observable<MessageEvent> {
    if (!ticket || !this.ticketService.consume(ticket)) {
      throw new HttpException('SSE 票据无效或已过期', HttpStatus.UNAUTHORIZED);
    }
    return this.sseHub.subscribe(query);
  }

  @Post('frontend')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '前端批量上报异常与关键操作日志' })
  reportFrontendLogs(
    @Body() dto: CreateFrontendLogsDto,
    @Req() req: Request & { user?: { id?: string }; traceId?: string }
  ) {
    const forwarded = process.env.RIRICLOUD_TRUST_PROXY === 'true' ? req.headers['x-forwarded-for'] : undefined;
    const clientIp = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || 'unknown';
    if (!this.rateLimit.consume(`frontend-logs:${clientIp}`, 30, 60_000)) {
      throw new HttpException('日志上报过于频繁', HttpStatus.TOO_MANY_REQUESTS);
    }
    const userAgent = req.headers['user-agent'] || '';
    const userId = req.user?.id || null;
    const reqTraceId = req.traceId || (req.headers['x-request-id'] as string) || null;

    for (const item of dto.logs) {
      this.logsService.enqueue({
        traceId: item.traceId || reqTraceId,
        source: 'WEB',
        level: item.level,
        module: item.module || 'WebClient',
        message: item.message,
        metadata: {
          ...item.metadata,
          clientIp,
          userAgent
        },
        userId
      });
    }
  }

  @Delete()
  @ApiBearerAuth()
  @Roles('ADMIN')
  @ApiOperation({ summary: '按保留策略清理历史日志' })
  @ApiQuery({ name: 'retentionDays', required: false, type: Number, description: '清理多少天之前的日志' })
  @ApiQuery({ name: 'maxRecords', required: false, type: Number, description: '保留最新记录上限，超额清理' })
  cleanLogs(@Query() query: CleanLogsDto) {
    return this.logsService.clean(query.retentionDays, query.maxRecords);
  }

  @Get('export')
  @ApiBearerAuth()
  @Roles('ADMIN')
  @ApiOperation({ summary: '按条件导出日志文件（JSON、CSV 或诊断 bundle）' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv', 'bundle'], description: '导出格式' })
  async exportLogs(
    @Query() query: ExportLogsDto,
    @Res({ passthrough: true }) res: Response
  ) {
    const format = query.format || 'json';
    const { data, truncated } = await this.logsService.exportWithManifest(query, format);
    res.setHeader('X-Logs-Truncated', String(truncated));
    const filename = `riricloud-logs-${new Date().toISOString().slice(0, 10)}.${format === 'bundle' ? 'json' : format}`;

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    } else {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }

    return data;
  }
}
