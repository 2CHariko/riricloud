import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PROTOCOL_TYPES, type ProtocolType } from '../../common/constants';

/** 可被上游出口线路接纳的入口协议：与 PROTOCOL_TYPES 保持一致，由服务层再做能力校验。 */
const ENTRY_PROTOCOL_TYPES = PROTOCOL_TYPES;

export class CreateUpstreamSubscriptionDto {
  @ApiProperty({ example: '机场 A' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name!: string;

  @ApiProperty({ example: 'https://sub.example.com/api/v1/client/subscribe?token=***' })
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  url!: string;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @ApiPropertyOptional({ example: 720, minimum: 15, maximum: 10080, description: '自动同步周期（分钟）' })
  @Type(() => Number)
  @IsInt()
  @Min(15)
  @Max(10080)
  @IsOptional()
  syncIntervalMins?: number;

  @ApiPropertyOptional({ example: 'clash-verge/v2.0.0', description: '自定义 User-Agent；留空使用默认值' })
  @IsString()
  @MaxLength(256)
  @IsOptional()
  userAgent?: string | null;
}

export class UpdateUpstreamSubscriptionDto {
  @ApiPropertyOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @IsOptional()
  url?: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @ApiPropertyOptional({ minimum: 15, maximum: 10080 })
  @Type(() => Number)
  @IsInt()
  @Min(15)
  @Max(10080)
  @IsOptional()
  syncIntervalMins?: number;

  @ApiPropertyOptional({ nullable: true })
  @IsString()
  @MaxLength(256)
  @IsOptional()
  userAgent?: string | null;
}

export class QueryUpstreamSubscriptionDto {
  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  pageSize?: number;

  @ApiPropertyOptional({ description: '按名称或 host 模糊搜索（不匹配完整 URL）' })
  @IsString()
  @MaxLength(128)
  @IsOptional()
  search?: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}

export class QueryUpstreamEntriesDto {
  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  pageSize?: number;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(128)
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ enum: PROTOCOL_TYPES })
  @IsIn(PROTOCOL_TYPES)
  @IsOptional()
  protocolType?: ProtocolType;

  @ApiPropertyOptional({ description: '仅显示仍在上游订阅中存在的条目' })
  @IsBoolean()
  @IsOptional()
  available?: boolean;
}

/** 导入预览：URL 与直接粘贴内容二选一。 */
export class PreviewUpstreamDto {
  @ApiPropertyOptional({ description: '订阅地址；与 content 二选一' })
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @IsOptional()
  url?: string;

  @ApiPropertyOptional({ description: '直接粘贴的订阅内容；与 url 二选一' })
  @IsString()
  @MaxLength(2 * 1024 * 1024)
  @IsOptional()
  content?: string;

  @ApiPropertyOptional({ description: '抓取时使用的 User-Agent' })
  @IsString()
  @MaxLength(256)
  @IsOptional()
  userAgent?: string;

  @ApiPropertyOptional({ description: '同时递归抓取 mihomo proxy-providers 中的远程订阅（仅一层）' })
  @IsBoolean()
  @IsOptional()
  followProviders?: boolean;
}

/** 物化：把选中的上游条目生成为用户可连的线路。 */
export class MaterializeUpstreamDto {
  @ApiProperty({ type: [String], description: '选中的上游条目 ID 列表' })
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID(undefined, { each: true })
  entryIds!: string[];

  @ApiProperty({ format: 'uuid', description: '入口节点；上游出口挂载在该节点上' })
  @IsUUID()
  entryNodeId!: string;

  @ApiProperty({ enum: ENTRY_PROTOCOL_TYPES, description: '用户面向的入口协议' })
  @IsIn(ENTRY_PROTOCOL_TYPES)
  entryProtocolType!: ProtocolType;

  @ApiPropertyOptional({ description: '入口协议参数；Reality 密钥对可由服务端自动补全' })
  @IsObject()
  @IsOptional()
  params?: Record<string, unknown>;

  @ApiPropertyOptional({ description: '线路名称前缀；留空使用上游节点名称' })
  @IsString()
  @MaxLength(64)
  @IsOptional()
  namePrefix?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional({ minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  level?: number;

  @ApiPropertyOptional({ minimum: 0.01, description: '流量倍率' })
  @Type(() => Number)
  @IsOptional()
  trafficRate?: number;

  @ApiPropertyOptional({ description: '生成后是否直接公开；默认 false，由管理员显式上架' })
  @IsBoolean()
  @IsOptional()
  isPublic?: boolean;

  @ApiPropertyOptional({ description: '生成后是否立即启用' })
  @IsBoolean()
  @IsOptional()
  status?: string;

  @ApiPropertyOptional({ nullable: true, minimum: 100, description: '单端口限速（Mbps）' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  speedLimitMbps?: number | null;
}
