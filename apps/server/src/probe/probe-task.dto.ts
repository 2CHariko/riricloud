import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import type { ProbePolicy } from './probe.types';

export class StartProbeDto {
  @ApiPropertyOptional({ enum: ['MIHOMO_PREFERRED', 'MIHOMO_ONLY'], default: 'MIHOMO_ONLY', description: '兼容旧客户端字段；日常延迟测试始终仅执行 Mihomo，不触发回退' })
  @IsOptional()
  @IsIn(['MIHOMO_PREFERRED', 'MIHOMO_ONLY'])
  policy: ProbePolicy = 'MIHOMO_ONLY';
}
export class ProbeResultsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  pageSize = 20;
}
