import { Module } from '@nestjs/common';
import { AgentGatewayModule } from '../agent-gateway/agent-gateway.module';
import { LinesModule } from '../lines/lines.module';
import { SystemModule } from '../system/system.module';
import { SystemLogsModule } from '../system-logs/system-logs.module';
import { UpstreamController } from './upstream.controller';
import { UpstreamFetchService } from './upstream-fetch.service';
import { UpstreamService } from './upstream.service';

@Module({
  imports: [AgentGatewayModule, LinesModule, SystemModule, SystemLogsModule],
  controllers: [UpstreamController],
  providers: [UpstreamService, UpstreamFetchService],
  exports: [UpstreamService]
})
export class UpstreamModule {}
