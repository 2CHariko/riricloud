import { Module } from '@nestjs/common';
import { AgentGatewayModule } from '../agent-gateway/agent-gateway.module';
import { LinesController } from './lines.controller';
import { LinesService } from './lines.service';
import { LineSpeedtestService } from './line-speedtest.service';
import { SystemModule } from '../system/system.module';
import { ProbeModule } from '../probe/probe.module';

@Module({
  imports: [AgentGatewayModule, SystemModule, ProbeModule],
  controllers: [LinesController],
  providers: [LinesService, LineSpeedtestService],
  exports: [LinesService, LineSpeedtestService]
})
export class LinesModule {}
