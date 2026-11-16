import { Module } from '@nestjs/common';
import { SystemLogsModule } from '../system-logs/system-logs.module';
import { SystemModule } from '../system/system.module';
import { MailController } from './mail.controller';
import { MailService } from './mail.service';

@Module({
  imports: [SystemModule, SystemLogsModule],
  controllers: [MailController],
  providers: [MailService],
  exports: [MailService]
})
export class MailModule {}
