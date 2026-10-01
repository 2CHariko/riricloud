import { Module } from '@nestjs/common';
import { AgentGatewayModule } from '../agent-gateway/agent-gateway.module';
import { AdminProxyPoolController } from './admin-proxy-pool.controller';
import { ProxyPoolService } from './proxy-pool.service';
import { UserProxyPoolController } from './user-proxy-pool.controller';
import { ProxyPoolAccessModule } from '../proxy-pool-access/proxy-pool-access.module';

@Module({
  imports: [AgentGatewayModule, ProxyPoolAccessModule],
  controllers: [UserProxyPoolController, AdminProxyPoolController],
  providers: [ProxyPoolService],
  exports: [ProxyPoolService]
})
export class ProxyPoolModule {}
