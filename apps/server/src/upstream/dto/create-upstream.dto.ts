import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { UPSTREAM_FORMATS, UPSTREAM_SOURCE_TYPES, UpstreamFormat, UpstreamSourceType } from '../../common/constants';

export class CreateUpstreamDto {
  @ApiProperty({ example: 'XX 机场主力订阅' })
  @IsString()
  @MinLength(1)
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
  @IsOptional()
  url?: string;

  @ApiPropertyOptional({ description: '手动粘贴的订阅快照文本' })
  @IsString()
  @IsOptional()
  content?: string;

  @ApiPropertyOptional({ description: '自定义 HTTP 请求头' })
  @IsObject()
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
}
