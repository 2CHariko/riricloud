import { IsIn, IsOptional, IsUUID, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { QueryProxyPoolNodesDto } from './query-proxy-pool-nodes.dto';

export const PROXY_POOL_EXPORT_FORMATS = ['text', 'uri', 'json'] as const;
export type ProxyPoolExportFormat = (typeof PROXY_POOL_EXPORT_FORMATS)[number];

export const PROXY_POOL_EXPORT_PROTOCOLS = ['socks5', 'http'] as const;
export type ProxyPoolExportProtocol = (typeof PROXY_POOL_EXPORT_PROTOCOLS)[number];

export class QueryProxyPoolExportDto extends QueryProxyPoolNodesDto {
  @ApiPropertyOptional({ enum: PROXY_POOL_EXPORT_FORMATS, default: 'text', description: '导出格式' })
  @IsIn(PROXY_POOL_EXPORT_FORMATS)
  @IsOptional()
  format?: ProxyPoolExportFormat = 'text';

  @ApiPropertyOptional({ enum: PROXY_POOL_EXPORT_PROTOCOLS, default: 'socks5', description: 'URI 导出的协议前缀' })
  @IsIn(PROXY_POOL_EXPORT_PROTOCOLS)
  @IsOptional()
  protocol?: ProxyPoolExportProtocol = 'socks5';


  @ApiPropertyOptional({ description: '免登录拉取令牌（ProxyKey exportToken）' })
  @IsUUID()
  @ValidateIf((_object, value) => value !== undefined)
  token?: string;
}
