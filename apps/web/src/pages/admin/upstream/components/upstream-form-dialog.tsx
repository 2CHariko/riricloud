import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import {
  Eye,
  EyeOff,
  Pencil,
  ChevronRight,
  Lock,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { ApiUpstreamSubscription, upstreamApi } from '@/lib/api';
import { useFormResetOnKey } from '@/hooks/use-form-reset';
import i18n from '@/i18n/config';

const formSchema = z.object({
  name: z.string().trim().min(1, i18n.t('admin:upstream.nameRequired')).max(128),
  sourceType: z.enum(['URL', 'TEXT']),
  format: z.enum(['AUTO', 'CLASH_META', 'SINGBOX', 'URI_LIST']),
  url: z.string(),
  content: z.string(),
  customHeaders: z.string(),
  status: z.enum(['ACTIVE', 'DISABLED']),
  autoUpdate: z.boolean(),
  updateIntervalMins: z.coerce
    .number()
    .int(i18n.t('admin:upstream.intervalInvalid'))
    .min(10, i18n.t('admin:upstream.intervalInvalid'))
    .max(43200, i18n.t('admin:upstream.intervalInvalid')),
});

type FormValues = z.infer<typeof formSchema>;
export type UpstreamFormSubmitValues = Parameters<typeof upstreamApi.create>[0];

const defaults: FormValues = {
  name: '',
  sourceType: 'URL',
  format: 'AUTO',
  url: '',
  content: '',
  customHeaders: '{}',
  status: 'ACTIVE',
  autoUpdate: true,
  updateIntervalMins: 720,
};

export function UpstreamFormDialog({
  open,
  onOpenChange,
  current,
  onSubmit,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current?: ApiUpstreamSubscription | null;
  onSubmit: (values: UpstreamFormSubmitValues) => void;
  isPending?: boolean;
}) {
  const { t } = useTranslation(['admin', 'common']);
  const isEditing = !!current;

  // 编辑模式下是否展开修改凭据
  const [editUrl, setEditUrl] = useState(!isEditing);
  const [showPassword, setShowPassword] = useState(false);
  const [showHeaders, setShowHeaders] = useState(false);

  const detail = useQuery({
    queryKey: ['admin-upstream-detail', current?.id, open],
    queryFn: async () => (await upstreamApi.detail(current!.id)).data.subscription,
    enabled: open && isEditing,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  const ready = !current || (detail.isFetchedAfterMount && !!detail.data);
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: defaults,
  });

  useFormResetOnKey({
    open,
    resetKey: current ? (ready ? current.id : null) : 'create',
    reset: () => {
      setEditUrl(!current);
      setShowPassword(false);
      setShowHeaders(false);
      const fresh = detail.data;
      form.reset(
        current && fresh
          ? {
              name: fresh.name,
              sourceType: fresh.sourceType,
              format: fresh.format,
              url: '',
              content: '',
              customHeaders: JSON.stringify(fresh.customHeaders ?? {}, null, 2),
              status: fresh.status,
              autoUpdate: fresh.autoUpdate,
              updateIntervalMins: fresh.updateIntervalMins,
            }
          : defaults
      );
    },
  });

  const sourceType = form.watch('sourceType');
  const autoUpdate = form.watch('autoUpdate');

  const submit = (values: FormValues) => {
    const fresh = detail.data;
    const replacingSource = !current || fresh?.sourceType !== values.sourceType;

    const payload: UpstreamFormSubmitValues = {
      name: values.name,
      sourceType: values.sourceType,
      format: values.format,
      status: values.status,
      ...(values.sourceType === 'URL'
        ? {
            autoUpdate: values.autoUpdate,
            updateIntervalMins: values.updateIntervalMins,
          }
        : {}),
    };

    if (values.sourceType === 'URL') {
      const shouldSubmitUrl = replacingSource || editUrl;
      if (shouldSubmitUrl) {
        if (!values.url.trim()) {
          form.setError('url', { message: t('admin:upstream.urlRequired') });
          return;
        }
        try {
          const parsed = new URL(values.url.trim());
          if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
        } catch {
          form.setError('url', { message: t('admin:upstream.urlRequired') });
          return;
        }
        payload.url = values.url.trim();
      }

      if (replacingSource || form.formState.dirtyFields.customHeaders) {
        try {
          const headers: unknown = JSON.parse(values.customHeaders || '{}');
          if (
            !headers ||
            typeof headers !== 'object' ||
            Array.isArray(headers) ||
            Object.values(headers).some((v) => typeof v !== 'string')
          ) {
            throw new Error();
          }
          payload.customHeaders = z.record(z.string()).parse(headers);
        } catch {
          form.setError('customHeaders', { message: t('admin:upstream.headersInvalid') });
          return;
        }
      }
    } else {
      const shouldSubmitContent = replacingSource || editUrl;
      if (shouldSubmitContent) {
        if (!values.content.trim()) {
          form.setError('content', { message: t('admin:upstream.contentRequired') });
          return;
        }
        payload.content = values.content;
      }
    }

    onSubmit(payload);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {current
              ? t('admin:upstream.editSubscription')
              : t('admin:upstream.addSubscription')}
          </DialogTitle>
        </DialogHeader>

        {!ready ? (
          <div className="space-y-3 py-6 text-center">
            <p className="text-sm text-muted-foreground">
              {detail.isError ? t('common:status.failed') : t('common:actions.loading')}
            </p>
            {detail.isError && (
              <Button onClick={() => void detail.refetch()} size="sm">
                {t('admin:upstream.retry')}
              </Button>
            )}
          </div>
        ) : (
          <Form {...form}>
            <form noValidate onSubmit={form.handleSubmit(submit)} className="space-y-4">
              {/* 区块 1：基础设置（平铺无卡片） */}
              <div className="space-y-3">
                <p className="text-xs font-semibold text-muted-foreground tracking-wide uppercase">
                  {t('admin:upstream.groupBasic')}
                </p>

                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('admin:upstream.name')}</FormLabel>
                      <FormControl>
                        <Input
                          placeholder={t('admin:upstream.nameRequired')}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="sourceType"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('admin:upstream.sourceType')}</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="URL">
                              {t('admin:upstream.sourceTypeUrl')}
                            </SelectItem>
                            <SelectItem value="TEXT">
                              {t('admin:upstream.sourceTypeText')}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="format"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('admin:upstream.format')}</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {(['AUTO', 'CLASH_META', 'SINGBOX', 'URI_LIST'] as const).map(
                              (f) => (
                                <SelectItem key={f} value={f}>
                                  {f}
                                </SelectItem>
                              )
                            )}
                          </SelectContent>
                        </Select>
                        {detail.data?.detectedFormat ? (
                          <FormDescription className="text-[11px]">
                            {t('admin:upstream.detectedFormat', {
                              format: detail.data.detectedFormat,
                            })}
                          </FormDescription>
                        ) : null}
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              <Separator className="my-2" />

              {/* 区块 2：订阅源与凭据（平铺无卡片） */}
              <div className="space-y-3">
                <p className="text-xs font-semibold text-muted-foreground tracking-wide uppercase">
                  {t('admin:upstream.groupSource')}
                </p>

                {sourceType === 'URL' ? (
                  <div className="space-y-3">
                    {isEditing && !editUrl ? (
                      <div className="space-y-1.5">
                        <FormLabel>{t('admin:upstream.url')}</FormLabel>
                        <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-xs">
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <Lock className="size-3.5 shrink-0" />
                            <span className="font-mono">
                              {t('admin:upstream.maskedUrl')}
                            </span>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 text-xs gap-1 px-2"
                            onClick={() => setEditUrl(true)}
                          >
                            <Pencil className="size-3" />
                            <span>{t('admin:upstream.editSourceUrl')}</span>
                          </Button>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          {t('admin:upstream.secretsHidden')}
                        </p>
                      </div>
                    ) : (
                      <FormField
                        control={form.control}
                        name="url"
                        render={({ field }) => (
                          <FormItem>
                            <div className="flex items-center justify-between">
                              <FormLabel>{t('admin:upstream.url')}</FormLabel>
                              {isEditing && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-5 p-0 text-[11px] text-muted-foreground hover:text-foreground"
                                  onClick={() => {
                                    setEditUrl(false);
                                    field.onChange('');
                                  }}
                                >
                                  {t('admin:upstream.cancelEditSourceUrl')}
                                </Button>
                              )}
                            </div>
                            <FormControl>
                              <div className="relative">
                                <Input
                                  type={showPassword ? 'text' : 'password'}
                                  autoComplete="off"
                                  placeholder={t('admin:upstream.urlPlaceholder')}
                                  className="pr-9 font-mono text-xs"
                                  {...field}
                                />
                                <IconButton
                                  type="button"
                                  variant="ghost"
                                  size="icon-xs"
                                  className="absolute right-1 top-1 text-muted-foreground hover:text-foreground"
                                  aria-label={t('admin:upstream.togglePassword')}
                                  tooltip={t('admin:upstream.togglePassword')}
                                  onClick={() => setShowPassword(!showPassword)}
                                >
                                  {showPassword ? (
                                    <EyeOff className="size-3.5" />
                                  ) : (
                                    <Eye className="size-3.5" />
                                  )}
                                </IconButton>
                              </div>
                            </FormControl>
                            <FormDescription className="text-[11px]">
                              {t('admin:upstream.urlDirectInput')}
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}

                    {/* 自定义请求头 (JSON) 折叠配置 */}
                    <div className="pt-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-muted-foreground gap-1.5 px-0 hover:text-foreground"
                        onClick={() => setShowHeaders(!showHeaders)}
                      >
                        <ChevronRight
                          className={`size-3.5 transition-transform duration-200 ${
                            showHeaders ? 'rotate-90' : ''
                          }`}
                        />
                        <span>{t('admin:upstream.headersCollapse')}</span>
                      </Button>

                      {showHeaders ? (
                        <div className="mt-2 space-y-1 animate-in fade-in-50 duration-200">
                          <FormField
                            control={form.control}
                            name="customHeaders"
                            render={({ field }) => (
                              <FormItem>
                                <FormDescription className="text-[11px]">
                                  {t('admin:upstream.headersCollapseDesc')}
                                </FormDescription>
                                <FormControl>
                                  <Textarea
                                    rows={3}
                                    className="font-mono text-xs"
                                    placeholder={t('admin:upstream.headersHint')}
                                    {...field}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {isEditing && !editUrl ? (
                      <div className="space-y-1.5">
                        <FormLabel>{t('admin:upstream.content')}</FormLabel>
                        <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-xs">
                          <span className="font-mono text-muted-foreground">
                            {t('admin:upstream.maskedUrl')}
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 text-xs gap-1 px-2"
                            onClick={() => setEditUrl(true)}
                          >
                            <Pencil className="size-3" />
                            <span>{t('admin:upstream.editSourceUrl')}</span>
                          </Button>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          {t('admin:upstream.secretsHidden')}
                        </p>
                      </div>
                    ) : (
                      <FormField
                        control={form.control}
                        name="content"
                        render={({ field }) => (
                          <FormItem>
                            <div className="flex items-center justify-between">
                              <FormLabel>{t('admin:upstream.content')}</FormLabel>
                              {isEditing && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-5 p-0 text-[11px] text-muted-foreground hover:text-foreground"
                                  onClick={() => {
                                    setEditUrl(false);
                                    field.onChange('');
                                  }}
                                >
                                  {t('admin:upstream.cancelEditSourceUrl')}
                                </Button>
                              )}
                            </div>
                            <FormControl>
                              <Textarea
                                rows={6}
                                className="font-mono text-xs"
                                placeholder={t('admin:upstream.contentPlaceholder')}
                                {...field}
                              />
                            </FormControl>
                            <FormDescription className="text-[11px]">
                              {t('admin:upstream.textKeepHint')}
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}
                  </div>
                )}
              </div>

              <Separator className="my-2" />

              {/* 区块 3：调度与分发状态（平铺无卡片，标准 FormItem 对齐） */}
              <div className="space-y-3">
                <p className="text-xs font-semibold text-muted-foreground tracking-wide uppercase">
                  {t('admin:upstream.groupSchedule')}
                </p>

                {/* 启用开关（平面无边框） */}
                <FormField
                  control={form.control}
                  name="status"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between py-1">
                      <div className="space-y-0.5">
                        <FormLabel className="text-sm font-medium">
                          {t('admin:upstream.enableSubscription')}
                        </FormLabel>
                        <FormDescription className="text-xs">
                          {t('admin:upstream.enableSubscriptionDesc')}
                        </FormDescription>
                      </div>
                      <FormControl>
                        <Switch
                          checked={field.value === 'ACTIVE'}
                          onCheckedChange={(v) =>
                            field.onChange(v ? 'ACTIVE' : 'DISABLED')
                          }
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />

                {sourceType === 'URL' && (
                  <div className="space-y-3 pt-1">
                    <FormField
                      control={form.control}
                      name="autoUpdate"
                      render={({ field }) => (
                        <FormItem className="flex items-center justify-between py-1">
                          <div className="space-y-0.5">
                            <FormLabel className="text-sm font-medium">
                              {t('admin:upstream.autoUpdate')}
                            </FormLabel>
                            <FormDescription className="text-xs">
                              {t('admin:upstream.autoUpdateDesc')}
                            </FormDescription>
                          </div>
                          <FormControl>
                            <Switch
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />

                    {autoUpdate ? (
                      <FormField
                        control={form.control}
                        name="updateIntervalMins"
                        render={({ field }) => (
                          <FormItem className="space-y-2 pt-1">
                            <div className="flex flex-wrap items-center justify-between gap-1">
                              <FormLabel className="text-xs text-muted-foreground">
                                {t('admin:upstream.updateIntervalMins')}
                              </FormLabel>
                              <div className="flex items-center gap-1">
                                {[
                                  { label: t('admin:upstream.preset1h'), mins: 60 },
                                  { label: t('admin:upstream.preset6h'), mins: 360 },
                                  { label: t('admin:upstream.preset12h'), mins: 720 },
                                  { label: t('admin:upstream.preset24h'), mins: 1440 },
                                ].map((preset) => (
                                  <Button
                                    key={preset.mins}
                                    type="button"
                                    variant={
                                      field.value === preset.mins
                                        ? 'secondary'
                                        : 'outline'
                                    }
                                    size="sm"
                                    className="h-6 text-[11px] px-2 font-normal"
                                    onClick={() => field.onChange(preset.mins)}
                                  >
                                    {preset.label}
                                  </Button>
                                ))}
                              </div>
                            </div>
                            <FormControl>
                              <Input
                                type="number"
                                min={10}
                                max={43200}
                                className="h-8 font-mono text-xs"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    ) : null}
                  </div>
                )}
              </div>

              <DialogFooter className="pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  {t('common:actions.cancel')}
                </Button>
                <Button type="submit" disabled={isPending || !ready}>
                  {t('common:actions.save')}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}
