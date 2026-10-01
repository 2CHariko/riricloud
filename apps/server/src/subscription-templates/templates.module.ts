import { Module } from '@nestjs/common';
import { LinesModule } from '../lines/lines.module';
import { SystemModule } from '../system/system.module';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';
import { ClientKernelsModule } from '../client-kernels/client-kernels.module';

@Module({
  imports: [LinesModule, SystemModule, ClientKernelsModule],
  controllers: [TemplatesController],
  providers: [TemplatesService],
  exports: [TemplatesService]
})
export class TemplatesModule {}
