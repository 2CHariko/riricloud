import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { setDefaultSystemTimezone } from './utils';
import type { SpeedTier } from './speed-tier';

export interface PublicSystemSettings {
  siteName: string;
  siteDescription: string;
  logoUrl: string;
  faviconUrl: string;
  publicBaseUrl: string;
  siteAnnouncement: string;
  siteAnnouncementsJson?: string;
  footerCopyright: string;
  supportTelegramUrl: string;
  supportDiscordUrl: string;
  supportEmail: string;
  supportCustomUrl: string;
  registrationEnabled: boolean;
  passwordMinLength: number;
  passwordRequireLowercase: boolean;
  passwordRequireUppercase: boolean;
  passwordRequireDigit: boolean;
  passwordRequireSpecial: boolean;
  systemTimezone: string;
  subscriptionBaseUrl: string;
  subscriptionShortLinksEnabled: boolean;
  subscriptionEffectsSyncEnabled?: boolean;
  speedLimitUnitConversionEnabled?: boolean;
  speedLimitColorTiers?: SpeedTier[];
  customCss: string;
  customHeadHtml: string;
  emailVerificationEnabled: boolean;
  enforceEmailVerification: boolean;
  captchaMode: 'OFF' | 'LOCAL' | 'TURNSTILE';
  turnstileSiteKey: string;
  landingEnabled?: boolean;
  landingHeroBadge?: string;
  landingHeroTitle?: string;
  landingHeroSubtitle?: string;
  landingShowFeatures?: boolean;
  landingShowPlans?: boolean;
  landingShowFaq?: boolean;
  landingCustomFeaturesJson?: string;
  landingCustomFaqJson?: string;
}

export function usePublicSettings() {
  return useQuery({
    queryKey: ['system', 'public-info'],
    queryFn: async () => {
      const data = (await api.get<PublicSystemSettings>('/system/public-info')).data;
      if (data?.systemTimezone) {
        setDefaultSystemTimezone(data.systemTimezone);
      }
      return data;
    },
    staleTime: 60_000
  });
}
