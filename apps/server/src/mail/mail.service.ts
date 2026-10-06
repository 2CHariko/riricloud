import { BadRequestException, Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { SettingsService } from '../system/settings.service';

@Injectable()
export class MailService {
  constructor(private readonly settingsService: SettingsService) {}

  async sendCertificateSummary(email: string, rows: Array<{ name: string; validTo: Date; days: number; lineCount: number }>, timezone: string) {
    const settings = await this.settingsService.getSettings();
    const transporter = this.createTransporter(settings);
    const date = new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' });
    const lines = rows.map(row => row.name + '：' + date.format(row.validTo) + '，剩余 ' + row.days + ' 天，关联 ' + row.lineCount + ' 条线路');
    return transporter.sendMail({ from: settings.smtpFrom || settings.smtpUser, to: email, subject: '【' + settings.siteName + '】证书到期提醒', text: lines.join('\n') });
  }

  async sendVerificationCode(email: string, code: string, action: 'REGISTER' | 'CHANGE_EMAIL' | 'VERIFY_CURRENT_EMAIL' | 'RESET_PASSWORD') {
    const settings = await this.settingsService.getSettings();
    const transporter = this.createTransporter(settings);
    const siteName = escapeHtml(settings.siteName);
    const subjectMap: Record<string, string> = {
      REGISTER: `【${settings.siteName}】注册验证码`,
      CHANGE_EMAIL: `【${settings.siteName}】换绑邮箱验证码`,
      VERIFY_CURRENT_EMAIL: `【${settings.siteName}】邮箱验证码`,
      RESET_PASSWORD: `【${settings.siteName}】重置登录密码验证码`
    };
    const subject = subjectMap[action] ?? `【${settings.siteName}】验证码`;
    const info = await transporter.sendMail({
      from: settings.smtpFrom || settings.smtpUser,
      to: email,
      subject,
      text: `${settings.siteName} 验证码：${code}，5 分钟内有效。请勿将验证码提供给他人。`,
      html: buildVerificationEmail({
        siteName,
        logoUrl: settings.logoUrl,
        code,
        footer: settings.footerCopyright || `© ${new Date().getFullYear()} ${settings.siteName}`,
        action
      })
    });
    return { messageId: info.messageId };
  }

  async testSmtp(email: string) {
    const settings = await this.settingsService.getSettings();
    const transporter = this.createTransporter(settings);
    const startedAt = Date.now();
    try {
      await transporter.verify();
      const info = await transporter.sendMail({
        from: settings.smtpFrom || settings.smtpUser,
        to: email,
        subject: `【${settings.siteName}】SMTP 测试邮件`,
        text: `SMTP 配置测试成功。发送时间：${new Date().toISOString()}`,
        html: `<p>${escapeHtml(settings.siteName)} SMTP 配置测试成功。</p><p>发送时间：${escapeHtml(new Date().toISOString())}</p>`
      });
      return { success: true, messageId: info.messageId, durationMs: Date.now() - startedAt };
    } catch {
      throw new BadRequestException('SMTP 测试失败，请检查服务器、端口、加密方式和账号密码');
    }
  }

  private createTransporter(settings: Awaited<ReturnType<SettingsService['getSettings']>>) {
    if (!settings.smtpEnabled) throw new BadRequestException('SMTP 发信服务未启用');
    if (!settings.smtpHost) throw new BadRequestException('SMTP 服务器未配置');
    if (!settings.smtpFrom && !settings.smtpUser) throw new BadRequestException('请配置发信人地址或 SMTP 账号');
    return nodemailer.createTransport({
      host: settings.smtpHost,
      port: settings.smtpPort,
      secure: settings.smtpSecure,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
      auth: settings.smtpUser ? { user: settings.smtpUser, pass: settings.smtpPass } : undefined
    });
  }
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}
