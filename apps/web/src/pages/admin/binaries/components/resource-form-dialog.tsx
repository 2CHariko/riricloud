import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@/lib/zod-resolver';
import { z } from 'zod';
import { FileArchive, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useFormResetOnKey } from '@/hooks/use-form-reset';
import { bytes } from '../binary-labels';
import { resolveSupportedTargets } from '../use-binaries';

const OS_LABELS: Record<string, string> = { linux: 'Linux', macos: 'macOS', windows: 'Windows' };

function targetLabel(target: string) {
  const [, os, arch] = target.split('-');
  return `Agent · ${OS_LABELS[os] ?? os} ${(arch ?? '').toUpperCase()}`;
}

export interface ResourceFormSubmitValue {
  files?: File[];
  url?: string;
  upstreamVersion?: string;
  target?: string;
  notes?: string;
}

interface ResourceFormValues {
  upstreamVersion: string;
  target: string;
  notes: string;
  url: string;
}

const EMPTY_VALUES: ResourceFormValues = {
  upstreamVersion: '',
  target: 'AUTO',
  notes: '',
  url: ''
};

export function ResourceFormDialog({
  mode,
  open,
  onOpenChange,
  onSubmit,
  pending,
  supportedTargets
}: {
  mode: 'upload' | 'import';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: ResourceFormSubmitValue) => void;
  pending: boolean;
  supportedTargets?: string[];
}) {
  const { t } = useTranslation(['admin', 'common']);
  const targets = resolveSupportedTargets(supportedTargets);
  const [files, setFiles] = React.useState<File[]>([]);
  const [fileError, setFileError] = React.useState<string | null>(null);

  const schema = React.useMemo(
    () =>
      z
        .object({
          upstreamVersion: z.string().trim().max(64, t('admin:binaries.valUpstreamMax')),
          target: z.string(),
          notes: z.string().trim().max(2000, t('admin:binaries.notesMax')),
          url: z.string().trim()
        })
        .superRefine((value, ctx) => {
          if (mode === 'import') {
            if (!value.url) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['url'],
                message: t('admin:binaries.valUrlRequired')
              });
              return;
            }
            if (!/^https?:\/\//i.test(value.url)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['url'],
                message: t('admin:binaries.valUrlInvalid')
              });
            }
          }
        }),
    [mode, t]
  );

  const form = useForm<ResourceFormValues>({
    resolver: zodResolver(schema),
    defaultValues: EMPTY_VALUES
  });

  useFormResetOnKey({
    open,
    resetKey: mode,
    reset: () => {
      form.reset(EMPTY_VALUES);
      setFiles([]);
      setFileError(null);
    }
  });

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    setFiles(selected);
    if (selected.length > 0) setFileError(null);
  };

  const handleSubmit = form.handleSubmit((values) => {
    if (mode === 'upload' && files.length === 0) {
      setFileError(t('admin:binaries.valFileRequired'));
      return;
    }
    onSubmit({
      ...(mode === 'upload' ? { files } : { url: values.url.trim() }),
      ...(values.upstreamVersion.trim() ? { upstreamVersion: values.upstreamVersion.trim() } : {}),
      ...(values.target && values.target !== 'AUTO' ? { target: values.target } : {}),
      ...(values.notes.trim() ? { notes: values.notes.trim() } : {})
    });
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent size="compact">
        <DialogHeader>
          <DialogTitle>
            {mode === 'upload' ? t('admin:binaries.formUploadTitle') : t('admin:binaries.formImportTitle')}
          </DialogTitle>
          <DialogDescription>{t('admin:binaries.formDesc')}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-4" onSubmit={handleSubmit}>
            {mode === 'upload' ? (
              <div className="space-y-2">
                <FormLabel>{t('admin:binaries.fileLabel')}</FormLabel>
                <Input type="file" multiple onChange={handleFileChange} />
                <p className="text-xs text-muted-foreground">{t('admin:binaries.fileSelectDesc')}</p>
                {fileError ? <p className="text-xs font-medium text-destructive">{fileError}</p> : null}
                {files.length > 0 ? (
                  <div className="space-y-1.5 rounded-md border bg-muted/30 p-2.5">
                    <div className="flex items-center justify-between text-xs font-medium">
                      <span>{t('admin:binaries.selectedFilesCount', { count: files.length })}</span>
                      <Badge variant="secondary" className="gap-1 text-[10px]">
                        <Sparkles className="size-3" />
                        {t('admin:binaries.autoDetectHint')}
                      </Badge>
                    </div>
                    <div className="max-h-36 space-y-1 overflow-y-auto text-xs">
                      {files.map((file, idx) => (
                        <div key={`${file.name}-${idx}`} className="flex items-center justify-between gap-2 text-muted-foreground">
                          <span className="flex min-w-0 items-center gap-1.5 truncate font-mono">
                            <FileArchive className="size-3.5 shrink-0" />
                            <span className="truncate">{file.name}</span>
                          </span>
                          <span className="shrink-0 tabular-nums">{bytes(file.size)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <FormField
                control={form.control}
                name="url"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('admin:binaries.urlLabel')}</FormLabel>
                    <FormControl>
                      <Input type="url" {...field} placeholder={t('admin:binaries.urlPlaceholder')} />
                    </FormControl>
                    <FormDescription>{t('admin:binaries.urlDesc')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="upstreamVersion"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('admin:binaries.upstreamVersionLabel')}</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder={t('admin:binaries.upstreamVersionPlaceholder')} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {mode === 'import' || files.length <= 1 ? (
                <FormField
                  control={form.control}
                  name="target"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('admin:binaries.targetLabel')}</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="AUTO">{t('admin:binaries.targetAutoDetect')}</SelectItem>
                          {targets.map((target) => (
                            <SelectItem key={target} value={target}>
                              {targetLabel(target)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : null}
            </div>

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('admin:binaries.notesLabel')}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={t('admin:binaries.notesPlaceholder')} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t('common:actions.cancel')}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending
                  ? t('admin:binaries.processing')
                  : mode === 'upload'
                    ? t('admin:binaries.formUploadTitle')
                    : t('admin:binaries.formImportTitle')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
