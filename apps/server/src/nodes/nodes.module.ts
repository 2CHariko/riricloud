import { Module } from '@nestjs/common';
import { LineCredentialsModule } from '../line-credentials/line-credentials.module';
import { AgentGatewayModule } from '../agent-gateway/agent-gateway.module';
import { BinariesModule } from '../binaries/binaries.module';
import { SystemLogsModule } from '../system-logs/system-logs.module';
import { SystemModule } from '../system/system.module';
import { NodesController } from './nodes.controller';
import { NodesService } from './nodes.service';

@Module({
  imports: [AgentGatewayModule, BinariesModule, SystemModule, SystemLogsModule, LineCredentialsModule],
  controllers: [NodesController],
  providers: [NodesService],
  exports: [NodesService]
})
export class NodesModule {}
