import { useTranslation } from 'react-i18next';
import {
  BarChart3,
  Cpu,
  Globe,
  Laptop,
  Layers,
  Lock,
  Radio,
  Server,
  ShieldCheck,
  Sparkles,
  Zap,
  type LucideIcon
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import type { LandingFeatureItem } from '../types';

const ICON_MAP: Record<string, LucideIcon> = {
  Zap,
  Lock,
  Globe,
  Laptop,
  BarChart3,
  ShieldCheck,
  Sparkles,
  Server,
  Cpu,
  Radio,
  Layers
};

interface FeaturesSectionProps {
  features: LandingFeatureItem[];
}

export function FeaturesSection({ features }: FeaturesSectionProps) {
  const { t } = useTranslation('landing');

  return (
    <section id="features" className="scroll-mt-16 border-t border-border/40 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        {/* Section Header */}
        <div className="text-center max-w-2xl mx-auto">
          <p className="text-xs font-bold uppercase tracking-widest text-primary">
            {t('features.tag', { defaultValue: 'CORE FEATURES' })}
          </p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight text-foreground sm:text-4xl">
            {t('features.heading', { defaultValue: '全链路卓越性能与安全保障' })}
          </h2>
          <p className="mt-3 text-sm sm:text-base text-muted-foreground leading-relaxed">
            {t('features.subtitle', {
              defaultValue: '基于自研控制平面与现代数据平面，为个人与团队提供坚如磐石的全球高速接入。'
            })}
          </p>
        </div>

        {/* Feature Cards Grid */}
        <div className="mt-14 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => {
            const IconComponent = ICON_MAP[feature.icon] ?? Sparkles;
            return (
              <Card
                key={feature.id}
                className="group relative overflow-hidden border-border/60 bg-card/50 backdrop-blur-xs transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-xs"
              >
                <CardContent className="p-6">
                  <div className="flex size-11 items-center justify-center rounded-lg bg-primary/10 text-primary border border-primary/20 transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                    <IconComponent className="size-5" />
                  </div>
                  <h3 className="mt-4 text-base font-semibold text-foreground tracking-tight">
                    {feature.title}
                  </h3>
                  <p className="mt-2 text-xs sm:text-sm text-muted-foreground leading-relaxed">
                    {feature.description}
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </section>
  );
}
