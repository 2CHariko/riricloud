import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n/config';
import { zodResolver } from '@hookform/resolvers/zod';
import { useFormResetOnKey } from '@/hooks/use-form-reset';
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { IconButton } from '@/components/ui/icon-button';
import {
  type Plan,
  type PlanPayload,
  type PlanThemeColor,
  type PlanCardStyle,
  type PlanAnimationEffect,
  type PlanBeamColor,
  type PlanBadgeVariant,
  usePlanMutations
} from '../use-plans';
import type { AdminLine } from '../../lines/use-lines';
import type { UserPlan } from '@/pages/user/subscription/use-user-subscription';
import { MarketPlanCard } from '@/pages/user/market/components/market-plan-card';
import { PLAN_ICONS } from '@/pages/user/market/components/market-plan-constants';
import { Sparkles, Palette, Eye, HelpCircle, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

const PRESET_FEATURE_KEYS = ['zap', 'rocket', 'crown', 'shield', 'sparkles', 'star', 'sla'] as const;

const PLAN_ICON_KEYS = [
  'Zap',
  'Rocket',
  'Crown',
  'Shield',
  'Sparkles',
  'Flame',
  'Globe',
  'Gauge',
  'Gem',
  'Server',
  'Cpu',
  'Plane'
] as const;

const THEME_OPTIONS: Array<{ key: PlanThemeColor; bgClass: string }> = [
  { key: 'default', bgClass: 'bg-zinc-600' },
  { key: 'amber', bgClass: 'bg-amber-500' },
  { key: 'blue', bgClass: 'bg-sky-500' },
  { key: 'purple', bgClass: 'bg-purple-500' },
  { key: 'emerald', bgClass: 'bg-emerald-500' },
  { key: 'rose', bgClass: 'bg-rose-500' },
  { key: 'indigo', bgClass: 'bg-indigo-500' }
];

const buildPlanSchema = () =>
  z.object({
    name: z.string().min(1, i18n.t('admin:planForm.validation.nameRequired')),
    description: z.string().optional(),
    price: z.coerce.number().min(0).multipleOf(0.01, i18n.t('admin:planForm.validation.priceDecimals')),
    durationDays: z.coerce.number().int().min(1),
    trafficLimitGB: z.coerce.number().positive(i18n.t('admin:planForm.validation.trafficPositive')),
    trafficResetMode: z.enum(['NONE', 'CALENDAR_MONTH', 'SUBSCRIPTION_CYCLE']),
  lineMatchMode: z.enum(['ALL', 'TAGS', 'EXPLICIT']),
  lineTags: z.string().optional(),
  lineIds: z.string().optional(),
  templateId: z.string().optional(),
  badgeText: z.string().optional(),
  isFeatured: z.boolean(),
  featuresText: z.string().optional(),
  isPublic: z.boolean(),
  sortOrder: z.coerce.number().int().min(0),
  purchaseLimitPerUser: z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? null : Number(value)),
    z.number().int().min(1).nullable()
  ),
  allowRenewal: z.boolean(),
  deviceLimit: z.coerce.number().int().min(0).max(1000),
  speedLimitMbps: z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? null : Number(val)),
    z.number().int().min(0).max(100000).nullable().optional()
  ),
  appendSpeedBadge: z.enum(['INHERIT', 'ENABLE', 'DISABLE']).default('INHERIT'),
  // 视觉与营销动效配置
  cardStyle: z.enum(['fusion', 'holographic', 'neon', 'custom']).default('fusion'),
  themeColor: z.enum(['default', 'amber', 'blue', 'purple', 'emerald', 'rose', 'indigo']),
  icon: z.string().min(1),
  buttonText: z.string().optional(),
  originalPrice: z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? undefined : Number(val)),
    z.number().min(0).optional().nullable()
  ),
  discountText: z.string().optional(),
  badgeVariant: z.enum(['default', 'outline', 'secondary', 'glow', 'gradient']),
  animationEffect: z.enum(['none', 'beam', 'pulse', 'beam_pulse']).optional().default('none'),
  beamColor: z.enum(['theme', 'rainbow']),
  shimmerButton: z.boolean(),
  syncToSubscription: z.boolean(),
  enable3DTilt: z.boolean().optional(),
  enableShineBorder: z.boolean().optional(),
  enableHolographic: z.boolean().optional(),
  enableAmbientGlow: z.boolean().optional(),
  enableAurora: z.boolean().optional()
});

type FormValues = z.infer<ReturnType<typeof buildPlanSchema>>;
const GB = 1024 ** 3;

interface PlanFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plan: Plan | null;
  lineOptions: AdminLine[];
  templateOptions: Array<{ id: string; name: string }>;
}

