import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@/lib/zod-resolver';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { useFormResetOnKey } from '@/hooks/use-form-reset';
import { validateCompatibilityText } from '../binary-labels';
import type { BinaryResource } from '../use-binaries';

interface ResourceEditValues {
  notes: string;
  compatibilityText: string;
}

export function ResourceEditDialog({ resource, open, onOpenChange, onSubmit, pending }: {
  resource: BinaryResource | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: { notes: string | null; compatibility?: Record<string, unknown> }) => void;
  pending: boolean;
}) {
  const { t } = useTranslation(['admin', 'common']);

  const editSchema = React.useMemo(() => z.object({
    notes: z.string().max(2000, t('admin:binaries.notesMax')),
    compatibilityText: z.string().superRefine((text, ctx) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const result = validateCompatibilityText(trimmed);
      if (!result.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.message });
    })
  }), [t]);

  const form = useForm<ResourceEditValues>({
    resolver: zodResolver(editSchema),
    defaultValues: { notes: '', compatibilityText: '' }
  });

  useFormResetOnKey({
    open,
    resetKey: resource?.id ?? 'create',
    reset: () => {
      let compatibilityText = '';
      if (resource?.compatibilityJson) {
        try {
          const parsed = JSON.parse(resource.compatibilityJson) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object' && Object.keys(parsed).length) {
            compatibilityText = JSON.stringify(parsed, null, 2);
          }
        } catch {
          compatibilityText = '';
        }
      }
      form.reset({ notes: resource?.notes ?? '', compatibilityText });
    }
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent size="compact">
        <DialogHeader>
          <DialogTitle>{resource ? t('admin:binaries.editTitle', { version: resource.version }) : t('admin:binaries.editTitleFallback')}</DialogTitle>
          <DialogDescription>{t('admin:binaries.editDesc')}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="space-y-4"
            onSubmit={form.handleSubmit((values) => {
              const trimmed = values.compatibilityText.trim();
              const compatibility = trimmed ? validateCompatibilityText(trimmed) : null;
              onSubmit({
                notes: values.notes.trim() || null,
                compatibility: compatibility && compatibility.ok ? compatibility.value : undefined
              });
            })}
          >
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('admin:binaries.notesLabel')}</FormLabel>
                  <FormControl>
                    <Textarea rows={3} {...field} placeholder={t('admin:binaries.notesPlaceholder')} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="compatibilityText"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('admin:binaries.compatLabel')}</FormLabel>
                  <FormControl>
                    <Textarea rows={5} className="font-mono text-xs" {...field} placeholder='{"minAgentProtocolVersion": 2}' />
                  </FormControl>
                  <FormDescription>
                    {t('admin:binaries.compatDesc')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common:actions.cancel')}</Button>
              <Button type="submit" disabled={pending}>{pending ? t('common:actions.loading') : t('admin:binaries.saveChanges')}</Button>
            </DialogFooter>
          </form>
        </Form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
