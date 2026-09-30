import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
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
  @Max(200)
  @IsOptional()
  pageSize?: number = 50;

  @ApiPropertyOptional({ description: '上游订阅 ID' })
  @IsUUID()
  @IsOptional()
  subscriptionId?: string;

  @ApiPropertyOptional({ description: '按节点名称搜索' })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ description: '按协议筛选' })
  @IsString()
  @IsOptional()
  protocolType?: string;

  @ApiPropertyOptional({ description: '按地区标签筛选（如 HK, JP）' })
  @IsString()
  @IsOptional()
  tag?: string;

  @ApiPropertyOptional({ enum: UPSTREAM_NODE_STATUSES })
  @IsIn(UPSTREAM_NODE_STATUSES)
  @IsOptional()
  status?: UpstreamNodeStatus;

  @ApiPropertyOptional({ description: '是否直接合并入用户订阅' })
  @Type(() => Boolean)
  @IsBoolean()
  @IsOptional()
  isDirectSub?: boolean;
}
