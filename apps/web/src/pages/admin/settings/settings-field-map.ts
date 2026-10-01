import type { SettingsForm } from './settings-schema';
export type SettingsTabKey = 'branding' | 'landing' | 'users' | 'subscription' | 'agent' | 'storage' | 'advanced';

export const FIELD_TAB_MAP: Record<keyof SettingsForm, SettingsTabKey> = {
  siteName: 'branding',
  siteDescription: 'branding',
  publicBaseUrl: 'branding',
  systemTimezone: 'branding',
  logoUrl: 'branding',
  faviconUrl: 'branding',
  siteAnnouncement: 'branding',
  siteAnnouncementsJson: 'branding',
  footerCopyright: 'branding',
  supportEmail: 'branding',
  supportTelegramUrl: 'branding',
  supportDiscordUrl: 'branding',
  supportCustomUrl: 'branding',
  landingEnabled: 'landing',
  landingHeroBadge: 'landing',
  landingHeroTitle: 'landing',
  landingHeroSubtitle: 'landing',
  landingShowFeatures: 'landing',
  landingShowPlans: 'landing',
  landingShowFaq: 'landing',
  landingCustomFeaturesJson: 'landing',
  landingCustomFaqJson: 'landing',
  registrationEnabled: 'users',
  defaultPlanId: 'users',
  defaultBalanceYuan: 'users',
  passwordMinLength: 'users',
  passwordRequireLowercase: 'users',
  passwordRequireUppercase: 'users',
  passwordRequireDigit: 'users',
  passwordRequireSpecial: 'users',
  emailDomainMode: 'users',
  emailDomainListText: 'users',
  smtpEnabled: 'users',
  smtpHost: 'users',
  smtpPort: 'users',
  smtpSecure: 'users',
  smtpUser: 'users',
  smtpPass: 'users',
  smtpFrom: 'users',
  emailVerificationEnabled: 'users',
  enforceEmailVerification: 'users',
  captchaMode: 'users',
  turnstileSiteKey: 'users',
  turnstileSecretKey: 'users',
  subscriptionBaseUrl: 'subscription',
  subscriptionShortLinksEnabled: 'subscription',
  subscriptionEffectsSyncEnabled: 'subscription',
  subscriptionUpdateIntervalHours: 'subscription',
  appendSubscriptionSpeedBadge: 'subscription',
  speedLimitUnitConversionEnabled: 'subscription',
  speedLimitColorTiers: 'subscription',
  defaultTemplateId: 'subscription',
  publicLinesEnabled: 'subscription',
  includeUsageHeaders: 'subscription',
  deviceLimitEnabled: 'agent',
  deviceOnlineWindowSecs: 'agent',
  heartbeatTimeoutSecs: 'agent',
  configSyncDebounceMs: 'agent',
  defaultPollIntervalSecs: 'agent',
  binaryDownloadBaseUrl: 'agent',
  githubRepoUrl: 'agent',
  githubMirrorUrlsText: 'agent',
  probePresetTargets: 'agent',
  lineSpeedtestEnabled: 'agent',
  lineSpeedtestIntervalMins: 'agent',
  lineSpeedtestTargetUrl: 'agent',
  lineSpeedtestTimeoutMs: 'agent',
  probeSingboxFallbackEnabled: 'agent',
  trafficHourlyRetentionDays: 'storage',
  nodeRateRetentionDays: 'storage',
  logsRetentionDays: 'storage',
  logsMaxCount: 'storage',
  logsMinIngestLevel: 'storage',
  agentLogMaxSizeMb: 'storage',
  agentLogMaxFiles: 'storage',
  jwtSessionDays: 'advanced',
  customCss: 'advanced',
  customHeadHtml: 'advanced'
};

export function findFirstErrorMessage(errObj: unknown): string | null {
  if (!errObj || typeof errObj !== 'object') return null;
  if (
    'message' in errObj &&
    typeof (errObj as { message?: unknown }).message === 'string' &&
    (errObj as { message: string }).message.trim()
  ) {
    return (errObj as { message: string }).message;
  }
  if (Array.isArray(errObj)) {
    for (const item of errObj) {
      const found = findFirstErrorMessage(item);
      if (found) return found;
    }
    return null;
  }
  for (const val of Object.values(errObj as Record<string, unknown>)) {
    const found = findFirstErrorMessage(val);
    if (found) return found;
  }
  return null;
}
