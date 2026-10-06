import { Module } from '@nestjs/common';
import { SystemLogsModule } from '../system-logs/system-logs.module';
import { CertificateTrackingService } from './certificate-tracking.service';
import { CertificateBindingsService } from './certificate-bindings.service';
@Module({ imports: [SystemLogsModule], providers: [CertificateTrackingService, CertificateBindingsService], exports: [CertificateTrackingService, CertificateBindingsService] })
export class CertificateTrackingModule {
}
