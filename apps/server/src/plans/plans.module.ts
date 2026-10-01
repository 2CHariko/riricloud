import { Module } from '@nestjs/common';
import { PlansController } from './plans.controller';
import { PublicPlansController } from './public-plans.controller';
import { PlansService } from './plans.service';
import { LinesModule } from '../lines/lines.module';
import { AgentGatewayModule } from '../agent-gateway/agent-gateway.module';

@Module({
  imports: [LinesModule, AgentGatewayModule],
  controllers: [PlansController, PublicPlansController],
  providers: [PlansService],
  exports: [PlansService]
})
export class PlansModule {}
