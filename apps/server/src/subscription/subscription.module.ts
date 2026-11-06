import { Module } from '@nestjs/common';
import { AgentGatewayModule } from '../agent-gateway/agent-gateway.module';
import { PlansModule } from '../plans/plans.module';
import { LinesModule } from '../lines/lines.module';
import { SystemModule } from '../system/system.module';
import { AdminSubscriptionController } from './admin-subscription.controller';
import { SubscriptionController } from './subscription.controller';
import { SubscriptionService } from './subscription.service';
import { UserSubscriptionController } from './user-subscription.controller';
import { WalletModule } from '../wallet/wallet.module';
import { PlanPurchasesModule } from './plan-purchases.module';
import { MailModule } from '../mail/mail.module';
import { SubscriptionEmailRemindersService } from './subscription-email-reminders.service';

@Module({
  imports: [AgentGatewayModule, PlansModule, LinesModule, SystemModule, WalletModule, PlanPurchasesModule, MailModule],
  controllers: [SubscriptionController, UserSubscriptionController, AdminSubscriptionController],
  providers: [SubscriptionService, SubscriptionEmailRemindersService],
  exports: [SubscriptionService, PlanPurchasesModule]
})
export class SubscriptionModule {}
