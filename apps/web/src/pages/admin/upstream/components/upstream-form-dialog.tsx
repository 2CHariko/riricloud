import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { ApiUpstreamSubscription, upstreamApi } from '@/lib/api';
import { useFormResetOnKey } from '@/hooks/use-form-reset';
import i18n from '@/i18n/config';

const formSchema = z.object({
  name: z.string().trim().min(1, i18n.t('admin:upstream.nameRequired')).max(128),
  sourceType: z.enum(['URL', 'TEXT']),
  format: z.enum(['AUTO', 'CLASH_META', 'SINGBOX', 'URI_LIST']),
  url: z.string(), content: z.string(), customHeaders: z.string(),
  status: z.enum(['ACTIVE', 'DISABLED']),
  autoUpdate: z.boolean(), updateIntervalMins: z.coerce.number().int(i18n.t('admin:upstream.intervalInvalid')).min(10, i18n.t('admin:upstream.intervalInvalid')).max(43200, i18n.t('admin:upstream.intervalInvalid'))
});
type FormValues = z.infer<typeof formSchema>;
export type UpstreamFormSubmitValues = Parameters<typeof upstreamApi.create>[0];
const defaults: FormValues = { name: '', sourceType: 'URL', format: 'AUTO', url: '', content: '', customHeaders: '{}', status: 'ACTIVE', autoUpdate: true, updateIntervalMins: 720 };

