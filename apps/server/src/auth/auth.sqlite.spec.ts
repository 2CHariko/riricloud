import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { AuthService } from './auth.service';
import { VerificationService } from '../verification/verification.service';
import { hashAuthValue } from '../common/auth-security';

describe('AuthService SQLite security', () => {
  jest.setTimeout(60_000);

  let tempDir: string;
  let prisma: PrismaClient;
  let service: AuthService;
  let ready = false;
  const settings = {
    registrationEnabled: true,
    emailVerificationEnabled: false,
    captchaMode: 'OFF',
    passwordMinLength: 8,
    defaultBalance: 0,
    defaultPlanId: null,
    emailDomainMode: 'none',
    emailDomainList: [],
    jwtSessionDays: 1
  };
  const settingsService = { getSettings: jest.fn().mockResolvedValue(settings) };
  const agentGateway = { pushConfigToAll: jest.fn() };
  const jwtService = { sign: jest.fn().mockReturnValue('test-token') };

  beforeAll(async () => {
    process.env.JWT_SECRET = 'test-secret-for-auth-sqlite-0123456789';
    tempDir = await mkdtemp(join(tmpdir(), 'riricloud-auth-'));
    const databaseUrl = `file:${join(tempDir, 'auth.db').replaceAll('\\', '/')}`;
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$connect();
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "User" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "uid" INTEGER UNIQUE,
        "nickname" TEXT,
        "email" TEXT NOT NULL UNIQUE,
        "emailVerifiedAt" DATETIME,
        "subscriptionEmailNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
        "passwordHash" TEXT NOT NULL,
        "role" TEXT NOT NULL DEFAULT 'USER',
        "balance" INTEGER NOT NULL DEFAULT 0,
        "trafficLimitBytes" BIGINT NOT NULL DEFAULT 107374182400,
        "trafficUsedBytes" BIGINT NOT NULL DEFAULT 0,
        "expireAt" DATETIME,
        "deviceLimit" INTEGER,
        "subscriptionToken" TEXT NOT NULL UNIQUE,
        "uuid" TEXT NOT NULL UNIQUE,
        "password" TEXT,
        "isActive" BOOLEAN NOT NULL DEFAULT 1,
        "sessionVersion" INTEGER NOT NULL DEFAULT 0,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "planPurchaseIdentityId" TEXT
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "VerificationCode" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "email" TEXT NOT NULL,
        "codeHash" TEXT NOT NULL,
        "action" TEXT NOT NULL,
        "attempts" INTEGER NOT NULL DEFAULT 0,
        "expiresAt" DATETIME NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await prisma.$executeRawUnsafe('CREATE INDEX "VerificationCode_email_action_createdAt_idx" ON "VerificationCode"("email", "action", "createdAt")');
    await prisma.$executeRawUnsafe('CREATE INDEX "VerificationCode_expiresAt_idx" ON "VerificationCode"("expiresAt")');

    const verification = new VerificationService(
      prisma as never,
      settingsService as never,
      { sendVerificationCode: jest.fn() } as never,
      { verifyCaptcha: jest.fn() } as never
    );
    service = new AuthService(
      prisma as never,
      jwtService as never,
      settingsService as never,
      agentGateway as never,
      undefined,
      undefined,
      verification,
      undefined,
      undefined
    );
    ready = true;
  });

  afterEach(async () => {
    if (!ready) return;
    await prisma.user.deleteMany();
    await prisma.verificationCode.deleteMany();
    settingsService.getSettings.mockResolvedValue(settings);
    agentGateway.pushConfigToAll.mockClear();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('并发注册同一归一化邮箱最多创建一个用户', async () => {
    const results = await Promise.allSettled([
      service.register({ email: 'Concurrent@Example.com', password: 'Password123!' }),
      service.register({ email: ' concurrent@example.com ', password: 'Password123!' })
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.user.count({ where: { email: 'concurrent@example.com' } })).toBe(1);
  });

  it('注册事务失败时回滚已消费的邮箱验证码和用户创建', async () => {
    settingsService.getSettings.mockResolvedValue({ ...settings, emailVerificationEnabled: true, defaultBalance: 100 });
    const email = 'rollback@example.com';
    await prisma.verificationCode.create({
      data: {
        email,
        action: 'REGISTER',
        codeHash: hashAuthValue('verification-code', '123456'),
        expiresAt: new Date(Date.now() + 60_000)
      }
    });
    const wallet = { applyBalanceChange: jest.fn().mockRejectedValue(new Error('forced wallet failure')) };
    service = new AuthService(
      prisma as never,
      jwtService as never,
      settingsService as never,
      agentGateway as never,
      undefined,
      wallet as never,
      new VerificationService(
        prisma as never,
        settingsService as never,
        { sendVerificationCode: jest.fn() } as never,
        { verifyCaptcha: jest.fn() } as never
      ),
      undefined,
      undefined
    );

    await expect(service.register({ email, password: 'Password123!', verificationCode: '123456' })).rejects.toThrow('forced wallet failure');
    expect(await prisma.user.count({ where: { email } })).toBe(0);
    expect(await prisma.verificationCode.count({ where: { email, action: 'REGISTER' } })).toBe(1);
  });

  it('密码重置事务失败时回滚验证码消费和 sessionVersion', async () => {
    settingsService.getSettings.mockResolvedValue({ ...settings, emailVerificationEnabled: true });
    const email = 'reset@example.com';
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: 'old-hash',
        subscriptionToken: 'subscription-reset',
        uuid: '00000000-0000-4000-8000-000000000011'
      }
    });
    await prisma.verificationCode.create({
      data: {
        email,
        action: 'RESET_PASSWORD',
        codeHash: hashAuthValue('verification-code', '654321'),
        expiresAt: new Date(Date.now() + 60_000)
      }
    });
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "fail_password_reset" BEFORE UPDATE OF "passwordHash" ON "User"
      WHEN NEW."passwordHash" <> OLD."passwordHash"
      BEGIN SELECT RAISE(ABORT, 'forced password update failure'); END;
    `);

    await expect(service.resetPassword({ email, code: '654321', newPassword: 'New-password-123!' })).rejects.toThrow('重置请求无效');
    const unchanged = await prisma.user.findUnique({ where: { id: user.id } });
    expect(unchanged?.sessionVersion).toBe(0);
    expect(await prisma.verificationCode.count({ where: { email, action: 'RESET_PASSWORD' } })).toBe(1);
    await prisma.$executeRawUnsafe('DROP TRIGGER "fail_password_reset"');
  });
});
