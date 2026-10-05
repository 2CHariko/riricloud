import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n/config';
import { useFormResetOnKey } from '@/hooks/use-form-reset';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TemplateGroupsEditor } from './template-groups-editor';
import { validationPolicySchema } from '../validation-policy';
import { TemplateValidationEditor } from './template-validation-editor';
import { TemplateRulesEditor } from './template-rules-editor';
import { TemplateDnsEditor, SemanticDnsConfig } from './template-dns-editor';
import { TemplateOverrideEditor } from './template-override-editor';
import { TemplateSourceEditor } from './template-source-editor';
import { TemplatePreviewDrawer } from './template-preview-drawer';
import { SubscriptionTemplate, TemplatePayload, useTemplateMutations } from '../use-templates';

const schema = z.object({
  validationConfig: validationPolicySchema,
  name: z.string().min(1, i18n.t('admin:templateForm.validation.nameRequired')),
  description: z.string().optional(),
  proxyGroups: z.string().refine((value) => isJsonArray(value), i18n.t('admin:templateForm.validation.jsonArrayRequired')),
  ruleSets: z.string().refine((value) => isJsonArray(value), i18n.t('admin:templateForm.validation.jsonArrayRequired')),
  dnsConfig: z.string().refine((value) => isJsonObject(value), i18n.t('admin:templateForm.validation.jsonObjectRequired')),
  customInjectYaml: z.string().optional(),
  customInjectJson: z.string().refine((value) => !value.trim() || isJsonObject(value), i18n.t('admin:templateForm.validation.jsonObjectRequired')),
  isDefault: z.boolean()
});
type FormValues = z.infer<typeof schema>;

function isJsonArray(value: string) {
  try { return Array.isArray(JSON.parse(value)); } catch { return false; }
}

function isJsonObject(value: string) {
  try { const parsed = JSON.parse(value); return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed); } catch { return false; }
}

