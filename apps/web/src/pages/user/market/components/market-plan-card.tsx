import { useState, useRef, type ReactNode } from 'react';
import {
  Zap,
  Rocket,
  Crown,
  Shield,
  Sparkles,
  Star,
  Check,
  ArrowRight,
  type LucideIcon
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { formatBytes, formatCurrency } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { usePublicSettings } from '@/lib/public-settings';
import { formatSpeedLimitWithUnit, getSpeedTierBadgeClass } from '@/lib/speed-tier';
import type { PlanCardConfig, PlanCardStyle, PlanThemeColor } from '@/pages/admin/plans/use-plans';
import type { UserPlan } from '@/pages/user/subscription/use-user-subscription';
import { useTranslation } from 'react-i18next';
import {
  PLAN_ICONS,
  THEME_COLOR_CONFIGS,
  RAINBOW_SHINE_GRADIENT,
  RAINBOW_HOLOGRAPHIC_FOIL
} from './market-plan-constants';

export interface MarketPlanCardProps {
  plan: UserPlan;
  isCurrent?: boolean;
  isLowerPriced?: boolean;
  isPurchaseExhausted?: boolean;
  activeSubscription?: boolean;
  onSelect?: (plan: UserPlan) => void;
  actionSlot?: ReactNode;
  isPreview?: boolean;
}

/**
 * 解析特性微标记语法:
 * [zap] [rocket] [crown] [shield] [sparkles] [star] 或行首 ! 加粗高亮
 * 图标色彩统一继承卡片主题折射色，杜绝杂乱七彩撞色
 */
function parseFeatureItem(raw: string, themeIconColor: string) {
  let text = raw.trim();
  let IconComponent: LucideIcon = Check;
  let isHighlighted = false;

  if (text.startsWith('[zap]')) {
    IconComponent = Zap;
    text = text.replace('[zap]', '').trim();
  } else if (text.startsWith('[rocket]')) {
    IconComponent = Rocket;
    text = text.replace('[rocket]', '').trim();
  } else if (text.startsWith('[crown]')) {
    IconComponent = Crown;
    text = text.replace('[crown]', '').trim();
  } else if (text.startsWith('[shield]')) {
    IconComponent = Shield;
    text = text.replace('[shield]', '').trim();
  } else if (text.startsWith('[sparkles]')) {
    IconComponent = Sparkles;
    text = text.replace('[sparkles]', '').trim();
  } else if (text.startsWith('[star]')) {
    IconComponent = Star;
    text = text.replace('[star]', '').trim();
  }

  if (text.startsWith('!')) {
    isHighlighted = true;
    text = text.substring(1).trim();
  }

  return { IconComponent, iconColor: themeIconColor, text, isHighlighted };
}

export function MarketPlanCard({
  plan,
  isCurrent = false,
  isLowerPriced = false,
  isPurchaseExhausted = false,
  activeSubscription = false,
  onSelect,
  actionSlot,
  isPreview = false
}: MarketPlanCardProps) {
  const { t } = useTranslation(['user', 'common']);
  const cardRef = useRef<HTMLDivElement>(null);
  const [mousePos, setMousePos] = useState({ x: -999, y: -999 });
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);

  const cardConfig: PlanCardConfig = plan.cardConfig || {};
  const themeKey = (cardConfig.themeColor || 'default') as PlanThemeColor;
  const theme = THEME_COLOR_CONFIGS[themeKey] || THEME_COLOR_CONFIGS.default;
  const cardStyle = (cardConfig.cardStyle || 'fusion') as PlanCardStyle;

  const effect = cardConfig.animationEffect || 'none';
  const isRainbow = cardConfig.beamColor === 'rainbow';

  // 视觉流派与原子微调继承规则:
  // 1. 优先采用 cardConfig 显式微调覆盖项 (enable3DTilt, enableShineBorder, enableHolographic, enableAmbientGlow, enableAurora)
  // 2. 其次继承 cardStyle 预设流派默认值:
  //    - fusion: 3D 微倾斜 + 全息折射 + 1.5px Shine Border + 双层环境光晕 + 流体极光
  //    - holographic: 3D 微倾斜 + 全息折射 + 晶体棱镜光栅网格 (无旋转流光边框，无漫溢环境光)
  //    - neon: 1.5px Shine Border + 双层呼吸环境霓虹 (无全息彩虹折射，无 3D 微倾斜)
  //    - custom: 纯原子定制模式
  // 3. 兜底兼容旧版 animationEffect
  const has3DTilt = cardConfig.enable3DTilt ?? (cardStyle === 'fusion' || cardStyle === 'holographic');
  const hasHolographicFoil = cardConfig.enableHolographic ?? (cardStyle === 'fusion' || cardStyle === 'holographic');
  const hasShineBorder = cardConfig.enableShineBorder ?? (cardStyle === 'fusion' || cardStyle === 'neon' || effect === 'beam' || effect === 'beam_pulse');
  const hasAmbientGlow = cardConfig.enableAmbientGlow ?? (cardStyle === 'neon' || cardStyle === 'fusion');
  const hasAurora = cardConfig.enableAurora ?? (cardStyle === 'fusion' || effect === 'pulse' || effect === 'beam_pulse' || plan.isFeatured);
  const hasShimmer = cardConfig.shimmerButton ?? (plan.isFeatured || effect === 'beam' || effect === 'beam_pulse');

  // Icon Resolution
  const selectedIconKey = cardConfig.icon || (plan.isFeatured ? 'Crown' : 'Zap');
  const IconComponent = PLAN_ICONS[selectedIconKey]?.icon || Zap;

  // Pricing
  const { data: publicSettings } = usePublicSettings();
  const unitConversion = publicSettings?.speedLimitUnitConversionEnabled !== false;
  const speedText = formatSpeedLimitWithUnit(plan.speedLimitMbps, unitConversion);
  const speedBadgeClass = getSpeedTierBadgeClass(plan.speedLimitMbps, publicSettings?.speedLimitColorTiers);
  const currentPrice = plan.price;
  const originalPrice = cardConfig.originalPrice;
  const hasDiscount = typeof originalPrice === 'number' && originalPrice > currentPrice;
  const discountText =
    cardConfig.discountText ||
    (hasDiscount
      ? t('user:market.savePercent', {
          percent: Math.round(((originalPrice - currentPrice) / originalPrice) * 100)
        })
      : null);

  const resetText =
    plan.trafficResetMode === 'CALENDAR_MONTH'
      ? t('common:resetMode.CALENDAR_MONTH')
      : plan.trafficResetMode === 'SUBSCRIPTION_CYCLE'
      ? t('common:resetMode.SUBSCRIPTION_CYCLE')
      : t('common:time.permanent');

  // Button text
  const defaultActionText = isCurrent
    ? t('user:market.currentPlanTag')
    : isLowerPriced
      ? t('user:market.downgradeUnsupported')
      : isPurchaseExhausted
        ? plan.purchaseLimitPerUser === 1 ? t('user:market.claimed') : t('user:market.limitReached')
      : activeSubscription
        ? t('user:market.upgradeButton')
        : t('user:market.buyButton');
  const buttonLabel = (!isCurrent && !isLowerPriced && !isPurchaseExhausted && cardConfig.buttonText) ? cardConfig.buttonText : defaultActionText;

  // Always surface the configured device cap, including when a plan has custom feature copy.
  const features = [
    ...(plan.features && plan.features.length > 0 ? plan.features : [
      t('user:market.trafficFeature', { traffic: formatBytes(plan.trafficLimitBytes) }),
      plan.speedLimitMbps ? `[zap] ${t('user:market.speedFeature', { speed: plan.speedLimitMbps })}` : `[zap] ${t('user:market.unlimitedSpeedFeature')}`,
      t('user:market.resetFeature', { reset: resetText }),
      t('user:market.allFormatsFeature'),
      t('user:market.allNodesFeature')
    ]),
    t('user:market.deviceLimitFeature', { limit: plan.deviceLimit && plan.deviceLimit > 0 ? String(plan.deviceLimit) : t('user:market.unlimitedDevices') })
  ];

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setMousePos({ x, y });
    setIsHovered(true);

    if (has3DTilt) {
      const px = x / rect.width - 0.5;
      const py = y / rect.height - 0.5;
      // 严格约束在 ±6 度细腻微倾斜范围，提供沉稳高级手感
      setTilt({
        x: Number((-py * 12).toFixed(2)),
        y: Number((px * 12).toFixed(2))
      });
    }
  };

  const handleMouseLeave = () => {
    setIsHovered(false);
    setTilt({ x: 0, y: 0 });
    setMousePos({ x: -999, y: -999 });
  };

  return (
    <div
      ref={cardRef}
      className={cn(
        'group relative flex flex-col justify-between rounded-2xl p-0 transition-transform duration-300',
        isCurrent && 'ring-2 ring-primary ring-offset-2 ring-offset-background shadow-lg shadow-primary/20'
      )}
      style={{
        perspective: 1000,
        transform:
          has3DTilt && isHovered
            ? `perspective(1000px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg) scale3d(1.015, 1.015, 1.015)`
            : 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)',
        transition: isHovered
          ? 'transform 0.12s ease-out'
          : 'transform 0.45s cubic-bezier(0.16, 1, 0.3, 1)'
      }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {/* 1. 双层高斯模糊呼吸环境霓虹光晕 (Ambient Neon Bloom) */}
      {hasAmbientGlow && (
        <div
          className={cn(
            'pointer-events-none absolute -inset-3 rounded-3xl blur-3xl z-0 transition-[opacity,transform] duration-500',
            'bg-gradient-to-br',
            isRainbow ? 'from-purple-500/35 via-sky-500/30 to-amber-500/25' : theme.ambientNeonGlow,
            cardStyle === 'neon'
              ? 'opacity-70 dark:opacity-65 group-hover:opacity-95 group-hover:scale-105'
              : 'opacity-45 dark:opacity-40 group-hover:opacity-80 group-hover:scale-105'
          )}
        />
      )}

      {/* 2. 1.5px 极细微导光流动微边框容器 (Shine Border Fiber) */}
      <div
        className={cn(
          'relative w-full h-full rounded-2xl transition-[padding,background-color,box-shadow] duration-300 z-10',
          hasShineBorder
            ? 'p-[1.5px] overflow-hidden bg-black/[0.04] dark:bg-white/[0.08] shadow-[0_0_15px_-3px_rgba(0,0,0,0.1)] dark:shadow-[0_0_20px_-3px_rgba(0,0,0,0.5)]'
            : 'p-0'
        )}
      >
        {/* Shine Border 动态高速环绕流光束 */}
        {hasShineBorder && (
          <div
            className="pointer-events-none absolute -inset-[100%] animate-shine-spin opacity-80 group-hover:opacity-100 transition-opacity duration-300"
            style={{
              background: isRainbow ? RAINBOW_SHINE_GRADIENT : theme.shineBorderGradient
            }}
          />
        )}

        {/* 3. 卡片主体 (黑曜石深色微晶玻璃 / 浅色珠光白玉微晶) */}
        <Card
          className={cn(
            'relative flex flex-col justify-between h-full w-full overflow-hidden transition-[background-color,border-color,box-shadow] duration-300',
            'backdrop-blur-2xl',
            hasShineBorder
              ? 'rounded-[calc(1rem-1.5px)] border border-black/[0.04] dark:border-white/[0.1]'
              : cn('rounded-2xl border', theme.borderClass),
            theme.cardBgClass,
            theme.cardShadowClass,
            plan.isFeatured && !isCurrent && !hasShineBorder && 'ring-1 ring-primary/30 dark:ring-primary/20 shadow-md'
          )}
        >
          {/* 顶部 1px 晶体棱线导光微条 (Top Rim Specular Highlight) */}
          <div
            className={cn(
              'pointer-events-none absolute inset-x-0 top-0 h-[1px] z-20 transition-opacity duration-300',
              'bg-gradient-to-r from-transparent',
              theme.topRimHighlight,
              'to-transparent opacity-80 group-hover:opacity-100'
            )}
          />

          {/* 顶部天光柔和漫射 (Top Ambient Light) */}
          <div
            className={cn(
              'pointer-events-none absolute -top-12 inset-x-0 h-44 rounded-t-2xl z-0 transition-opacity duration-500',
              'bg-gradient-to-b blur-2xl',
              theme.topAmbientGlow,
              plan.isFeatured ? 'opacity-85 dark:opacity-75' : 'opacity-45 dark:opacity-40 group-hover:opacity-70'
            )}
          />

          {/* 4. 全息镭射晶格折射图层 (Holographic Foil Overlay) */}
          {hasHolographicFoil && (
            <>
              {/* 静止时柔和全息贝母底蕴 */}
              <div
                className={cn(
                  'pointer-events-none absolute inset-0 z-10 animate-holographic-foil overflow-hidden rounded-[inherit]',
                  'mix-blend-screen opacity-30 dark:opacity-35',
                  cardStyle === 'holographic' && 'opacity-40 dark:opacity-45'
                )}
                style={{
                  background: isRainbow ? RAINBOW_HOLOGRAPHIC_FOIL : theme.holographicFoilStyle
                }}
              />
              {/* 鼠标移入时高透璀璨彩虹全息折射 */}
              <div
                className={cn(
                  'pointer-events-none absolute inset-0 z-10 opacity-0 group-hover:opacity-85 dark:group-hover:opacity-90 transition-opacity duration-300 mix-blend-screen overflow-hidden rounded-[inherit]',
                  cardStyle === 'holographic' && 'group-hover:opacity-100'
                )}
                style={{
                  background: isRainbow ? RAINBOW_HOLOGRAPHIC_FOIL : theme.holographicFoilStyle,
                  filter: 'contrast(1.2) brightness(1.1)'
                }}
              />
              {/* 全息闪卡独有的微晶棱镜光栅纹理 (Prismatic Diffraction Grid) */}
              {cardStyle === 'holographic' && (
                <div
                  className="pointer-events-none absolute inset-0 z-10 opacity-20 dark:opacity-25 group-hover:opacity-40 transition-opacity duration-300 mix-blend-screen rounded-[inherit]"
                  style={{
                    backgroundImage: `repeating-linear-gradient(
                      0deg,
                      rgba(255,255,255,0.06) 0px,
                      rgba(255,255,255,0.06) 1px,
                      transparent 1px,
                      transparent 4px
                    ), repeating-linear-gradient(
                      90deg,
                      rgba(255,255,255,0.06) 0px,
                      rgba(255,255,255,0.06) 1px,
                      transparent 1px,
                      transparent 4px
                    )`
                  }}
                />
              )}
            </>
          )}

          {/* 5. 鼠标物理镜面反射追踪 (Dual-Layer Specular Spotlight) */}
          {isHovered && (
            <div
              className="pointer-events-none absolute -inset-px opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-20 rounded-[inherit]"
              style={{
                background: `radial-gradient(120px circle at ${mousePos.x}px ${mousePos.y}px, rgba(255, 255, 255, 0.35), transparent 70%), radial-gradient(300px circle at ${mousePos.x}px ${mousePos.y}px, ${theme.spotlightRgba}, transparent 80%)`
              }}
            />
          )}

          {/* 6. 流体极光内衬微光 (Fluid Aurora Engine) */}
          {hasAurora && (
            <div className="pointer-events-none absolute inset-0 overflow-hidden z-0 opacity-25 dark:opacity-35 transition-opacity duration-300">
              {/* 主流体极光光池 1 */}
              <div
                className={cn(
                  'absolute -top-12 -left-12 h-64 w-64 rounded-full bg-gradient-to-br blur-3xl animate-aurora-1',
                  isRainbow
                    ? 'from-indigo-400/30 via-purple-500/20 to-transparent'
                    : theme.auroraOrb1
                )}
              />
              {/* 辅助逆向流体极光光池 2 */}
              <div
                className={cn(
                  'absolute -bottom-12 -right-12 h-60 w-60 rounded-full bg-gradient-to-tl blur-3xl animate-aurora-2',
                  isRainbow
                    ? 'from-cyan-400/25 via-emerald-500/20 to-transparent'
                    : theme.auroraOrb2
                )}
              />
            </div>
          )}

        <div className="relative z-10 flex flex-col flex-1">
          <CardHeader className="pb-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-3">
                {/* 专业 Lucide 矢量图标微光底座 */}
                <div
                  className={cn(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-[transform,background-color,border-color] duration-300 group-hover:scale-105',
                    theme.iconBgClass
                  )}
                >
                  <IconComponent className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle className="text-base font-bold tracking-tight text-foreground">
                    {plan.name}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                    {plan.description || t('user:market.defaultPlanDesc')}
                  </p>
                </div>
              </div>

              {/* 徽章组 */}
              <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                {Boolean(plan.speedLimitMbps) && (
                  <Badge
                    variant="outline"
                    className={cn('gap-1 text-xs px-2 py-0.5 font-semibold', speedBadgeClass)}
                  >
                    <Zap className="size-3" />
                    {speedText}
                  </Badge>
                )}
                {isCurrent && (
                  <Badge variant="default" className="text-xs">
                    {t('user:market.currentPlanTag')}
                  </Badge>
                )}
                {plan.badgeText && (
                  <Badge
                    variant={cardConfig.badgeVariant === 'outline' ? 'outline' : 'default'}
                    className={cn(
                      'text-xs px-2 py-0.5 font-medium',
                      cardConfig.badgeVariant === 'gradient' || !cardConfig.badgeVariant
                        ? theme.badgeGradient
                        : cardConfig.badgeVariant === 'glow'
                          ? 'bg-primary/10 text-primary border border-primary/25 shadow-sm'
                          : ''
                    )}
                  >
                    {plan.badgeText}
                  </Badge>
                )}
                {isPreview && (
                  <Badge variant="outline" className="text-[10px] text-muted-foreground border-dashed bg-muted/20">
                    Preview
                  </Badge>
                )}
              </div>
            </div>
          </CardHeader>

          <CardContent className="space-y-4 flex-1">
            {/* 价格与折扣对比（纯净晶体面板） */}
            <div
              className={cn(
                'flex items-baseline justify-between rounded-xl px-3.5 py-2.5 transition-[background-color,border-color,box-shadow] duration-300 border',
                theme.priceBoxClass,
                cardStyle === 'neon' && 'shadow-[0_0_12px_-2px_rgba(56,189,248,0.15)] dark:shadow-[0_0_14px_-2px_rgba(255,255,255,0.08)]'
              )}
            >
              <div>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-2xl font-extrabold tracking-tight text-foreground">
                    {currentPrice === 0 ? t('user:market.free') : formatCurrency(Math.round(currentPrice * 100))}
                  </span>
                  <span className="text-xs font-normal text-muted-foreground">
                    / {t('common:time.days', { count: plan.durationDays })}
                  </span>
                </div>
                {hasDiscount && originalPrice != null && (
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                    <span>{t('user:market.originalPrice')}</span>
                    <span className="line-through">{formatCurrency(Math.round(originalPrice * 100))}</span>
                  </div>
                )}
              </div>

              {discountText && (
                <div className="shrink-0 text-right">
                  <span className="inline-block rounded-full bg-rose-500/15 dark:bg-rose-500/15 px-2.5 py-0.5 text-xs font-bold text-rose-700 dark:text-rose-400 border border-rose-500/30 dark:border-rose-500/25 shadow-xs">
                    {discountText}
                  </span>
                </div>
              )}
            </div>

            {/* 特性清单 */}
            <div className="space-y-2 text-sm pt-1">
              {features.map((featureRaw, idx) => {
                const { IconComponent: FeatureIcon, iconColor, text, isHighlighted } = parseFeatureItem(featureRaw, theme.featureIconColor);
                return (
                  <div key={idx} className="flex items-start gap-2.5">
                    <div className="mt-0.5 shrink-0">
                      <FeatureIcon className={cn('h-4 w-4', iconColor)} />
                    </div>
                    <span
                      className={cn(
                        'text-xs leading-relaxed',
                        isHighlighted ? 'font-semibold text-foreground' : 'text-foreground/85'
                      )}
                    >
                      {text}
                    </span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </div>

        {/* 底部行动区域 */}
        <CardFooter className="relative z-10 pt-2 pb-5">
          {actionSlot ? (
            actionSlot
          ) : (
            <Button
              className={cn(
                'relative w-full overflow-hidden transition-colors duration-300 font-medium group/btn h-10',
                isCurrent
                  ? 'border border-primary/30 bg-primary/10 text-primary font-semibold cursor-default hover:bg-primary/10'
                  : isLowerPriced || isPurchaseExhausted
                    ? 'border border-zinc-200/80 dark:border-white/10 bg-zinc-100/60 dark:bg-white/[0.04] text-muted-foreground font-medium cursor-not-allowed opacity-80'
                    : theme.buttonGlassClass
              )}
              variant="ghost"
              onClick={() => onSelect?.(plan)}
              disabled={isCurrent || isLowerPriced || isPurchaseExhausted}
            >
              {/* 按钮金属微光扫光动效 (Shimmer) */}
              {hasShimmer && !isCurrent && !isLowerPriced && !isPurchaseExhausted && (
                <div className="absolute inset-0 -translate-x-full animate-shimmer pointer-events-none bg-gradient-to-r from-transparent via-white/20 to-transparent" />
              )}
              <span className="relative z-10 flex items-center justify-center gap-1.5 text-sm tracking-wide">
                {buttonLabel}
                {!isCurrent && !isLowerPriced && !isPurchaseExhausted && (
                  <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover/btn:translate-x-0.5" />
                )}
              </span>
            </Button>
          )}
        </CardFooter>
      </Card>
      </div>
    </div>
  );
}
