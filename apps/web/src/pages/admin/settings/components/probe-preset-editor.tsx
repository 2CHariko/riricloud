import { Fragment, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { zodResolver } from '@/lib/zod-resolver';
import { useFieldArray, useForm, useFormContext, useWatch } from 'react-hook-form';
import { Plus, Settings2, Trash2 } from 'lucide-react';
import type { SettingsForm } from '../index';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  EMPTY_PROBE_PRESET,
  MAX_PROBE_PRESETS,
  createProbePresetEditorSchema,
  type ProbePresetEditorValues,
  type ProbePresetFormValue,
  type ProbePresetType
} from './probe-preset-schema';

export function ProbePresetEditor() {
  const { t } = useTranslation(['admin', 'common']);
  const { control, setValue } = useFormContext<SettingsForm>();
  const value = useWatch({ control, name: 'probePresetTargets' }) ?? [];

  return (
    <div className="space-y-3 md:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{t('admin:settings.probePresetTitle')}</p>
          <p className="text-[0.8rem] text-muted-foreground">{t('admin:settings.probePresetDesc')}</p>
        </div>
        <ProbePresetDialog
          value={value}
          onApply={(nextValue) => setValue('probePresetTargets', nextValue, { shouldDirty: true, shouldValidate: true })}
        />
      </div>
    </div>
  );
}

function ProbePresetDialog({ value, onApply }: { value: ProbePresetFormValue[]; onApply: (value: ProbePresetFormValue[]) => void }) {
  const { t } = useTranslation(['admin', 'common']);
  const [open, setOpen] = useState(false);
  const schema = useMemo(() => {
    void t;
    return createProbePresetEditorSchema();
  }, [t]);
  const form = useForm<ProbePresetEditorValues>({
    resolver: zodResolver(schema),
    defaultValues: { probePresetTargets: [] }
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'probePresetTargets' });

  const openEditor = () => {
    form.reset({ probePresetTargets: value });
    setOpen(true);
  };
  const apply = form.handleSubmit((values) => {
    onApply(values.probePresetTargets);
    setOpen(false);
  });

  return (
    <>
      <div className="flex items-center gap-3">
        <span className="text-xs tabular-nums text-muted-foreground">{t('admin:settings.probePresetCount', { count: value.length, max: MAX_PROBE_PRESETS })}</span>
        <Button type="button" variant="outline" size="sm" onClick={openEditor}><Settings2 />{t('admin:settings.probePresetManage')}</Button>
      </div>
      <ResponsiveDialog open={open} onOpenChange={setOpen}>
        <ResponsiveDialogContent size="wide">
          <DialogHeader>
            <DialogTitle>{t('admin:settings.probePresetDialogTitle')}</DialogTitle>
            <DialogDescription>{t('admin:settings.probePresetDialogDesc', { max: MAX_PROBE_PRESETS })}</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form className="space-y-6" onSubmit={apply}>
              {fields.length ? (
                <div className="space-y-6">
                  {fields.map((field, index) => <Fragment key={field.id}>{index > 0 ? <Separator /> : null}<ProbePresetRow index={index} onRemove={() => remove(index)} /></Fragment>)}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t('admin:settings.probePresetEmpty')}</p>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Button type="button" variant="outline" size="sm" disabled={fields.length >= MAX_PROBE_PRESETS} onClick={() => append({ ...EMPTY_PROBE_PRESET })}><Plus />{t('admin:settings.probePresetAdd')}</Button>
                <DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>{t('common:actions.cancel')}</Button><Button type="submit">{t('admin:settings.probePresetApply')}</Button></DialogFooter>
              </div>
            </form>
          </Form>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  );
}

function ProbePresetRow({ index, onRemove }: { index: number; onRemove: () => void }) {
  const { t } = useTranslation(['admin', 'common']);
  const { control, getValues, setValue } = useFormContext<ProbePresetEditorValues>();
  const type = useWatch({ control, name: `probePresetTargets.${index}.type` });

  const changeType = (nextType: ProbePresetType) => {
    setValue(`probePresetTargets.${index}.type`, nextType, { shouldDirty: true, shouldValidate: true });
    if (nextType === 'tcp') {
      const currentPort = getValues(`probePresetTargets.${index}.port`);
      if (!currentPort) setValue(`probePresetTargets.${index}.port`, '443', { shouldDirty: true, shouldValidate: true });
      return;
    }
    setValue(`probePresetTargets.${index}.port`, '', { shouldDirty: true, shouldValidate: true });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{t('admin:settings.probePresetTargetLabel', { index: index + 1 })}</p>
        <IconButton
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('admin:settings.probePresetDeleteAria', { index: index + 1 })}
          tooltip={t('admin:settings.probePresetDeleteTooltip')}
          onClick={onRemove}
        >
          <Trash2 className="size-4" />
        </IconButton>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <FormField control={control} name={`probePresetTargets.${index}.type`} render={({ field }) => <FormItem><FormLabel>{t('admin:settings.probePresetType')}</FormLabel><Select value={field.value} onValueChange={(value) => changeType(value as ProbePresetType)}><FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent><SelectItem value="tcp">{t('admin:settings.probePresetTypeTcp')}</SelectItem><SelectItem value="dns">{t('admin:settings.probePresetTypeDns')}</SelectItem><SelectItem value="icmp">{t('admin:settings.probePresetTypeIcmp')}</SelectItem></SelectContent></Select><FormMessage /></FormItem>} />
        <FormField control={control} name={`probePresetTargets.${index}.target`} render={({ field }) => <FormItem><FormLabel>{t('admin:settings.probePresetTargetAddress')}</FormLabel><FormControl><Input placeholder={type === 'icmp' ? t('admin:settings.probePresetTargetPlaceholderIcmp') : t('admin:settings.probePresetTargetPlaceholderHost')} {...field} /></FormControl><FormMessage /></FormItem>} />
        {type === 'tcp' ? <FormField control={control} name={`probePresetTargets.${index}.port`} render={({ field }) => <FormItem><FormLabel>{t('admin:settings.probePresetPort')}</FormLabel><FormControl><Input type="number" min={1} max={65535} placeholder="443" {...field} /></FormControl><FormMessage /></FormItem>} /> : null}
        <FormField control={control} name={`probePresetTargets.${index}.timeoutMs`} render={({ field }) => <FormItem><FormLabel>{t('admin:settings.probePresetTimeout')}</FormLabel><FormControl><Input type="number" min={100} max={10000} placeholder="5000" {...field} /></FormControl><FormMessage /></FormItem>} />
      </div>
    </div>
  );
}
