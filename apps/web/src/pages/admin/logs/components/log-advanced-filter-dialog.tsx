import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { useFormResetOnKey } from '@/hooks/use-form-reset';
import { advancedFilterPatch, toLocalDateTimeInput, type AdvancedFilterDraft } from '../log-presentation';
import type { LogsFilter } from '../types';

interface LogAdvancedFilterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filter: LogsFilter;
  onChange: (patch: Partial<LogsFilter>) => void;
}

export function LogAdvancedFilterDialog({ open, onOpenChange, filter, onChange }: LogAdvancedFilterDialogProps) {
  const { t } = useTranslation(['admin', 'common']);
  const dateTime = z.string().refine((value) => !value || Number.isFinite(new Date(value).getTime()), t('admin:logs.invalidDateTime'));
  const schema = z.object({ module: z.string(), startTime: dateTime, endTime: dateTime }).refine(
    ({ startTime, endTime }) => !startTime || !endTime || new Date(startTime) <= new Date(endTime),
    { path: ['endTime'], message: t('admin:logs.invalidTimeRange') }
  );
  const form = useForm<AdvancedFilterDraft>({ resolver: zodResolver(schema), defaultValues: { module: '', startTime: '', endTime: '' } });
  useFormResetOnKey({ open, resetKey: 'logs-advanced', reset: () => form.reset({
    module: filter.module, startTime: toLocalDateTimeInput(filter.startTime), endTime: toLocalDateTimeInput(filter.endTime)
  }) });
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent>
        <DialogHeader className="pr-8">
          <DialogTitle>{t('admin:logs.advancedFilters')}</DialogTitle>
          <DialogDescription>{t('admin:logs.advancedFiltersDescription')}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form noValidate className="space-y-4" onSubmit={form.handleSubmit((draft) => {
            onChange(advancedFilterPatch(draft));
            onOpenChange(false);
          })}>
            <FormField control={form.control} name="module" render={({ field }) => (
              <FormItem><FormLabel>{t('admin:logs.moduleTitle')}</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <div className="grid gap-4 sm:grid-cols-2">
              {(['startTime', 'endTime'] as const).map((name) => (
                <FormField key={name} control={form.control} name={name} render={({ field }) => (
                  <FormItem><FormLabel>{t(`admin:logs.${name}`)}</FormLabel>
                    <FormControl><Input type="datetime-local" step="0.001" className="min-w-0" {...field} /></FormControl><FormMessage />
                  </FormItem>
                )} />
              ))}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common:actions.cancel')}</Button>
              <Button type="submit">{t('common:actions.apply')}</Button>
            </DialogFooter>
          </form>
        </Form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
