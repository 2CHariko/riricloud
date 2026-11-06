import * as React from 'react';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@/lib/zod-resolver';
import { useTranslation } from 'react-i18next';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Plan } from '../../plans/use-plans';
import type { RedeemCodeCategory, RedeemCodeCategoryPayload } from '../use-redeem-codes';
import { useFormResetOnKey } from '@/hooks/use-form-reset';

export interface CategoryFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  category?: RedeemCodeCategory | null;
  plans: Plan[];
  pending: boolean;
  onSubmit: (payload: RedeemCodeCategoryPayload) => Promise<void>;
}

export function CategoryFormDialog({ open, onOpenChange, category, plans, pending, onSubmit }: CategoryFormDialogProps) {
  const { t, i18n } = useTranslation(['admin', 'common']);
  const schema = React.useMemo(() => z.object({
    name: z.string().trim()
      .min(1, t('admin:redeemCodes.valCategoryNameRequired'))
      .max(80, t('admin:redeemCodes.valCategoryNameMax')),
    tags: z.string(),
    rewardType: z.enum(['BALANCE', 'PLAN']),
    rewardAmountYuan: z.coerce.number({ error: t('admin:redeemCodes.valAmountInvalid') })
      .positive(t('admin:redeemCodes.valAmountPositive'))
      .multipleOf(0.01, t('admin:redeemCodes.valAmountDecimals'))
      .optional(),
    planId: z.string(),
    limit: z.string().refine(
      (value) => value === '' || (/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))),
      t('admin:redeemCodes.valIdentityLimit')
    )
  }).superRefine((value, ctx) => {
    if (value.rewardType === 'BALANCE') {
      const amount = value.rewardAmountYuan;
      if (amount == null) {
        ctx.addIssue({ code: 'custom', path: ['rewardAmountYuan'], message: t('admin:redeemCodes.valAmountPositive') });
      }
    }
    if (value.rewardType === 'PLAN' && !value.planId) ctx.addIssue({ code: 'custom', path: ['planId'], message: t('admin:redeemCodes.planRequired') });
  }), [t]);
  type Values = z.infer<typeof schema>;
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: {
    name: '', tags: '', rewardType: 'BALANCE', rewardAmountYuan: 10, planId: '', limit: '1'
  } });
  const rewardType = form.watch('rewardType');
  const { trigger } = form;
  const errorFieldsRef = React.useRef<Array<keyof Values>>([]);

  React.useEffect(() => {
    errorFieldsRef.current = Object.keys(form.formState.errors) as Array<keyof Values>;
  }, [form.formState.errors]);
  React.useEffect(() => {
    if (errorFieldsRef.current.length > 0) void trigger(errorFieldsRef.current);
  }, [trigger, i18n.resolvedLanguage]);

  useFormResetOnKey({
    open,
    resetKey: category?.id ?? 'create',
    reset: () => form.reset({
      name: category?.name ?? '', tags: category?.tags.join(', ') ?? '',
      rewardType: category?.rewardType ?? 'BALANCE',
      rewardAmountYuan: category?.rewardAmount ? category.rewardAmount / 100 : 10,
      planId: category?.planId ?? '', limit: category?.limitPerIdentity == null ? '' : String(category.limitPerIdentity)
    })
  });

  const submit = async (values: Values) => {
    try {
      await onSubmit({
        name: values.name.trim(), tags: values.tags.split(',').map((tag) => tag.trim()).filter(Boolean), rewardType: values.rewardType,
        ...(values.rewardType === 'BALANCE' ? { rewardAmount: Math.round((values.rewardAmountYuan ?? 0) * 100) } : { planId: values.planId }),
        limitPerIdentity: values.limit ? Number(values.limit) : null
      });
      onOpenChange(false);
    } catch {
      // Mutation errors are surfaced by the owning query hook; keep the form open for correction or retry.
    }
  };

  return <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
    <ResponsiveDialogContent>
      <DialogHeader><DialogTitle>{category ? t('admin:redeemCodes.editCategory') : t('admin:redeemCodes.createCategory')}</DialogTitle><DialogDescription>{t('admin:redeemCodes.categoryDialogDesc')}</DialogDescription></DialogHeader>
      <Form {...form}><form noValidate onSubmit={form.handleSubmit(submit)} className="grid gap-4 sm:grid-cols-2">
        <FormField control={form.control} name="name" render={({ field }) => <FormItem className="sm:col-span-2"><FormLabel>{t('admin:redeemCodes.categoryName')}</FormLabel><FormControl><Input maxLength={80} {...field} /></FormControl><FormMessage /></FormItem>} />
        <FormField control={form.control} name="tags" render={({ field }) => <FormItem className="sm:col-span-2"><FormLabel>{t('admin:redeemCodes.categoryTags')}</FormLabel><FormControl><Input placeholder={t('admin:redeemCodes.categoryTagsPlaceholder')} {...field} /></FormControl><FormDescription>{t('admin:redeemCodes.categoryTagsDesc')}</FormDescription><FormMessage /></FormItem>} />
        <FormField control={form.control} name="rewardType" render={({ field }) => <FormItem><FormLabel>{t('admin:redeemCodes.rewardType')}</FormLabel><Select value={field.value} onValueChange={field.onChange}><FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent><SelectItem value="BALANCE">{t('admin:redeemCodes.typeBalance')}</SelectItem><SelectItem value="PLAN">{t('admin:redeemCodes.typePlan')}</SelectItem></SelectContent></Select><FormMessage /></FormItem>} />
        {rewardType === 'BALANCE' ? <FormField control={form.control} name="rewardAmountYuan" render={({ field }) => <FormItem><FormLabel>{t('admin:redeemCodes.amountLabel')}</FormLabel><FormControl><Input type="number" min="0.01" step="0.01" {...field} /></FormControl><FormMessage /></FormItem>} /> : <FormField control={form.control} name="planId" render={({ field }) => <FormItem><FormLabel>{t('admin:redeemCodes.planLabel')}</FormLabel><Select value={field.value || undefined} onValueChange={field.onChange}><FormControl><SelectTrigger><SelectValue placeholder={t('admin:redeemCodes.selectPlan')} /></SelectTrigger></FormControl><SelectContent>{plans.map((plan) => <SelectItem key={plan.id} value={plan.id}>{plan.name}</SelectItem>)}</SelectContent></Select><FormMessage /></FormItem>} />}
        <FormField control={form.control} name="limit" render={({ field }) => <FormItem className="sm:col-span-2"><FormLabel>{t('admin:redeemCodes.identityLimit')}</FormLabel><FormControl><Input inputMode="numeric" placeholder={t('admin:redeemCodes.identityLimitPlaceholder')} {...field} /></FormControl><FormDescription>{t('admin:redeemCodes.identityLimitDesc')}</FormDescription><FormMessage /></FormItem>} />
        <DialogFooter className="sm:col-span-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common:actions.cancel')}</Button><Button type="submit" disabled={pending}>{pending ? t('common:actions.saving') : t('common:actions.save')}</Button></DialogFooter>
      </form></Form>
    </ResponsiveDialogContent>
  </ResponsiveDialog>;
}
