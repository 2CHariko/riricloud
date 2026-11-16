import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as nodemailer from 'nodemailer';
import { SettingsService } from '../system/settings.service';
import { mailErrorDetails, sanitizeMailDiagnostic } from '../system-logs/mail-log';
import type { MailLogInput, MailLogMetadata } from '../system-logs/mail-log';
import { SystemLogsService } from '../system-logs/system-logs.service';

export interface MailContext {
  userId?: string;
  subscriptionId?: string;
  deliveryId?: string;
  certificateIds?: string[];
  certificateRevisions?: Array<{ certificateId: string; revision: number }>;
  certificateCount?: number;
}

type MailSettings = Awaited<ReturnType<SettingsService['getSettings']>>;
interface MailOperation {
  mailType: MailLogMetadata['mailType'];
  title: string;
  action?: string;
  secrets?: string[];
  verify?: boolean;
}

@Injectable()
export class MailService {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly systemLogsService: SystemLogsService
  ) {}

  async sendCertificateSummary(email: string, rows: Array<{ name: string; validTo: Date; days: number; lineCount: number }>, timezone: string, context?: MailContext) {
    const result = await this.deliver(email, { mailType: 'CERTIFICATE_EXPIRY', title: '证书到期提醒' }, () => {
      const date = new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' });
      const lines = rows.map(row => row.name + '：' + date.format(row.validTo) + '，剩余 ' + row.days + ' 天，关联 ' + row.lineCount + ' 条线路');
      return { text: lines.join('\n') };
    }, context);
    return result.info;
  }

  async sendTrafficWarning(email: string, input: { planName: string; usedBytes: bigint; limitBytes: bigint; percentage: number }, context?: MailContext) {
    const exhausted = input.percentage >= 100;
    const title = exhausted ? '流量已用尽' : '流量使用提醒';
    const result = await this.deliver(email, { mailType: 'TRAFFIC_WARNING', title }, settings => {
      const remainingBytes = input.limitBytes > input.usedBytes ? input.limitBytes - input.usedBytes : BigInt(0);
      const intro = exhausted
        ? '您的套餐流量额度已用尽，订阅连接可能已暂停。'
        : `您的套餐流量使用已达到 ${input.percentage}%，请留意剩余额度。`;
      const rows: Array<[string, string]> = [
        ['套餐', input.planName],
        ['已用流量', formatBytesValue(input.usedBytes)],
        ['套餐总量', formatBytesValue(input.limitBytes)],
        ['剩余流量', formatBytesValue(remainingBytes)],
        ['使用比例', `${input.percentage}%`]
      ];
      return buildReminderEmail(settings, title, intro, rows, '如有疑问，请联系站点管理员。');
    }, context);
    return result.info;
  }

  async sendSubscriptionExpiry(email: string, input: { planName: string; expireAt: Date; daysRemaining: number; timezone: string }, context?: MailContext) {
    const expired = input.daysRemaining <= 0;
    const title = expired ? '套餐已到期' : '套餐即将到期';
    const result = await this.deliver(email, { mailType: 'SUBSCRIPTION_EXPIRY', title }, settings => {
      const date = new Intl.DateTimeFormat('zh-CN', { timeZone: input.timezone, dateStyle: 'medium', timeStyle: 'short' });
      const intro = expired
        ? '您的套餐已到期，订阅连接可能已暂停。如需继续使用，请及时续费。'
        : `您的套餐将在 ${input.daysRemaining} 天内到期，请及时安排续费。`;
      const rows: Array<[string, string]> = [
        ['套餐', input.planName],
        ['到期时间', date.format(input.expireAt)],
        ['剩余天数', expired ? '已到期' : `${input.daysRemaining} 天`]
      ];
      return buildReminderEmail(settings, title, intro, rows, '续费后订阅将自动恢复。');
    }, context);
    return result.info;
  }

  async sendVerificationCode(email: string, code: string, action: 'REGISTER' | 'CHANGE_EMAIL' | 'VERIFY_CURRENT_EMAIL' | 'RESET_PASSWORD', context?: MailContext) {
    const titles: Record<string, string> = {
      REGISTER: '注册验证码', CHANGE_EMAIL: '换绑邮箱验证码', VERIFY_CURRENT_EMAIL: '邮箱验证码', RESET_PASSWORD: '重置登录密码验证码'
    };
    const { info } = await this.deliver(email, { mailType: 'VERIFICATION', title: titles[action] ?? '验证码', action, secrets: [code] }, settings => ({
      text: `${settings.siteName} 验证码：${code}，5 分钟内有效。请勿将验证码提供给他人。`,
      html: buildVerificationEmail({
        siteName: escapeHtml(settings.siteName), logoUrl: settings.logoUrl, code,
        footer: settings.footerCopyright || `© ${new Date().getFullYear()} ${settings.siteName}`, action
      })
    }), context);
    return { messageId: info.messageId };
  }

  async testSmtp(email: string, context?: MailContext) {
    const { info, durationMs } = await this.deliver(email, { mailType: 'SMTP_TEST', title: 'SMTP 测试邮件', verify: true }, settings => ({
      text: `SMTP 配置测试成功。发送时间：${new Date().toISOString()}`,
      html: `<p>${escapeHtml(settings.siteName)} SMTP 配置测试成功。</p><p>发送时间：${escapeHtml(new Date().toISOString())}</p>`
    }), context);
    return { success: true, messageId: info.messageId, durationMs };
  }

  private async deliver(
    email: string,
    operation: MailOperation,
    buildContent: (settings: MailSettings) => Pick<nodemailer.SendMailOptions, 'text' | 'html'>,
    context: MailContext = {}
  ) {
    const startedAt = Date.now();
    const secrets = [...(operation.secrets ?? [])];
    const metadata: MailLogMetadata = {
      event: 'MAIL_SEND_FAILED', operationId: randomUUID(), mailType: operation.mailType,
      to: email, action: operation.action, stage: 'CONFIG',
      subscriptionId: context.subscriptionId, deliveryId: context.deliveryId,
      certificateIds: context.certificateIds, certificateRevisions: context.certificateRevisions,
      certificateCount: context.certificateCount
    };
    try {
      const settings = await this.settingsService.getSettings();
      secrets.push(settings.smtpPass);
      Object.assign(metadata, {
        from: settings.smtpFrom || settings.smtpUser, subject: `【${settings.siteName}】${operation.title}`,
        smtpHost: settings.smtpHost, smtpPort: settings.smtpPort, smtpSecure: settings.smtpSecure
      });
      const transporter = this.createTransporter(settings);
      // 测试接口原耗时不含配置读取，日志耗时覆盖整个操作。
      const smtpStartedAt = Date.now();
      if (operation.verify) {
        metadata.stage = 'VERIFY';
        await transporter.verify();
      }
      metadata.stage = 'SEND';
      const info = await transporter.sendMail({
        from: settings.smtpFrom || settings.smtpUser, to: email, subject: metadata.subject,
        ...buildContent(settings)
      });
      const durationMs = Date.now() - smtpStartedAt;
      // ACCEPTED 仅表示 SMTP 接受发送，不表示邮件进入收件箱。
      this.recordMail({ ...metadata, event: 'MAIL_SEND_ACCEPTED', durationMs: Date.now() - startedAt }, context.userId, secrets, undefined, info);
      return { info, durationMs };
    } catch (error) {
      this.recordMail({ ...metadata, durationMs: Date.now() - startedAt }, context.userId, secrets, error);
      if (operation.verify && metadata.stage !== 'CONFIG') {
        throw new BadRequestException('SMTP 测试失败，请检查服务器、端口、加密方式和账号密码');
      }
      throw error;
    }
  }

  private recordMail(metadata: MailLogMetadata, userId: string | undefined, secrets: string[], error?: unknown, result?: unknown): void {
    try {
      const clean = (value: string) => sanitizeMailDiagnostic(value, secrets);
      const safeMetadata: MailLogMetadata = { ...metadata };
      for (const key of ['to', 'from', 'subject', 'smtpHost'] as const) {
        if (typeof safeMetadata[key] === 'string') safeMetadata[key] = clean(safeMetadata[key]);
      }
      if (metadata.event === 'MAIL_SEND_FAILED') safeMetadata.error = mailErrorDetails(error, secrets);
      if (result && typeof result === 'object') {
        const info = result as Record<string, unknown>;
        const messageId = readSmtpField(info, 'messageId');
        const response = readSmtpField(info, 'response');
        if (typeof messageId === 'string') safeMetadata.messageId = clean(messageId);
        if (typeof response === 'string') safeMetadata.smtpResponse = clean(response);
        for (const key of ['accepted', 'rejected'] as const) {
          const addresses = readSmtpField(info, key);
          if (Array.isArray(addresses)) safeMetadata[key] = addresses.filter((value): value is string => typeof value === 'string').map(clean);
        }
      }
      // 显式全部拒收只改变日志终态，不改变 Nodemailer 的 resolved 返回或提醒重试语义。
      if (safeMetadata.accepted?.length === 0 && safeMetadata.rejected?.length) safeMetadata.event = 'MAIL_SEND_FAILED';
      const input: MailLogInput = { level: safeMetadata.event === 'MAIL_SEND_ACCEPTED' ? 'INFO' : 'ERROR', metadata: safeMetadata };
      if (userId !== undefined) input.userId = userId;
      // 日志尽力入队；同步异常或异步拒绝均不能改变发信结果或触发重发。
      void Promise.resolve(this.systemLogsService.enqueueMail(input)).catch(() => undefined);
    } catch {
      // 不将原始错误再写入其他日志，避免泄露凭据或遮蔽发信结果。
    }
  }

  private createTransporter(settings: MailSettings) {
    if (!settings.smtpEnabled) throw new BadRequestException('SMTP 发信服务未启用');
    if (!settings.smtpHost) throw new BadRequestException('SMTP 服务器未配置');
    if (!settings.smtpFrom && !settings.smtpUser) throw new BadRequestException('请配置发信人地址或 SMTP 账号');
    return nodemailer.createTransport({
      host: settings.smtpHost, port: settings.smtpPort, secure: settings.smtpSecure,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
      auth: settings.smtpUser ? { user: settings.smtpUser, pass: settings.smtpPass } : undefined
    });
  }
}

