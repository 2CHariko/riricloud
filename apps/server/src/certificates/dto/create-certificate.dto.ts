import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';

export class CreateCertificateDto {
  @ApiProperty({ example: 'api.example.com 生产证书' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @ApiProperty({ description: 'PEM 编码的叶子证书或 fullchain（叶子在前）' })
  @IsString()
  @MinLength(1)
  @MaxLength(262144)
  certificatePem!: string;

  @ApiProperty({ description: 'PEM 编码的未加密私钥' })
  @IsString()
  @MinLength(1)
  @MaxLength(32768)
  privateKeyPem!: string;
}

export class UpdateCertificateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedRevision?: number;
  @ApiPropertyOptional({ example: 'api.example.com 生产证书' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ description: 'PEM 编码的叶子证书或 fullchain（叶子在前）' })
  @IsString()
  @MinLength(1)
  @IsOptional()
  @MaxLength(262144)
  certificatePem?: string;

  @ApiPropertyOptional({ description: 'PEM 编码的未加密私钥；省略时保留原私钥' })
  @IsString()
  @MinLength(1)
  @IsOptional()
  @MaxLength(32768)
  privateKeyPem?: string;
}

export class ParseCertificateDto {
  @ApiProperty({ description: 'PEM 编码的叶子证书或 fullchain（叶子在前）' })
  @IsString()
  @MinLength(1)
  @MaxLength(262144)
  certificatePem!: string;

  @ApiPropertyOptional({ description: '可选：用于即时校验公私钥是否匹配' })
  @IsString()
  @MinLength(1)
  @IsOptional()
  @MaxLength(32768)
  privateKeyPem?: string;
}

export class RollbackCertificateDto {
  @IsInt() @Min(1) revision!: number;
  @IsOptional() @IsInt() @Min(1) expectedRevision?: number;
}
export class RetryCertificateDto {
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsUUID('4', { each: true }) nodeIds?: string[];
}
export class ExportCertificateDto {
  @IsIn(['leaf', 'fullchain', 'private-key', 'bundle']) format!: 'leaf' | 'fullchain' | 'private-key' | 'bundle';
}
