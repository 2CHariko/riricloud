import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import type { ProbePolicy } from './probe.types';

export class StartProbeDto {
  @ApiPropertyOptional({ enum: ['MIHOMO_PREFERRED', 'MIHOMO_ONLY'], default: 'MIHOMO_PREFERRED' })
  @IsOptional()
  @IsIn(['MIHOMO_PREFERRED', 'MIHOMO_ONLY'])
  policy: ProbePolicy = 'MIHOMO_PREFERRED';
}
export class ProbeResultsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  pageSize = 20;
}
