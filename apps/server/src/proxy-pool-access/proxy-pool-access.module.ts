import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SystemModule } from '../system/system.module';
import { ProxyPoolAccessService } from './proxy-pool-access.service';

@Module({
  imports: [PrismaModule, SystemModule],
  providers: [ProxyPoolAccessService],
  exports: [ProxyPoolAccessService]
})
export class ProxyPoolAccessModule {}
