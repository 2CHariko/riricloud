import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { ApiUpstreamSubscription, upstreamApi } from '@/lib/api';
import { useFormResetOnKey } from '@/hooks/use-form-reset';

const formSchema = z.object({
  name: z.string().trim().min(1),
  sourceType: z.enum(['URL', 'TEXT']),
  format: z.enum(['AUTO', 'CLASH_META', 'SINGBOX', 'URI_LIST']),
  url: z.string().optional(),
  content: z.string().optional(),
  autoUpdate: z.boolean(),
  updateIntervalHours: z.coerce.number().min(1).max(720)
});

type FormValues = z.infer<typeof formSchema>;
export type UpstreamFormSubmitValues = Parameters<typeof upstreamApi.create>[0];

export function UpstreamFormDialog({
  open,
  onOpenChange,
  current,
  onSubmit,
  isPending
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current?: ApiUpstreamSubscription | null;
  onSubmit: (values: UpstreamFormSubmitValues) => void;
  isPending?: boolean;
}) {
  const { t } = useTranslation(['admin', 'common']);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      sourceType: 'URL',
      format: 'AUTO',
      url: '',
      content: '',
      autoUpdate: true,
      updateIntervalHours: 12
    }
  });

  useFormResetOnKey({
    open,
    resetKey: current?.id ?? 'create',
    reset: () => {
      if (current) {
        form.reset({
          name: current.name,
          sourceType: current.sourceType as 'URL' | 'TEXT',
          format: current.format as 'AUTO' | 'CLASH_META' | 'SINGBOX' | 'URI_LIST',
          url: current.url || '',
          content: '',
          autoUpdate: current.autoUpdate,
          updateIntervalHours: Math.max(1, Math.round(current.updateIntervalMins / 60))
        });
      } else {
        form.reset({
          name: '',
          sourceType: 'URL',
          format: 'AUTO',
          url: '',
          content: '',
          autoUpdate: true,
          updateIntervalHours: 12
        });
      }
    }
  });

  const sourceType = form.watch('sourceType');

  const handleSubmit = (values: FormValues) => {
    onSubmit({
      name: values.name,
      sourceType: values.sourceType,
      format: values.format,
      url: values.sourceType === 'URL' ? values.url : undefined,
      content: values.sourceType === 'TEXT' ? values.content : undefined,
      autoUpdate: values.autoUpdate,
      updateIntervalMins: values.updateIntervalHours * 60
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {current ? t('admin:upstream.editSubscription') : t('admin:upstream.addSubscription')}
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('admin:upstream.name')}</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="sourceType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('admin:upstream.sourceType')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="URL">{t('admin:upstream.sourceTypeUrl')}</SelectItem>
                        <SelectItem value="TEXT">{t('admin:upstream.sourceTypeText')}</SelectItem>
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
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="AUTO">{t('admin:upstream.formatAuto')}</SelectItem>
                        <SelectItem value="CLASH_META">{t('admin:upstream.formatClash')}</SelectItem>
                        <SelectItem value="SINGBOX">{t('admin:upstream.formatSingbox')}</SelectItem>
                        <SelectItem value="URI_LIST">{t('admin:upstream.formatUri')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {sourceType === 'URL' ? (
              <FormField
                control={form.control}
                name="url"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('admin:upstream.url')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('admin:upstream.urlPlaceholder')} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : (
              <FormField
                control={form.control}
                name="content"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('admin:upstream.content')}</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={6}
                        placeholder={t('admin:upstream.contentPlaceholder')}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <div className="rounded-lg border p-4 space-y-3 bg-muted/20">
              <FormField
                control={form.control}
                name="autoUpdate"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <FormLabel>{t('admin:upstream.autoUpdate')}</FormLabel>
                      <FormDescription>{t('admin:upstream.autoUpdateDesc')}</FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />

              {form.watch('autoUpdate') && (
                <FormField
                  control={form.control}
                  name="updateIntervalHours"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('admin:upstream.updateIntervalMins')}</FormLabel>
                      <FormControl>
                        <Input type="number" min={1} max={720} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t('common:actions.cancel')}
              </Button>
              <Button type="submit" disabled={isPending}>
                {t('common:actions.save')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
