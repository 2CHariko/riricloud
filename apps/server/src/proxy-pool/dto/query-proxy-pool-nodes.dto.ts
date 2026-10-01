import { BadRequestException } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID, ValidateBy, ValidateIf } from 'class-validator';
import { PROXY_LINE_UUID_REGEX } from '../proxy-key.util';

export function parseProxyPoolLineIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new BadRequestException('线路选择必须为 UUID 列表');
  const ids = value.split(',').map((id) => id.trim());
  if (ids.length > 200 || ids.some((id) => !PROXY_LINE_UUID_REGEX.test(id))) {
    throw new BadRequestException('线路选择须为 1~200 个有效 UUID');
  }
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}

export class QueryProxyPoolNodesDto {
  @ApiPropertyOptional({ description: '指定当前账号的启用凭据' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  keyId?: string;

  @ApiPropertyOptional({ description: '逗号分隔的线路 UUID，最多 200 个' })
  @ValidateIf((_object, value) => value !== undefined)
  @ValidateBy({ name: 'proxyPoolLineIds', validator: { validate: (value: unknown) => {
    try { parseProxyPoolLineIds(value); return true; } catch { return false; }
  }, defaultMessage: () => '线路选择须为 1~200 个有效 UUID' } })
  lineIds?: string;
}