function parseArray(value: string): unknown[] {
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function parseObject(value: string): Record<string, unknown> {
  try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}

function normalizeDns(value: Record<string, unknown>): Record<string, unknown> {
  if ('directDns' in value || 'proxyDns' in value || 'fakeIp' in value) return value;
  const nameserver = Array.isArray(value.nameserver) ? value.nameserver.filter((item): item is string => typeof item === 'string') : [];
  const fallback = Array.isArray(value.fallback) ? value.fallback.filter((item): item is string => typeof item === 'string') : [];
  return {
    enable: value.enable !== false,
    fakeIp: value['enhanced-mode'] === 'fake-ip' || value['fake-ip-range'] !== undefined,
    directDns: nameserver.length ? (fallback.length ? nameserver : [nameserver[0]]) : [],
    proxyDns: fallback.length ? fallback : nameserver.slice(1),
    ipv6: value.ipv6 !== false
  };
}

const defaultDns = JSON.stringify({ enable: true, fakeIp: true, directDns: ['https://223.5.5.5/dns-query', '223.5.5.5'], proxyDns: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query', 'https://9.9.9.9/dns-query'], ipv6: false }, null, 2);

export function TemplateFormDialog({ open, onOpenChange, template }: { open: boolean; onOpenChange: (open: boolean) => void; template: SubscriptionTemplate | null }) {
  const { t } = useTranslation(['admin', 'common']);
  const { create, update } = useTemplateMutations();
  const [previewDrawerOpen, setPreviewDrawerOpen] = useState(false);
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { validationConfig: {}, name: '', description: '', proxyGroups: '[]', ruleSets: '[]', dnsConfig: defaultDns, customInjectYaml: '', customInjectJson: '', isDefault: false } });
  const watchedGroups = form.watch('proxyGroups');
  const watchedRules = form.watch('ruleSets');
  const watchedDns = form.watch('dnsConfig');
  const watchedValues = form.watch();

  useFormResetOnKey({
    open,
    resetKey: template?.id ?? 'create',
    reset: () => form.reset(template ? {
      validationConfig: template.validationConfig ?? {},
      name: template.name,
      description: template.description ?? '',
      proxyGroups: JSON.stringify(template.proxyGroups, null, 2),
      ruleSets: JSON.stringify(template.ruleSets, null, 2),
      dnsConfig: JSON.stringify(normalizeDns(template.dnsConfig), null, 2),
      customInjectYaml: template.customInjectYaml ?? '',
      customInjectJson: template.customInjectJson ?? '',
      isDefault: template.isDefault
    } : undefined)
  });

  const targets = useMemo(() => parseArray(watchedGroups).map((item) => item && typeof item === 'object' && !Array.isArray(item) && typeof (item as Record<string, unknown>).name === 'string' ? (item as Record<string, unknown>).name as string : '').filter(Boolean), [watchedGroups]);
  const previewTemplate = useMemo<TemplatePayload>(() => ({
    validationConfig: watchedValues.validationConfig,
    name: watchedValues.name,
    description: watchedValues.description,
    proxyGroups: parseArray(watchedValues.proxyGroups),
    ruleSets: parseArray(watchedValues.ruleSets),
    dnsConfig: parseObject(watchedValues.dnsConfig),
    customInjectYaml: watchedValues.customInjectYaml || null,
    customInjectJson: watchedValues.customInjectJson || null,
    isDefault: watchedValues.isDefault
  }), [watchedValues]);

  const submit = (values: FormValues) => {
    const payload: TemplatePayload = {
      validationConfig: values.validationConfig,
      name: values.name,
      description: values.description,
      proxyGroups: JSON.parse(values.proxyGroups),
      ruleSets: JSON.parse(values.ruleSets),
      dnsConfig: JSON.parse(values.dnsConfig),
      customInjectYaml: values.customInjectYaml || null,
      customInjectJson: values.customInjectJson || null,
      isDefault: values.isDefault
    };
    if (template) update.mutate({ id: template.id, ...payload }, { onSuccess: () => onOpenChange(false) });
    else create.mutate(payload, { onSuccess: () => onOpenChange(false) });
  };

  const busy = create.isPending || update.isPending;
  const setJsonArray = (field: 'proxyGroups' | 'ruleSets', value: unknown[]) => form.setValue(field, JSON.stringify(value, null, 2), { shouldDirty: true, shouldValidate: true });

  return (
    <>
      <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
        <ResponsiveDialogContent size="wide" className="!flex min-h-0 min-w-0 flex-col overflow-hidden md:h-[calc(100dvh-2rem)] md:max-h-[94dvh]">
          <DialogHeader className="shrink-0">
            <DialogTitle>{template ? t('admin:templateForm.titleEdit') : t('admin:templateForm.titleCreate')}</DialogTitle>
            <DialogDescription>{t('admin:templateForm.desc')}</DialogDescription>
          </DialogHeader>
          <form noValidate onSubmit={form.handleSubmit(submit)} className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden">
            <Tabs defaultValue="basic" className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
              <div className="w-full shrink-0 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                <TabsList className="inline-flex h-9 w-auto min-w-full flex-nowrap items-center justify-start gap-1 p-1">
                  <TabsTrigger className="shrink-0 flex-none whitespace-nowrap px-3 py-1 text-xs sm:text-sm" value="basic">{t('admin:templateForm.tabBasic')}</TabsTrigger>
                  <TabsTrigger className="shrink-0 flex-none whitespace-nowrap px-3 py-1 text-xs sm:text-sm" value="groups">{t('admin:templateForm.tabGroups')}</TabsTrigger>
                  <TabsTrigger className="shrink-0 flex-none whitespace-nowrap px-3 py-1 text-xs sm:text-sm" value="rules">{t('admin:templateForm.tabRules')}</TabsTrigger>
                  <TabsTrigger className="shrink-0 flex-none whitespace-nowrap px-3 py-1 text-xs sm:text-sm" value="dns">{t('admin:templateForm.tabDns')}</TabsTrigger>
                  <TabsTrigger className="shrink-0 flex-none whitespace-nowrap px-3 py-1 text-xs sm:text-sm" value="override">{t('admin:templateForm.tabOverride')}</TabsTrigger>
                  <TabsTrigger className="shrink-0 flex-none whitespace-nowrap px-3 py-1 text-xs sm:text-sm" value="source">{t('admin:templateForm.tabSource')}</TabsTrigger>
                  <TabsTrigger className="shrink-0 flex-none whitespace-nowrap px-3 py-1 text-xs sm:text-sm" value="validation">{t('admin:templateAnalysis.title')}</TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="basic" className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2"><Label htmlFor="template-name">{t('admin:templateForm.name')}</Label><Input id="template-name" {...form.register('name')} />{form.formState.errors.name && <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>}</div>
                  <div className="space-y-2"><Label htmlFor="template-description">{t('admin:templateForm.descLabel')}</Label><Input id="template-description" {...form.register('description')} /></div>
                </div>
                <div className="flex items-center gap-3 rounded-md border p-3"><Switch checked={form.watch('isDefault')} onCheckedChange={(checked) => form.setValue('isDefault', checked, { shouldDirty: true })} /><div><Label>{t('admin:templateForm.isDefault')}</Label><p className="text-xs text-muted-foreground">{t('admin:templateForm.isDefaultDesc')}</p></div></div>
              </TabsContent>
              <TabsContent value="groups" className="data-[state=active]:flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <TemplateGroupsEditor value={parseArray(watchedGroups)} onChange={(value) => setJsonArray('proxyGroups', value)} />
                {form.formState.errors.proxyGroups && <p className="shrink-0 text-xs text-destructive">{form.formState.errors.proxyGroups.message}</p>}
              </TabsContent>
              <TabsContent value="rules" className="data-[state=active]:flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <TemplateRulesEditor value={parseArray(watchedRules)} targets={targets} onChange={(value) => setJsonArray('ruleSets', value)} />
                {form.formState.errors.ruleSets && <p className="shrink-0 text-xs text-destructive">{form.formState.errors.ruleSets.message}</p>}
              </TabsContent>
              <TabsContent value="dns" className="data-[state=active]:flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <TemplateDnsEditor
                  value={parseObject(watchedDns) as SemanticDnsConfig}
                  onChange={(nextDns) => form.setValue('dnsConfig', JSON.stringify(nextDns, null, 2), { shouldDirty: true, shouldValidate: true })}
                />
                {form.formState.errors.dnsConfig && <p className="shrink-0 text-xs text-destructive">{form.formState.errors.dnsConfig.message}</p>}
              </TabsContent>
              <TabsContent value="override" className="data-[state=active]:flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <TemplateOverrideEditor
                  yamlValue={watchedValues.customInjectYaml || ''}
                  jsonValue={watchedValues.customInjectJson || ''}
                  onYamlChange={(value) => form.setValue('customInjectYaml', value, { shouldDirty: true })}
                  onJsonChange={(value) => form.setValue('customInjectJson', value, { shouldDirty: true, shouldValidate: true })}
                  yamlError={form.formState.errors.customInjectYaml?.message}
                  jsonError={form.formState.errors.customInjectJson?.message}
                />
              </TabsContent>
              <TabsContent value="validation" className="min-h-0 flex-1 overflow-y-auto">
                <TemplateValidationEditor value={watchedValues.validationConfig} onChange={(value) => form.setValue('validationConfig', value, { shouldDirty: true, shouldValidate: true })} />
                {form.formState.errors.validationConfig && <p className="text-xs text-destructive">{t('admin:templateAnalysis.invalidPolicy')}</p>}
              </TabsContent>
              <TabsContent value="source" className="data-[state=active]:flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <TemplateSourceEditor
                  template={previewTemplate}
                  onChange={(nextPayload) => {
                    form.setValue('validationConfig', nextPayload.validationConfig ?? {}, { shouldDirty: true, shouldValidate: true });
                    form.setValue('name', nextPayload.name, { shouldDirty: true });
                    if (nextPayload.description !== undefined) form.setValue('description', nextPayload.description ?? '', { shouldDirty: true });
                    form.setValue('proxyGroups', JSON.stringify(nextPayload.proxyGroups, null, 2), { shouldDirty: true, shouldValidate: true });
                    form.setValue('ruleSets', JSON.stringify(nextPayload.ruleSets, null, 2), { shouldDirty: true, shouldValidate: true });
                    form.setValue('dnsConfig', JSON.stringify(nextPayload.dnsConfig, null, 2), { shouldDirty: true, shouldValidate: true });
                    form.setValue('customInjectYaml', nextPayload.customInjectYaml || '', { shouldDirty: true });
                    form.setValue('customInjectJson', nextPayload.customInjectJson || '', { shouldDirty: true, shouldValidate: true });
                    form.setValue('isDefault', nextPayload.isDefault, { shouldDirty: true });
                  }}
                  onTestRender={() => setPreviewDrawerOpen(true)}
                />
              </TabsContent>
            </Tabs>
            <DialogFooter className="shrink-0"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('admin:templateForm.cancel')}</Button><Button type="button" variant="outline" onClick={() => setPreviewDrawerOpen(true)}>{t('admin:templateAnalysis.validate')}</Button><Button type="submit" disabled={busy}>{busy ? t('admin:templateForm.saving') : t('admin:templateForm.save')}</Button></DialogFooter>
          </form>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      <TemplatePreviewDrawer
        open={previewDrawerOpen}
        onOpenChange={setPreviewDrawerOpen}
        template={previewTemplate}
        onApply={(next) => form.setValue('ruleSets', JSON.stringify(next.ruleSets, null, 2), { shouldDirty: true, shouldValidate: true })}
        title={t('admin:templateForm.quickTestRender')}
      />
    </>
  );
}
