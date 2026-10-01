import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { TelemetryPrismaModule } from './prisma/telemetry-prisma.module';
import { AuthModule } from './auth/auth.module';
import { SystemModule } from './system/system.module';
import { UsersModule } from './users/users.module';
import { NodesModule } from './nodes/nodes.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { AgentGatewayModule } from './agent-gateway/agent-gateway.module';
import { PlansModule } from './plans/plans.module';
import { TemplatesModule } from './subscription-templates/templates.module';
import { LinesModule } from './lines/lines.module';
import { BinariesModule } from './binaries/binaries.module';
import { CertificatesModule } from './certificates/certificates.module';
import { TrafficModule } from './traffic/traffic.module';
import { WalletModule } from './wallet/wallet.module';
import { RedeemCodesModule } from './redeem-codes/redeem-codes.module';
import { SystemLogsModule } from './system-logs/system-logs.module';
import { MirrorsModule } from './mirrors/mirrors.module';
import { ProxyPoolModule } from './proxy-pool/proxy-pool.module';
import { HelpModule } from './help/help.module';
import { UpstreamModule } from './upstream/upstream.module';
import { ProbeModule } from './probe/probe.module';

// Web 静态托管在 main.ts 以中间件方式注册（@nestjs/serve-static 与 Express 5 不兼容）
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    TelemetryPrismaModule,
    AuthModule,
    SystemModule,
    UsersModule,
    NodesModule,
    LinesModule,
    PlansModule,
    TemplatesModule,
    SubscriptionModule,
    AgentGatewayModule,
    BinariesModule,
    CertificatesModule,
    TrafficModule,
    WalletModule,
    RedeemCodesModule,
    SystemLogsModule,
    MirrorsModule,
    ProxyPoolModule,
    HelpModule,
    UpstreamModule,
    ProbeModule,
  ]
})
export class AppModule {}