function readSmtpField(info: Record<string, unknown>, key: string): unknown {
  try { return info[key]; } catch { return undefined; }
}

function buildVerificationEmail(input: { siteName: string; logoUrl: string; code: string; footer: string; action: string }) {
  const titleMap: Record<string, string> = {
    REGISTER: '完成注册验证',
    CHANGE_EMAIL: '确认换绑邮箱',
    VERIFY_CURRENT_EMAIL: '验证当前邮箱',
    RESET_PASSWORD: '重置登录密码'
  };
  const title = titleMap[input.action] ?? '邮箱安全验证';
  const logo = input.logoUrl
    ? `<img src="${escapeHtml(input.logoUrl)}" alt="${input.siteName}" style="width:48px;height:48px;object-fit:contain;border-radius:12px;">`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f4f7fb;padding:32px 16px;font-family:Arial,'Microsoft YaHei',sans-serif;color:#172033;"><div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e4e9f2;border-radius:16px;overflow:hidden;"><div style="padding:28px 28px 16px;text-align:center;">${logo}<h1 style="font-size:22px;margin:14px 0 6px;">${input.siteName}</h1><p style="margin:0;color:#667085;">${title}</p></div><div style="padding:12px 28px 30px;text-align:center;"><p style="color:#475467;">您的验证码是：</p><div style="display:inline-block;letter-spacing:8px;font-size:34px;font-weight:700;color:#2563eb;background:#eff6ff;border-radius:12px;padding:14px 24px 14px 32px;">${escapeHtml(input.code)}</div><p style="color:#667085;font-size:14px;margin:22px 0 0;">验证码 5 分钟内有效，请勿将验证码提供给他人。</p></div><div style="padding:16px 28px;background:#f8fafc;color:#98a2b3;font-size:12px;text-align:center;">${escapeHtml(input.footer)}</div></div></body></html>`;
}

