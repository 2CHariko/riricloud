import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class UpdateNotificationPreferencesDto {
  @ApiProperty({ example: true, description: '是否接收订阅流量预警和套餐到期邮件' })
  @IsBoolean()
  subscriptionEmailNotificationsEnabled!: boolean;
}
