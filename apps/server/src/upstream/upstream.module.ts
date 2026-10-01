import { Module, forwardRef } from '@nestjs/common';
import { UpstreamService } from './upstream.service';
import { UpstreamParserService } from './upstream-parser.service';
import { UpstreamController } from './upstream.controller';
import { AgentGatewayModule } from '../agent-gateway/agent-gateway.module';
import { ProbeModule } from '../probe/probe.module';

@Module({
  imports: [forwardRef(() => AgentGatewayModule), ProbeModule],
  controllers: [UpstreamController],
  providers: [UpstreamService, UpstreamParserService],
  exports: [UpstreamService, UpstreamParserService]
})
export class UpstreamModule {}
