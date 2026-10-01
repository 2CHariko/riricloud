import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, Min, MinLength, MaxLength, ValidateBy } from 'class-validator';
import { validateUpstreamHeaders } from '../upstream-fetch';
import { UPSTREAM_FORMATS, UPSTREAM_NODE_STATUSES, UPSTREAM_SOURCE_TYPES, UpstreamFormat, UpstreamNodeStatus, UpstreamSourceType } from '../../common/constants';

export class CreateUpstreamDto {
  @ApiProperty({ example: 'XX 机场主力订阅' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @ApiPropertyOptional({ enum: UPSTREAM_SOURCE_TYPES, default: 'URL' })
  @IsIn(UPSTREAM_SOURCE_TYPES)
  @IsOptional()
  sourceType?: UpstreamSourceType;

  @ApiPropertyOptional({ enum: UPSTREAM_FORMATS, default: 'AUTO' })
  @IsIn(UPSTREAM_FORMATS)
  @IsOptional()
  format?: UpstreamFormat;

  @ApiPropertyOptional({ example: 'https://example.com/api/v1/client/subscribe?token=xxx' })
  @IsString()
  @MaxLength(8192)
  @IsOptional()
  url?: string;

  @ApiPropertyOptional({ description: '手动粘贴的订阅快照文本' })
  @IsString()
  @MaxLength(5 * 1024 * 1024)
  @IsOptional()
  content?: string;

  @ApiPropertyOptional({ description: '自定义 HTTP 请求头' })
  @IsObject()
  @ValidateBy({ name: 'upstreamHeaders', validator: { validate: (value: Record<string, string>) => { try { validateUpstreamHeaders(value); return true; } catch { return false; } }, defaultMessage: () => '自定义 Header 名称、类型或长度无效' } })
  @IsOptional()
  customHeaders?: Record<string, string>;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  autoUpdate?: boolean;

  @ApiPropertyOptional({ example: 720, minimum: 10, maximum: 43200, description: '自动刷新间隔分钟' })
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(43200)
  @IsOptional()
  updateIntervalMins?: number;

  @ApiPropertyOptional({ enum: UPSTREAM_NODE_STATUSES, default: 'ACTIVE' })
  @IsIn(UPSTREAM_NODE_STATUSES)
  @IsOptional()
  status?: UpstreamNodeStatus;
}
