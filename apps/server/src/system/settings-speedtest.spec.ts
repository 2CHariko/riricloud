import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SettingsService, DEFAULTS } from './settings.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import type { PrismaService } from '../prisma/prisma.service';

const userId = '12345678-1234-4234-8234-123456789abc';
function setup() {
  const values = new Map<string, string>();
  const subscription = { id: 'sub', status: 'ACTIVE', expireAt: null as Date | null, trafficLimitBytes: 1000n, trafficUsedBytes: 0n,
    user: { isActive: true, role: 'USER', emailVerifiedAt: new Date(1) as Date | null }, plan: { lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]' } };
  const prisma = {
    systemSetting: { findMany: jest.fn(async () => [...values].map(([key, value]) => ({ key, value }))),
      upsert: jest.fn(async (args: { where: { key: string }; update: { value: string } }) => { values.set(args.where.key, args.update.value); }),
      deleteMany: jest.fn(async (args: { where: { key: { in: string[] } } }) => { for (const key of args.where.key.in) values.delete(key); }) },
    subscription: { findUnique: jest.fn().mockImplementation(async () => subscription) }, $transaction: jest.fn()
  };
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
  return { service: new SettingsService(prisma as unknown as PrismaService), prisma, values, subscription };
}
describe('拨测账号设置', () => {
  it('默认未配置，只在管理端返回；清空与重置恢复为 null', async () => {
    const f = setup(); expect(DEFAULTS.lineSpeedtestUserId).toBeNull();
    expect((await f.service.getAdminSettings()).lineSpeedtestUserId).toBeNull();
    expect((await f.service.updateSettings({ lineSpeedtestUserId: userId })).lineSpeedtestUserId).toBe(userId);
    expect(await f.service.getPublicSettings()).not.toHaveProperty('lineSpeedtestUserId');
    expect((await f.service.updateSettings({ lineSpeedtestUserId: null })).lineSpeedtestUserId).toBeNull();
    await f.service.updateSettings({ lineSpeedtestUserId: userId });
    expect((await f.service.resetToDefaults(['lineSpeedtestUserId'])).lineSpeedtestUserId).toBeNull();
  });
  it.each(['missing', 'inactive', 'expired', 'quota', 'revoked', 'email'] as const)('保存拒绝 %s 账号', async (failure) => {
    const f = setup(); f.values.set('enforceEmailVerification', 'true');
    if (failure === 'missing') f.prisma.subscription.findUnique.mockResolvedValueOnce(null);
    if (failure === 'inactive') f.subscription.user.isActive = false;
    if (failure === 'expired') f.subscription.expireAt = new Date(1);
    if (failure === 'quota') f.subscription.trafficUsedBytes = 1000n;
    if (failure === 'revoked') f.subscription.status = 'REVOKED';
    if (failure === 'email') f.subscription.user.emailVerifiedAt = null;
    await expect(f.service.updateSettings({ lineSpeedtestUserId: userId })).rejects.toThrow('请选择');
    expect(f.prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });
  it('使用同次提交的邮箱验证设置判定，未到期取消订阅仍可用', async () => {
    const f = setup(); f.subscription.user.emailVerifiedAt = null;
    await expect(f.service.updateSettings({ lineSpeedtestUserId: userId, enforceEmailVerification: true })).rejects.toThrow();
    f.subscription.status = 'CANCELED';
    await expect(f.service.updateSettings({ lineSpeedtestUserId: userId, enforceEmailVerification: false })).resolves.toHaveProperty('lineSpeedtestUserId', userId);
  });
  it('DTO 只接受 UUID 或 null，不接受空串及其他类型', async () => {
    for (const value of [userId, null, undefined]) expect(await validate(plainToInstance(UpdateSettingsDto, { lineSpeedtestUserId: value }))).toHaveLength(0);
    for (const value of ['', 'not-a-uuid', 3, true, []]) expect((await validate(plainToInstance(UpdateSettingsDto, { lineSpeedtestUserId: value }))).length).toBeGreaterThan(0);
  });
});
