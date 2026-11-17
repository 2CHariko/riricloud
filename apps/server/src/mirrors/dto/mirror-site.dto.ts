import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';

export class CreateMirrorSiteDto {
  @IsString()
  @MaxLength(80)
  @Matches(/\S/, { message: '名称不能为空' })
  name!: string;

  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{2,62}$/, { message: 'slug 只能包含小写字母、数字和连字符，长度为 3-63' })
  slug!: string;

  @IsString()
  @MaxLength(2048)
  upstreamBaseUrl!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @IsString({ each: true })
  allowedOrigins!: string[];

  @IsString()
  @MaxLength(128)
  @Matches(/\S/, { message: '节点不能为空' })
  nodeId!: string;

  @IsIn(['ADMIN', 'SHARE', 'PUBLIC'])
  accessMode!: 'ADMIN' | 'SHARE' | 'PUBLIC';

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  enabled?: boolean;

  @ValidateIf((_object, value) => value !== undefined)
  @IsDateString()
  shareExpiresAt?: string;
}

export class UpdateMirrorSiteDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(80)
  @Matches(/\S/, { message: '名称不能为空' })
  name?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{2,62}$/)
  slug?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(2048)
  upstreamBaseUrl?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @IsString({ each: true })
  allowedOrigins?: string[];

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(128)
  @Matches(/\S/, { message: '节点不能为空' })
  nodeId?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['ADMIN', 'SHARE', 'PUBLIC'])
  accessMode?: 'ADMIN' | 'SHARE' | 'PUBLIC';

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  enabled?: boolean;

  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsDateString()
  shareExpiresAt?: string | null;
}

export class ListMirrorSitesDto {
  @ValidateIf((_object, value) => value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ValidateIf((_object, value) => value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
