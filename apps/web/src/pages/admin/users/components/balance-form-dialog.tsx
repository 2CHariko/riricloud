import { zodResolver } from '@/lib/zod-resolver';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { useUserMutations, type AdminUser } from '../use-users';
import { formatCurrency } from '@/lib/utils';

const schema = z.object({ amountYuan: z.coerce.number(), description: z.string().max(200).optional() });
type Values = z.infer<typeof schema>;

export function BalanceFormDialog({ user, open, onOpenChange }: { user: AdminUser | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation(['admin', 'common']);
  const { adjustBalance } = useUserMutations();
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { amountYuan: 0, description: '' } });
  const submit = (values: Values) => {
    if (values.amountYuan === 0 || !Number.isInteger(values.amountYuan * 100)) {
      form.setError('amountYuan', { message: t('admin:balanceForm.amountError') });
      return;
    }
    adjustBalance.mutate({ id: user!.id, amount: Math.round(values.amountYuan * 100), description: values.description || undefined }, { onSuccess: () => { form.reset(); onOpenChange(false); } });
  };
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent size="compact">
        <DialogHeader>
          <DialogTitle>{t('admin:balanceForm.title', { email: user?.email ?? '' })}</DialogTitle>
          <DialogDescription>
            {t('admin:balanceForm.currentBalance', { amount: formatCurrency(user?.balance) })}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
            <FormField
              control={form.control}
              name="amountYuan"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('admin:balanceForm.amountLabel')}</FormLabel>
                  <FormControl><Input type="number" step="0.01" placeholder={t('admin:balanceForm.amountPlaceholder')} {...field} /></FormControl>
                  <FormDescription>{t('admin:balanceForm.balanceHint')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('admin:balanceForm.reasonLabel')}</FormLabel>
                  <FormControl><Input placeholder={t('admin:balanceForm.reasonPlaceholder')} {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t('common:actions.cancel')}
              </Button>
              <Button type="submit" disabled={adjustBalance.isPending}>
                {adjustBalance.isPending ? t('common:actions.saving') : t('admin:balanceForm.confirmAdjust')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