function buildReminderEmail(
  settings: MailSettings,
  title: string,
  intro: string,
  rows: Array<[string, string]>,
  footerText: string
) {
  const siteName = escapeHtml(settings.siteName);
  const profileUrl = buildProfileUrl(settings.publicBaseUrl);
  const textRows = rows.map(([label, value]) => `${label}：${value}`).join(String.fromCharCode(10));
  const htmlRows = rows.map(([label, value]) => `<tr><td style="padding:8px 0;color:#667085;">${escapeHtml(label)}</td><td style="padding:8px 0;text-align:right;font-weight:600;color:#172033;">${escapeHtml(value)}</td></tr>`).join('');
  const text = [settings.siteName + ' ' + title, '', intro, '', textRows, '', footerText, '', '可在个人中心关闭订阅邮件提醒。', ...(profileUrl ? [profileUrl] : [])].join(String.fromCharCode(10));
  const html = `<!doctype html><html><body style="margin:0;background:#f4f7fb;padding:32px 16px;font-family:Arial,'Microsoft YaHei',sans-serif;color:#172033;"><div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e4e9f2;border-radius:16px;overflow:hidden;"><div style="padding:28px 28px 16px;text-align:center;"><h1 style="font-size:22px;margin:0 0 6px;">${siteName}</h1><p style="margin:0;color:#667085;">${escapeHtml(title)}</p></div><div style="padding:8px 28px 24px;"><p style="color:#475467;line-height:1.7;">${escapeHtml(intro)}</p><table style="width:100%;border-collapse:collapse;font-size:14px;">${htmlRows}</table><p style="color:#667085;font-size:14px;line-height:1.7;margin:22px 0 0;">${escapeHtml(footerText)}</p>${profileUrl ? `<p style="margin:18px 0 0;text-align:center;"><a href="${escapeHtml(profileUrl)}" style="display:inline-block;border-radius:10px;background:#2563eb;color:#fff;padding:10px 18px;text-decoration:none;">打开个人中心</a></p>` : ''}<p style="color:#98a2b3;font-size:12px;text-align:center;margin:18px 0 0;">可在个人中心关闭订阅邮件提醒。</p></div><div style="padding:16px 28px;background:#f8fafc;color:#98a2b3;font-size:12px;text-align:center;">${escapeHtml(settings.footerCopyright || `© ${new Date().getFullYear()} ${settings.siteName}`)}</div></div></body></html>`;
  return { text, html };
}

function buildProfileUrl(publicBaseUrl: string): string {
  try {
    return publicBaseUrl ? new URL('/profile', publicBaseUrl).toString() : '';
  } catch {
    return '';
  }
}

function formatBytesValue(value: bigint): string {
  if (value <= BigInt(0)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let unitIndex = 0;
  let divisor = BigInt(1);
  while (unitIndex < units.length - 1 && value >= divisor * BigInt(1024)) {
    divisor *= BigInt(1024);
    unitIndex += 1;
  }
  const whole = value / divisor;
  const fraction = (value % divisor) * BigInt(100) / divisor;
  const fractionText = fraction ? `.${fraction.toString().padStart(2, '0').replace(/0+$/, '')}` : '';
  return `${whole}${fractionText} ${units[unitIndex]}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}