export function UpstreamFormDialog({ open, onOpenChange, current, onSubmit, isPending }: {
  open: boolean; onOpenChange: (open: boolean) => void; current?: ApiUpstreamSubscription | null;
  onSubmit: (values: UpstreamFormSubmitValues) => void; isPending?: boolean;
}) {
  const { t } = useTranslation(['admin', 'common']);
  const [showSecrets, setShowSecrets] = useState(false);
  const detail = useQuery({
    queryKey: ['admin-upstream-detail', current?.id, open],
    queryFn: async () => (await upstreamApi.detail(current!.id)).data.subscription,
    enabled: open && !!current, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false
  });
  const ready = !current || (detail.isFetchedAfterMount && !!detail.data);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: defaults });
  useFormResetOnKey({
    open,
    resetKey: current ? (ready ? current.id : null) : 'create',
    reset: () => {
      setShowSecrets(false);
      const fresh = detail.data;
      form.reset(current && fresh ? {
        name: fresh.name, sourceType: fresh.sourceType, format: fresh.format,
        url: fresh.url ?? '', content: fresh.content ?? '', customHeaders: JSON.stringify(fresh.customHeaders, null, 2),
        status: fresh.status, autoUpdate: fresh.autoUpdate, updateIntervalMins: fresh.updateIntervalMins
      } : defaults);
    }
  });
  const sourceType = form.watch('sourceType');
  const submit = (values: FormValues) => {
    const fresh = detail.data;
    const replacingSource = !current || fresh?.sourceType !== values.sourceType;
    const payload: UpstreamFormSubmitValues = {
      name: values.name, sourceType: values.sourceType, format: values.format, status: values.status,
      ...(values.sourceType === 'URL' ? { autoUpdate: values.autoUpdate, updateIntervalMins: values.updateIntervalMins } : {})
    };
    if (values.sourceType === 'URL') {
      if (replacingSource || form.formState.dirtyFields.url) {
        try {
          const url = new URL(values.url.trim());
          if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
        } catch { form.setError('url', { message: t('admin:upstream.urlRequired') }); return; }
        payload.url = values.url.trim();
      }
      if (replacingSource || form.formState.dirtyFields.customHeaders) {
        try {
          const headers: unknown = JSON.parse(values.customHeaders || '{}');
          if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.values(headers).some((v) => typeof v !== 'string')) throw new Error();
          payload.customHeaders = z.record(z.string()).parse(headers);
        } catch { form.setError('customHeaders', { message: t('admin:upstream.headersInvalid') }); return; }
      }
    } else if (replacingSource || form.formState.dirtyFields.content) {
      if (!values.content.trim()) { form.setError('content', { message: t('admin:upstream.contentRequired') }); return; }
      payload.content = values.content;
    }
    onSubmit(payload);
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
      <DialogHeader><DialogTitle>{current ? t('admin:upstream.editSubscription') : t('admin:upstream.addSubscription')}</DialogTitle></DialogHeader>
      {!ready ? <div className="space-y-3"><p>{detail.isError ? t('common:status.failed') : t('common:actions.loading')}</p>{detail.isError && <Button onClick={() => void detail.refetch()}>{t('admin:upstream.retry')}</Button>}</div> :
        <Form {...form}><form noValidate onSubmit={form.handleSubmit(submit)} className="space-y-4">
          <FormField control={form.control} name="name" render={({ field }) => <FormItem><FormLabel>{t('admin:upstream.name')}</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>} />
          <div className="grid grid-cols-2 gap-4">
            <FormField control={form.control} name="sourceType" render={({ field }) => <FormItem><FormLabel>{t('admin:upstream.sourceType')}</FormLabel><Select value={field.value} onValueChange={field.onChange}><FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent><SelectItem value="URL">{t('admin:upstream.sourceTypeUrl')}</SelectItem><SelectItem value="TEXT">{t('admin:upstream.sourceTypeText')}</SelectItem></SelectContent></Select><FormMessage /></FormItem>} />
            <FormField control={form.control} name="format" render={({ field }) => <FormItem><FormLabel>{t('admin:upstream.format')}</FormLabel><Select value={field.value} onValueChange={field.onChange}><FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent>{(['AUTO', 'CLASH_META', 'SINGBOX', 'URI_LIST'] as const).map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}</SelectContent></Select><FormDescription>{t('admin:upstream.detectedFormat', { format: detail.data?.detectedFormat ?? t('common:status.unknown') })}</FormDescription></FormItem>} />
          </div>
          <Button type="button" variant="outline" onClick={() => setShowSecrets((value) => !value)}>{t(showSecrets ? 'admin:upstream.hideSecrets' : 'admin:upstream.showSecrets')}</Button>
          {sourceType === 'URL' ? <>
            <FormField control={form.control} name="url" render={({ field }) => <FormItem><FormLabel>{t('admin:upstream.url')}</FormLabel><FormControl><Input type={showSecrets ? 'text' : 'password'} autoComplete="off" {...field} /></FormControl><FormMessage /></FormItem>} />
            {showSecrets ? <FormField control={form.control} name="customHeaders" render={({ field }) => <FormItem><FormLabel>{t('admin:upstream.customHeaders')}</FormLabel><FormDescription>{t('admin:upstream.headersHint')}</FormDescription><FormControl><Textarea rows={4} {...field} /></FormControl><FormMessage /></FormItem>} /> : <p className="text-sm text-muted-foreground">{t('admin:upstream.secretsHidden')}</p>}
          </> : showSecrets ? <FormField control={form.control} name="content" render={({ field }) => <FormItem><FormLabel>{t('admin:upstream.content')}</FormLabel><FormDescription>{t('admin:upstream.textKeepHint')}</FormDescription><FormControl><Textarea rows={6} {...field} /></FormControl><FormMessage /></FormItem>} /> : <p className="text-sm text-muted-foreground">{t('admin:upstream.secretsHidden')}</p>}
          <FormField control={form.control} name="status" render={({ field }) => <FormItem className="flex items-center justify-between"><FormLabel>{t('admin:upstream.statusActive')}</FormLabel><FormControl><Switch checked={field.value === 'ACTIVE'} onCheckedChange={(v) => field.onChange(v ? 'ACTIVE' : 'DISABLED')} /></FormControl></FormItem>} />
          {sourceType === 'URL' && <FormField control={form.control} name="autoUpdate" render={({ field }) => <FormItem className="flex items-center justify-between"><FormLabel>{t('admin:upstream.autoUpdate')}</FormLabel><FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl></FormItem>} />}
          {sourceType === 'URL' && form.watch('autoUpdate') && <FormField control={form.control} name="updateIntervalMins" render={({ field }) => <FormItem><FormLabel>{t('admin:upstream.updateIntervalMins')}</FormLabel><FormControl><Input type="number" min={10} max={43200} {...field} /></FormControl><FormMessage /></FormItem>} />}
          <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common:actions.cancel')}</Button><Button type="submit" disabled={isPending || !ready}>{t('common:actions.save')}</Button></DialogFooter>
        </form></Form>}
    </DialogContent>
  </Dialog>;
}
