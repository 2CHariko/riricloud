import type { UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { UpstreamNodePicker } from './upstream-node-picker';
import { FieldGrid, SwitchField, TextField } from './line-form-controls';
import { StatusSwitch } from './line-advanced-fields';
import type { LineFormValues } from './line-form-schema';

export function ExternalLineFields({ form, summary }: { form: UseFormReturn<LineFormValues>; summary?: { id: string; name: string; protocolType: string; serverHost: string; serverPort: number } | null }) {
  const { t } = useTranslation('admin');
  return <div className="space-y-4">
    <p className="text-sm text-destructive">{t('upstream.externalRisk')}</p>
    <p className="text-sm text-muted-foreground">{t('upstream.externalDefaults')}</p>
    <UpstreamNodePicker form={form} selectedSummary={summary} />
    <p className="text-xs text-muted-foreground">{t('lineForm.egress.unsupported')}</p>
    <FieldGrid>
      <TextField form={form} name="tag" label={t('lineForm.tag')} />
      <TextField form={form} name="tags" label={t('lineForm.tags')} placeholder={t('lineForm.tagsPlaceholder')} />
      <TextField form={form} name="level" label={t('lineForm.level')} type="number" inputProps={{ min: 0 }} />
      <TextField form={form} name="sortOrder" label={t('lineForm.sortOrder')} type="number" inputProps={{ min: 0 }} />
    </FieldGrid>
    <SwitchField form={form} name="isPublic" label={t('lineForm.isPublic')} description={t('upstream.publicAllImpact')} />
    <StatusSwitch form={form} />
  </div>;
}
