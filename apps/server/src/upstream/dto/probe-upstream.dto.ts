import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class ProbeUpstreamDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  subscriptionId?: string;
}
