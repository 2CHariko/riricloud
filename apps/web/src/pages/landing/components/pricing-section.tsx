import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Check, Gauge, Sparkles, Zap } from 'lucide-react';
import { usePublicPlans, type Plan } from '@/pages/admin/plans/use-plans';
import { useCurrentUser } from '@/lib/current-user';
import { useAuthStore } from '@/stores/auth';
import { formatBytes, formatYuan } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface PricingSectionProps {
  registrationEnabled?: boolean;
}

export function PricingSection({ registrationEnabled = false }: PricingSectionProps) {
  const { t } = useTranslation(['landing', 'common']);
  const { data: plans, isLoading } = usePublicPlans();
  const sessionQuery = useCurrentUser();
  const storeUser = useAuthStore((s) => s.user);
  const currentUser = sessionQuery.data ?? storeUser;

  const publicPlans = (plans ?? []).filter((p) => p.isPublic).sort((a, b) => a.sortOrder - b.sortOrder);

  if (!isLoading && publicPlans.length === 0) {
    return null;
  }

  return (
    <section id="plans" className="scroll-mt-16 border-t border-border/40 bg-muted/20 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        {/* Section Header */}
        <div className="text-center max-w-2xl mx-auto">
          <p className="text-xs font-bold uppercase tracking-widest text-primary">
            {t('pricing.tag', { defaultValue: 'SUBSCRIPTION PLANS' })}
          </p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight text-foreground sm:text-4xl">
            {t('pricing.heading', { defaultValue: '灵活透明的订阅方案' })}
          </h2>
          <p className="mt-3 text-sm sm:text-base text-muted-foreground leading-relaxed">
            {t('pricing.subtitle', {
              defaultValue: '按需选购高速节点配额，无隐形费用，随时自主管理与续订。'
            })}
          </p>
        </div>

        {/* Pricing Cards Grid */}
        <div className="mt-14 grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3 max-w-5xl mx-auto">
          {publicPlans.map((plan: Plan) => {
            const isFeatured = plan.isFeatured || plan.badgeText;
            const features = plan.features && plan.features.length > 0
              ? plan.features
              : [
                  t('pricing.featureProtocol', { defaultValue: '全协议支持 (VLESS Reality / Hysteria2)' }),
                  t('pricing.featureGlobal', { defaultValue: '覆盖全球核心数据中心高速节点' }),
                  t('pricing.featureClients', { defaultValue: '全平台客户端无缝配置导入' }),
                  t('pricing.featureReset', { defaultValue: '周期流量自动定时重置' })
                ];

            return (
              <Card
                key={plan.id}
                className={`relative flex flex-col justify-between overflow-hidden border-border/70 bg-card transition-[box-shadow,border-color] duration-200 hover:shadow-md ${
                  isFeatured ? 'border-primary/60 shadow-xs ring-1 ring-primary/20' : ''
                }`}
              >
                {/* Featured Badge */}
                {isFeatured && (
                  <div className="absolute top-4 right-4">
                    <Badge variant="default" className="gap-1 text-xs font-medium py-0.5 px-2">
                      <Sparkles className="size-3" />
                      {plan.badgeText || t('pricing.popular', { defaultValue: '热门推荐' })}
                    </Badge>
                  </div>
                )}

                <div>
                  <CardHeader className="pb-4">
                    <CardTitle className="text-lg font-bold text-foreground">{plan.name}</CardTitle>
                    {plan.description && (
                      <CardDescription className="text-xs line-clamp-2 mt-1">
                        {plan.description}
                      </CardDescription>
                    )}
                    <div className="mt-4 flex items-baseline gap-1">
                      <span className="text-3xl font-extrabold tracking-tight text-foreground">
                        {plan.price === 0 ? t('common:pricing.free') : formatYuan(plan.price)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        / {plan.durationDays} {t('pricing.days', { defaultValue: '天' })}
                      </span>
                    </div>
                  </CardHeader>

                  <CardContent className="space-y-4 pt-0">
                    <div className="flex flex-col gap-2 rounded-lg border border-border/50 bg-muted/40 p-3 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground flex items-center gap-1.5">
                          <Zap className="size-3.5 text-primary" />
                          {t('pricing.trafficLimit', { defaultValue: '包含流量' })}
                        </span>
                        <span className="font-semibold text-foreground">
                          {formatBytes(plan.trafficLimitBytes)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground flex items-center gap-1.5">
                          <Gauge className="size-3.5 text-muted-foreground" />
                          {t('pricing.speedLimit', { defaultValue: '峰值速率' })}
                        </span>
                        <span className="font-medium text-foreground">
                          {plan.speedLimitMbps && plan.speedLimitMbps > 0
                            ? `${plan.speedLimitMbps} Mbps`
                            : t('pricing.unlimitedSpeed', { defaultValue: '无上限 / 峰值' })}
                        </span>
                      </div>
                    </div>

                    <div className="space-y-2 pt-2">
                      <p className="text-xs font-semibold text-muted-foreground">
                        {t('pricing.includedFeatures', { defaultValue: '方案权益' })}
                      </p>
                      <ul className="space-y-2 text-xs text-muted-foreground">
                        {features.map((feat, idx) => (
                          <li key={idx} className="flex items-start gap-2">
                            <Check className="size-3.5 shrink-0 text-emerald-500 mt-0.5" />
                            <span className="leading-tight">{feat}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </CardContent>
                </div>

                <CardFooter className="pt-4 border-t border-border/40">
                  {currentUser ? (
                    <Button
                      variant={isFeatured ? 'default' : 'outline'}
                      className="w-full gap-1.5 text-xs font-medium"
                      asChild
                    >
                      <Link to="/market">
                        <span>{t('pricing.subscribeNow', { defaultValue: '前往控制台订购' })}</span>
                        <ArrowRight className="size-3.5" />
                      </Link>
                    </Button>
                  ) : (
                    <Button
                      variant={isFeatured ? 'default' : 'outline'}
                      className="w-full gap-1.5 text-xs font-medium"
                      asChild
                    >
                      <Link to={registrationEnabled ? '/register' : '/login'}>
                        <span>
                          {registrationEnabled
                            ? t('pricing.getStarted', { defaultValue: '立即注册选购' })
                            : t('pricing.loginToBuy', { defaultValue: '登录账号选购' })}
                        </span>
                        <ArrowRight className="size-3.5" />
                      </Link>
                    </Button>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      </div>
    </section>
  );
}
