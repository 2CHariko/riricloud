import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_SOURCES = ['SERVER', 'WEB', 'AGENT', 'SINGBOX'] as const;
export type LogSource = (typeof LOG_SOURCES)[number];

export class QueryLogsDto {
  @IsOptional()
  @IsEnum(LOG_LEVELS)
  level?: LogLevel;

  @IsOptional()
  @IsEnum(LOG_SOURCES)
  source?: LogSource;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  nodeId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  userId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  module?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  traceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  keyword?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  startTime?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  endTime?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number = 50;
}

export class ExportLogsDto extends QueryLogsDto {
  @IsOptional()
  @IsIn(['json', 'csv', 'bundle'])
  format?: 'json' | 'csv' | 'bundle' = 'json';
}

export class LogMetricsQueryDto extends QueryLogsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(168)
  hours?: number = 24;
}

export class CleanLogsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  retentionDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxRecords?: number;
}