export function PlanFormDialog({
  open,
  onOpenChange,
  plan,
  lineOptions,
  templateOptions
}: PlanFormDialogProps) {
  const { t } = useTranslation(['admin', 'common']);
  const formSchema = useMemo(() => buildPlanSchema(), []);
  const [showAdvancedVisuals, setShowAdvancedVisuals] = useState(false);
  const { create, update } = usePlanMutations();
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      description: '',
      price: 0,
      durationDays: 30,
      trafficLimitGB: 100,
      trafficResetMode: 'NONE',
      lineMatchMode: 'ALL',
      lineTags: '',
      lineIds: '',
      templateId: '',
      badgeText: '',
      isFeatured: false,
      featuresText: '',
      isPublic: true,
      sortOrder: 0,
      purchaseLimitPerUser: 1,
      allowRenewal: false,
      deviceLimit: 0,
      speedLimitMbps: null,
      appendSpeedBadge: 'INHERIT',
      cardStyle: 'fusion',
      themeColor: 'default',
      icon: 'Zap',
      buttonText: '',
      originalPrice: null,
      discountText: '',
      badgeVariant: 'gradient',
      animationEffect: 'none',
      beamColor: 'theme',
      shimmerButton: true,
      syncToSubscription: true,
      enable3DTilt: undefined,
      enableShineBorder: undefined,
      enableHolographic: undefined,
      enableAmbientGlow: undefined,
      enableAurora: undefined
    }
  });

  const lineTags = Array.from(new Set(lineOptions.flatMap((line) => line.tags))).sort();
  const selectedTags = (form.watch('lineTags') ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
  const selectedIds = (form.watch('lineIds') ?? '').split(',').map((id) => id.trim()).filter(Boolean);

  const toggleTag = (tag: string) => {
    const next = selectedTags.includes(tag)
      ? selectedTags.filter((item) => item !== tag)
      : [...selectedTags, tag];
    form.setValue('lineTags', next.join(', '), { shouldDirty: true });
  };

  const toggleLine = (id: string) => {
    const next = selectedIds.includes(id)
      ? selectedIds.filter((item) => item !== id)
      : [...selectedIds, id];
    form.setValue('lineIds', next.join(', '), { shouldDirty: true });
  };

  const addPresetFeature = (feature: string) => {
    const current = (form.getValues('featuresText') || '')
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
    if (!current.includes(feature)) {
      const next = [...current, feature].join('\n');
      form.setValue('featuresText', next, { shouldDirty: true });
    }
  };

  useFormResetOnKey({
    open,
    resetKey: plan?.id ?? 'create',
    reset: () =>
      form.reset(
        plan
          ? {
              name: plan.name,
              description: plan.description ?? '',
              price: plan.price,
              durationDays: plan.durationDays,
              trafficLimitGB: plan.trafficLimitBytes / GB,
              trafficResetMode: plan.trafficResetMode ?? 'NONE',
              lineMatchMode: plan.lineMatchMode,
              lineTags: plan.lineTags.join(', '),
              lineIds: plan.lineIds.join(', '),
              templateId: plan.templateId ?? '',
              badgeText: plan.badgeText ?? '',
              isFeatured: plan.isFeatured ?? false,
              featuresText: plan.features?.join('\n') ?? '',
              isPublic: plan.isPublic,
              sortOrder: plan.sortOrder,
              purchaseLimitPerUser: plan.purchaseLimitPerUser,
              allowRenewal: plan.allowRenewal,
              deviceLimit: plan.deviceLimit ?? 0,
              speedLimitMbps: plan.speedLimitMbps ?? null,
              appendSpeedBadge: (plan.appendSpeedBadge as 'INHERIT' | 'ENABLE' | 'DISABLE') ?? 'INHERIT',
              cardStyle: plan.cardConfig?.cardStyle ?? 'fusion',
              themeColor: plan.cardConfig?.themeColor ?? 'default',
              icon: plan.cardConfig?.icon ?? 'Zap',
              buttonText: plan.cardConfig?.buttonText ?? '',
              originalPrice: plan.cardConfig?.originalPrice ?? null,
              discountText: plan.cardConfig?.discountText ?? '',
              badgeVariant: plan.cardConfig?.badgeVariant ?? 'gradient',
              animationEffect: plan.cardConfig?.animationEffect ?? 'none',
              beamColor: plan.cardConfig?.beamColor ?? 'theme',
              shimmerButton: plan.cardConfig?.shimmerButton ?? true,
              syncToSubscription: plan.cardConfig?.syncToSubscription ?? true,
              enable3DTilt: plan.cardConfig?.enable3DTilt,
              enableShineBorder: plan.cardConfig?.enableShineBorder,
              enableHolographic: plan.cardConfig?.enableHolographic,
              enableAmbientGlow: plan.cardConfig?.enableAmbientGlow,
              enableAurora: plan.cardConfig?.enableAurora
            }
          : undefined
      )
  });

  const submit = (values: FormValues) => {
    const features = values.featuresText
      ? values.featuresText
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean)
      : [];

    const payload: PlanPayload = {
      name: values.name,
      description: values.description,
      price: values.price,
      durationDays: values.durationDays,
      trafficLimitBytes: Math.round(values.trafficLimitGB * GB),
      trafficResetMode: values.trafficResetMode,
      lineMatchMode: values.lineMatchMode,
      lineTags: values.lineTags?.split(',').map((tag) => tag.trim()).filter(Boolean) ?? [],
      lineIds: values.lineIds?.split(',').map((id) => id.trim()).filter(Boolean) ?? [],
      templateId: values.templateId || null,
      badgeText: values.badgeText?.trim() || null,
      isFeatured: values.isFeatured,
      features,
      isPublic: values.isPublic,
      sortOrder: values.sortOrder,
      purchaseLimitPerUser: values.purchaseLimitPerUser,
      allowRenewal: values.allowRenewal,
      deviceLimit: values.deviceLimit,
      speedLimitMbps: values.speedLimitMbps ?? null,
      appendSpeedBadge: values.appendSpeedBadge ?? 'INHERIT',
      cardConfig: {
        cardStyle: values.cardStyle,
        themeColor: values.themeColor,
        icon: values.icon,
        buttonText: values.buttonText?.trim() || null,
        originalPrice: values.originalPrice != null && values.originalPrice > 0 ? Number(values.originalPrice) : null,
        discountText: values.discountText?.trim() || null,
        badgeVariant: values.badgeVariant,
        animationEffect: values.animationEffect,
        beamColor: values.beamColor,
        shimmerButton: values.shimmerButton,
        syncToSubscription: values.syncToSubscription,
        enable3DTilt: values.enable3DTilt,
        enableShineBorder: values.enableShineBorder,
        enableHolographic: values.enableHolographic,
        enableAmbientGlow: values.enableAmbientGlow,
        enableAurora: values.enableAurora
      }
    };

    if (plan) {
      update.mutate({ id: plan.id, ...payload }, { onSuccess: () => onOpenChange(false) });
    } else {
      create.mutate(payload, { onSuccess: () => onOpenChange(false) });
    }
  };

  const busy = create.isPending || update.isPending;

  // 构造即时实机预览数据 (Live Preview Plan)
  const watchedValues = form.watch();
  const previewPlan: UserPlan = {
    id: plan?.id || 'preview',
    name: watchedValues.name || t('admin:planForm.previewDefaultName'),
    description: watchedValues.description || t('admin:planForm.previewDefaultDesc'),
    price: Number(watchedValues.price) || 0,
    durationDays: Number(watchedValues.durationDays) || 30,
    trafficLimitBytes: Math.round((Number(watchedValues.trafficLimitGB) || 100) * GB),
    deviceLimit: Number(watchedValues.deviceLimit) || 0,
    trafficResetMode: watchedValues.trafficResetMode || 'NONE',
    lineMatchMode: watchedValues.lineMatchMode || 'ALL',
    badgeText: watchedValues.badgeText || null,
    isFeatured: watchedValues.isFeatured,
    purchaseLimitPerUser: watchedValues.purchaseLimitPerUser,
    allowRenewal: watchedValues.allowRenewal,
    speedLimitMbps: watchedValues.speedLimitMbps ? Number(watchedValues.speedLimitMbps) : null,
    features: watchedValues.featuresText
      ? watchedValues.featuresText.split('\n').filter(Boolean)
      : undefined,
    cardConfig: {
      cardStyle: (watchedValues.cardStyle || 'fusion') as PlanCardStyle,
      themeColor: watchedValues.themeColor as PlanThemeColor,
      icon: watchedValues.icon,
      buttonText: watchedValues.buttonText,
      originalPrice: watchedValues.originalPrice ? Number(watchedValues.originalPrice) : null,
      discountText: watchedValues.discountText,
      badgeVariant: watchedValues.badgeVariant as PlanBadgeVariant,
      animationEffect: watchedValues.animationEffect as PlanAnimationEffect,
      beamColor: watchedValues.beamColor as PlanBeamColor,
      shimmerButton: watchedValues.shimmerButton,
      syncToSubscription: watchedValues.syncToSubscription,
      enable3DTilt: watchedValues.enable3DTilt,
      enableShineBorder: watchedValues.enableShineBorder,
      enableHolographic: watchedValues.enableHolographic,
      enableAmbientGlow: watchedValues.enableAmbientGlow,
      enableAurora: watchedValues.enableAurora
    }
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{plan ? t('admin:planForm.editTitle') : t('admin:planForm.createTitle')}</DialogTitle>
          <DialogDescription>
            {t('admin:planForm.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 lg:grid-cols-12 items-start">
          {/* 左侧配置表单 */}
          <form onSubmit={form.handleSubmit(submit)} className="space-y-6 lg:col-span-7">
            {/* 1. 基础配置 */}
            <div className="space-y-4 rounded-xl border p-4 bg-card">
              <h4 className="text-sm font-semibold flex items-center gap-2 text-foreground">
                {t('admin:planForm.sectionBasic')}
              </h4>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="plan-name">{t('admin:planForm.name')}</Label>
                  <Input id="plan-name" placeholder={t('admin:planForm.namePlaceholder')} {...form.register('name')} />
                  {form.formState.errors.name && (
                    <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
                  )}
                </div>

                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="plan-description">{t('admin:planForm.descLabel')}</Label>
                  <Input
                    id="plan-description"
                    placeholder={t('admin:planForm.descPlaceholder')}
                    {...form.register('description')}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="plan-price">{t('admin:planForm.price')}</Label>
                  <Input
                    id="plan-price"
                    type="number"
                    min="0"
                    step="0.01"
                    {...form.register('price', {
                      onChange: (event) => {
                        const price = Number(event.target.value);
                        if (price === 0) {
                          form.setValue('purchaseLimitPerUser', 1, { shouldDirty: true });
                          form.setValue('allowRenewal', false, { shouldDirty: true });
                        } else if (Number.isFinite(price) && price > 0) {
                          form.setValue('purchaseLimitPerUser', null, { shouldDirty: true });
                          form.setValue('allowRenewal', true, { shouldDirty: true });
                        }
                      }
                    })}
                  />
                  {form.formState.errors.price && (
                    <p className="text-xs text-destructive">{form.formState.errors.price.message}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="plan-days">{t('admin:planForm.durationDays')}</Label>
                  <Input id="plan-days" type="number" min="1" {...form.register('durationDays')} />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="plan-traffic">{t('admin:planForm.trafficLimit')}</Label>
                  <Input id="plan-traffic" type="number" min="1" step="0.1" {...form.register('trafficLimitGB')} />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="plan-device-limit">{t('admin:planForm.deviceLimit')}</Label>
                  <Input id="plan-device-limit" type="number" min="0" max="1000" {...form.register('deviceLimit')} />
                  <p className="text-[11px] text-muted-foreground">{t('admin:planForm.deviceLimitHint')}</p>
                </div>

                <div className="space-y-2">
                  <Label>{t('admin:planForm.trafficResetMode')}</Label>
                  <Controller
                    control={form.control}
                    name="trafficResetMode"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="NONE">{t('common:resetMode.NONE')}</SelectItem>
                          <SelectItem value="CALENDAR_MONTH">{t('common:resetMode.CALENDAR_MONTH')}</SelectItem>
                          <SelectItem value="SUBSCRIPTION_CYCLE">{t('common:resetMode.SUBSCRIPTION_CYCLE')}</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="plan-sort">{t('admin:planForm.sortOrder')}</Label>
                  <Input id="plan-sort" type="number" min="0" placeholder="0" {...form.register('sortOrder')} />
                  <p className="text-[11px] text-muted-foreground">{t('admin:planForm.sortOrderHint')}</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="plan-purchase-limit">{t('admin:planForm.purchaseLimit')}</Label>
                  <Input
                    id="plan-purchase-limit"
                    type="number"
                    min="1"
                    placeholder={t('admin:planForm.purchaseLimitPlaceholder')}
                    {...form.register('purchaseLimitPerUser')}
                  />
                  <p className="text-[11px] text-muted-foreground">{t('admin:planForm.purchaseLimitHint')}</p>
                </div>

                <div className="flex items-center justify-between rounded-lg border p-2.5 bg-muted/20 h-9">
                  <Label htmlFor="plan-allow-renewal" className="text-xs font-medium cursor-pointer truncate mr-1">
                    {t('admin:planForm.allowRenewal')}
                  </Label>
                  <Controller
                    control={form.control}
                    name="allowRenewal"
                    render={({ field }) => (
                      <Switch id="plan-allow-renewal" checked={field.value} onCheckedChange={field.onChange} />
                    )}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="plan-badge">{t('admin:planForm.badgeText')}</Label>
                  <Input id="plan-badge" placeholder={t('admin:planForm.badgeTextPlaceholder')} {...form.register('badgeText')} />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="plan-speed-limit">{t('admin:planForm.speedLimit')}</Label>
                  <Input
                    id="plan-speed-limit"
                    type="number"
                    min="0"
                    max="100000"
                    placeholder={t('admin:planForm.speedLimitPlaceholder')}
                    {...form.register('speedLimitMbps')}
                  />
                  <p className="text-[11px] text-muted-foreground">{t('admin:planForm.speedLimitHint')}</p>
                </div>

                <div className="space-y-2">
                  <Label>{t('admin:planForm.appendSpeedBadge')}</Label>
                  <Controller
                    control={form.control}
                    name="appendSpeedBadge"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="INHERIT">{t('admin:planForm.speedBadgeInherit')}</SelectItem>
                          <SelectItem value="ENABLE">{t('admin:planForm.speedBadgeEnable')}</SelectItem>
                          <SelectItem value="DISABLE">{t('admin:planForm.speedBadgeDisable')}</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                  <p className="text-[11px] text-muted-foreground">{t('admin:planForm.appendSpeedBadgeHint')}</p>
                </div>
              </div>
            </div>

            {/* 2. 视觉风格与动效配置 */}
            <div className="space-y-4 rounded-xl border p-4 bg-card">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold flex items-center gap-2 text-foreground">
                  <Palette className="h-4 w-4 text-primary" />
                  {t('admin:planForm.sectionVisual')}
                </h4>
                <Badge variant="secondary" className="text-[11px] gap-1 font-normal">
                  <Sparkles className="h-3 w-3 text-amber-500" />
                  {t('admin:planForm.fullyConfigurable')}
                </Badge>
              </div>

              {/* 视觉流派方案 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium text-foreground/90">{t('admin:planForm.cardStyleLabel')}</Label>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      form.setValue('cardStyle', 'fusion', { shouldDirty: true });
                      form.setValue('enable3DTilt', undefined, { shouldDirty: true });
                      form.setValue('enableShineBorder', undefined, { shouldDirty: true });
                      form.setValue('enableHolographic', undefined, { shouldDirty: true });
                      form.setValue('enableAmbientGlow', undefined, { shouldDirty: true });
                      form.setValue('enableAurora', undefined, { shouldDirty: true });
                    }}
                    className={cn(
                      'flex flex-col items-center justify-center p-3 rounded-lg border text-center transition-colors',
                      form.watch('cardStyle') === 'fusion'
                        ? 'border-primary ring-2 ring-primary/40 bg-accent/40 font-semibold'
                        : 'border-border/60 hover:border-border hover:bg-muted/40'
                    )}
                  >
                    <span className="text-xs font-bold text-foreground">{t('admin:planForm.styles.fusion')}</span>
                    <span className="text-[11px] text-muted-foreground mt-0.5">{t('admin:planForm.styles.fusionDesc')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      form.setValue('cardStyle', 'holographic', { shouldDirty: true });
                      form.setValue('enable3DTilt', undefined, { shouldDirty: true });
                      form.setValue('enableShineBorder', undefined, { shouldDirty: true });
                      form.setValue('enableHolographic', undefined, { shouldDirty: true });
                      form.setValue('enableAmbientGlow', undefined, { shouldDirty: true });
                      form.setValue('enableAurora', undefined, { shouldDirty: true });
                    }}
                    className={cn(
                      'flex flex-col items-center justify-center p-3 rounded-lg border text-center transition-colors',
                      form.watch('cardStyle') === 'holographic'
                        ? 'border-primary ring-2 ring-primary/40 bg-accent/40 font-semibold'
                        : 'border-border/60 hover:border-border hover:bg-muted/40'
                    )}
                  >
                    <span className="text-xs font-bold text-foreground">{t('admin:planForm.styles.holographic')}</span>
                    <span className="text-[11px] text-muted-foreground mt-0.5">{t('admin:planForm.styles.holographicDesc')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      form.setValue('cardStyle', 'neon', { shouldDirty: true });
                      form.setValue('enable3DTilt', undefined, { shouldDirty: true });
                      form.setValue('enableShineBorder', undefined, { shouldDirty: true });
                      form.setValue('enableHolographic', undefined, { shouldDirty: true });
                      form.setValue('enableAmbientGlow', undefined, { shouldDirty: true });
                      form.setValue('enableAurora', undefined, { shouldDirty: true });
                    }}
                    className={cn(
                      'flex flex-col items-center justify-center p-3 rounded-lg border text-center transition-colors',
                      form.watch('cardStyle') === 'neon'
                        ? 'border-primary ring-2 ring-primary/40 bg-accent/40 font-semibold'
                        : 'border-border/60 hover:border-border hover:bg-muted/40'
                    )}
                  >
                    <span className="text-xs font-bold text-foreground">{t('admin:planForm.styles.neon')}</span>
                    <span className="text-[11px] text-muted-foreground mt-0.5">{t('admin:planForm.styles.neonDesc')}</span>
                  </button>
                </div>
              </div>

              {/* 高级视觉微调（折叠抽屉面板） */}
              <div className="rounded-xl border bg-muted/10 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowAdvancedVisuals((prev) => !prev)}
                  className="w-full flex items-center justify-between p-3 text-xs font-medium text-foreground/90 hover:bg-muted/20 transition-colors"
                >
                  <span className="flex items-center gap-1.5 font-semibold">
                    <Sparkles className="h-3.5 w-3.5 text-primary" />
                    {t('admin:planForm.advancedVisuals')}
                  </span>
                  <div className="flex items-center gap-1 text-muted-foreground text-[11px]">
                    <span>{showAdvancedVisuals ? t('admin:planForm.collapse') : t('admin:planForm.expand')}</span>
                    <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200', showAdvancedVisuals && 'rotate-180')} />
                  </div>
                </button>

                {showAdvancedVisuals && (
                  <div className="p-3 pt-0 border-t space-y-2.5 mt-1">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-2">
                      <div className="flex items-center justify-between rounded-lg border p-2.5 bg-background">
                        <Label htmlFor="plan-enable-tilt" className="text-xs cursor-pointer">
                          {t('admin:planForm.enableTilt')}
                        </Label>
                        <Controller
                          control={form.control}
                          name="enable3DTilt"
                          render={({ field }) => (
                            <Switch
                              id="plan-enable-tilt"
                              checked={field.value ?? (form.watch('cardStyle') === 'fusion' || form.watch('cardStyle') === 'holographic')}
                              onCheckedChange={field.onChange}
                            />
                          )}
                        />
                      </div>

                      <div className="flex items-center justify-between rounded-lg border p-2.5 bg-background">
                        <Label htmlFor="plan-enable-shine" className="text-xs cursor-pointer">
                          {t('admin:planForm.enableShine')}
                        </Label>
                        <Controller
                          control={form.control}
                          name="enableShineBorder"
                          render={({ field }) => (
                            <Switch
                              id="plan-enable-shine"
                              checked={field.value ?? (form.watch('cardStyle') === 'fusion' || form.watch('cardStyle') === 'neon')}
                              onCheckedChange={field.onChange}
                            />
                          )}
                        />
                      </div>

                      <div className="flex items-center justify-between rounded-lg border p-2.5 bg-background">
                        <Label htmlFor="plan-enable-holo" className="text-xs cursor-pointer">
                          {t('admin:planForm.enableHolo')}
                        </Label>
                        <Controller
                          control={form.control}
                          name="enableHolographic"
                          render={({ field }) => (
                            <Switch
                              id="plan-enable-holo"
                              checked={field.value ?? (form.watch('cardStyle') === 'fusion' || form.watch('cardStyle') === 'holographic')}
                              onCheckedChange={field.onChange}
                            />
                          )}
                        />
                      </div>

                      <div className="flex items-center justify-between rounded-lg border p-2.5 bg-background">
                        <Label htmlFor="plan-enable-ambient" className="text-xs cursor-pointer">
                          {t('admin:planForm.enableAmbient')}
                        </Label>
                        <Controller
                          control={form.control}
                          name="enableAmbientGlow"
                          render={({ field }) => (
                            <Switch
                              id="plan-enable-ambient"
                              checked={field.value ?? (form.watch('cardStyle') === 'neon' || form.watch('cardStyle') === 'fusion')}
                              onCheckedChange={field.onChange}
                            />
                          )}
                        />
                      </div>

                      <div className="flex items-center justify-between rounded-lg border p-2.5 bg-background sm:col-span-2">
                        <Label htmlFor="plan-enable-aurora" className="text-xs cursor-pointer">
                          {t('admin:planForm.enableAurora')}
                        </Label>
                        <Controller
                          control={form.control}
                          name="enableAurora"
                          render={({ field }) => (
                            <Switch
                              id="plan-enable-aurora"
                              checked={field.value ?? form.watch('cardStyle') === 'fusion'}
                              onCheckedChange={field.onChange}
                            />
                          )}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* 主题色系选择 */}
              <div className="space-y-2">
                <Label className="text-xs font-medium text-foreground/90">{t('admin:planForm.themeColorLabel')}</Label>
                <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
                  {THEME_OPTIONS.map((theme) => {
                    const isSelected = form.watch('themeColor') === theme.key;
                    return (
                      <button
                        key={theme.key}
                        type="button"
                        onClick={() => form.setValue('themeColor', theme.key, { shouldDirty: true })}
                        className={cn(
                          'flex flex-col items-center gap-1.5 p-2 rounded-lg border text-center transition-colors',
                          isSelected
                            ? 'border-primary ring-2 ring-primary/40 bg-accent/40 font-semibold'
                            : 'border-border/60 hover:border-border hover:bg-muted/40'
                        )}
                      >
                        <span className={cn('h-4 w-4 rounded-full shadow-sm', theme.bgClass)} />
                        <span className="text-[11px] leading-tight">{t(`admin:planForm.themes.${theme.key}`)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 专业 Lucide 图标网格 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium text-foreground/90">{t('admin:planForm.iconsLabel')}</Label>
                  <span className="text-[11px] text-muted-foreground">{t('admin:planForm.iconsHint')}</span>
                </div>
                <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                  {PLAN_ICON_KEYS.map((key) => {
                    const IconComp = PLAN_ICONS[key].icon;
                    const isSelected = form.watch('icon') === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => form.setValue('icon', key, { shouldDirty: true })}
                        className={cn(
                          'flex flex-col items-center gap-1 p-2 rounded-lg border text-center transition-colors',
                          isSelected
                            ? 'border-primary ring-2 ring-primary/40 bg-accent/50 text-foreground font-semibold'
                            : 'border-border/60 hover:border-border hover:bg-muted/40 text-muted-foreground'
                        )}
                      >
                        <IconComp className="h-4 w-4" />
                        <span className="text-[10px] leading-tight">{t(`admin:planForm.icons.${key}`)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 流光光色与角标风格 */}
              <div className="grid gap-3 sm:grid-cols-2 pt-1">
                <div className="space-y-2">
                  <Label className="text-xs font-medium">{t('admin:planForm.beamColorLabel')}</Label>
                  <Controller
                    control={form.control}
                    name="beamColor"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="theme">{t('admin:planForm.beamColorTheme')}</SelectItem>
                          <SelectItem value="rainbow">{t('admin:planForm.beamColorRainbow')}</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-xs font-medium">{t('admin:planForm.badgeVariantLabel')}</Label>
                  <Controller
                    control={form.control}
                    name="badgeVariant"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="gradient">{t('admin:planForm.badgeVariants.gradient')}</SelectItem>
                          <SelectItem value="glow">{t('admin:planForm.badgeVariants.glow')}</SelectItem>
                          <SelectItem value="outline">{t('admin:planForm.badgeVariants.outline')}</SelectItem>
                          <SelectItem value="default">{t('admin:planForm.badgeVariants.default')}</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
              </div>

              {/* 营销对比与文案定制 */}
              <div className="grid gap-3 sm:grid-cols-3 pt-1">
                <div className="space-y-2">
                  <Label htmlFor="plan-orig-price" className="text-xs">{t('admin:planForm.originalPrice')}</Label>
                  <Input
                    id="plan-orig-price"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder={t('admin:planForm.originalPricePlaceholder')}
                    {...form.register('originalPrice')}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="plan-discount-text" className="text-xs">{t('admin:planForm.discountText')}</Label>
                  <Input
                    id="plan-discount-text"
                    placeholder={t('admin:planForm.discountTextPlaceholder')}
                    {...form.register('discountText')}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="plan-btn-text" className="text-xs">{t('admin:planForm.buttonText')}</Label>
                  <Input
                    id="plan-btn-text"
                    placeholder={t('admin:planForm.buttonTextPlaceholder')}
                    {...form.register('buttonText')}
                  />
                </div>
              </div>

              {/* 按钮微光与订阅同步开关 */}
              <div className="grid gap-3 sm:grid-cols-2 pt-1">
                <div className="flex items-center justify-between rounded-lg border p-2.5 bg-muted/20 h-9">
                  <Label htmlFor="plan-shimmer" className="text-xs font-medium cursor-pointer truncate mr-1">
                    {t('admin:planForm.shimmerButton')}
                  </Label>
                  <Controller
                    control={form.control}
                    name="shimmerButton"
                    render={({ field }) => (
                      <Switch id="plan-shimmer" checked={field.value} onCheckedChange={field.onChange} />
                    )}
                  />
                </div>

                <div className="flex items-center justify-between rounded-lg border p-2.5 bg-muted/20 h-9">
                  <Label htmlFor="plan-sync-sub" className="text-xs font-medium cursor-pointer truncate mr-1">
                    {t('admin:planForm.syncToSubscription')}
                  </Label>
                  <Controller
                    control={form.control}
                    name="syncToSubscription"
                    render={({ field }) => (
                      <Switch id="plan-sync-sub" checked={field.value} onCheckedChange={field.onChange} />
                    )}
                  />
                </div>
              </div>

              {/* 主推推荐开关 */}
              <div className="rounded-lg border p-3 bg-muted/20 flex items-center justify-between">
                <div>
                  <Label htmlFor="plan-featured" className="font-medium text-xs">
                    {t('admin:planForm.isFeatured')}
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    {t('admin:planForm.isFeaturedHint')}
                  </p>
                </div>
                <Controller
                  control={form.control}
                  name="isFeatured"
                  render={({ field }) => (
                    <Switch id="plan-featured" checked={field.value} onCheckedChange={field.onChange} />
                  )}
                />
              </div>
            </div>

            {/* 3. 权益特性清单与线路 */}
            <div className="space-y-4 rounded-xl border p-4 bg-card">
              <h4 className="text-sm font-semibold flex items-center gap-2 text-foreground">
                {t('admin:planForm.sectionFeatures')}
              </h4>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Label htmlFor="plan-features" className="text-xs">{t('admin:planForm.featuresLabel')}</Label>
                    <IconButton
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={t('admin:planForm.featuresSyntaxGuide')}
                      tooltipSide="top"
                      tooltipClassName="max-w-xs p-3"
                      tooltip={
                        <div className="space-y-2">
                          <p className="font-semibold text-xs">{t('admin:planForm.featuresSyntaxTitle')}</p>
                          <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                            <div><code className="rounded bg-muted px-1 text-primary">[zap]</code> {t('admin:planForm.featuresSyntaxZap')}</div>
                            <div><code className="rounded bg-muted px-1 text-primary">[rocket]</code> {t('admin:planForm.featuresSyntaxRocket')}</div>
                            <div><code className="rounded bg-muted px-1 text-primary">[crown]</code> {t('admin:planForm.featuresSyntaxCrown')}</div>
                            <div><code className="rounded bg-muted px-1 text-primary">[shield]</code> {t('admin:planForm.featuresSyntaxShield')}</div>
                            <div><code className="rounded bg-muted px-1 text-primary">[sparkles]</code> {t('admin:planForm.featuresSyntaxSparkles')}</div>
                            <div><code className="rounded bg-muted px-1 text-primary">[star]</code> {t('admin:planForm.featuresSyntaxStar')}</div>
                          </div>
                          <p className="border-t border-border/50 pt-1 text-[10px] text-muted-foreground">
                            {t('admin:planForm.featuresSyntaxBold')}
                          </p>
                        </div>
                      }
                    >
                      <HelpCircle className="size-4" />
                    </IconButton>
                  </div>
                  <span className="text-[11px] text-muted-foreground">{t('admin:planForm.oneItemPerLine')}</span>
                </div>
                <Textarea
                  id="plan-features"
                  rows={4}
                  placeholder={t('admin:planForm.featuresPlaceholder')}
                  {...form.register('featuresText')}
                />
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <span className="text-[11px] text-muted-foreground">{t('admin:planForm.quickFill')}</span>
                  {PRESET_FEATURE_KEYS.map((key) => {
                    const item = t(`admin:planForm.presets.${key}`);
                    return (
                      <Button
                        key={key}
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-6 text-[11px] px-2"
                        onClick={() => addPresetFeature(item)}
                      >
                        + {item.replace(/\[\w+\]\s*/, '').replace(/^!\s*/, '')}
                      </Button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs">{t('admin:planForm.lineMatchMode')}</Label>
                <Controller
                  control={form.control}
                  name="lineMatchMode"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ALL">{t('common:matchMode.ALL')}</SelectItem>
                        <SelectItem value="TAGS">{t('common:matchMode.TAGS')}</SelectItem>
                        <SelectItem value="EXPLICIT">{t('common:matchMode.EXPLICIT')}</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>

              {form.watch('lineMatchMode') === 'TAGS' && (
                <div className="space-y-2">
                  <Label htmlFor="plan-line-tags" className="text-xs">{t('admin:planForm.lineTagsLabel')}</Label>
                  <Input id="plan-line-tags" placeholder={t('admin:planForm.lineTagsPlaceholder')} {...form.register('lineTags')} />
                  {lineTags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {lineTags.map((tag) => (
                        <Button
                          key={tag}
                          type="button"
                          size="sm"
                          variant={selectedTags.includes(tag) ? 'secondary' : 'outline'}
                          onClick={() => toggleTag(tag)}
                        >
                          #{tag}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {form.watch('lineMatchMode') === 'EXPLICIT' && (
                <div className="space-y-2">
                  <Label className="text-xs">{t('admin:planForm.explicitLinesLabel')}</Label>
                  <div className="max-h-36 space-y-2 overflow-y-auto rounded-md border p-3">
                    {lineOptions.length ? (
                      lineOptions.map((line) => (
                        <div key={line.id} className="flex items-start gap-2">
                          <Checkbox
                            id={`plan-line-${line.id}`}
                            checked={selectedIds.includes(line.id)}
                            onCheckedChange={() => toggleLine(line.id)}
                          />
                          <Label htmlFor={`plan-line-${line.id}`} className="cursor-pointer text-sm font-normal">
                            <span className="font-medium">{line.name}</span>
                            <span className="ml-2 text-xs text-muted-foreground">
                              {line.serverHost}:{line.serverPort}
                            </span>
                          </Label>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-muted-foreground">{t('admin:planForm.emptyLines')}</p>
                    )}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <Label className="text-xs">{t('admin:planForm.templateLabel')}</Label>
                <Controller
                  control={form.control}
                  name="templateId"
                  render={({ field }) => (
                    <Select
                      value={field.value || 'none'}
                      onValueChange={(value) => field.onChange(value === 'none' ? '' : value)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t('admin:planForm.selectTemplate')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">{t('admin:planForm.defaultTemplate')}</SelectItem>
                        {templateOptions.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>

              <div className="flex items-center gap-3 py-1">
                <Controller
                  control={form.control}
                  name="isPublic"
                  render={({ field }) => <Switch id="plan-public" checked={field.value} onCheckedChange={field.onChange} />}
                />
                <Label htmlFor="plan-public" className="text-xs cursor-pointer">
                  {t('admin:planForm.isPublic')}
                </Label>
              </div>
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t('common:actions.cancel')}
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? t('admin:planForm.saving') : t('admin:planForm.savePlan')}
              </Button>
            </DialogFooter>
          </form>

          {/* 右侧：所见即所得实机卡片预览 (Live Preview) */}
          <div className="space-y-4 lg:col-span-5 lg:sticky lg:top-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Eye className="h-4 w-4 text-primary" />
                <h4 className="text-sm font-semibold text-foreground">{t('admin:planForm.livePreview')}</h4>
              </div>
              <Badge variant="outline" className="text-[11px] gap-1 font-normal text-muted-foreground">
                {t('admin:planForm.whatYouSeeIsWhatYouGet')}
              </Badge>
            </div>

            <div className="rounded-2xl border bg-muted/20 p-4 sm:p-5 flex items-center justify-center min-h-[460px]">
              <div className="w-full max-w-sm">
                <MarketPlanCard plan={previewPlan} isPreview />
              </div>
            </div>
          </div>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
