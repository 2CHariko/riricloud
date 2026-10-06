import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryCertificateDto {
  @IsOptional() @IsIn(['VALID', 'EXPIRING', 'EXPIRED', 'NOT_YET_VALID']) status?: string;
  @IsOptional() @IsIn(['linked', 'unlinked']) association?: string;
  @IsOptional() @IsIn(['expiry-asc', 'expiry-desc', 'updated-desc']) sort?: string;
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  pageSize?: number;

  @ApiPropertyOptional({ description: '按名称、主题、签发者或 SAN 搜索' })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  search?: string;
}
