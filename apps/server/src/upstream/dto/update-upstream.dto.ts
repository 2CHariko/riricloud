import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { UPSTREAM_FORMATS, UPSTREAM_NODE_STATUSES, UPSTREAM_SOURCE_TYPES, UpstreamFormat, UpstreamNodeStatus, UpstreamSourceType } from '../../common/constants';

export class UpdateUpstreamDto {
  @ApiPropertyOptional()
  @IsString()
  @MinLength(1)
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
  @IsOptional()
  url?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  content?: string;

  @ApiPropertyOptional()
  @IsObject()
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
