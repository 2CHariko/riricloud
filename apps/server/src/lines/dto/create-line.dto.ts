import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LINE_STATUSES, LINE_TYPES, PROTOCOL_TYPES, RELAY_MODES, LineStatus, LineType, ProtocolType, RelayMode } from '../../common/constants';

export class CreateLineDto {
  @ApiProperty({ example: '香港落地线路' })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiPropertyOptional({ example: 'hk-vless' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @IsOptional()
  tag?: string;

  @ApiPropertyOptional({ example: '0.0.0.0', default: '0.0.0.0' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @IsOptional()
  listen?: string;

  @ApiPropertyOptional({ enum: LINE_TYPES, default: 'DIRECT' })
  @IsIn(LINE_TYPES)
  @IsOptional()
  type?: LineType;

  @ApiPropertyOptional({ enum: PROTOCOL_TYPES, default: 'VLESS' })
  @IsIn(PROTOCOL_TYPES)
  @IsOptional()
  protocolType?: ProtocolType;

  @ApiPropertyOptional({ description: '协议专属参数；Reality/SS 缺省值由服务端补全' })
  @IsObject()
  @IsOptional()
  params?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: RELAY_MODES })
  @IsIn(RELAY_MODES)
  @IsOptional()
  relayMode?: RelayMode;

  @ApiPropertyOptional({ format: 'uuid', description: '用户连接入口节点；直连线路可与出口节点互相推导' })
  @IsUUID()
  @IsOptional()
  entryNodeId?: string;

  @ApiPropertyOptional({ example: 24443, minimum: 1, maximum: 65535, description: '入口监听端口，省略时随机分配' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  entryPort?: number;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: '中继落地节点；普通中继必填，直连与桥接中继置空' })
  @IsUUID()
  @IsOptional()
  landingNodeId?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: '桥接已有直连线路时的目标线路' })
  @IsUUID()
  @IsOptional()
  targetLineId?: string | null;

  @ApiPropertyOptional({ example: 24444, minimum: 1, maximum: 65535, nullable: true, description: '中继落地监听端口，普通中继省略时随机分配，直连与桥接置空' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  landingPort?: number | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: '标准 TLS 证书 ID；关联后由 Master 将 PEM 内嵌下发至 Agent' })
  @IsUUID()
  @IsOptional()
  certificateId?: string | null;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  endpointOverrideEnabled?: boolean;

  @ApiPropertyOptional({ example: 'edge.example.com' })
  @IsString()
  @IsOptional()
  serverHost?: string;

  @ApiPropertyOptional({ example: 443, minimum: 1, maximum: 65535 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  serverPort?: number;

  @ApiPropertyOptional({ example: 'www.apple.com' })
  @IsString()
  @IsOptional()
  serverName?: string;

  @ApiPropertyOptional({ example: 'cdn.example.com' })
  @IsString()
  @IsOptional()
  host?: string;

  @ApiPropertyOptional({ default: false, description: '是否启用中继落地端点覆盖（仅 RELAY 生效）' })
  @IsBoolean()
  @IsOptional()
  landingEndpointOverrideEnabled?: boolean;

  @ApiPropertyOptional({ example: '10.0.0.2', nullable: true, description: '中继落地连接地址/域名覆盖' })
  @IsString()
  @IsOptional()
  landingServerHost?: string;

  @ApiPropertyOptional({ example: 24444, minimum: 1, maximum: 65535, nullable: true, description: '中继落地连接端口覆盖' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  landingServerPort?: number;

  @ApiPropertyOptional({ example: 1.5, default: 1, minimum: 0.01 })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @IsOptional()
  trafficRate?: number;

  @ApiPropertyOptional({ default: false, description: '落地端是否允许访问局域网私网 IP (默认 false 拦截保护内网安全)' })
  @IsBoolean()
  @IsOptional()
  allowLanAccess?: boolean;

  @ApiPropertyOptional({ enum: ['TCP_MUX', 'WIREGUARD'], nullable: true, description: '反向穿透隧道类型' })
  @IsIn(['TCP_MUX', 'WIREGUARD'])
  @IsOptional()
  tunnelType?: string | null;

  @ApiPropertyOptional({ example: 29000, minimum: 1, maximum: 65535, nullable: true, description: '反向穿透端口，省略时自动分配' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  tunnelPort?: number | null;

  @ApiPropertyOptional({ nullable: true, description: '反向穿透鉴权 Token，省略时自动生成' })
  @IsString()
  @IsOptional()
  tunnelSecret?: string | null;

  @ApiPropertyOptional({ example: 100, nullable: true, description: '物理端口带宽限速 (Mbps)，0 或留空表示不限速' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  @IsOptional()
  speedLimitMbps?: number | null;

  @ApiPropertyOptional({ default: false, description: '是否开启 TCP Fast Open' })
  @IsBoolean()
  @IsOptional()
  tcpFastOpen?: boolean;

  @ApiPropertyOptional({ default: false, description: '是否开启 MPTCP' })
  @IsBoolean()
  @IsOptional()
  tcpMultiPath?: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'UDP 分片支持' })
  @IsBoolean()
  @IsOptional()
  udpFragment?: boolean;

  @ApiPropertyOptional({ example: '5m', nullable: true, description: 'UDP 超时时长，如 5m、300s' })
  @IsString()
  @IsOptional()
  udpTimeout?: string | null;

  @ApiPropertyOptional({ default: false, description: '是否开启 PROXY Protocol' })
  @IsBoolean()
  @IsOptional()
  proxyProtocol?: boolean;

  @ApiPropertyOptional({ default: false, description: '是否接受无 PROXY 头的连接' })
  @IsBoolean()
  @IsOptional()
  proxyProtocolAcceptNoHeader?: boolean;

  @ApiPropertyOptional({ type: [String], example: ['hk', 'relay'] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional({ example: 1, minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  level?: number;

  @ApiPropertyOptional({ example: 0, minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  isPublic?: boolean;

  @ApiPropertyOptional({ enum: LINE_STATUSES, default: 'ACTIVE' })
  @IsIn(LINE_STATUSES)
  @IsOptional()
  status?: LineStatus;
}
