import { Module } from '@nestjs/common';
import { SystemLogsModule } from '../system-logs/system-logs.module';
import { LineCredentialsController } from './line-credentials.controller';
import { LineCredentialsService } from './line-credentials.service';
@Module({ imports: [SystemLogsModule], controllers: [LineCredentialsController], providers: [LineCredentialsService], exports: [LineCredentialsService] })
export class LineCredentialsModule {}
