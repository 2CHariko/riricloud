import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SettingsService } from '../system/settings.service';
import { ProbeTaskService } from '../probe/probe-task.service';

@Injectable()
export class LineSpeedtestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LineSpeedtestService.name);
  private timer?: NodeJS.Timeout;
  private lastScheduledAt = Date.now();
  private checking = false;
  private stopping = false;
  constructor(private readonly tasks: ProbeTaskService, private readonly settings: SettingsService) {}
  onModuleInit() { this.timer = setInterval(() => { void this.schedule(); }, 30_000); this.timer.unref(); }
  onModuleDestroy() { this.stopping = true; if (this.timer) clearInterval(this.timer); }
  private async schedule() {
    if (this.checking || this.stopping) return;
    this.checking = true;
    try {
      const settings = await this.settings.getSettings();
      if (!settings.lineSpeedtestEnabled || Date.now() - this.lastScheduledAt < Math.max(1, settings.lineSpeedtestIntervalMins) * 60_000 || this.stopping) return;
      await this.tasks.start('SYSTEM_LINE_SCHEDULER', 'LINE', {}, 'MIHOMO_PREFERRED');
      this.lastScheduledAt = Date.now();
    } catch { this.logger.warn('Scheduled line probe could not be queued'); }
    finally { this.checking = false; }
  }
}
