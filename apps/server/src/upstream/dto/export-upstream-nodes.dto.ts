import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export class ExportUpstreamNodesDto {
  @ApiPropertyOptional({ description: '指定要导出的节点 ID，逗号分隔；不传则按 subscriptionId 或全部有效节点导出' })
  @IsString()
  @IsOptional()
  nodeIds?: string;

  @ApiPropertyOptional({ description: '上游订阅 ID' })
  @IsString()
  @IsOptional()
  subscriptionId?: string;

  @ApiPropertyOptional({ enum: ['uri', 'json'], default: 'uri' })
  @IsIn(['uri', 'json'])
  @IsOptional()
  format?: 'uri' | 'json' = 'uri';
}
