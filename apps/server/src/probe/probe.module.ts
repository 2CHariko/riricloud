import { Module } from '@nestjs/common';
import { ClientKernelsModule } from '../client-kernels/client-kernels.module';
import { SystemModule } from '../system/system.module';
import { ProbeController } from './probe.controller';
import { ProbeService } from './probe.service';
import { ProbeResourceService } from './probe-resource.service';
import { ProbeTaskService } from './probe-task.service';

@Module({
  imports: [ClientKernelsModule, SystemModule],
  controllers: [ProbeController],
  providers: [ProbeService, ProbeResourceService, ProbeTaskService],
  exports: [ProbeService, ProbeTaskService]
})
export class ProbeModule {}
