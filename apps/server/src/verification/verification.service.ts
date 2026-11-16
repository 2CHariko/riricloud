import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { assertEmailLength, hashAuthValue, normalizeEmail, normalizeVerificationCode, safeEqual } from '../common/auth-security';
import { CaptchaService } from '../captcha/captcha.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../system/settings.service';
import { MailService } from '../mail/mail.service';
import { SendCodeDto, VerificationAction } from './dto/send-code.dto';
import { RateLimitService } from '../common/rate-limit.service';
import { AuthAuditEvent, AuthAuditService } from '../common/auth-audit.service';

const CODE_TTL_MS = 5 * 60 * 1000;
const CODE_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

type VerificationCodeRow = { id: string; codeHash: string; attempts: number; expiresAt: Date };
type VerificationStore = {
  findFirst: (args: Record<string, unknown>) => Promise<VerificationCodeRow | null>;
  create: (args: Record<string, unknown>) => Promise<VerificationCodeRow>;
  updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
  deleteMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
};

@Injectable()
export class VerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SettingsService,
    private readonly mailService: MailService,
    private readonly captchaService: CaptchaService,
    @Optional() private readonly rateLimitService?: RateLimitService,
    @Optional() private readonly authAuditService?: AuthAuditService
  ) {}

  async sendCode(dto: SendCodeDto, userId?: string, remoteIp?: string, deviceKey = 'unknown') {
    const email = normalizeEmail(dto.email);
    assertEmailLength(email);
    const emailHash = this.authAuditService?.emailHash(email);
    const metadata = { action: dto.action, emailHash, remoteIp: remoteIp || 'unknown' };
    this.assertRateLimit(`verification:ip:${remoteIp || 'unknown'}`, 10, 60 * 60_000, metadata);
    this.assertRateLimit(`verification:email:${email}:${dto.action}`, 3, 60 * 60_000, metadata);
    this.assertRateLimit(`verification:device:${deviceKey || 'unknown'}`, 20, 60 * 60_000, metadata);
    const settings = await this.settingsService.getSettings();
    if (dto.action === 'REGISTER') {
      if (!settings.emailVerificationEnabled) throw new BadRequestException('注册邮箱验证未启用');
      if (settings.captchaMode !== 'OFF') {
        await this.captchaService.verifyCaptcha({ ...dto, remoteIp, action: dto.action });
      }
      const existing = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (existing) {
        this.audit('VERIFICATION_SENT', { ...metadata, delivered: false });
        return this.genericResponse();
      }
    } else if (dto.action === 'CHANGE_EMAIL') {
      if (!userId) throw new UnauthorizedException('请先登录后换绑邮箱');
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!user) throw new UnauthorizedException();
      const existing = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (existing && existing.id !== userId) throw new ConflictException('新邮箱已被其他账号使用');
    } else if (dto.action === 'VERIFY_CURRENT_EMAIL') {
      if (!userId) throw new UnauthorizedException('请先登录后验证邮箱');
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
      if (!user) throw new UnauthorizedException();
      if (normalizeEmail(user.email) !== email) throw new BadRequestException('只能验证当前登录账号绑定的邮箱');
    } else if (dto.action === 'RESET_PASSWORD') {
      if (settings.captchaMode !== 'OFF') {
        await this.captchaService.verifyCaptcha({ ...dto, remoteIp, action: dto.action });
      }
      const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (!user) {
        this.audit('VERIFICATION_SENT', { ...metadata, delivered: false });
        return this.genericResponse();
      }
    }

    const store = this.store(this.client(this.prisma));
    const now = new Date();
    await store.deleteMany({ where: { expiresAt: { lt: now } } });
    const recent = await store.findFirst({
      where: { email, action: dto.action, createdAt: { gte: new Date(now.getTime() - CODE_COOLDOWN_MS) } },
      orderBy: { createdAt: 'desc' }
    });
    if (recent) {
      this.audit('VERIFICATION_RATE_LIMITED', metadata);
      throw new HttpException('验证码发送过于频繁，请 60 秒后再试', HttpStatus.TOO_MANY_REQUESTS);
    }

    const code = randomInt(100000, 1000000).toString();
    const record = await store.create({
      data: {
        email,
        codeHash: hashAuthValue('verification-code', normalizeVerificationCode(code)),
        action: dto.action,
        attempts: 0,
        expiresAt: new Date(now.getTime() + CODE_TTL_MS)
      }
    });
    try {
      await this.mailService.sendVerificationCode(email, code, dto.action, userId ? { userId } : undefined);
      this.audit('VERIFICATION_SENT', { ...metadata, delivered: true });
      return this.genericResponse();
    } catch (error) {
      await store.deleteMany({ where: { id: record.id } });
      this.audit('VERIFICATION_SEND_FAILURE', metadata);
      throw error;
    }
  }

  async verifyCode(email: string, action: VerificationAction, code: string, client: unknown = this.prisma) {
    const store = this.store(this.client(client));
    const normalizedEmail = normalizeEmail(email);
    assertEmailLength(normalizedEmail);
    const normalizedCode = normalizeVerificationCode(code);
    const metadata = { action, emailHash: this.authAuditService?.emailHash(normalizedEmail) };
    if (!/^\d{6}$/.test(normalizedCode)) return this.failVerification(metadata, '验证码错误');
    const record = await store.findFirst({ where: { email: normalizedEmail, action }, orderBy: { createdAt: 'desc' } });
    if (!record || record.expiresAt.getTime() <= Date.now()) return this.failVerification(metadata, '验证码不存在或已过期');
    if (record.attempts >= MAX_ATTEMPTS) return this.failVerification(metadata, '验证码错误次数过多，请重新获取');
    const codeHash = hashAuthValue('verification-code', normalizedCode);
    if (!safeEqual(record.codeHash, codeHash)) {
      const updated = await store.updateMany({
        where: { id: record.id, attempts: { lt: MAX_ATTEMPTS } },
        data: { attempts: { increment: 1 } }
      });
      if (!updated.count) return this.failVerification(metadata, '验证码错误次数过多，请重新获取');
      const latest = await store.findFirst({ where: { id: record.id }, orderBy: { createdAt: 'desc' } });
      if (!latest || latest.attempts >= MAX_ATTEMPTS) return this.failVerification(metadata, '验证码错误次数过多，请重新获取');
      return this.failVerification(metadata, '验证码错误');
    }
    const deleted = await store.deleteMany({ where: { id: record.id, codeHash, attempts: { lt: MAX_ATTEMPTS }, expiresAt: { gt: new Date() } } });
    if (!deleted.count) return this.failVerification(metadata, '验证码不存在或已过期');
    this.audit('VERIFICATION_CONSUMED', metadata);
    return { verified: true };
  }

  private failVerification(metadata: Record<string, unknown>, message: string): never {
    this.audit('VERIFICATION_FAILURE', metadata);
    throw new BadRequestException(message);
  }

  private audit(event: AuthAuditEvent, metadata: Record<string, unknown>): void {
    this.authAuditService?.record(event, metadata);
  }

  private client(client: unknown): VerificationClient {
    return client as unknown as VerificationClient;
  }

  private genericResponse() {
    return { sent: true, cooldownSeconds: 60, message: '如果邮箱已注册，验证码将在短时间内发送' };
  }

  private assertRateLimit(key: string, limit: number, windowMs: number, metadata: Record<string, unknown>): void {
    if (this.rateLimitService && !this.rateLimitService.consume(key, limit, windowMs)) {
      this.audit('VERIFICATION_RATE_LIMITED', metadata);
      throw new HttpException('请求过于频繁，请稍后再试', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private store(client: VerificationClient): VerificationStore {
    return client.verificationCode;
  }
}

type VerificationClient = { verificationCode: VerificationStore };
