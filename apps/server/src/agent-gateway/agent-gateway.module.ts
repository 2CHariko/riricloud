import { Module, OnModuleInit } from '@nestjs/common';
import { AgentGateway } from './agent.gateway';
import { AgentService } from './agent.service';
import { AgentSweepService } from './agent-sweep.service';
import { AgentPollController } from './agent-poll.controller';
import { SystemModule } from '../system/system.module';
import { SystemLogsModule } from '../system-logs/system-logs.module';
import { ProxyPoolAccessModule } from '../proxy-pool-access/proxy-pool-access.module';
import { CertificateTrackingModule } from '../certificates/certificate-tracking.module';

@Module({
  imports: [SystemModule, SystemLogsModule, ProxyPoolAccessModule, CertificateTrackingModule],
  controllers: [AgentPollController],
  providers: [AgentGateway, AgentService, AgentSweepService],
  exports: [AgentService]
})
export class AgentGatewayModule implements OnModuleInit {
  constructor(private readonly sweep: AgentSweepService) {}

  onModuleInit() {
    this.sweep.start();
  }
}
