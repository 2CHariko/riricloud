import { IsArray, IsBoolean, IsObject, IsOptional, IsString, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTemplateDto {
  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsObject()
  @IsOptional()
  validationConfig?: Record<string, unknown>;

  @ApiProperty({ example: '家庭分流模板' })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ type: 'array', default: [] })
  @IsArray()
  @IsOptional()
  proxyGroups?: unknown[];

  @ApiPropertyOptional({ type: 'array', default: [] })
  @IsArray()
  @IsOptional()
  ruleSets?: unknown[];

  @ApiPropertyOptional({ type: 'object', additionalProperties: true, default: {} })
  @IsObject()
  @IsOptional()
  dnsConfig?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Clash YAML 顶层覆写' })
  @IsString()
  @IsOptional()
  customInjectYaml?: string | null;

  @ApiPropertyOptional({ description: 'Sing-box JSON 顶层覆写' })
  @IsString()
  @IsOptional()
  customInjectJson?: string | null;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}
