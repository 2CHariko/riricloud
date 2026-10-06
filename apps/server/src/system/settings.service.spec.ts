import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { encryptSecret } from '../common/secret-crypto';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { DEFAULTS, SETTING_KEYS, SettingsService } from './settings.service';
import * as nodemailer from 'nodemailer';
jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

describe('SettingsService', () => {
  let service: SettingsService;
  type PrismaMock = {
    systemSetting: Record<string, jest.Mock>;
    subscriptionTemplate: Record<string, jest.Mock>;
    plan: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  const prisma: PrismaMock = {
    systemSetting: { findMany: jest.fn(), findUnique: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
    subscriptionTemplate: { updateMany: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    plan: { findUnique: jest.fn() },
    $transaction: jest.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma))
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [SettingsService, { provide: PrismaService, useValue: prisma }]
    }).compile();
    service = moduleRef.get(SettingsService);
  });

  afterEach(() => jest.clearAllMocks());

  it('空表时返回全量安全默认值', async () => {
    prisma.systemSetting.findMany.mockResolvedValue([]);
    await expect(service.getSettings()).resolves.toEqual(DEFAULTS);
  });
  it('证书提醒默认关闭，阈值与邮箱受 DTO 校验，启用需 SMTP 可用', async () => {
    expect(DEFAULTS.certificateExpiryWarningDays).toBe(30);
    expect(DEFAULTS.certificateMailEnabled).toBe(false);
    expect(DEFAULTS.certificateMailRecipients).toEqual([]);
    for (const patch of [{ certificateExpiryWarningDays: 0 }, { certificateExpiryWarningDays: 91 }, { certificateMailRecipients: ['invalid'] }]) expect((await validate(plainToInstance(UpdateSettingsDto, patch))).length).toBeGreaterThan(0);
    expect(await validate(plainToInstance(UpdateSettingsDto, { certificateExpiryWarningDays: 90, certificateMailRecipients: ['admin@example.com'] }))).toHaveLength(0);
    prisma.systemSetting.findMany.mockResolvedValue([]);
    await expect(service.updateSettings({ certificateMailEnabled: true })).rejects.toThrow('SMTP');
    const transporter = { verify: jest.fn().mockRejectedValue(new Error('failure')), close: jest.fn() };
    jest.mocked(nodemailer.createTransport).mockReturnValue(transporter as unknown as nodemailer.Transporter);
    const patch = { certificateMailEnabled: true, certificateMailRecipients: ['admin@example.com'], smtpEnabled: true, smtpHost: 'smtp.example.com', smtpFrom: 'admin@example.com' };
    await expect(service.updateSettings(patch)).rejects.toThrow('SMTP');
    expect(transporter.close).toHaveBeenCalled();
    transporter.verify.mockResolvedValue(undefined as never);
    await expect(service.updateSettings(patch)).resolves.toBeDefined();
    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { key: 'certificateMailEnabled' } }));
  });

  it('普通延迟默认十秒但不覆盖已有显式超时', async () => {
    expect(DEFAULTS.lineSpeedtestTargetUrl).toBe('https://cp.cloudflare.com/generate_204');
    expect(DEFAULTS.lineSpeedtestTimeoutMs).toBe(10000);
    prisma.systemSetting.findMany.mockResolvedValue([{ key: SETTING_KEYS.LINE_SPEEDTEST_TIMEOUT_MS, value: '3000' }]);
    expect((await service.getSettings()).lineSpeedtestTimeoutMs).toBe(3000);
  });

  it('默认启用能力限定回退，管理员可明确关闭', async () => {
    prisma.systemSetting.findMany.mockResolvedValue([{ key: SETTING_KEYS.PROBE_SINGBOX_FALLBACK_ENABLED, value: 'false' }]);
    expect((await service.getSettings()).probeSingboxFallbackEnabled).toBe(false);
    expect(DEFAULTS.probeSingboxFallbackEnabled).toBe(true);
    const dto = plainToInstance(UpdateSettingsDto, { probeSingboxFallbackEnabled: false });
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
  });

  it('支持数字、布尔、数组、时区与无效值回退', async () => {
    prisma.systemSetting.findMany.mockResolvedValue([
      { key: SETTING_KEYS.SITE_NAME, value: ' 我的面板 ' },
      { key: SETTING_KEYS.REGISTRATION_ENABLED, value: 'true' },
      { key: SETTING_KEYS.SUBSCRIPTION_SHORT_LINKS_ENABLED, value: '1' },
      { key: SETTING_KEYS.SUBSCRIPTION_EFFECTS_SYNC_ENABLED, value: 'false' },
      { key: SETTING_KEYS.DEFAULT_BALANCE, value: '2500' },
      { key: SETTING_KEYS.EMAIL_DOMAIN_MODE, value: 'whitelist' },
      { key: SETTING_KEYS.EMAIL_DOMAIN_LIST, value: JSON.stringify(['@Example.COM', 'company.org']) },
      { key: SETTING_KEYS.PROBE_PRESET_TARGETS, value: JSON.stringify([{ type: 'tcp', target: 'example.com', port: 443 }]) },
      { key: SETTING_KEYS.CONFIG_SYNC_DEBOUNCE_MS, value: '-1' },
      { key: SETTING_KEYS.SYSTEM_TIMEZONE, value: 'America/New_York' },
      { key: SETTING_KEYS.LOGS_MIN_INGEST_LEVEL, value: 'WARN' }
    ]);
    const settings = await service.getSettings();
    expect(settings.siteName).toBe('我的面板');
    expect(settings.registrationEnabled).toBe(true);
    expect(settings.subscriptionShortLinksEnabled).toBe(true);
    expect(settings.subscriptionEffectsSyncEnabled).toBe(false);
    expect(settings.defaultBalance).toBe(2500);
    expect(settings.emailDomainList).toEqual(['example.com', 'company.org']);
    expect(settings.probePresetTargets).toEqual([{ type: 'tcp', target: 'example.com', port: 443 }]);
    expect(settings.configSyncDebounceMs).toBe(DEFAULTS.configSyncDebounceMs);
    expect(settings.systemTimezone).toBe('America/New_York');
    expect(settings.logsMinIngestLevel).toBe('WARN');
    expect(settings.trafficHourlyRetentionDays).toBe(DEFAULTS.trafficHourlyRetentionDays);
    expect(settings.nodeRateRetentionDays).toBe(DEFAULTS.nodeRateRetentionDays);
    expect(settings.agentLogMaxSizeMb).toBe(DEFAULTS.agentLogMaxSizeMb);
    expect(settings.agentLogMaxFiles).toBe(DEFAULTS.agentLogMaxFiles);
  });

  it('无效时区自动回退为默认时区', async () => {
    prisma.systemSetting.findMany.mockResolvedValue([
      { key: SETTING_KEYS.SYSTEM_TIMEZONE, value: 'Invalid/Timezone_Name' }
    ]);
    const settings = await service.getSettings();
    expect(settings.systemTimezone).toBe('Asia/Shanghai');
  });

  it('部分更新对每个传入键执行事务 upsert 并返回全量', async () => {
    prisma.systemSetting.upsert.mockResolvedValue({});
    prisma.systemSetting.findMany.mockResolvedValue([
      { key: SETTING_KEYS.SITE_NAME, value: '新站名' },
      { key: SETTING_KEYS.REGISTRATION_ENABLED, value: 'false' },
      { key: SETTING_KEYS.SYSTEM_TIMEZONE, value: 'UTC' }
    ]);
    const result = await service.updateSettings({ siteName: '新站名', systemTimezone: 'UTC' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith({
      where: { key: SETTING_KEYS.SITE_NAME },
      update: { value: '新站名' },
      create: { key: SETTING_KEYS.SITE_NAME, value: '新站名', description: '站点名称' }
    });
    expect(result.systemTimezone).toBe('UTC');
  });

  it('通过 plainToInstance 转换的 UpdateSettingsDto 局部更新不会把未传字段覆写为 "undefined"', async () => {
    prisma.systemSetting.upsert.mockResolvedValue({});
    prisma.systemSetting.findMany.mockResolvedValue([
      { key: SETTING_KEYS.GITHUB_MIRROR_URLS, value: JSON.stringify(['https://ghfast.top/']) }
    ]);

    const dto = plainToInstance(UpdateSettingsDto, {
      githubMirrorUrls: ['https://ghfast.top/']
    });
    const result = await service.updateSettings(dto);

    expect(prisma.systemSetting.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith({
      where: { key: SETTING_KEYS.GITHUB_MIRROR_URLS },
      update: { value: JSON.stringify(['https://ghfast.top/']) },
      create: {
        key: SETTING_KEYS.GITHUB_MIRROR_URLS,
        value: JSON.stringify(['https://ghfast.top/']),
        description: 'GitHub 加速镜像列表（前缀代理，节点安装时自动测速择优）'
      }
    });
    expect(result.binaryDownloadBaseUrl).toBe('');
    expect(result.lineSpeedtestTargetUrl).toBe('https://cp.cloudflare.com/generate_204');
  });

  it('自动忽略并清理库中脏写入的 "undefined" 记录（含加密密钥）', async () => {
    prisma.systemSetting.deleteMany.mockResolvedValue({ count: 3 });
    prisma.systemSetting.findMany.mockResolvedValue([
      { key: SETTING_KEYS.BINARY_DOWNLOAD_BASE_URL, value: 'undefined' },
      { key: SETTING_KEYS.LINE_SPEEDTEST_TARGET_URL, value: 'undefined' },
      { key: SETTING_KEYS.SMTP_PASS, value: encryptSecret('undefined') }
    ]);

    const settings = await service.getSettings();
    expect(settings.binaryDownloadBaseUrl).toBe('');
    expect(settings.lineSpeedtestTargetUrl).toBe('https://cp.cloudflare.com/generate_204');
    expect(settings.smtpPass).toBe('');
    expect(prisma.systemSetting.deleteMany).toHaveBeenCalledWith({
      where: {
        key: {
          in: [
            SETTING_KEYS.BINARY_DOWNLOAD_BASE_URL,
            SETTING_KEYS.LINE_SPEEDTEST_TARGET_URL,
            SETTING_KEYS.SMTP_PASS
          ]
        }
      }
    });
  });

  it('defaultPlanId 指向已删除或非公开套餐时自动回退为 null 并清理失效记录', async () => {
    prisma.systemSetting.deleteMany.mockResolvedValue({ count: 1 });
    prisma.systemSetting.findMany.mockResolvedValue([
      { key: SETTING_KEYS.DEFAULT_PLAN_ID, value: 'hidden-plan-id' }
    ]);
    prisma.plan.findUnique.mockResolvedValue({ id: 'hidden-plan-id', isPublic: false });

    const settings = await service.getSettings();
    expect(settings.defaultPlanId).toBeNull();
    expect(prisma.systemSetting.deleteMany).toHaveBeenCalledWith({
      where: { key: SETTING_KEYS.DEFAULT_PLAN_ID, value: 'hidden-plan-id' }
    });
  });

  it('UpdateSettingsDto 支持清空 lineSpeedtestTargetUrl 以及 localhost / 内网 URL', async () => {
    const dto = plainToInstance(UpdateSettingsDto, {
      publicBaseUrl: 'http://localhost:3000',
      binaryDownloadBaseUrl: 'http://192.168.1.10:8080/releases',
      lineSpeedtestTargetUrl: ''
    });
    const errors = await validate(dto, { whitelist: true });
    expect(errors).toHaveLength(0);
  });

  it('更新非法时区抛出 BadRequestException', async () => {
    await expect(service.updateSettings({ systemTimezone: 'Not/A_Real_Timezone' })).rejects.toThrow('无效的 IANA 时区标识符');
  });

  it('可保存 Nginx 短订阅链接开关', async () => {
    prisma.systemSetting.upsert.mockResolvedValue({});
    prisma.systemSetting.findMany.mockResolvedValue([]);
    await service.updateSettings({ subscriptionShortLinksEnabled: true });
    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith({
      where: { key: SETTING_KEYS.SUBSCRIPTION_SHORT_LINKS_ENABLED },
      update: { value: 'true' },
      create: {
        key: SETTING_KEYS.SUBSCRIPTION_SHORT_LINKS_ENABLED,
        value: 'true',
        description: '是否使用 Nginx 伪静态短订阅链接'
      }
    });
  });

  it('切换全局默认模板时同步模板默认标记', async () => {
    prisma.subscriptionTemplate.findUnique.mockResolvedValue({ id: 'template-1' });
    prisma.systemSetting.upsert.mockResolvedValue({});
    prisma.systemSetting.findMany.mockResolvedValue([]);
    await service.updateSettings({ defaultTemplateId: 'template-1' });
    expect(prisma.subscriptionTemplate.updateMany).toHaveBeenCalledWith({ data: { isDefault: false } });
    expect(prisma.subscriptionTemplate.update).toHaveBeenCalledWith({ where: { id: 'template-1' }, data: { isDefault: true } });
  });

  it('读取全站访问 URL 设置', async () => {
    prisma.systemSetting.findMany.mockResolvedValue([
      { key: SETTING_KEYS.PUBLIC_BASE_URL, value: ' https://panel.example.com/ ' }
    ]);
    await expect(service.getSettings()).resolves.toEqual(expect.objectContaining({
      publicBaseUrl: 'https://panel.example.com/'
    }));
  });

  it('公开设置包含时区与全站基准URL并严格过滤内部运维参数', async () => {
    prisma.systemSetting.findMany.mockResolvedValue([
      { key: SETTING_KEYS.SITE_NAME, value: '公开站点' },
      { key: SETTING_KEYS.PUBLIC_BASE_URL, value: 'https://panel.example.com' },
      { key: SETTING_KEYS.SYSTEM_TIMEZONE, value: 'Asia/Tokyo' },
      { key: SETTING_KEYS.JWT_SESSION_DAYS, value: '30' },
      { key: SETTING_KEYS.BINARY_DOWNLOAD_BASE_URL, value: 'https://internal.example.com' },
      { key: SETTING_KEYS.SUBSCRIPTION_SHORT_LINKS_ENABLED, value: 'true' },
      { key: SETTING_KEYS.CUSTOM_CSS, value: 'body {}' }
    ]);
    await expect(service.getPublicSettings()).resolves.toEqual(expect.objectContaining({
      siteName: '公开站点',
      publicBaseUrl: 'https://panel.example.com',
      systemTimezone: 'Asia/Tokyo',
      subscriptionShortLinksEnabled: true,
      customCss: 'body {}'
    }));
    const result = await service.getPublicSettings();
    expect(result).not.toHaveProperty('jwtSessionDays');
    expect(result).not.toHaveProperty('binaryDownloadBaseUrl');
  });

  it('管理端读取时同时脱敏 SMTP 密码与 Turnstile Secret，并支持占位值保留原密钥', async () => {
    prisma.systemSetting.findMany.mockResolvedValue([
      { key: SETTING_KEYS.SMTP_PASS, value: 'smtp-secret' },
      { key: SETTING_KEYS.TURNSTILE_SECRET_KEY, value: 'turnstile-secret' }
    ]);
    await expect(service.getAdminSettings()).resolves.toEqual(expect.objectContaining({
      smtpPass: '********',
      turnstileSecretKey: '********'
    }));

    prisma.systemSetting.upsert.mockResolvedValue({});
    prisma.systemSetting.findMany.mockResolvedValue([]);
    await service.updateSettings({ smtpPass: '********', turnstileSecretKey: '********' });
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it('重置普通设置时也不会在管理端响应中泄露内部密钥', async () => {
    prisma.systemSetting.findMany.mockResolvedValue([
      { key: SETTING_KEYS.SMTP_PASS, value: 'smtp-secret' },
      { key: SETTING_KEYS.TURNSTILE_SECRET_KEY, value: 'turnstile-secret' }
    ]);
    prisma.systemSetting.deleteMany.mockResolvedValue({ count: 1 });
    await expect(service.resetToDefaults(['siteName'])).resolves.toEqual(expect.objectContaining({
      smtpPass: '********',
      turnstileSecretKey: '********'
    }));
  });

  it('重置指定键时删除覆盖值并返回默认值', async () => {
    prisma.systemSetting.deleteMany.mockResolvedValue({ count: 3 });
    prisma.systemSetting.findMany.mockResolvedValue([]);
    const result = await service.resetToDefaults(['siteName', 'registrationEnabled', 'subscriptionShortLinksEnabled']);
    expect(prisma.systemSetting.deleteMany).toHaveBeenCalledWith({ where: { key: { in: ['siteName', 'registrationEnabled', 'subscriptionShortLinksEnabled'] } } });
    expect(result).toEqual(DEFAULTS);
  });

  it('正确解析速率换算开关与阶梯色彩配置', async () => {
    prisma.systemSetting.findMany.mockResolvedValue([
      { key: SETTING_KEYS.SPEED_LIMIT_UNIT_CONVERSION_ENABLED, value: 'false' },
      { key: SETTING_KEYS.SPEED_LIMIT_COLOR_TIERS, value: JSON.stringify([{ maxMbps: 500, color: 'cyan' }, { maxMbps: null, color: 'rose' }]) }
    ]);
    const settings = await service.getSettings();
    expect(settings.speedLimitUnitConversionEnabled).toBe(false);
    expect(settings.speedLimitColorTiers).toEqual([
      { maxMbps: 500, color: 'cyan' },
      { maxMbps: null, color: 'rose' }
    ]);

    const publicSettings = await service.getPublicSettings();
    expect(publicSettings.speedLimitUnitConversionEnabled).toBe(false);
    expect(publicSettings.speedLimitColorTiers).toEqual([
      { maxMbps: 500, color: 'cyan' },
      { maxMbps: null, color: 'rose' }
    ]);
  });

  it('正确读取与更新首页配置字段', async () => {
    prisma.systemSetting.findMany.mockResolvedValue([
      { key: SETTING_KEYS.LANDING_ENABLED, value: 'true' },
      { key: SETTING_KEYS.LANDING_HERO_TITLE, value: '自定义首屏标题' },
      { key: SETTING_KEYS.LANDING_HERO_SUBTITLE, value: '极速互联节点' },
      { key: SETTING_KEYS.LANDING_SHOW_FEATURES, value: 'false' },
      { key: SETTING_KEYS.LANDING_CUSTOM_FEATURES_JSON, value: JSON.stringify([{ id: 'f1', title: '特快' }]) }
    ]);
    const settings = await service.getSettings();
    expect(settings.landingEnabled).toBe(true);
    expect(settings.landingHeroTitle).toBe('自定义首屏标题');
    expect(settings.landingHeroSubtitle).toBe('极速互联节点');
    expect(settings.landingShowFeatures).toBe(false);
    expect(settings.landingShowPlans).toBe(true);
    expect(settings.landingCustomFeaturesJson).toBe(JSON.stringify([{ id: 'f1', title: '特快' }]));

    const publicSettings = await service.getPublicSettings();
    expect(publicSettings.landingEnabled).toBe(true);
    expect(publicSettings.landingHeroTitle).toBe('自定义首屏标题');
    expect(publicSettings.landingCustomFeaturesJson).toBe(JSON.stringify([{ id: 'f1', title: '特快' }]));

    prisma.systemSetting.upsert.mockResolvedValue({});
    prisma.systemSetting.findMany.mockResolvedValue([]);
    await service.updateSettings({
      landingEnabled: false,
      landingHeroTitle: '新主标题',
      landingCustomFeaturesJson: JSON.stringify([{ id: 'f2', title: '新特性' }])
    });
    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: SETTING_KEYS.LANDING_ENABLED },
      update: { value: 'false' }
    }));
    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: SETTING_KEYS.LANDING_CUSTOM_FEATURES_JSON },
      update: { value: JSON.stringify([{ id: 'f2', title: '新特性' }]) }
    }));
  });

  it('正确读取与更新结构化公告列表字段', async () => {
    const sampleAnnouncements = [
      {
        id: 'ann-1',
        title: '系统升级维护通知',
        content: '今晚 **23:00** 进行主干节点扩容升级。',
        type: 'MAINTENANCE',
        isPinned: true,
        showBanner: true,
        popupOnLogin: true,
        enabled: true,
        createdAt: '2026-09-28T00:00:00.000Z',
        updatedAt: '2026-09-28T00:00:00.000Z'
      }
    ];
    prisma.systemSetting.findMany.mockResolvedValue([
      { key: SETTING_KEYS.SITE_ANNOUNCEMENTS_JSON, value: JSON.stringify(sampleAnnouncements) }
    ]);

    const settings = await service.getSettings();
    expect(settings.siteAnnouncementsJson).toBe(JSON.stringify(sampleAnnouncements));

    const publicSettings = await service.getPublicSettings();
    expect(publicSettings.siteAnnouncementsJson).toBe(JSON.stringify(sampleAnnouncements));

    prisma.systemSetting.upsert.mockResolvedValue({});
    prisma.systemSetting.findMany.mockResolvedValue([]);
    await service.updateSettings({
      siteAnnouncementsJson: JSON.stringify(sampleAnnouncements)
    });
    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: SETTING_KEYS.SITE_ANNOUNCEMENTS_JSON },
      update: { value: JSON.stringify(sampleAnnouncements) }
    }));
  });
});


