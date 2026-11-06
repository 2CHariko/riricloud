import { zodResolver } from '@/lib/zod-resolver';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { useProfileMutations } from '@/pages/user/profile/use-profile';

export function QuickRedeemForm() {
  const { t } = useTranslation(['user', 'common']);
  const { redeem } = useProfileMutations();

  const schema = z.object({
    code: z.string().trim().min(6, t('user:quickRedeem.invalidCode')).max(128)
  });
  type Values = z.infer<typeof schema>;

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { code: '' }
  });

  return (
    <Form {...form}>
      <form
        className="mt-3 space-y-2"
        onSubmit={form.handleSubmit((values) =>
          redeem.mutate(values.code, { onSuccess: () => form.reset() })
        )}
      >
        <FormField
          control={form.control}
          name="code"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs">{t('user:quickRedeem.insufficientBalance')}</FormLabel>
              <div className="flex gap-2">
                <FormControl>
                  <Input placeholder={t('user:quickRedeem.codePlaceholder')} autoComplete="off" {...field} />
                </FormControl>
                <Button type="submit" variant="outline" disabled={redeem.isPending}>
                  {redeem.isPending ? t('user:quickRedeem.redeeming') : t('user:quickRedeem.rechargeAction')}
                </Button>
              </div>
              <FormMessage />
            </FormItem>
          )}
        />
        <p className="text-xs text-muted-foreground">
          {t('user:quickRedeem.profileHintPrefix')}
          <Link className="text-primary underline underline-offset-4" to="/profile">
            {t('common:nav.profile')}
          </Link>
          {t('user:quickRedeem.profileHintSuffix')}
        </p>
      </form>
    </Form>
  );
}

