
import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret, encryptSecret } from '../common/secret-crypto';
import { DEFAULT_SPEED_TIERS, type SpeedTier } from '../common/speed-format';

export type EmailDomainMode = 'none' | 'whitelist' | 'blacklist';
export type ProbePresetType = 'tcp' | 'dns' | 'icmp';

export interface ProbePresetTarget {
  type: ProbePresetType;
  target: string;
  port?: number;
  timeoutMs?: number;
}

function resolveDefaultGithubRepoUrl(): string {
  const fromEnv = process.env.RIRICLOUD_DEFAULT_GITHUB_REPO_URL?.trim();
  if (fromEnv) {
    return fromEnv.replace(/^git\+/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  }
  const candidates = [
    resolve(process.cwd(), 'package.json'),
    resolve(process.cwd(), '../../package.json'),
    resolve(__dirname, '../../../../package.json'),
    resolve(__dirname, '../../../package.json')
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as {
        repository?: string | { url?: string };
      };
      const rawUrl =
        typeof parsed.repository === 'string'
          ? parsed.repository
          : typeof parsed.repository?.url === 'string'
            ? parsed.repository.url
            : '';
      if (rawUrl.trim()) {
        return rawUrl.trim().replace(/^git\+/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
      }
    } catch {
      // ignore missing package.json
    }
  }
  return 'https://github.com/Nanako660/riricloud';
}

// 构建/打包时内嵌的默认项目公开 GitHub 仓库地址（可在系统设置中覆盖）
export const DEFAULT_GITHUB_REPO_URL = resolveDefaultGithubRepoUrl();

// SystemSetting 键定义（键名与取值格式见 docs/DATA_MODELS.md §SystemSetting）
// 内置默认 GitHub 加速镜像（前缀代理，可被系统设置覆盖；公共镜像可用性不保证，安装脚本测速后择优）。
export const DEFAULT_GITHUB_MIRRORS = ['https://ghfast.top/', 'https://gh-proxy.com/'] as const;

export const SETTING_KEYS = {
  SITE_NAME: 'siteName',
  SITE_DESCRIPTION: 'siteDescription',
  PUBLIC_BASE_URL: 'publicBaseUrl',
  LOGO_URL: 'logoUrl',
  FAVICON_URL: 'faviconUrl',
  SITE_ANNOUNCEMENT: 'siteAnnouncement',
  SITE_ANNOUNCEMENTS_JSON: 'siteAnnouncementsJson',
  FOOTER_COPYRIGHT: 'footerCopyright',
  SUPPORT_TELEGRAM_URL: 'supportTelegramUrl',
  SUPPORT_DISCORD_URL: 'supportDiscordUrl',
  SUPPORT_EMAIL: 'supportEmail',
  SUPPORT_CUSTOM_URL: 'supportCustomUrl',
  REGISTRATION_ENABLED: 'registrationEnabled',
  DEFAULT_PLAN_ID: 'defaultPlanId',
  DEFAULT_BALANCE: 'defaultBalance',
  EMAIL_DOMAIN_MODE: 'emailDomainMode',
  EMAIL_DOMAIN_LIST: 'emailDomainList',
  PASSWORD_MIN_LENGTH: 'passwordMinLength',
  PASSWORD_REQUIRE_LOWERCASE: 'passwordRequireLowercase',
  PASSWORD_REQUIRE_UPPERCASE: 'passwordRequireUppercase',
  PASSWORD_REQUIRE_DIGIT: 'passwordRequireDigit',
  PASSWORD_REQUIRE_SPECIAL: 'passwordRequireSpecial',
  SUBSCRIPTION_BASE_URL: 'subscriptionBaseUrl',
  SUBSCRIPTION_SHORT_LINKS_ENABLED: 'subscriptionShortLinksEnabled',
  SUBSCRIPTION_EFFECTS_SYNC_ENABLED: 'subscriptionEffectsSyncEnabled',
  SUBSCRIPTION_UPDATE_INTERVAL_HOURS: 'subscriptionUpdateIntervalHours',
  APPEND_SUBSCRIPTION_SPEED_BADGE: 'appendSubscriptionSpeedBadge',
  SPEED_LIMIT_UNIT_CONVERSION_ENABLED: 'speedLimitUnitConversionEnabled',
  SPEED_LIMIT_COLOR_TIERS: 'speedLimitColorTiers',
  DEFAULT_TEMPLATE_ID: 'defaultTemplateId',
  PUBLIC_LINES_ENABLED: 'publicLinesEnabled',
  INCLUDE_USAGE_HEADERS: 'includeUsageHeaders',
  DEVICE_LIMIT_ENABLED: 'deviceLimitEnabled',
  DEVICE_ONLINE_WINDOW_SECS: 'deviceOnlineWindowSecs',
  HEARTBEAT_TIMEOUT_SECS: 'heartbeatTimeoutSecs',
  CONFIG_SYNC_DEBOUNCE_MS: 'configSyncDebounceMs',
  DEFAULT_POLL_INTERVAL_SECS: 'defaultPollIntervalSecs',
  BINARY_DOWNLOAD_BASE_URL: 'binaryDownloadBaseUrl',
  GITHUB_REPO_URL: 'githubRepoUrl',
  GITHUB_MIRROR_URLS: 'githubMirrorUrls',
  PROBE_PRESET_TARGETS: 'probePresetTargets',
  JWT_SESSION_DAYS: 'jwtSessionDays',
  CUSTOM_CSS: 'customCss',
  CUSTOM_HEAD_HTML: 'customHeadHtml',
  LINE_SPEEDTEST_ENABLED: 'lineSpeedtestEnabled',
  LINE_SPEEDTEST_INTERVAL_MINS: 'lineSpeedtestIntervalMins',
  LINE_SPEEDTEST_TARGET_URL: 'lineSpeedtestTargetUrl',
  LINE_SPEEDTEST_TIMEOUT_MS: 'lineSpeedtestTimeoutMs',
  PROBE_SINGBOX_FALLBACK_ENABLED: 'probeSingboxFallbackEnabled',
  SYSTEM_TIMEZONE: 'systemTimezone',
  SMTP_ENABLED: 'smtpEnabled',
  SMTP_HOST: 'smtpHost',
  SMTP_PORT: 'smtpPort',
  SMTP_SECURE: 'smtpSecure',
  SMTP_USER: 'smtpUser',
  SMTP_PASS: 'smtpPass',
  SMTP_FROM: 'smtpFrom',
  EMAIL_VERIFICATION_ENABLED: 'emailVerificationEnabled',
  ENFORCE_EMAIL_VERIFICATION: 'enforceEmailVerification',
  CAPTCHA_MODE: 'captchaMode',
  TURNSTILE_SITE_KEY: 'turnstileSiteKey',
  TURNSTILE_SECRET_KEY: 'turnstileSecretKey',
  LOGS_RETENTION_DAYS: 'logsRetentionDays',
  LOGS_MAX_COUNT: 'logsMaxCount',
  LOGS_MIN_INGEST_LEVEL: 'logsMinIngestLevel',
  TRAFFIC_HOURLY_RETENTION_DAYS: 'trafficHourlyRetentionDays',
  NODE_RATE_RETENTION_DAYS: 'nodeRateRetentionDays',
  AGENT_LOG_MAX_SIZE_MB: 'agentLogMaxSizeMb',
  AGENT_LOG_MAX_FILES: 'agentLogMaxFiles',
  LANDING_ENABLED: 'landingEnabled',
  LANDING_HERO_BADGE: 'landingHeroBadge',
  LANDING_HERO_TITLE: 'landingHeroTitle',
  LANDING_HERO_SUBTITLE: 'landingHeroSubtitle',
  LANDING_SHOW_FEATURES: 'landingShowFeatures',
  LANDING_SHOW_PLANS: 'landingShowPlans',
  LANDING_SHOW_FAQ: 'landingShowFaq',
  LANDING_CUSTOM_FEATURES_JSON: 'landingCustomFeaturesJson',
  LANDING_CUSTOM_FAQ_JSON: 'landingCustomFaqJson'
} as const;

export interface SystemSettings {
  siteName: string;
  siteDescription: string;
  publicBaseUrl: string;
  logoUrl: string;
  faviconUrl: string;
  siteAnnouncement: string;
  siteAnnouncementsJson: string;
  footerCopyright: string;
  supportTelegramUrl: string;
  supportDiscordUrl: string;
  supportEmail: string;
  supportCustomUrl: string;
  registrationEnabled: boolean;
  defaultPlanId: string | null;
  defaultBalance: number;
  emailDomainMode: EmailDomainMode;
  emailDomainList: string[];
  passwordMinLength: number;
  passwordRequireLowercase: boolean;
  passwordRequireUppercase: boolean;
  passwordRequireDigit: boolean;
  passwordRequireSpecial: boolean;
  subscriptionBaseUrl: string;
  subscriptionShortLinksEnabled: boolean;
  subscriptionEffectsSyncEnabled: boolean;
  subscriptionUpdateIntervalHours: number;
  appendSubscriptionSpeedBadge: boolean;
  speedLimitUnitConversionEnabled: boolean;
  speedLimitColorTiers: SpeedTier[];
  defaultTemplateId: string | null;
  publicLinesEnabled: boolean;
  includeUsageHeaders: boolean;
  deviceLimitEnabled: boolean;
  deviceOnlineWindowSecs: number;
  heartbeatTimeoutSecs: number;
  configSyncDebounceMs: number;
  defaultPollIntervalSecs: number;
  binaryDownloadBaseUrl: string;
  githubRepoUrl: string;
  githubMirrorUrls: string[];
  probePresetTargets: ProbePresetTarget[];
  jwtSessionDays: number;
  customCss: string;
  customHeadHtml: string;
  lineSpeedtestEnabled: boolean;
  lineSpeedtestIntervalMins: number;
  lineSpeedtestTargetUrl: string;
  lineSpeedtestTimeoutMs: number;
  probeSingboxFallbackEnabled: boolean;
  systemTimezone: string;
  smtpEnabled: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  emailVerificationEnabled: boolean;
  enforceEmailVerification: boolean;
  captchaMode: 'OFF' | 'LOCAL' | 'TURNSTILE';
  turnstileSiteKey: string;
  turnstileSecretKey: string;
  logsRetentionDays: number;
  logsMaxCount: number;
  logsMinIngestLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  trafficHourlyRetentionDays: number;
  nodeRateRetentionDays: number;
  agentLogMaxSizeMb: number;
  agentLogMaxFiles: number;
  landingEnabled: boolean;
  landingHeroBadge: string;
  landingHeroTitle: string;
  landingHeroSubtitle: string;
  landingShowFeatures: boolean;
  landingShowPlans: boolean;
  landingShowFaq: boolean;
  landingCustomFeaturesJson: string;
  landingCustomFaqJson: string;
}

export type SystemSettingsPatch = {
  [K in keyof SystemSettings]?: SystemSettings[K] | null;
};

export type PublicSystemSettings = Pick<
  SystemSettings,
  | 'siteName'
  | 'siteDescription'
  | 'publicBaseUrl'
  | 'systemTimezone'
  | 'logoUrl'
  | 'faviconUrl'
  | 'siteAnnouncement'
  | 'siteAnnouncementsJson'
  | 'footerCopyright'
  | 'supportTelegramUrl'
  | 'supportDiscordUrl'
  | 'supportEmail'
  | 'supportCustomUrl'
  | 'registrationEnabled'
  | 'passwordMinLength'
  | 'passwordRequireLowercase'
  | 'passwordRequireUppercase'
  | 'passwordRequireDigit'
  | 'passwordRequireSpecial'
  | 'subscriptionBaseUrl'
  | 'subscriptionShortLinksEnabled'
  | 'subscriptionEffectsSyncEnabled'
  | 'speedLimitUnitConversionEnabled'
  | 'deviceLimitEnabled'
  | 'deviceOnlineWindowSecs'
  | 'speedLimitColorTiers'
  | 'customCss'
  | 'customHeadHtml'
  | 'emailVerificationEnabled'
  | 'enforceEmailVerification'
  | 'captchaMode'
  | 'turnstileSiteKey'
  | 'landingEnabled'
  | 'landingHeroBadge'
  | 'landingHeroTitle'
  | 'landingHeroSubtitle'
  | 'landingShowFeatures'
  | 'landingShowPlans'
  | 'landingShowFaq'
  | 'landingCustomFeaturesJson'
  | 'landingCustomFaqJson'
>;

export const DEFAULTS: SystemSettings = {
  siteName: 'RiriCloud',
  siteDescription: '',
  publicBaseUrl: '',
  logoUrl: '',
  faviconUrl: '',
  siteAnnouncement: '',
  siteAnnouncementsJson: '[]',
  footerCopyright: '',
  supportTelegramUrl: '',
  supportDiscordUrl: '',
  supportEmail: '',
  supportCustomUrl: '',
  registrationEnabled: false,
  defaultPlanId: null,
  defaultBalance: 0,
  emailDomainMode: 'none',
  emailDomainList: [],
  passwordMinLength: 8,
  passwordRequireLowercase: true,
  passwordRequireUppercase: false,
  passwordRequireDigit: true,
  passwordRequireSpecial: false,
  subscriptionBaseUrl: '',
  subscriptionShortLinksEnabled: false,
  subscriptionEffectsSyncEnabled: true,
  subscriptionUpdateIntervalHours: 24,
  appendSubscriptionSpeedBadge: true,
  speedLimitUnitConversionEnabled: true,
  speedLimitColorTiers: [...DEFAULT_SPEED_TIERS],
  defaultTemplateId: null,
  publicLinesEnabled: true,
  includeUsageHeaders: true,
  deviceLimitEnabled: true,
  deviceOnlineWindowSecs: 60,
  heartbeatTimeoutSecs: 15,
  configSyncDebounceMs: 250,
  defaultPollIntervalSecs: 15,
  binaryDownloadBaseUrl: '',
  githubRepoUrl: DEFAULT_GITHUB_REPO_URL,
  githubMirrorUrls: [...DEFAULT_GITHUB_MIRRORS],
  probePresetTargets: [
    { type: 'tcp', target: 'www.apple.com', port: 443, timeoutMs: 5000 },
    { type: 'dns', target: 'cloudflare.com', timeoutMs: 5000 }
  ],
  jwtSessionDays: 1,
  customCss: '',
  customHeadHtml: '',
  lineSpeedtestEnabled: true,
  lineSpeedtestIntervalMins: 30,
  lineSpeedtestTargetUrl: 'https://cp.cloudflare.com/generate_204',
  lineSpeedtestTimeoutMs: 3000,
  probeSingboxFallbackEnabled: true,
  systemTimezone: 'Asia/Shanghai',
  smtpEnabled: false,
  smtpHost: '',
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: '',
  smtpPass: '',
  smtpFrom: '',
  emailVerificationEnabled: false,
  enforceEmailVerification: false,
  captchaMode: 'OFF',
  turnstileSiteKey: '',
  turnstileSecretKey: '',
  logsRetentionDays: 7,
  logsMaxCount: 100000,
  logsMinIngestLevel: 'INFO',
  trafficHourlyRetentionDays: 90,
  nodeRateRetentionDays: 30,
  agentLogMaxSizeMb: 50,
  agentLogMaxFiles: 5,
  landingEnabled: true,
  landingHeroBadge: '',
  landingHeroTitle: '',
  landingHeroSubtitle: '',
  landingShowFeatures: true,
  landingShowPlans: true,
  landingShowFaq: true,
  landingCustomFeaturesJson: '[]',
  landingCustomFaqJson: '[]'
};

const DESCRIPTIONS: Record<keyof SystemSettings, string> = {
  siteName: '站点名称',
  siteDescription: '系统副标题描述（展示于登录页等区域）',
  publicBaseUrl: '系统对外访问基准地址',
  logoUrl: '系统 Logo 地址',
  faviconUrl: '站点 Favicon 地址',
  siteAnnouncement: '用户面板公告横幅（支持 Markdown）',
  siteAnnouncementsJson: '结构化公告列表配置（JSON 格式）',
  footerCopyright: '页脚版权文案',
  supportTelegramUrl: 'Telegram 客服或群组地址',
  supportDiscordUrl: 'Discord 服务器邀请地址',
  supportEmail: '客服支持邮箱',
  supportCustomUrl: '自定义帮助中心/工单系统地址',
  registrationEnabled: '是否允许新用户注册',
  defaultPlanId: '新用户注册默认激活的公开套餐',
  defaultBalance: '新用户注册默认赠送余额（分）',
  emailDomainMode: '注册邮箱域名过滤模式',
  emailDomainList: '注册邮箱域名名单列表',
  passwordMinLength: '密码最小长度限制',
  passwordRequireLowercase: '密码必须包含小写字母',
  passwordRequireUppercase: '密码必须包含大写字母',
  passwordRequireDigit: '密码必须包含数字',
  passwordRequireSpecial: '密码必须包含特殊字符',
  subscriptionBaseUrl: '对外订阅基准地址',
  subscriptionShortLinksEnabled: '是否使用 Nginx 伪静态短订阅链接',
  subscriptionEffectsSyncEnabled: '是否开启「我的订阅」卡片套餐特效同步',
  subscriptionUpdateIntervalHours: '客户端订阅更新周期（小时）',
  appendSubscriptionSpeedBadge: '是否在订阅节点名称默认追加速率角标（如 [50M]）',
  speedLimitUnitConversionEnabled: '速率展示是否在达到 1000M 及以上时自动换算为 G 单位（如 1G、2.5G）',
  speedLimitColorTiers: '速率展示阶梯阈值与色彩映射规则（JSON 数组）',
  defaultTemplateId: '全局默认订阅模板',
  publicLinesEnabled: '是否公开线路列表',
  includeUsageHeaders: '是否注入订阅用量响应头',
  deviceLimitEnabled: '是否全局启用同时在线设备数限制',
  deviceOnlineWindowSecs: '设备在线活跃判定时间窗口（秒）',
  heartbeatTimeoutSecs: 'Agent 心跳离线判定超时（秒）',
  configSyncDebounceMs: '配置同步防抖延迟（毫秒）',
  defaultPollIntervalSecs: 'Agent 默认 HTTP 轮询周期（秒）',
  binaryDownloadBaseUrl: '二进制分发基准地址',
  githubRepoUrl: '项目 GitHub 仓库地址（Agent 安装脚本 Release 下载源）',
  githubMirrorUrls: 'GitHub 加速镜像列表（前缀代理，节点安装时自动测速择优）',
  probePresetTargets: '默认网络探针目标列表',
  jwtSessionDays: 'JWT 会话有效天数',
  customCss: '自定义 CSS 样式',
  customHeadHtml: '自定义 HTML/JS 头部代码',
  lineSpeedtestEnabled: '是否开启线路自动定时测速',
  lineSpeedtestIntervalMins: '线路自动测速执行周期（分钟）',
  lineSpeedtestTargetUrl: '线路测速测试目标 URL',
  lineSpeedtestTimeoutMs: '线路测速单次超时阈值（毫秒）',
  probeSingboxFallbackEnabled: '是否允许能力白名单内的 Sing-box 兼容拨测（不对网络/环境失败回退）',
  systemTimezone: '系统统一时区',
  smtpEnabled: '是否启用 SMTP 发信服务',
  smtpHost: 'SMTP 服务器地址',
  smtpPort: 'SMTP 服务器端口',
  smtpSecure: 'SMTP 是否使用 SSL/TLS',
  smtpUser: 'SMTP 登录账号',
  smtpPass: 'SMTP 登录密码',
  smtpFrom: 'SMTP 发信人地址',
  emailVerificationEnabled: '是否启用注册邮箱验证',
  enforceEmailVerification: '强制邮箱验证以使用订阅',
  captchaMode: '人机验证模式',
  turnstileSiteKey: 'Cloudflare Turnstile Site Key',
  turnstileSecretKey: 'Cloudflare Turnstile Secret Key',
  logsRetentionDays: '系统日志保留天数',
  logsMaxCount: '系统日志最大保留条数',
  logsMinIngestLevel: '系统日志最低采集入库级别',
  trafficHourlyRetentionDays: '流量小时汇总保留天数',
  nodeRateRetentionDays: '节点速率指标保留天数',
  agentLogMaxSizeMb: 'Agent 本地日志单文件大小（MiB）',
  agentLogMaxFiles: 'Agent 本地日志文件总数',
  landingEnabled: '是否启用首页门户',
  landingHeroBadge: '首页顶部徽章标签（留空使用默认）',
  landingHeroTitle: '首页主标题（留空使用默认）',
  landingHeroSubtitle: '首页副标题（留空使用默认）',
  landingShowFeatures: '首页是否展示核心特性模块',
  landingShowPlans: '首页是否展示公开套餐模块',
  landingShowFaq: '首页是否展示常见问答 FAQ 模块',
  landingCustomFeaturesJson: '首页自定义特性列表（JSON 格式）',
  landingCustomFaqJson: '首页自定义 FAQ 列表（JSON 格式）'
};

const SETTING_VALUES = Object.values(SETTING_KEYS);

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly changeListeners: Array<(patch: SystemSettingsPatch) => void> = [];

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.cleanupDirtyUndefinedSettings();
  }

  async cleanupDirtyUndefinedSettings(): Promise<number> {
    try {
      const findMany = this.prisma.systemSetting?.findMany;
      const deleteMany = this.prisma.systemSetting?.deleteMany;
      if (!findMany || !deleteMany) return 0;
      const rows = await this.prisma.systemSetting.findMany({ where: { key: { in: SETTING_VALUES } } });
      if (!Array.isArray(rows) || !rows.length) return 0;
      const dirtyKeys: string[] = [];
      for (const row of rows) {
        if (typeof row.value !== 'string') continue;
        if (row.value.trim() === 'undefined') {
          dirtyKeys.push(row.key);
          continue;
        }
        if (row.key === SETTING_KEYS.SMTP_PASS || row.key === SETTING_KEYS.TURNSTILE_SECRET_KEY) {
          const decrypted = decryptSecret(row.value);
          if (decrypted.trim() === 'undefined') {
            dirtyKeys.push(row.key);
          }
        }
      }
      if (!dirtyKeys.length) return 0;
      const result = await this.prisma.systemSetting.deleteMany({ where: { key: { in: dirtyKeys } } });
      return result?.count ?? dirtyKeys.length;
    } catch {
      return 0;
    }
  }

  onSettingsChange(listener: (patch: SystemSettingsPatch) => void) {
    this.changeListeners.push(listener);
  }

  private notifyChange(patch: SystemSettingsPatch) {
    for (const listener of this.changeListeners) {
      try {
        listener(patch);
      } catch {
        // 忽略监听器内部异常
      }
    }
  }

  async getSettings(): Promise<SystemSettings> {
    const rows = await this.prisma.systemSetting.findMany({ where: { key: { in: SETTING_VALUES } } });
    const map = new Map<string, string>();
    const dirtyKeys: string[] = [];
    for (const row of rows) {
      if (typeof row.value === 'string' && row.value.trim() === 'undefined') {
        dirtyKeys.push(row.key);
        continue;
      }
      map.set(row.key, row.value);
    }
    for (const key of [SETTING_KEYS.SMTP_PASS, SETTING_KEYS.TURNSTILE_SECRET_KEY]) {
      const stored = map.get(key);
      if (stored) {
        const decrypted = decryptSecret(stored);
        if (decrypted.trim() === 'undefined') {
          map.delete(key);
          dirtyKeys.push(key);
        } else {
          map.set(key, decrypted);
        }
      }
    }
    if (dirtyKeys.length > 0) {
      void Promise.resolve(this.prisma.systemSetting.deleteMany?.({ where: { key: { in: dirtyKeys } } })).catch(() => undefined);
    }

    let defaultPlanId = this.readNullableString(map, 'defaultPlanId');
    if (defaultPlanId) {
      const planDelegate = (this.prisma as unknown as {
        plan?: { findUnique?: (args: Record<string, unknown>) => Promise<{ isPublic: boolean } | null> };
      }).plan;
      if (planDelegate?.findUnique) {
        const plan = await planDelegate.findUnique({ where: { id: defaultPlanId }, select: { isPublic: true } });
        if (!plan || !plan.isPublic) {
          const stalePlanId = defaultPlanId;
          defaultPlanId = null;
          void Promise.resolve(
            this.prisma.systemSetting.deleteMany?.({ where: { key: SETTING_KEYS.DEFAULT_PLAN_ID, value: stalePlanId } })
          ).catch(() => undefined);
        }
      }
    }

    return {
      siteName: this.readString(map, 'siteName'),
      siteDescription: this.readString(map, 'siteDescription'),
      publicBaseUrl: this.readString(map, 'publicBaseUrl'),
      logoUrl: this.readString(map, 'logoUrl'),
      faviconUrl: this.readString(map, 'faviconUrl'),
      siteAnnouncement: this.readString(map, 'siteAnnouncement'),
      siteAnnouncementsJson: this.readString(map, 'siteAnnouncementsJson'),
      footerCopyright: this.readString(map, 'footerCopyright'),
      supportTelegramUrl: this.readString(map, 'supportTelegramUrl'),
      supportDiscordUrl: this.readString(map, 'supportDiscordUrl'),
      supportEmail: this.readString(map, 'supportEmail'),
      supportCustomUrl: this.readString(map, 'supportCustomUrl'),
      registrationEnabled: this.readBoolean(map, 'registrationEnabled'),
      defaultPlanId,
      defaultBalance: this.readInteger(map, 'defaultBalance', 0, Number.MAX_SAFE_INTEGER),
      emailDomainMode: this.readEnum(map, 'emailDomainMode', ['none', 'whitelist', 'blacklist']),
      emailDomainList: this.readStringArray(map, 'emailDomainList').map(normalizeDomain).filter(Boolean),
      passwordMinLength: this.readInteger(map, 'passwordMinLength', 8, 64),
      passwordRequireLowercase: this.readBoolean(map, 'passwordRequireLowercase'),
      passwordRequireUppercase: this.readBoolean(map, 'passwordRequireUppercase'),
      passwordRequireDigit: this.readBoolean(map, 'passwordRequireDigit'),
      passwordRequireSpecial: this.readBoolean(map, 'passwordRequireSpecial'),
      subscriptionBaseUrl: this.readString(map, 'subscriptionBaseUrl'),
      subscriptionShortLinksEnabled: this.readBoolean(map, 'subscriptionShortLinksEnabled'),
      subscriptionEffectsSyncEnabled: this.readBoolean(map, 'subscriptionEffectsSyncEnabled'),
      subscriptionUpdateIntervalHours: this.readInteger(map, 'subscriptionUpdateIntervalHours', 1, 168),
      appendSubscriptionSpeedBadge: this.readBoolean(map, 'appendSubscriptionSpeedBadge'),
      speedLimitUnitConversionEnabled: this.readBoolean(map, 'speedLimitUnitConversionEnabled'),
      speedLimitColorTiers: this.readSpeedTiers(map),
      defaultTemplateId: this.readNullableString(map, 'defaultTemplateId'),
      publicLinesEnabled: this.readBoolean(map, 'publicLinesEnabled'),
      includeUsageHeaders: this.readBoolean(map, 'includeUsageHeaders'),
      deviceLimitEnabled: this.readBoolean(map, 'deviceLimitEnabled'),
      deviceOnlineWindowSecs: this.readInteger(map, 'deviceOnlineWindowSecs', 15, 600),
      heartbeatTimeoutSecs: this.readInteger(map, 'heartbeatTimeoutSecs', 5, 3600),
      configSyncDebounceMs: this.readInteger(map, 'configSyncDebounceMs', 0, 10000),
      defaultPollIntervalSecs: this.readInteger(map, 'defaultPollIntervalSecs', 5, 300),
      binaryDownloadBaseUrl: this.readString(map, 'binaryDownloadBaseUrl'),
      githubRepoUrl: this.readString(map, 'githubRepoUrl'),
      githubMirrorUrls: this.readStringArray(map, 'githubMirrorUrls'),
      probePresetTargets: this.readProbePresets(map),
      jwtSessionDays: this.readInteger(map, 'jwtSessionDays', 1, 30),
      customCss: this.readString(map, 'customCss'),
      customHeadHtml: this.readString(map, 'customHeadHtml'),
      lineSpeedtestEnabled: this.readBoolean(map, 'lineSpeedtestEnabled'),
      lineSpeedtestIntervalMins: this.readInteger(map, 'lineSpeedtestIntervalMins', 1, 1440),
      lineSpeedtestTargetUrl: this.readString(map, 'lineSpeedtestTargetUrl'),
      lineSpeedtestTimeoutMs: this.readInteger(map, 'lineSpeedtestTimeoutMs', 500, 30000),
      probeSingboxFallbackEnabled: this.readBoolean(map, 'probeSingboxFallbackEnabled'),
      systemTimezone: this.readTimezone(map, 'systemTimezone'),
      smtpEnabled: this.readBoolean(map, 'smtpEnabled'),
      smtpHost: this.readString(map, 'smtpHost'),
      smtpPort: this.readInteger(map, 'smtpPort', 1, 65535),
      smtpSecure: this.readBoolean(map, 'smtpSecure'),
      smtpUser: this.readString(map, 'smtpUser'),
      smtpPass: this.readString(map, 'smtpPass'),
      smtpFrom: this.readString(map, 'smtpFrom'),
      emailVerificationEnabled: this.readBoolean(map, 'emailVerificationEnabled'),
      enforceEmailVerification: this.readBoolean(map, 'enforceEmailVerification'),
      captchaMode: this.readEnum(map, 'captchaMode', ['OFF', 'LOCAL', 'TURNSTILE']),
      turnstileSiteKey: this.readString(map, 'turnstileSiteKey'),
      turnstileSecretKey: this.readString(map, 'turnstileSecretKey'),
      logsRetentionDays: this.readInteger(map, 'logsRetentionDays', 1, 3650),
      logsMaxCount: this.readInteger(map, 'logsMaxCount', 1000, 1000000),
      logsMinIngestLevel: this.readEnum(map, 'logsMinIngestLevel', ['DEBUG', 'INFO', 'WARN', 'ERROR']),
      trafficHourlyRetentionDays: this.readInteger(map, 'trafficHourlyRetentionDays', 1, 3650),
      nodeRateRetentionDays: this.readInteger(map, 'nodeRateRetentionDays', 1, 3650),
      agentLogMaxSizeMb: this.readInteger(map, 'agentLogMaxSizeMb', 1, 1024),
      agentLogMaxFiles: this.readInteger(map, 'agentLogMaxFiles', 1, 20),
      landingEnabled: this.readBoolean(map, 'landingEnabled'),
      landingHeroBadge: this.readString(map, 'landingHeroBadge'),
      landingHeroTitle: this.readString(map, 'landingHeroTitle'),
      landingHeroSubtitle: this.readString(map, 'landingHeroSubtitle'),
      landingShowFeatures: this.readBoolean(map, 'landingShowFeatures'),
      landingShowPlans: this.readBoolean(map, 'landingShowPlans'),
      landingShowFaq: this.readBoolean(map, 'landingShowFaq'),
      landingCustomFeaturesJson: this.readString(map, 'landingCustomFeaturesJson'),
      landingCustomFaqJson: this.readString(map, 'landingCustomFaqJson')
    };
  }

  async getAdminSettings(): Promise<Omit<SystemSettings, 'smtpPass' | 'turnstileSecretKey'> & { smtpPass: string; turnstileSecretKey: string }> {
    const settings = await this.getSettings();
    return {
      ...settings,
      smtpPass: settings.smtpPass ? '********' : '',
      turnstileSecretKey: settings.turnstileSecretKey ? '********' : ''
    };
  }

  async getPublicSettings(): Promise<PublicSystemSettings> {
    const settings = await this.getSettings();
    return {
      siteName: settings.siteName,
      siteDescription: settings.siteDescription,
      publicBaseUrl: settings.publicBaseUrl,
      systemTimezone: settings.systemTimezone,
      logoUrl: settings.logoUrl,
      faviconUrl: settings.faviconUrl,
      siteAnnouncement: settings.siteAnnouncement,
      siteAnnouncementsJson: settings.siteAnnouncementsJson,
      footerCopyright: settings.footerCopyright,
      supportTelegramUrl: settings.supportTelegramUrl,
      supportDiscordUrl: settings.supportDiscordUrl,
      supportEmail: settings.supportEmail,
      supportCustomUrl: settings.supportCustomUrl,
      registrationEnabled: settings.registrationEnabled,
      passwordMinLength: settings.passwordMinLength,
      passwordRequireLowercase: settings.passwordRequireLowercase,
      passwordRequireUppercase: settings.passwordRequireUppercase,
      passwordRequireDigit: settings.passwordRequireDigit,
      passwordRequireSpecial: settings.passwordRequireSpecial,
      subscriptionBaseUrl: settings.subscriptionBaseUrl,
      subscriptionShortLinksEnabled: settings.subscriptionShortLinksEnabled,
      subscriptionEffectsSyncEnabled: settings.subscriptionEffectsSyncEnabled,
      speedLimitUnitConversionEnabled: settings.speedLimitUnitConversionEnabled,
      deviceLimitEnabled: settings.deviceLimitEnabled,
      deviceOnlineWindowSecs: settings.deviceOnlineWindowSecs,
      speedLimitColorTiers: settings.speedLimitColorTiers,
      customCss: settings.customCss,
      customHeadHtml: settings.customHeadHtml,
      emailVerificationEnabled: settings.emailVerificationEnabled,
      enforceEmailVerification: settings.enforceEmailVerification,
      captchaMode: settings.captchaMode,
      turnstileSiteKey: settings.turnstileSiteKey,
      landingEnabled: settings.landingEnabled,
      landingHeroBadge: settings.landingHeroBadge,
      landingHeroTitle: settings.landingHeroTitle,
      landingHeroSubtitle: settings.landingHeroSubtitle,
      landingShowFeatures: settings.landingShowFeatures,
      landingShowPlans: settings.landingShowPlans,
      landingShowFaq: settings.landingShowFaq,
      landingCustomFeaturesJson: settings.landingCustomFeaturesJson,
      landingCustomFaqJson: settings.landingCustomFaqJson
    };
  }

  async updateSettings(patch: SystemSettingsPatch): Promise<SystemSettings> {
    const entries = Object.entries(patch).filter(
      ([key, value]) => key in DEFAULTS && value !== undefined
    ) as Array<[keyof SystemSettings, SystemSettings[keyof SystemSettings]]>;
    if (!entries.length) throw new BadRequestException('未提供任何有效设置字段');
    const cleanPatch = Object.fromEntries(entries) as SystemSettingsPatch;
    await this.validateReferences(cleanPatch);

    await this.prisma.$transaction(async (tx) => {
      for (const [key, value] of entries) {
        if ((key === 'smtpPass' || key === 'turnstileSecretKey') && value === '********') continue;
        const normalized = this.normalizeForStorage(key, value);
        const stored = key === 'smtpPass' || key === 'turnstileSecretKey' ? encryptSecret(normalized) : normalized;
        await tx.systemSetting.upsert({
          where: { key },
          update: { value: stored },
          create: { key, value: stored, description: DESCRIPTIONS[key] }
        });
      }

      const defaultTemplateId = entries.find(([key]) => key === 'defaultTemplateId')?.[1];
      if (typeof defaultTemplateId === 'string' && defaultTemplateId.trim()) {
        await tx.subscriptionTemplate.updateMany({ data: { isDefault: false } });
        await tx.subscriptionTemplate.update({
          where: { id: defaultTemplateId.trim() },
          data: { isDefault: true }
        });
      }
    });
    this.notifyChange(cleanPatch);
    return this.getAdminSettings();
  }

  async resetToDefaults(keys?: Array<keyof SystemSettings>): Promise<Omit<SystemSettings, 'smtpPass' | 'turnstileSecretKey'> & { smtpPass: string; turnstileSecretKey: string }> {
    const selected = keys?.length
      ? keys.filter((key): key is keyof SystemSettings => key in DEFAULTS)
      : (Object.keys(DEFAULTS) as Array<keyof SystemSettings>);
    if (keys && selected.length !== keys.length) throw new BadRequestException('包含无效的设置键');
    await this.prisma.systemSetting.deleteMany({ where: { key: { in: selected } } });
    this.notifyChange(DEFAULTS);
    return this.getAdminSettings();
  }

  private async validateReferences(patch: SystemSettingsPatch) {
    if (patch.systemTimezone !== undefined && patch.systemTimezone !== null && !isValidTimezone(patch.systemTimezone)) {
      throw new BadRequestException('无效的 IANA 时区标识符');
    }
    if (patch.defaultPlanId) {
      const planDelegate = (this.prisma as unknown as {
        plan?: { findUnique: (args: Record<string, unknown>) => Promise<{ isPublic: boolean } | null> };
      }).plan;
      const plan = planDelegate ? await planDelegate.findUnique({ where: { id: patch.defaultPlanId } }) : null;
      if (planDelegate && (!plan || !plan.isPublic)) throw new NotFoundException('默认套餐不存在或未公开');
    }
    if (patch.defaultTemplateId) {
      const templateDelegate = (this.prisma as unknown as {
        subscriptionTemplate?: { findUnique: (args: Record<string, unknown>) => Promise<unknown> };
      }).subscriptionTemplate;
      if (templateDelegate && !(await templateDelegate.findUnique({ where: { id: patch.defaultTemplateId } }))) {
        throw new NotFoundException('默认订阅模板不存在');
      }
    }
  }

  private normalizeForStorage<K extends keyof SystemSettings>(key: K, value: SystemSettings[K] | null | undefined): string {
    if (Array.isArray(value)) return JSON.stringify(value);
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed === 'undefined') return '';
      return key === 'customCss' || key === 'customHeadHtml' || key === 'landingCustomFeaturesJson' || key === 'landingCustomFaqJson' || key === 'siteAnnouncementsJson' ? value : trimmed;
    }
    return String(value);
  }

  private readString(map: Map<string, string>, key: keyof SystemSettings): string {
    const value = map.get(key);
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed === 'undefined') return (DEFAULTS[key] as string | null) ?? '';
    // 清理旧版本内置副标题，避免已有数据库继续展示开发默认文案。
    if (key === 'siteDescription' && trimmed === '多节点代理管理面板') return '';
    return trimmed || ((DEFAULTS[key] as string | null) ?? '');
  }

  private readNullableString(map: Map<string, string>, key: keyof SystemSettings): string | null {
    const value = this.readString(map, key);
    return value || null;
  }

  private readBoolean(map: Map<string, string>, key: keyof SystemSettings): boolean {
    const value = map.get(key)?.trim().toLowerCase();
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return DEFAULTS[key] as boolean;
  }

  private readInteger<K extends keyof SystemSettings>(map: Map<string, string>, key: K, min: number, max: number): number {
    const value = Number(map.get(key));
    return Number.isSafeInteger(value) && value >= min && value <= max ? value : DEFAULTS[key] as number;
  }

  private readEnum<K extends keyof SystemSettings, T extends string>(map: Map<string, string>, key: K, values: readonly T[]): T {
    const value = map.get(key)?.trim().toLowerCase();
    return values.find((item) => item.toLowerCase() === value) ?? DEFAULTS[key] as unknown as T;
  }

  private readStringArray(map: Map<string, string>, key: keyof SystemSettings): string[] {
    try {
      const value: unknown = JSON.parse(map.get(key) ?? 'null');
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : DEFAULTS[key] as string[];
    } catch {
      return DEFAULTS[key] as string[];
    }
  }

  private readProbePresets(map: Map<string, string>): ProbePresetTarget[] {
    try {
      const value: unknown = JSON.parse(map.get('probePresetTargets') ?? 'null');
      if (!Array.isArray(value)) return DEFAULTS.probePresetTargets;
      return value.filter(isProbePresetTarget).slice(0, 32);
    } catch {
      return DEFAULTS.probePresetTargets;
    }
  }

  private readTimezone(map: Map<string, string>, key: keyof SystemSettings): string {
    const value = map.get(key)?.trim();
    if (value && isValidTimezone(value)) {
      return value;
    }
    return DEFAULTS[key] as string;
  }

  private readSpeedTiers(map: Map<string, string>): SpeedTier[] {
    try {
      const raw = map.get('speedLimitColorTiers');
      if (!raw) return DEFAULTS.speedLimitColorTiers;
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value)) return DEFAULTS.speedLimitColorTiers;
      const filtered = value.filter(isSpeedTier).slice(0, 16);
      return filtered.length > 0 ? filtered : DEFAULTS.speedLimitColorTiers;
    } catch {
      return DEFAULTS.speedLimitColorTiers;
    }
  }
}

function isSpeedTier(value: unknown): value is SpeedTier {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const validMax = item.maxMbps === null || (typeof item.maxMbps === 'number' && Number.isFinite(item.maxMbps) && item.maxMbps >= 0);
  const validColor = typeof item.color === 'string' && item.color.trim().length > 0;
  return validMax && validColor;
}

export function isValidTimezone(tz: string): boolean {
  if (!tz || typeof tz !== 'string') return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@+/, '');
}

function isProbePresetTarget(value: unknown): value is ProbePresetTarget {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    (item.type === 'tcp' || item.type === 'dns' || item.type === 'icmp') &&
    typeof item.target === 'string' &&
    item.target.trim().length > 0 &&
    (item.port === undefined || Number.isInteger(item.port)) &&
    (item.timeoutMs === undefined || Number.isInteger(item.timeoutMs))
  );
}
