import { Module, forwardRef } from '@nestjs/common';
import { UpstreamService } from './upstream.service';
import { UpstreamParserService } from './upstream-parser.service';
import { UpstreamController } from './upstream.controller';
import { AgentGatewayModule } from '../agent-gateway/agent-gateway.module';

@Module({
  imports: [forwardRef(() => AgentGatewayModule)],
  controllers: [UpstreamController],
  providers: [UpstreamService, UpstreamParserService],
  exports: [UpstreamService, UpstreamParserService]
})
export class UpstreamModule {}
