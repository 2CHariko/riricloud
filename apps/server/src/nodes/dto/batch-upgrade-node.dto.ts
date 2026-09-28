import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsOptional, IsUUID } from 'class-validator';

export class BatchUpgradeNodeDto {
  @ApiProperty({ type: [String], description: '要升级的节点 UUID，最多 100 个' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique((value: string) => typeof value === 'string' ? value.toLowerCase() : value)
  @IsUUID('4', { each: true })
  ids!: string[];

  @ApiPropertyOptional({ format: 'uuid', description: '可选的 ACTIVE Agent 托管资源 ID；留空时按各节点架构选择默认版本' })
  @IsUUID('4')
  @IsOptional()
  resourceId?: string;
}
