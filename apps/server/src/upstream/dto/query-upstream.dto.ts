import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { UPSTREAM_NODE_STATUSES, UpstreamNodeStatus } from '../../common/constants';

export class QueryUpstreamDto {
  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  pageSize?: number = 20;

  @ApiPropertyOptional({ description: '按名称搜索' })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ enum: UPSTREAM_NODE_STATUSES })
  @IsIn(UPSTREAM_NODE_STATUSES)
  @IsOptional()
  status?: UpstreamNodeStatus;
}
