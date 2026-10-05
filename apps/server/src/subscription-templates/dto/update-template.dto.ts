import { IsArray, IsBoolean, IsObject, IsOptional, IsString, MinLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateTemplateDto {
  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsObject()
  @IsOptional()
  validationConfig?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsString()
  @MinLength(1)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsString()
  @IsOptional()
  description?: string | null;

  @ApiPropertyOptional({ type: 'array' })
  @IsArray()
  @IsOptional()
  proxyGroups?: unknown[];

  @ApiPropertyOptional({ type: 'array' })
  @IsArray()
  @IsOptional()
  ruleSets?: unknown[];

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsObject()
  @IsOptional()
  dnsConfig?: Record<string, unknown>;

  @ApiPropertyOptional({ nullable: true })
  @IsString()
  @IsOptional()
  customInjectYaml?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsString()
  @IsOptional()
  customInjectJson?: string | null;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}
