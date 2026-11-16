import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../system/settings.service';
import { MailService, type MailContext } from '../mail/mail.service';
import { CertificatesService } from './certificates.service';
import { createHash, randomUUID } from 'node:crypto';
import { SystemLogsService } from '../system-logs/system-logs.service';
import { mailErrorDetails } from '../system-logs/mail-log';
export function reminderStage(days: number, threshold: number): string | null {
  if (days <= 0)
    return 'EXPIRED';
  if (days <= 1)
    return 'ONE_DAY';
  if (days <= 7)
    return 'SEVEN_DAYS';
  return days <= threshold ? 'THRESHOLD' : null;
}
@Injectable()
export class CertificateRemindersService implements OnModuleInit, OnModuleDestroy {
  private startup?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  constructor(private readonly prisma: PrismaService, private readonly settings: SettingsService, private readonly mail: MailService, private readonly certificates: CertificatesService, @Optional() private readonly systemLogs?: SystemLogsService) { }
  onModuleInit() {
    this.startup = setTimeout(() => { void this.check(); }, 10000);
    this.timer = setInterval(() => { void this.check(); }, 3600000);
    this.startup.unref();
    this.timer.unref();
  }
  async onModuleDestroy() { this.stopped = true; clearTimeout(this.startup); clearInterval(this.timer); await this.running; }
  check(): Promise<void> {
    if (this.running)
      return this.running;
    if (this.stopped)
      return Promise.resolve();
    const startedAt = Date.now();
    this.running = this.run().catch((error: unknown) => { this.recordSweepFailure(error, startedAt); }).finally(() => { this.running = undefined; });
    return this.running;
  }
  private recordSweepFailure(error: unknown, startedAt: number, context: MailContext = {}, to?: string) {
    try {
      const { userId, ...association } = context;
      void Promise.resolve(this.systemLogs?.enqueueMail({ level: 'ERROR', userId, metadata: {
        ...association, to, event: 'MAIL_SWEEP_FAILED', operationId: randomUUID(), mailType: 'CERTIFICATE_SWEEP',
        stage: 'SWEEP', durationMs: Date.now() - startedAt, error: mailErrorDetails(error)
      } })).catch(() => undefined);
    } catch {
      // 日志故障不得阻断巡检退出与后续重试。
    }
  }
  private async run() {
    const settings = await this.settings.getSettings();
    let page = 1;
    while (!this.stopped) {
      const rows = await this.certificates.list({ page, pageSize: 100 });
      if (page * 100 >= rows.total)
        break;
      page++;
    }
    if (!settings.certificateMailEnabled || !settings.smtpEnabled)
      return;
    const now = new Date(), day = new Intl.DateTimeFormat('en-CA', { timeZone: settings.systemTimezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const rows = await this.prisma.certificate.findMany({ where: { validTo: { lte: new Date(now.getTime() + Math.max(7, settings.certificateExpiryWarningDays) * 86400000) } }, include: { _count: { select: { lines: true } } } });
    for (const recipient of settings.certificateMailRecipients) {
      if (this.stopped)
        return;
      // 独立的日限额保留在设置表，删除证书不能清掉收件人当日已发送记录。
      const dailyKey = 'certificateReminderDaily:' + createHash('sha256').update(recipient).digest('hex');
      const daily = await this.prisma.systemSetting.findUnique({ where: { key: dailyKey } });
      if (daily?.value === day || await this.prisma.certificateReminder.findFirst({ where: { recipient, sentDay: day, state: 'SENT' } }))
        continue;
      const pending = [] as Array<{
        id: string;
        certificateId: string;
        revision: number;
        name: string;
        validTo: Date;
        days: number;
        lineCount: number;
      }>;
      for (const row of rows) {
        const days = Math.ceil((row.validTo.getTime() - now.getTime()) / 86400000), stage = reminderStage(days, settings.certificateExpiryWarningDays);
        if (!stage)
          continue;
        const record = await this.prisma.certificateReminder.upsert({ where: { certificateId_revision_stage_recipient: { certificateId: row.id, revision: row.currentRevision, stage, recipient } }, create: { certificateId: row.id, revision: row.currentRevision, stage, recipient }, update: {} });
        if (record.state === 'SENT' || record.attemptedAt && now.getTime() - record.attemptedAt.getTime() < 6 * 3600000)
          continue;
        pending.push({ id: record.id, certificateId: row.id, revision: row.currentRevision, name: row.name, validTo: row.validTo, days, lineCount: row._count.lines });
      }
      if (!pending.length)
        continue;
      const latest = await this.prisma.certificate.findMany({ where: { id: { in: pending.map(row => row.certificateId) } }, select: { id: true, currentRevision: true } });
      const current = pending.filter(row => latest.some(cert => cert.id === row.certificateId && cert.currentRevision === row.revision));
      if (!current.length)
        continue;
      const ids = current.map(row => row.id);
      await this.prisma.certificateReminder.updateMany({ where: { id: { in: ids } }, data: { attemptedAt: now, state: 'PENDING' } });
      const context: MailContext = {
        certificateIds: current.map(row => row.certificateId),
        certificateRevisions: current.map(row => ({ certificateId: row.certificateId, revision: row.revision })),
        certificateCount: current.length
      };
      const startedAt = Date.now();
      let sent = false;
      try {
        await this.mail.sendCertificateSummary(recipient, current, settings.systemTimezone, context);
        sent = true;
        await this.prisma.$transaction(async tx => {
          await tx.certificateReminder.updateMany({ where: { id: { in: ids } }, data: { sentAt: new Date(), sentDay: day, state: 'SENT' } });
          await tx.systemSetting.upsert({ where: { key: dailyKey }, create: { key: dailyKey, value: day }, update: { value: day } });
        });
      }
      catch (error) {
        if (sent) this.recordSweepFailure(error, startedAt, context, recipient);
        await this.prisma.certificateReminder.updateMany({ where: { id: { in: ids } }, data: { state: 'FAILED' } });
        // 发送失败由邮件层统一记录；台账异常另记巡检失败，保持原重试规则。
      }
    }
  }
}
