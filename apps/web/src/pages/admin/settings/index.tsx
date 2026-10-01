import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, Gauge, Globe2, Layout, Palette, RotateCcw, Save, Send, ShieldCheck, UsersRound } from 'lucide-react';
import { toast } from 'sonner';
import { useFormResetOnKey } from '@/hooks/use-form-reset';
import { api, extractErrorMessage } from '@/lib/api';
import { formatBytes } from '@/lib/utils';
import { usePublicSettings } from '@/lib/public-settings';
import { useAdminPlans } from '@/pages/admin/plans/use-plans';
import { useAdminTemplates } from '@/pages/admin/templates/use-templates';
import { DatabaseStatsResponse, TelemetryCleanupDialog, VacuumResponse } from '@/components/shared/telemetry-cleanup-dialog';
import { PageContainer, PageHeader } from '@/components/shared/page-container';
import { Button } from '@/components/ui/button';
import { Form } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import type { SystemSettings } from './settings-types';
import { createSettingsSchema, type SettingsForm } from './settings-schema';
export type { SettingsForm } from './settings-schema';
import { defaultSettingsForm, toForm, toPayload } from './settings-form';
import { FIELD_TAB_MAP, findFirstErrorMessage, type SettingsTabKey } from './settings-field-map';
import { SettingsTabs } from './components/settings-tabs';

