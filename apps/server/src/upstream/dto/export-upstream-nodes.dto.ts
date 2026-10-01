import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class ExportUpstreamNodesDto {
  @ApiPropertyOptional({ description: '指定要导出的节点 ID，逗号分隔；不传则按 subscriptionId 或全部有效节点导出' })
  @IsString()
  @MaxLength(37000)
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\s*,\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*$/i)
  @IsOptional()
  nodeIds?: string;

  @ApiPropertyOptional({ description: '上游订阅 ID' })
  @IsUUID()
  @IsOptional()
  subscriptionId?: string;

  @ApiPropertyOptional({ enum: ['uri', 'json', 'clash'], default: 'uri' })
  @IsIn(['uri', 'json', 'clash'])
  @IsOptional()
  format?: 'uri' | 'json' | 'clash' = 'uri';
}
