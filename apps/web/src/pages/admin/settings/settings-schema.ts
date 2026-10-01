import { z } from 'zod';
import i18n from '@/i18n/config';
import { probePresetTargetsSchema } from './components/probe-preset-schema';
function isValidTimezone(value: string): boolean {
  if (!value || !value.trim()) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value.trim() });
    return true;
  } catch {
    return false;
  }
}
export function createSettingsSchema() {
  return z.object({
    siteName: z.string().trim().min(1, i18n.t('admin:settings.valSiteNameReq')).max(32),
    siteDescription: z.string().max(120),
    publicBaseUrl: z.string().refine(isBlankOrUrl, i18n.t('admin:settings.valPublicBaseUrl')),
    systemTimezone: z.string().trim().min(1, i18n.t('admin:settings.valTimezoneReq')).refine(isValidTimezone, i18n.t('admin:settings.valTimezoneInvalid')),
    logoUrl: z.string().refine(isBlankOrUrl, i18n.t('admin:settings.valLogoUrl')),
    faviconUrl: z.string().refine(isBlankOrUrl, i18n.t('admin:settings.valFaviconUrl')),
    siteAnnouncement: z.string().max(10000),
    siteAnnouncementsJson: z.string().max(50000),
    footerCopyright: z.string().max(200),
    supportTelegramUrl: z.string().refine(isBlankOrUrl, i18n.t('admin:settings.valTgUrl')),
    supportDiscordUrl: z.string().refine(isBlankOrUrl, i18n.t('admin:settings.valDiscordUrl')),
    supportEmail: z.string().refine((value) => !value || z.string().email().safeParse(value).success, i18n.t('admin:settings.valEmail')),
    supportCustomUrl: z.string().refine(isBlankOrUrl, i18n.t('admin:settings.valCustomSupportUrl')),
    registrationEnabled: z.boolean(),
    defaultPlanId: z.string(),
    defaultBalanceYuan: z.coerce.number().min(0, i18n.t('admin:settings.valBalanceNegative')).multipleOf(0.01, i18n.t('admin:settings.valBalanceDecimals')),
    emailDomainMode: z.enum(['none', 'whitelist', 'blacklist']),
    emailDomainListText: z.string().max(16000),
    passwordMinLength: z.coerce.number().int().min(8).max(64),
    passwordRequireLowercase: z.boolean(),
    passwordRequireUppercase: z.boolean(),
    passwordRequireDigit: z.boolean(),
    passwordRequireSpecial: z.boolean(),
    subscriptionBaseUrl: z.string().refine(isBlankOrUrl, i18n.t('admin:settings.valSubBaseUrl')),
    subscriptionShortLinksEnabled: z.boolean(),
    subscriptionEffectsSyncEnabled: z.boolean(),
    subscriptionUpdateIntervalHours: z.coerce.number().int().min(1).max(168),
    appendSubscriptionSpeedBadge: z.boolean(),
    speedLimitUnitConversionEnabled: z.boolean(),
    speedLimitColorTiers: z.array(z.object({
      maxMbps: z.number().int().min(1).nullable().optional(),
      color: z.string().min(1)
    })),
    defaultTemplateId: z.string(),
    publicLinesEnabled: z.boolean(),
    includeUsageHeaders: z.boolean(),
    deviceLimitEnabled: z.boolean(),
    deviceOnlineWindowSecs: z.coerce.number().int().min(15).max(600),
    heartbeatTimeoutSecs: z.coerce.number().int().min(5).max(3600),
    configSyncDebounceMs: z.coerce.number().int().min(0).max(10000),
    defaultPollIntervalSecs: z.coerce.number().int().min(5).max(300),
    binaryDownloadBaseUrl: z.string().refine(isBlankOrUrl, i18n.t('admin:settings.valBinaryDownloadUrl')),
    githubRepoUrl: z.string().refine(isBlankOrUrl, i18n.t('admin:settings.valGithubRepoUrl')),
    githubMirrorUrlsText: z
      .string()
      .max(16000)
      .refine(
        (val) => {
          const lines = val
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
          return lines.length <= 32 && lines.every(isValidHttpUrl);
        },
        i18n.t('admin:settings.valGithubMirrorUrls')
      ),
    probePresetTargets: probePresetTargetsSchema,
    jwtSessionDays: z.coerce.number().int().min(1).max(30),
    customCss: z.string().max(50000),
    customHeadHtml: z.string().max(20000),
    lineSpeedtestEnabled: z.boolean(),
    lineSpeedtestIntervalMins: z.coerce.number().int().min(1).max(1440),
    lineSpeedtestTargetUrl: z.string().refine(isBlankOrUrl, i18n.t('admin:settings.valSpeedtestTargetUrl')),
    lineSpeedtestTimeoutMs: z.coerce.number().int().min(500).max(30000),
    probeSingboxFallbackEnabled: z.boolean(),
    smtpEnabled: z.boolean(),
    smtpHost: z.string().max(255),
    smtpPort: z.coerce.number().int().min(1).max(65535),
    smtpSecure: z.boolean(),
    smtpUser: z.string().max(255),
    smtpPass: z.string().max(512),
    smtpFrom: z.string().max(255),
    emailVerificationEnabled: z.boolean(),
    enforceEmailVerification: z.boolean(),
    captchaMode: z.enum(['OFF', 'LOCAL', 'TURNSTILE']),
    turnstileSiteKey: z.string().max(255),
    turnstileSecretKey: z.string().max(512),
    logsRetentionDays: z.coerce.number().int().min(1).max(3650),
    logsMaxCount: z.coerce.number().int().min(1000).max(1000000),
    logsMinIngestLevel: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']),
    trafficHourlyRetentionDays: z.coerce.number().int().min(1).max(3650),
    nodeRateRetentionDays: z.coerce.number().int().min(1).max(3650),
    agentLogMaxSizeMb: z.coerce.number().int().min(1).max(1024),
    agentLogMaxFiles: z.coerce.number().int().min(1).max(20),
    landingEnabled: z.boolean(),
    landingHeroBadge: z.string().max(100),
    landingHeroTitle: z.string().max(150),
    landingHeroSubtitle: z.string().max(500),
    landingShowFeatures: z.boolean(),
    landingShowPlans: z.boolean(),
    landingShowFaq: z.boolean(),
    landingCustomFeaturesJson: z.string().max(50000),
    landingCustomFaqJson: z.string().max(50000)
  });
}

export type SettingsForm = z.infer<ReturnType<typeof createSettingsSchema>>;
export function isValidHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function isBlankOrUrl(value: string): boolean {
  const trimmed = value.trim();
  return !trimmed || isValidHttpUrl(trimmed);
}
