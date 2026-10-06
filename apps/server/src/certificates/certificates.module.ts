import { Module } from '@nestjs/common';
import { AgentGatewayModule } from '../agent-gateway/agent-gateway.module';
import { CertificatesController } from './certificates.controller';
import { CertificatesService } from './certificates.service';
import { CertificateTrackingModule } from './certificate-tracking.module';
import { SystemModule } from '../system/system.module';
import { SystemLogsModule } from '../system-logs/system-logs.module';
import { MailModule } from '../mail/mail.module';
import { CertificateRemindersService } from './certificate-reminders.service';
@Module({
  imports: [AgentGatewayModule, CertificateTrackingModule, SystemModule, SystemLogsModule, MailModule],
  controllers: [CertificatesController],
  providers: [CertificatesService, CertificateRemindersService],
  exports: [CertificatesService]
})
export class CertificatesModule {
}
