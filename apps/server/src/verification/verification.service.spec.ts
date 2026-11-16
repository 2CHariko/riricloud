import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../system/settings.service';
import { MailService } from '../mail/mail.service';
import { CaptchaService } from '../captcha/captcha.service';
import { hashAuthValue } from '../common/auth-security';
import { VerificationService } from './verification.service';

describe('VerificationService', () => {
  let service: VerificationService;
  const prisma = {
    user: { findUnique: jest.fn() },
    verificationCode: { findFirst: jest.fn(), create: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() }
  };
  const settingsService = { getSettings: jest.fn() };
  const mailService = { sendVerificationCode: jest.fn() };
  const captchaService = { verifyCaptcha: jest.fn() };

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret-for-verification-hashing-0123456789';
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        VerificationService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettingsService, useValue: settingsService },
        { provide: MailService, useValue: mailService },
        { provide: CaptchaService, useValue: captchaService }
      ]
    }).compile();
    service = moduleRef.get(VerificationService);
  });

  beforeEach(() => {
    settingsService.getSettings.mockResolvedValue({ emailVerificationEnabled: true, captchaMode: 'OFF' });
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.verificationCode.findFirst.mockResolvedValue(null);
    prisma.verificationCode.deleteMany.mockResolvedValue({ count: 0 });
    prisma.verificationCode.updateMany.mockResolvedValue({ count: 1 });
    prisma.verificationCode.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'code-1', ...data }));
    mailService.sendVerificationCode.mockResolvedValue({ messageId: 'mail-1' });
    jest.clearAllMocks();
    settingsService.getSettings.mockResolvedValue({ emailVerificationEnabled: true, captchaMode: 'OFF' });
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.verificationCode.findFirst.mockResolvedValue(null);
    prisma.verificationCode.deleteMany.mockResolvedValue({ count: 0 });
    prisma.verificationCode.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'code-1', ...data }));
    mailService.sendVerificationCode.mockResolvedValue({ messageId: 'mail-1' });
  });

  it('生成六位验证码并设置五分钟有效期', async () => {
    const before = Date.now();
    const result = await service.sendCode({ email: 'User@Example.com', action: 'REGISTER' });
    const data = prisma.verificationCode.create.mock.calls[0][0].data as { codeHash: string; expiresAt: Date };
    expect(data.codeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 4 * 60 * 1000);
    expect(data.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);
    expect(result).toMatchObject({ sent: true, cooldownSeconds: 60 });
    const sentCode = mailService.sendVerificationCode.mock.calls[0][1] as string;
    expect(sentCode).toMatch(/^\d{6}$/);
    expect(data.codeHash).toBe(hashAuthValue('verification-code', sentCode));
    expect(mailService.sendVerificationCode).toHaveBeenCalledWith('user@example.com', sentCode, 'REGISTER', undefined);
  });

  it('已登录用户验证邮箱时传递用户关联且不额外查询', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'user@example.com' });
    await service.sendCode({ email: 'User@Example.com', action: 'VERIFY_CURRENT_EMAIL' }, 'user-1');
    expect(mailService.sendVerificationCode).toHaveBeenCalledWith(
      'user@example.com', expect.stringMatching(/^\d{6}$/), 'VERIFY_CURRENT_EMAIL', { userId: 'user-1' }
    );
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it('同邮箱同一行为六十秒内拒绝重复发送', async () => {
    prisma.verificationCode.findFirst.mockResolvedValue({ id: 'recent', createdAt: new Date(), expiresAt: new Date(Date.now() + 1000) });
    await expect(service.sendCode({ email: 'user@example.com', action: 'REGISTER' })).rejects.toBeInstanceOf(HttpException);
    await expect(service.sendCode({ email: 'user@example.com', action: 'REGISTER' })).rejects.toThrow('60 秒');
  });

  it('注册和重置验证码先校验 CAPTCHA，再查询邮箱，避免枚举', async () => {
    settingsService.getSettings.mockResolvedValue({ emailVerificationEnabled: true, captchaMode: 'LOCAL' });
    captchaService.verifyCaptcha.mockRejectedValue(new HttpException('captcha failed', 400));
    prisma.user.findUnique.mockResolvedValue({ id: 'existing-user' });

    await expect(service.sendCode({ email: 'existing@example.com', action: 'REGISTER', captchaToken: 'token', captchaAnswer: '3' }, undefined, '127.0.0.1'))
      .rejects.toThrow('captcha failed');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();

    prisma.user.findUnique.mockClear();
    captchaService.verifyCaptcha.mockResolvedValue(undefined);
    await service.sendCode({ email: 'missing@example.com', action: 'RESET_PASSWORD', captchaToken: 'token', captchaAnswer: '3' }, undefined, '127.0.0.1');
    expect(captchaService.verifyCaptcha).toHaveBeenCalledWith(expect.objectContaining({ action: 'RESET_PASSWORD', remoteIp: '127.0.0.1' }));
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'missing@example.com' }, select: { id: true } });
  });

  it('第五次错误验证码触发熔断，过期验证码拒绝', async () => {
    prisma.verificationCode.findFirst
      .mockResolvedValueOnce({ id: 'code-1', codeHash: hashAuthValue('verification-code', '123456'), attempts: 4, expiresAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ id: 'code-1', attempts: 5 });
    prisma.verificationCode.updateMany.mockResolvedValue({ count: 1 });
    await expect(service.verifyCode('user@example.com', 'REGISTER', '000000')).rejects.toThrow('错误次数过多');
    expect(prisma.verificationCode.updateMany).toHaveBeenCalledWith({ where: { id: 'code-1', attempts: { lt: 5 } }, data: { attempts: { increment: 1 } } });

    prisma.verificationCode.findFirst.mockResolvedValue({ id: 'expired', codeHash: hashAuthValue('verification-code', '123456'), attempts: 0, expiresAt: new Date(Date.now() - 1000) });
    await expect(service.verifyCode('user@example.com', 'REGISTER', '123456')).rejects.toThrow('已过期');
  });
});
