import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { LINE_STATUSES, LINE_TYPES, PROTOCOL_TYPES, RELAY_MODES, LineStatus, LineType, ProtocolType, RelayMode } from '../../common/constants';

export class UpdateLineDto {
  @ApiPropertyOptional()
  @IsString()
  @MinLength(1)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @IsOptional()
  tag?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @IsOptional()
  listen?: string;

  @ApiPropertyOptional({ enum: LINE_TYPES })
  @IsIn(LINE_TYPES)
  @IsOptional()
  type?: LineType;

  @ApiPropertyOptional({ enum: PROTOCOL_TYPES })
  @IsIn(PROTOCOL_TYPES)
  @IsOptional()
  protocolType?: ProtocolType;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  params?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: RELAY_MODES, nullable: true })
  @IsIn(RELAY_MODES)
  @IsOptional()
  relayMode?: RelayMode | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsUUID()
  @IsOptional()
  entryNodeId?: string | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 65535, nullable: true })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  entryPort?: number | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: '中继落地节点；直连与桥接中继传 null 清空' })
  @IsUUID()
  @IsOptional()
  landingNodeId?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: '桥接已有直连线路时的目标线路' })
  @IsUUID()
  @IsOptional()
  targetLineId?: string | null;
  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: 'EXTERNAL 与 UPSTREAM_NODE 中继必须引用有效的上游节点' })
  @IsUUID()
  @IsOptional()
  upstreamNodeId?: string | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 65535, nullable: true, description: '中继落地监听端口' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  landingPort?: number | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: '标准 TLS 证书 ID；传 null 清除关联' })
  @IsUUID()
  @IsOptional()
  certificateId?: string | null;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  endpointOverrideEnabled?: boolean;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  serverHost?: string | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 65535, nullable: true })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  serverPort?: number | null;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  serverName?: string | null;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  host?: string | null;

  @ApiPropertyOptional({ description: '是否启用中继落地端点覆盖（仅 RELAY 生效）' })
  @IsBoolean()
  @IsOptional()
  landingEndpointOverrideEnabled?: boolean;

  @ApiPropertyOptional({ nullable: true, description: '中继落地连接地址/域名覆盖' })
  @IsString()
  @IsOptional()
  landingServerHost?: string | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 65535, nullable: true, description: '中继落地连接端口覆盖' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  landingServerPort?: number | null;

  @ApiPropertyOptional({ minimum: 0.01 })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @IsOptional()
  trafficRate?: number;

  @ApiPropertyOptional({ description: '落地端是否允许访问局域网私网 IP (默认 false 拦截保护内网安全)' })
  @IsBoolean()
  @IsOptional()
  allowLanAccess?: boolean;

  @ApiPropertyOptional({ enum: ['TCP_MUX', 'WIREGUARD'], nullable: true, description: '反向穿透隧道类型' })
  @IsIn(['TCP_MUX', 'WIREGUARD'])
  @IsOptional()
  tunnelType?: string | null;

  @ApiPropertyOptional({ example: 29000, minimum: 1, maximum: 65535, nullable: true, description: '反向穿透端口' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  tunnelPort?: number | null;

  @ApiPropertyOptional({ nullable: true, description: '反向穿透鉴权 Token' })
  @IsString()
  @IsOptional()
  tunnelSecret?: string | null;

  @ApiPropertyOptional({ example: 100, nullable: true, description: '物理端口带宽限速 (Mbps)，0 或 null 表示不限速' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  @IsOptional()
  speedLimitMbps?: number | null;

  @ApiPropertyOptional({ description: '是否开启 TCP Fast Open' })
  @IsBoolean()
  @IsOptional()
  tcpFastOpen?: boolean;

  @ApiPropertyOptional({ description: '是否开启 MPTCP' })
  @IsBoolean()
  @IsOptional()
  tcpMultiPath?: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'UDP 分片支持' })
  @IsBoolean()
  @IsOptional()
  udpFragment?: boolean | null;

  @ApiPropertyOptional({ example: '5m', nullable: true, description: 'UDP 超时时长' })
  @IsString()
  @IsOptional()
  udpTimeout?: string | null;

  @ApiPropertyOptional({ description: '是否开启 PROXY Protocol' })
  @IsBoolean()
  @IsOptional()
  proxyProtocol?: boolean;

  @ApiPropertyOptional({ description: '是否接受无 PROXY 头的连接' })
  @IsBoolean()
  @IsOptional()
  proxyProtocolAcceptNoHeader?: boolean;

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

  @ApiPropertyOptional({ minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isPublic?: boolean;

  @ApiPropertyOptional({ enum: LINE_STATUSES })
  @IsIn(LINE_STATUSES)
  @IsOptional()
  status?: LineStatus;
}
