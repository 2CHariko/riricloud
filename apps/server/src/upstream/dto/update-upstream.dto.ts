import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, Min, MinLength, MaxLength, ValidateBy } from 'class-validator';
import { validateUpstreamHeaders } from '../upstream-fetch';
import { UPSTREAM_FORMATS, UPSTREAM_NODE_STATUSES, UPSTREAM_SOURCE_TYPES, UpstreamFormat, UpstreamNodeStatus, UpstreamSourceType } from '../../common/constants';

export class UpdateUpstreamDto {
  @ApiPropertyOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ enum: UPSTREAM_SOURCE_TYPES })
  @IsIn(UPSTREAM_SOURCE_TYPES)
  @IsOptional()
  sourceType?: UpstreamSourceType;

  @ApiPropertyOptional({ enum: UPSTREAM_FORMATS })
  @IsIn(UPSTREAM_FORMATS)
  @IsOptional()
  format?: UpstreamFormat;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(8192)
  @IsOptional()
  url?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(5 * 1024 * 1024)
  @IsOptional()
  content?: string;

  @ApiPropertyOptional()
  @IsObject()
  @ValidateBy({ name: 'upstreamHeaders', validator: { validate: (value: Record<string, string>) => { try { validateUpstreamHeaders(value); return true; } catch { return false; } }, defaultMessage: () => '自定义 Header 名称、类型或长度无效' } })
  @IsOptional()
  customHeaders?: Record<string, string>;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  autoUpdate?: boolean;

  @ApiPropertyOptional({ minimum: 10, maximum: 43200 })
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(43200)
  @IsOptional()
  updateIntervalMins?: number;

  @ApiPropertyOptional({ enum: UPSTREAM_NODE_STATUSES })
  @IsIn(UPSTREAM_NODE_STATUSES)
  @IsOptional()
  status?: UpstreamNodeStatus;
}
