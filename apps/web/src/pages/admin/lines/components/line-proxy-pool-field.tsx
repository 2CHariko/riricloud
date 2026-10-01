import type { UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Switch } from '@/components/ui/switch';
import type { LineFormValues } from './line-form-schema';
import { canEnableProxyPool } from './proxy-pool-line-capabilities';

export function LineProxyPoolField({ form }: { form: UseFormReturn<LineFormValues> }) {
  const { t } = useTranslation('admin');
  const values = form.watch();
  const eligible = canEnableProxyPool(values);
  return <FormField control={form.control} name="proxyPoolEnabled" render={({ field }) => <FormItem>
    <div className="flex items-center justify-between gap-3">
      <FormLabel>{t('lineForm.proxyPoolEnabled')}</FormLabel>
      <FormControl><Switch checked={field.value} disabled={!eligible && !field.value} onCheckedChange={field.onChange} /></FormControl>
    </div>
    <FormDescription>{t(eligible ? 'lineForm.proxyPoolDesc' : 'lineForm.proxyPoolInvalid')}</FormDescription>
    <FormMessage />
  </FormItem>} />;
}
