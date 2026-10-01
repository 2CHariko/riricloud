import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min, MaxLength } from 'class-validator';
import { UPSTREAM_NODE_STATUSES, UpstreamNodeStatus } from '../../common/constants';

export class QueryUpstreamNodeDto {
  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({ default: 50 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  pageSize?: number = 50;

  @ApiPropertyOptional({ description: '上游订阅 ID' })
  @IsUUID()
  @IsOptional()
  subscriptionId?: string;

  @ApiPropertyOptional({ description: '按节点名称搜索' })
  @IsString()
  @MaxLength(512)
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ description: '按协议筛选' })
  @IsString()
  @MaxLength(32)
  @IsOptional()
  protocolType?: string;

  @ApiPropertyOptional({ description: '按地区标签筛选（如 HK, JP）' })
  @IsString()
  @MaxLength(128)
  @IsOptional()
  tag?: string;

  @ApiPropertyOptional({ enum: UPSTREAM_NODE_STATUSES })
  @IsIn(UPSTREAM_NODE_STATUSES)
  @IsOptional()
  status?: UpstreamNodeStatus;

  @ApiPropertyOptional({ enum: ['PRESENT', 'MISSING'] })
  @IsIn(['PRESENT', 'MISSING'])
  @IsOptional()
  presenceStatus?: 'PRESENT' | 'MISSING';
}
