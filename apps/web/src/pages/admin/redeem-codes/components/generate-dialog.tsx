import * as React from 'react';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import type { RedeemCodeCategory } from '../use-redeem-codes';
import { useFormResetOnKey } from '@/hooks/use-form-reset';

export interface GenerateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: RedeemCodeCategory[];
  onSubmit: (payload: { count: number; categoryId: string; prefix?: string; expiresAt?: string | null; note?: string }) => void;
  pending: boolean;
}

export function GenerateDialog({ open, onOpenChange, categories, onSubmit, pending }: GenerateDialogProps) {
  const { t, i18n } = useTranslation(['admin', 'common']);
  const schema = React.useMemo(() => z.object({
    count: z.coerce.number({ error: t('admin:redeemCodes.valCountInvalid') })
      .int(t('admin:redeemCodes.valCountInteger'))
      .min(1, t('admin:redeemCodes.valCountMin'))
      .max(1000, t('admin:redeemCodes.valCountMax')),
    categoryId: z.string().min(1, t('admin:redeemCodes.categoryRequired')),
    prefix: z.string().max(16, t('admin:redeemCodes.valPrefixMax')).regex(/^[A-Za-z0-9-]*$/, t('admin:redeemCodes.valPrefixChars')).optional(),
    expiresAt: z.string().optional(), note: z.string().max(200, t('admin:redeemCodes.valNoteMax')).optional()
  }), [t]);
  type FormValues = z.infer<typeof schema>;
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { count: 10, categoryId: '', prefix: '', expiresAt: '', note: '' } });
  const { trigger } = form;
  const errorFieldsRef = React.useRef<Array<keyof FormValues>>([]);

  React.useEffect(() => {
    errorFieldsRef.current = Object.keys(form.formState.errors) as Array<keyof FormValues>;
  }, [form.formState.errors]);
  React.useEffect(() => {
    if (errorFieldsRef.current.length > 0) void trigger(errorFieldsRef.current);
  }, [trigger, i18n.resolvedLanguage]);

  useFormResetOnKey({
    open,
    resetKey: 'generate',
    dataRevision: categories.length,
    isDirty: form.formState.isDirty,
    reset: () => form.reset({ count: 10, categoryId: categories[0]?.id ?? '', prefix: '', expiresAt: '', note: '' })
  });
  const category = categories.find((item) => item.id === form.watch('categoryId'));
  const submit = (values: FormValues) => onSubmit({ count: values.count, categoryId: values.categoryId, prefix: values.prefix || undefined, expiresAt: values.expiresAt ? new Date(values.expiresAt).toISOString() : null, note: values.note || undefined });

  return <ResponsiveDialog open={open} onOpenChange={onOpenChange}><ResponsiveDialogContent>
    <DialogHeader><DialogTitle>{t('admin:redeemCodes.batchGenerate')}</DialogTitle><DialogDescription>{t('admin:redeemCodes.generateDialogDesc')}</DialogDescription></DialogHeader>
    <Form {...form}><form noValidate onSubmit={form.handleSubmit(submit)} className="grid gap-4 sm:grid-cols-2">
      <FormField control={form.control} name="categoryId" render={({ field }) => <FormItem className="sm:col-span-2"><FormLabel>{t('admin:redeemCodes.category')}</FormLabel><Select value={field.value || undefined} onValueChange={field.onChange}><FormControl><SelectTrigger><SelectValue placeholder={t('admin:redeemCodes.selectCategory')} /></SelectTrigger></FormControl><SelectContent>{categories.map((item) => <SelectItem key={item.id} value={item.id}>{item.name} · {item.rewardType === 'BALANCE' ? t('admin:redeemCodes.balanceReward', { amount: (item.rewardAmount ?? 0) / 100 }) : item.plan?.name ?? t('admin:redeemCodes.typePlan')}</SelectItem>)}</SelectContent></Select><FormDescription>{category ? `${category.limitPerIdentity == null ? t('admin:redeemCodes.unlimited') : t('admin:redeemCodes.identityLimitCount', { count: category.limitPerIdentity })} · ${t('admin:redeemCodes.snapshotAtGeneration')}` : t('admin:redeemCodes.categoryRequired')}</FormDescription><FormMessage /></FormItem>} />
      <FormField control={form.control} name="count" render={({ field }) => <FormItem><FormLabel>{t('admin:redeemCodes.countLabel')}</FormLabel><FormControl><Input type="number" min={1} max={1000} {...field} /></FormControl><FormMessage /></FormItem>} />
      <FormField control={form.control} name="prefix" render={({ field }) => <FormItem><FormLabel>{t('admin:redeemCodes.prefixLabel')}</FormLabel><FormControl><Input placeholder={t('admin:redeemCodes.prefixPlaceholder')} {...field} /></FormControl><FormMessage /></FormItem>} />
      <FormField control={form.control} name="expiresAt" render={({ field }) => <FormItem><FormLabel>{t('admin:redeemCodes.expiresAtLabel')}</FormLabel><FormControl><Input type="datetime-local" {...field} /></FormControl><FormDescription>{t('admin:redeemCodes.expiresAtDesc')}</FormDescription><FormMessage /></FormItem>} />
      <FormField control={form.control} name="note" render={({ field }) => <FormItem><FormLabel>{t('admin:redeemCodes.noteLabel')}</FormLabel><FormControl><Input placeholder={t('admin:redeemCodes.notePlaceholder')} {...field} /></FormControl><FormMessage /></FormItem>} />
      <DialogFooter className="sm:col-span-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common:actions.cancel')}</Button><Button type="submit" disabled={pending || categories.length === 0}>{pending ? t('admin:redeemCodes.generating') : t('admin:redeemCodes.generate')}</Button></DialogFooter>
    </form></Form>
  </ResponsiveDialogContent></ResponsiveDialog>;
}