export default function AdminSettingsPage() {
  const { t } = useTranslation(['admin', 'common']);
  const queryClient = useQueryClient();
  const publicSettings = usePublicSettings();
  const plans = useAdminPlans();
  const templates = useAdminTemplates();
  const [activeTab, setActiveTab] = useState<SettingsTabKey>('branding');
  const [smtpTestOpen, setSmtpTestOpen] = useState(false);
  const [smtpTestEmail, setSmtpTestEmail] = useState('');
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const publicPlans = useMemo(
    () => (plans.data ?? []).filter((plan) => plan.isPublic !== false),
    [plans.data]
  );
  const availablePublicPlanIds = useMemo(
    () => (plans.data ? new Set(publicPlans.map((plan) => plan.id)) : undefined),
    [plans.data, publicPlans]
  );
  const settingsQuery = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: async () => (await api.get<SystemSettings>('/admin/settings')).data
  });
  const dbStatsQuery = useQuery({
    queryKey: ['admin-database-stats'],
    queryFn: async () => (await api.get<DatabaseStatsResponse>('/admin/telemetry/cleanup/database-stats')).data
  });
  const vacuumMutation = useMutation({
    mutationFn: async () => (await api.post<VacuumResponse>('/admin/telemetry/cleanup/vacuum', {})).data,
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['admin-database-stats'] });
      if (data.totalReclaimedBytes > 0) {
        toast.success(t('admin:settings.vacuumSuccessReclaimed', { bytes: formatBytes(data.totalReclaimedBytes) }));
      } else {
        toast.success(t('admin:settings.vacuumSuccessClean'));
      }
    },
    onError: (error) => {
      toast.error(extractErrorMessage(error, t('admin:settings.vacuumFailed')));
    }
  });
  const defaultTemplate = templates.data?.find((t) => t.isDefault) ?? templates.data?.find((t) => t.id === settingsQuery.data?.defaultTemplateId);
  const dynamicSettingsSchema = useMemo(() => {
    void t;
    return createSettingsSchema();
  }, [t]);
  const form = useForm<SettingsForm>({
    resolver: zodResolver(dynamicSettingsSchema),
    defaultValues: defaultSettingsForm()
  });

  // 服务端设置回灌：仅在表单没有未保存修改时跟随数据版本同步，
  // 避免后台 refetch 或别处 invalidate 清空管理员正在编辑的设置项
  useFormResetOnKey({
    resetKey: settingsQuery.data ? 'settings' : null,
    dataRevision: settingsQuery.dataUpdatedAt,
    isDirty: form.formState.isDirty,
    reset: () => { if (settingsQuery.data) form.reset(toForm(settingsQuery.data, availablePublicPlanIds)); }
  });

  useEffect(() => {
    if (!availablePublicPlanIds) return;
    const currentPlanId = form.getValues('defaultPlanId');
    if (currentPlanId && currentPlanId !== 'none' && !availablePublicPlanIds.has(currentPlanId)) {
      form.resetField('defaultPlanId', { defaultValue: 'none' });
    }
  }, [availablePublicPlanIds, form]);

  const saveMutation = useMutation({
    mutationFn: async (values: SettingsForm) => (await api.put<SystemSettings>('/admin/settings', toPayload(values))).data,
    onSuccess: (settings) => {
      form.reset(toForm(settings, availablePublicPlanIds));
      toast.success(t('admin:settings.saveSuccess'));
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
      void queryClient.invalidateQueries({ queryKey: ['system', 'public-info'] });
    },
    onError: (error) => toast.error(extractErrorMessage(error, t('admin:settings.saveFailed')))
  });
  const resetMutation = useMutation({
    mutationFn: async () => (await api.post<SystemSettings>('/admin/settings/reset', {})).data,
    onSuccess: (settings) => {
      form.reset(toForm(settings, availablePublicPlanIds));
      toast.success(t('admin:settings.resetSuccess'));
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
      void queryClient.invalidateQueries({ queryKey: ['system', 'public-info'] });
    },
    onError: (error) => toast.error(extractErrorMessage(error, t('admin:settings.resetFailed')))
  });
  const smtpTestMutation = useMutation({
    mutationFn: async (email: string) => (await api.post<{ success: boolean; messageId?: string; durationMs?: number }>('/admin/settings/smtp/test', { email })).data,
    onSuccess: (result) => { setSmtpTestOpen(false); toast.success(t('admin:settings.smtpTestSuccess', { duration: result.durationMs ? `（${result.durationMs}ms）` : '' })); },
    onError: (error) => toast.error(extractErrorMessage(error, t('admin:settings.smtpTestFailed')))
  });

  const submitSettings = form.handleSubmit(
    (values) => saveMutation.mutate(values),
    (errors) => {
      const firstErrorField = Object.keys(errors)[0] as keyof SettingsForm | undefined;
      if (firstErrorField && FIELD_TAB_MAP[firstErrorField]) {
        setActiveTab(FIELD_TAB_MAP[firstErrorField]);
      }
      const firstMsg = findFirstErrorMessage(errors);
      toast.error(
        firstMsg
          ? t('admin:settings.valFormInvalidToast', { message: firstMsg })
          : t('admin:settings.saveFailed')
      );
    }
  );

  if (settingsQuery.isPending) {
    return <PageContainer><PageHeader title={t('admin:settings.title')} /><Skeleton className="h-[520px] w-full" /></PageContainer>;
  }

  return (
    <PageContainer>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <PageHeader title={t('admin:settings.title')} description={t('admin:settings.subtitle')} />
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <AlertDialog>
            <AlertDialogTrigger asChild><Button type="button" variant="outline" className="w-full sm:w-auto" disabled={resetMutation.isPending}><RotateCcw />{t('admin:settings.resetDefaults')}</Button></AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader><AlertDialogTitle>{t('admin:settings.resetConfirmTitle')}</AlertDialogTitle><AlertDialogDescription>{t('admin:settings.resetConfirmDesc')}</AlertDialogDescription></AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => resetMutation.mutate()}>{t('admin:settings.resetConfirm')}</AlertDialogAction></AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button type="button" className="w-full sm:w-auto" disabled={saveMutation.isPending} onClick={() => void submitSettings()}><Save />{saveMutation.isPending ? t('admin:settings.saving') : t('admin:settings.saveSettingsButton')}</Button>
        </div>
      </div>

      <Form {...form}>
        <form className="min-w-0" onSubmit={(e) => void submitSettings(e)}>
          <Tabs value={activeTab} onValueChange={(val) => setActiveTab(val as SettingsTabKey)} className="min-w-0 max-w-full w-full space-y-4">
            <TabsList className="h-auto w-full max-w-full justify-start gap-1 overflow-x-auto p-1">
              <TabsTrigger className="shrink-0" value="branding"><Palette className="h-4 w-4 shrink-0" />{t('admin:settings.generalTab')}</TabsTrigger>
              <TabsTrigger className="shrink-0" value="landing"><Layout className="h-4 w-4 shrink-0" />{t('admin:settings.landingTab')}</TabsTrigger>
              <TabsTrigger className="shrink-0" value="users"><UsersRound className="h-4 w-4 shrink-0" />{t('admin:settings.authTab')}</TabsTrigger>
               <TabsTrigger className="shrink-0" value="subscription"><Globe2 className="h-4 w-4 shrink-0" />{t('admin:settings.subscriptionTab')}</TabsTrigger>
               <TabsTrigger className="shrink-0" value="agent"><Gauge className="h-4 w-4 shrink-0" />{t('admin:settings.agentTab')}</TabsTrigger>
              <TabsTrigger className="shrink-0" value="storage"><Database className="h-4 w-4 shrink-0" />{t('admin:settings.databaseTab')}</TabsTrigger>
               <TabsTrigger className="shrink-0" value="advanced"><ShieldCheck className="h-4 w-4 shrink-0" />{t('admin:settings.securityTab')}</TabsTrigger>
            </TabsList>

            <SettingsTabs publicPlans={publicPlans} defaultTemplate={defaultTemplate} dbStatsQuery={dbStatsQuery} vacuumMutation={vacuumMutation} smtpTestMutation={smtpTestMutation} setSmtpTestOpen={setSmtpTestOpen} setCleanupOpen={setCleanupOpen} />
          </Tabs>
          <div className="flex justify-end pt-4"><Button type="submit" className="w-full sm:w-auto" disabled={saveMutation.isPending}><Save />{saveMutation.isPending ? t('admin:settings.saving') : t('admin:settings.saveSettingsButton')}</Button></div>
        </form>
      </Form>
      {publicSettings.isError ? <p className="text-xs text-muted-foreground">{t('admin:settings.publicSettingsUnavailable')}</p> : null}
      <Dialog open={smtpTestOpen} onOpenChange={setSmtpTestOpen}><DialogContent size="compact"><DialogHeader><DialogTitle>{t('admin:settings.dialogSmtpTestTitle')}</DialogTitle><DialogDescription>{t('admin:settings.dialogSmtpTestDesc')}</DialogDescription></DialogHeader><div className="space-y-2"><Label htmlFor="smtp-test-email">{t('admin:settings.labelSmtpTestEmail')}</Label><Input id="smtp-test-email" type="email" value={smtpTestEmail} onChange={(event) => setSmtpTestEmail(event.target.value)} placeholder="admin@example.com" /></div><DialogFooter><Button type="button" variant="outline" onClick={() => setSmtpTestOpen(false)}>{t('common:actions.cancel')}</Button><Button type="button" disabled={smtpTestMutation.isPending || !smtpTestEmail.trim()} onClick={() => smtpTestMutation.mutate(smtpTestEmail.trim())}><Send />{smtpTestMutation.isPending ? t('admin:settings.sendingTestEmail') : t('admin:settings.btnSendTestEmail')}</Button></DialogFooter></DialogContent></Dialog>
      <TelemetryCleanupDialog open={cleanupOpen} onOpenChange={setCleanupOpen} />
    </PageContainer>
  );
}
