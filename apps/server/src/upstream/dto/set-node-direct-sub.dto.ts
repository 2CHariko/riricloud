import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetNodeDirectSubDto {
  @ApiProperty({ description: '是否合并入用户客户端订阅' })
  @IsBoolean()
  isDirectSub!: boolean;
}
