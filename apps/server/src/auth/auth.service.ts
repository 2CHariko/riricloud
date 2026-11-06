import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { AgentService } from '../agent-gateway/agent.service';
import { CaptchaService } from '../captcha/captcha.service';
import { assertEmailLength, assertPasswordPolicy, buildPasswordStrengthPolicy, normalizeEmail, passwordComplexityFromSettings } from '../common/auth-security';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../system/settings.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { WalletService } from '../wallet/wallet.service';
import { defaultUserNickname, generateUniqueUserUid, isUidUniqueConstraintError, isUniqueConstraintError, normalizeNickname } from '../users/user-identity';
import { VerificationService } from '../verification/verification.service';
import { RateLimitService } from '../common/rate-limit.service';
import { AuthAuditEvent, AuthAuditService } from '../common/auth-audit.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

const DUMMY_PASSWORD_HASH = '$2b$10$qsd1lBJ9TaflXxxFrnDi3.t.ZC3wtXtcZXKOTtVFfiFljQKnfBcGa';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private settingsService: SettingsService,
    private agentGateway: AgentService,
    @Optional() private subscriptionService?: SubscriptionService,
    @Optional() private walletService?: WalletService,
    @Optional() private verificationService?: VerificationService,
    @Optional() private captchaService?: CaptchaService,
    @Optional() private rateLimitService?: RateLimitService,
    @Optional() private authAuditService?: AuthAuditService
  ) {}

  async login(dto: LoginDto, remoteIp = 'unknown', deviceKey = 'unknown'): Promise<{ accessToken: string }> {
    const email = normalizeEmail(dto.email);
    assertEmailLength(email);
    const emailHash = this.authAuditService?.emailHash(email);
    this.assertRateLimit(`login:ip:${remoteIp}`, 10, 60_000, 'LOGIN_RATE_LIMITED', { emailHash, remoteIp });
    this.assertRateLimit(`login:email:${email}`, 5, 60_000, 'LOGIN_RATE_LIMITED', { emailHash });
    this.assertRateLimit(`login:device:${deviceKey || 'unknown'}`, 20, 60_000, 'LOGIN_RATE_LIMITED', { emailHash });
    const user = await this.prisma.user.findUnique({ where: { email } });
    const passwordMatches = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !user.isActive || !passwordMatches) {
      this.audit('LOGIN_FAILURE', { emailHash, accountActive: user?.isActive ?? null });
      throw new UnauthorizedException('邮箱或密码错误');
    }
    this.audit('LOGIN_SUCCESS', { emailHash }, user.id);
    return { accessToken: await this.signToken(user) };
  }

  // 注册：受注册开关控制，新用户固定 USER 角色与默认配额，注册即登录
  async register(dto: RegisterDto, remoteIp = 'unknown', deviceKey = 'unknown'): Promise<{ accessToken: string }> {
    const email = normalizeEmail(dto.email);
    assertEmailLength(email);
    const emailHash = this.authAuditService?.emailHash(email);
    this.assertRateLimit(`register:ip:${remoteIp}`, 5, 60 * 60_000, 'REGISTER_RATE_LIMITED', { emailHash, remoteIp });
    this.assertRateLimit(`register:email:${email}`, 5, 60 * 60_000, 'REGISTER_RATE_LIMITED', { emailHash });
    this.assertRateLimit(`register:device:${deviceKey || 'unknown'}`, 10, 60 * 60_000, 'REGISTER_RATE_LIMITED', { emailHash });
    const settings = await this.settingsService.getSettings();
    if (!settings.registrationEnabled) {
      throw new ForbiddenException('注册已关闭');
    }
    assertPasswordPolicy(dto.password, settings.passwordMinLength ?? 8, buildPasswordStrengthPolicy(passwordComplexityFromSettings(settings)));
    this.assertEmailDomainAllowed(email, settings.emailDomainMode ?? 'none', settings.emailDomainList ?? []);

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      this.audit('REGISTER_FAILURE', { emailHash, reason: 'duplicate_email' });
      throw new BadRequestException('注册信息无效');
    }
    const passwordHash = await bcrypt.hash(dto.password, 10);
    let user: { id: string; email: string; role: string; sessionVersion?: number } | null = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const uid = await generateUniqueUserUid(this.prisma.user);
      const nickname = dto.nickname ? normalizeNickname(dto.nickname) : defaultUserNickname(uid);
      try {
        user = await this.prisma.$transaction(async (tx) => {
          if (settings.emailVerificationEnabled === true) {
            if (!this.verificationService || !dto.verificationCode) throw new BadRequestException('请输入邮箱验证码');
            try {
              await this.verificationService.verifyCode(email, 'REGISTER', dto.verificationCode, tx);
            } catch {
              throw new BadRequestException('注册信息无效');
            }
          } else if ((settings.captchaMode ?? 'OFF') !== 'OFF') {
            if (!this.captchaService) throw new BadRequestException('人机验证服务不可用');
            await this.captchaService.verifyCaptcha({
              captchaToken: dto.captchaToken,
              captchaAnswer: dto.captchaAnswer,
              turnstileToken: dto.turnstileToken,
              remoteIp,
              action: 'REGISTER'
            }, tx);
          }
          const created = await tx.user.create({
            data: {
              uid,
              nickname,
              email,
              emailVerifiedAt: settings.emailVerificationEnabled ? new Date() : null,
              passwordHash,
              role: 'USER',
              trafficLimitBytes: BigInt(0),
              expireAt: null
            }
          });
          if (settings.defaultBalance > 0 && this.walletService) {
            await this.walletService.applyBalanceChange(tx, created.id, settings.defaultBalance, 'SYSTEM_GIFT', '新用户注册赠金');
          }
          if (settings.defaultPlanId && this.subscriptionService) {
            try {
              await this.subscriptionService.subscribe(created.id, settings.defaultPlanId, tx, {
                source: 'REGISTRATION',
                skipIfClaimUnavailable: true
              });
            } catch (error) {
              if (!(error instanceof NotFoundException)) throw error;
            }
          }
          return created;
        });
        break;
      } catch (error) {
        if (isUniqueConstraintError(error, 'email')) {
          this.audit('REGISTER_FAILURE', { emailHash, reason: 'duplicate_email' });
          throw new BadRequestException('注册信息无效');
        }
        if (!isUidUniqueConstraintError(error) || attempt === 7) throw error;
      }
    }
    if (!user) throw new BadRequestException('无法分配唯一用户 UID，请稍后重试');
    // 用户变动需向在线节点同步（协议约定见 docs/API_AND_PROTOCOLS.md §2.2）
    void this.agentGateway.pushConfigToAll();
    this.audit('REGISTER_SUCCESS', { emailHash }, user.id);
    return { accessToken: await this.signToken(user) };
  }

  async resetPassword(dto: ResetPasswordDto, remoteIp = 'unknown', deviceKey = 'unknown') {
    const email = normalizeEmail(dto.email);
    assertEmailLength(email);
    const emailHash = this.authAuditService?.emailHash(email);
    this.assertRateLimit(`reset:ip:${remoteIp}`, 5, 60 * 60_000, 'PASSWORD_RESET_FAILURE', { emailHash, remoteIp });
    this.assertRateLimit(`reset:email:${email}`, 5, 60 * 60_000, 'PASSWORD_RESET_FAILURE', { emailHash });
    this.assertRateLimit(`reset:device:${deviceKey || 'unknown'}`, 10, 60 * 60_000, 'PASSWORD_RESET_FAILURE', { emailHash });
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      this.audit('PASSWORD_RESET_FAILURE', { emailHash, reason: 'invalid_request' });
      throw new BadRequestException('重置请求无效');
    }
    const settings = await this.settingsService.getSettings();
    assertPasswordPolicy(dto.newPassword, settings.passwordMinLength ?? 8, buildPasswordStrengthPolicy(passwordComplexityFromSettings(settings)));

    if (!this.verificationService) throw new BadRequestException('邮箱验证服务不可用');

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.$transaction(async (tx) => {
      try {
        await this.verificationService!.verifyCode(email, 'RESET_PASSWORD', dto.code, tx);
      } catch {
        throw new BadRequestException('重置请求无效');
      }
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          sessionVersion: { increment: 1 },
          emailVerifiedAt: user.emailVerifiedAt ?? new Date()
        }
      });
    });

    void this.agentGateway.pushConfigToAll();
    this.audit('PASSWORD_RESET_SUCCESS', { emailHash }, user.id);
    return { success: true, message: '密码重置成功' };
  }

  async logout(userId: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
    this.audit('LOGOUT', {}, userId);
    this.audit('SESSION_INVALIDATED', { reason: 'logout' }, userId);
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
         id: true,
         uid: true,
         nickname: true,
         email: true,
         emailVerifiedAt: true,
         subscriptionEmailNotificationsEnabled: true,
        role: true,
        balance: true,
        uuid: true,
        trafficLimitBytes: true,
        trafficUsedBytes: true,
        expireAt: true,
        subscriptionToken: true,
        isActive: true,
        createdAt: true
      }
    });
    if (!user) {
      throw new UnauthorizedException();
    }
    // BigInt 无法 JSON 序列化，在服务边界转 Number（流量值 < 2^53，无精度损失）
    return {
      ...user,
      nickname: user.nickname ?? defaultUserNickname(user.uid),
      emailVerifiedAt: user.emailVerifiedAt ? user.emailVerifiedAt.toISOString() : null,
      balance: user.balance,
      uuid: user.uuid,
      trafficLimitBytes: Number(user.trafficLimitBytes),
      trafficUsedBytes: Number(user.trafficUsedBytes)
    };
  }

  private async signToken(user: { id: string; email: string; role: string; sessionVersion?: number }) {
    const settings = await this.settingsService.getSettings();
    const days = Number.isInteger(settings?.jwtSessionDays) && settings.jwtSessionDays > 0
      ? settings.jwtSessionDays
      : 1;
    return this.jwtService.sign(
       { sub: user.id, email: user.email, role: user.role, sessionVersion: (user as { sessionVersion?: number }).sessionVersion ?? 0 },
      { expiresIn: `${days}d` }
    );
  }

  private assertRateLimit(key: string, limit: number, windowMs: number, event?: AuthAuditEvent, metadata?: Record<string, unknown>): void {
    if (this.rateLimitService && !this.rateLimitService.consume(key, limit, windowMs)) {
      if (event) this.audit(event, metadata);
      throw new HttpException('请求过于频繁，请稍后再试', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private audit(event: AuthAuditEvent, metadata: Record<string, unknown> = {}, userId?: string | null): void {
    this.authAuditService?.record(event, metadata, userId);
  }

  private assertEmailDomainAllowed(email: string, mode: 'none' | 'whitelist' | 'blacklist', domains: string[]) {
    if (mode === 'none') return;
    const domain = email.trim().toLowerCase().split('@').pop() ?? '';
    const normalized = new Set(domains.map((item) => item.trim().toLowerCase().replace(/^@+/, '')).filter(Boolean));
    const matched = normalized.has(domain);
    if (mode === 'whitelist' && !matched) throw new ForbiddenException('该邮箱域名不在允许注册范围内');
    if (mode === 'blacklist' && matched) throw new ForbiddenException('该邮箱域名已被禁止注册');
  }
}
