import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import type { EgressProxyInput } from '../../common/line-egress';

export class LineEgressProxyDto implements EgressProxyInput {
  @ApiProperty({ enum: ['HTTP', 'SOCKS5'] })
  @IsIn(['HTTP', 'SOCKS5'])
  protocol!: 'HTTP' | 'SOCKS5';

  @ApiProperty({ example: '127.0.0.1', maxLength: 253 })
  @IsString()
  @MinLength(1)
  @MaxLength(253)
  serverHost!: string;

  @ApiProperty({ minimum: 1, maximum: 65535 })
  @IsInt()
  @Min(1)
  @Max(65535)
  serverPort!: number;

  @ApiProperty({ default: false })
  @IsBoolean()
  authEnabled!: boolean;

  @ApiPropertyOptional({ maxLength: 255 })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(255)
  username?: string;

  @ApiPropertyOptional({ maxLength: 255, description: '编辑时省略保留原密码；显式空密码无效' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  password?: string;

  @ApiPropertyOptional({ default: false, description: '仅 SOCKS5 支持；需确认代理提供 UDP ASSOCIATE' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  udpEnabled?: boolean;
}
