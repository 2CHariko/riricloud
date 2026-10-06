import * as React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTheme } from 'next-themes';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n/config';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { ArrowLeft, FileText, Network, RefreshCw, RotateCcw, Server, Trash2, Wrench } from 'lucide-react';
import { PageContainer } from '@/components/shared/page-container';
import { CertificateReturnLink } from '@/components/shared/certificate-return-link';
import { CopyButton } from '@/components/shared/copy-button';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { useFormResetOnKey } from '@/hooks/use-form-reset';
import { useAdminBinaryInfo, useAdminNodeDetail, useNodeMutations } from './use-nodes';
import { useAdminBinaryResources } from '../binaries/use-binaries';
import { UpgradeNodeDialog } from './components/upgrade-node-dialog';
import { NodeDeploymentHistory } from './components/node-deployment-history';
import { ProbeNodeDialog } from './components/probe-node-dialog';
import { SingboxDiagnosticsCard } from './components/singbox-diagnostics-card';
import { NodeLinesTab } from './components/node-lines-tab';
import { GeneratedConfigPreview, InstallCommandDialog, NodeProfileCards, ProbeSnapshotCard } from './components/node-detail-support';
import { DiagnosticsSnapshotCard } from '@/components/shared/diagnostics-snapshot-card';

const nodeDetailSchema = z.object({
  name: z.string().trim().min(1, i18n.t('admin:nodes.valNameReq')).max(64, i18n.t('admin:nodes.valNameMax')),
  reachability: z.enum(['PUBLIC', 'NAT']),
  serverHost: z.string().trim(),
  configOverride: z.string()
}).superRefine((data, ctx) => {
  if (data.reachability === 'PUBLIC' && !data.serverHost) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['serverHost'],
      message: i18n.t('admin:nodes.valServerHostPublic')
    });
  }
});

type NodeDetailFormValues = z.infer<typeof nodeDetailSchema>;

export default function NodeDetailPage() {
  const { t } = useTranslation(['admin', 'common']);
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const { data: node, isPending, isError } = useAdminNodeDetail(id);
  const { data: binaryInfo } = useAdminBinaryInfo();
  const { data: binaryResources } = useAdminBinaryResources({ status: 'ACTIVE', pageSize: 100 });
  const { updateNode, deleteNode, reloadNode, upgradeNode, probeNode, restartAgent, importBinary, waitForTask, enableLogDiagnostics, disableLogDiagnostics } = useNodeMutations();
  const [upgradeOpen, setUpgradeOpen] = React.useState(false);
  const [probeOpen, setProbeOpen] = React.useState(false);
  const [installOpen, setInstallOpen] = React.useState(false);
  const form = useForm<NodeDetailFormValues>({
    resolver: zodResolver(nodeDetailSchema),
    defaultValues: { name: '', reachability: 'PUBLIC', serverHost: '', configOverride: '' }
  });

  useFormResetOnKey({
    resetKey: node?.id ?? null,
    reset: () => form.reset({
      name: node?.name ?? '',
      reachability: node?.reachability ?? 'PUBLIC',
      serverHost: node?.serverHost ?? '',
      configOverride: node?.configOverride ?? ''
    })
  });

  const override = form.watch('configOverride');

  if (isPending) return <PageContainer><CertificateReturnLink /><Skeleton className="h-8 w-48" /><Skeleton className="h-12 w-full" /><Skeleton className="h-72 w-full" /></PageContainer>;
  if (isError || !node) return (
    <PageContainer>
      <CertificateReturnLink />
      <EmptyState title={t('admin:nodes.nodeNotFound')} description={t('admin:nodes.nodeNotFoundDesc')} />
      <Button variant="outline" size="sm" asChild>
        <Link to="/admin/nodes">{t('admin:nodes.backToNodes')}</Link>
      </Button>
    </PageContainer>
  );

  const statusLabel = node.status === 'ONLINE' ? (node.communicationMode === 'HTTP' ? t('admin:nodes.modeHttp') : t('admin:nodes.modeWs')) : node.status === 'DISABLED' ? t('admin:nodes.statusDisabled') : t('admin:nodes.statusOffline');
  const saveBasic = async () => {
    if (!(await form.trigger(['name', 'reachability', 'serverHost']))) return;
    const values = form.getValues();
    updateNode.mutate({
      id: node.id,
      name: values.name,
      reachability: values.reachability,
      serverHost: values.reachability === 'NAT' && !values.serverHost ? '127.0.0.1' : values.serverHost
    });
  };
  const saveOverride = () => {
    const value = form.getValues('configOverride').trim();
    if (value) {
      try { const parsed: unknown = JSON.parse(value); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); }
      catch { toast.error(t('admin:nodes.invalidJson')); return; }
    }
    updateNode.mutate({ id: node.id, configOverride: value || null });
  };
  const remove = () => deleteNode.mutate(node.id, { onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['admin', 'nodes'] }); navigate('/admin/nodes'); } });
  const wait = (taskId: string, label: string) => { void waitForTask({ nodeId: node.id, taskId, label }); };

  return (
    <PageContainer>
      <CertificateReturnLink />
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <IconButton variant="ghost" size="icon-sm" asChild aria-label={t('common:actions.back')}>
            <Link to="/admin/nodes"><ArrowLeft className="h-4 w-4" /></Link>
          </IconButton>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{node.name}</h1>
            <p className="truncate text-sm text-muted-foreground">{node.serverHost}</p>
          </div>
          <Badge variant={node.status === 'ONLINE' ? 'default' : 'secondary'}>{statusLabel}</Badge>
          <Badge variant={node.reachability === 'NAT' ? 'secondary' : 'outline'}>
            {node.reachability === 'NAT' ? t('admin:nodes.natTag') : t('admin:nodes.publicTag')}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to={`/admin/logs?nodeId=${node.id}&live=true`}><FileText />{t('admin:nodes.liveLogs')}</Link>
          </Button>
          <Button variant="outline" size="sm" disabled={reloadNode.isPending} onClick={() => reloadNode.mutate(node.id)}>
            <RefreshCw />{t('admin:nodes.restartKernel')}
          </Button>
          <Button variant="outline" size="sm" disabled={restartAgent.isPending} onClick={() => restartAgent.mutate(node.id, { onSuccess: (data) => data.requested && wait(data.taskId, t('admin:nodes.restartAgent')) })}>
            <RotateCcw />{t('admin:nodes.restartAgent')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setProbeOpen(true)}>
            <Network />{t('admin:nodes.probe')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setUpgradeOpen(true)}>
            <Wrench />{t('admin:nodes.upgradeCenter')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setInstallOpen(true)}>
            <Server />{t('admin:nodes.installCommands')}
          </Button>
        </div>
      </div>
      {node.configError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          <span className="font-medium">{t('admin:nodes.recentKernelError')}</span>
          {node.configError}
        </div>
      )}
      <DiagnosticsSnapshotCard key={node.id} node={node} />
      <SingboxDiagnosticsCard node={node} enabling={enableLogDiagnostics.isPending} disabling={disableLogDiagnostics.isPending} onEnable={(level) => enableLogDiagnostics.mutate({ id: node.id, level })} onDisable={() => disableLogDiagnostics.mutate(node.id)} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card><CardContent className="pt-5"><p className="text-xs text-muted-foreground">{t('admin:nodes.statLines')}</p><p className="mt-1 text-2xl font-semibold">{node.lines.length}</p></CardContent></Card>
        <Card><CardContent className="pt-5"><p className="text-xs text-muted-foreground">{t('admin:nodes.statPorts')}</p><p className="mt-1 text-2xl font-semibold">{node.servicePorts.length}</p></CardContent></Card>
        <Card><CardContent className="pt-5"><p className="text-xs text-muted-foreground">{t('admin:nodes.statCpu')}</p><p className="mt-1 text-2xl font-semibold">{node.status === 'ONLINE' && node.cpuUsage != null ? `${node.cpuUsage.toFixed(1)}%` : '—'}</p></CardContent></Card>
        <Card><CardContent className="pt-5"><p className="text-xs text-muted-foreground">{t('admin:nodes.statMem')}</p><p className="mt-1 text-2xl font-semibold">{node.status === 'ONLINE' && node.memoryUsage != null ? `${node.memoryUsage.toFixed(1)}%` : '—'}</p></CardContent></Card>
      </div>
      {node.status === 'ONLINE' && !node.supportsAgentLogRotation ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          {t('admin:nodes.logRotationNotice')}
        </div>
      ) : null}
      <Tabs defaultValue="lines">
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="lines">{t('admin:nodes.tabLines')}</TabsTrigger>
          <TabsTrigger value="basic">{t('admin:nodes.tabBasic')}</TabsTrigger>
          <TabsTrigger value="advanced">{t('admin:nodes.tabAdvanced')}</TabsTrigger>
        </TabsList>
        <TabsContent value="lines" className="space-y-4">
          <NodeLinesTab node={node} />
        </TabsContent>
        <TabsContent value="basic" className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">{t('admin:nodes.basicInfo')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <Form {...form}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField control={form.control} name="name" render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('admin:nodes.name')}</FormLabel>
                      <FormControl><Input {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="reachability" render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('admin:nodes.reachability')}</FormLabel>
                      <Select value={field.value} onValueChange={(val: 'PUBLIC' | 'NAT') => { field.onChange(val); if (val === 'NAT' && !form.getValues('serverHost')) { form.setValue('serverHost', '127.0.0.1'); } }}>
                        <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="PUBLIC">{t('admin:nodes.reachabilityPublic')}</SelectItem>
                          <SelectItem value="NAT">{t('admin:nodes.reachabilityNat')}</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="serverHost" render={({ field }) => (
                    <FormItem className="sm:col-span-2">
                      <FormLabel>{t('admin:nodes.serverHost')}</FormLabel>
                      <FormControl>
                        <Input placeholder={form.watch('reachability') === 'NAT' ? '127.0.0.1' : '198.51.100.1'} {...field} />
                      </FormControl>
                      <FormDescription>
                        {form.watch('reachability') === 'NAT' ? t('admin:nodes.serverHostNatDesc') : t('admin:nodes.serverHostPublicDesc')}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
                <Button size="sm" disabled={updateNode.isPending} onClick={saveBasic}>{t('admin:nodes.saveBasic')}</Button>
              </Form>
            </CardContent>
          </Card>
          <NodeProfileCards node={node} />
        </TabsContent>
        <TabsContent value="advanced" className="space-y-4">
          <Card><CardHeader><CardTitle className="text-base">{t('admin:nodes.probeSnapshot')}</CardTitle></CardHeader><CardContent><ProbeSnapshotCard snapshot={node.lastProbeResult} /></CardContent></Card>
          <NodeDeploymentHistory nodeId={node.id} />
          <Card><CardHeader><CardTitle className="text-base">{t('admin:nodes.configPreview')}</CardTitle></CardHeader><CardContent><GeneratedConfigPreview node={node} /></CardContent></Card>
          <Card>
            <CardHeader><CardTitle className="text-base">{t('admin:nodes.configOverride')}</CardTitle></CardHeader>
            <CardContent className="min-w-0 space-y-3">
              <CodeMirror value={override} height="360px" theme={resolvedTheme === 'dark' ? 'dark' : 'light'} extensions={[json()]} onChange={(value) => form.setValue('configOverride', value, { shouldDirty: true })} className="min-w-0 overflow-hidden rounded-md border" />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={updateNode.isPending} onClick={saveOverride}>{t('admin:nodes.saveOverride')}</Button>
                <Button size="sm" variant="outline" disabled={!override} onClick={() => form.setValue('configOverride', '', { shouldDirty: true })}>{t('admin:nodes.clear')}</Button>
              </div>
              <Separator />
              <p className="text-xs text-muted-foreground">{t('admin:nodes.configOverrideDesc')}</p>
            </CardContent>
          </Card>
          {node.configError && (
            <Card>
              <CardHeader><CardTitle className="text-base text-destructive">{t('admin:nodes.recentKernelError')}</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <pre className="max-h-64 overflow-auto rounded-md border border-destructive/30 bg-destructive/5 p-3 font-mono text-xs leading-relaxed text-destructive">{node.configError}</pre>
                <CopyButton value={node.configError} />
              </CardContent>
            </Card>
          )}
          {node.isLocal ? (
            <Card className="border-muted bg-muted/20">
              <CardHeader><CardTitle className="text-base">{t('admin:nodes.systemNode')}</CardTitle></CardHeader>
              <CardContent><p className="text-sm text-muted-foreground">{t('admin:nodes.systemNodeDesc')}</p></CardContent>
            </Card>
          ) : (
            <Card className="border-destructive/40 bg-destructive/5">
              <CardHeader><CardTitle className="flex items-center gap-2 text-base text-destructive"><Trash2 className="h-4 w-4" />{t('admin:nodes.dangerZone')}</CardTitle></CardHeader>
              <CardContent className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
                <p className="text-xs text-muted-foreground">{t('admin:nodes.dangerDesc')}</p>
                <AlertDialog>
                  <AlertDialogTrigger asChild><Button variant="destructive" size="sm" className="w-full sm:w-auto">{t('admin:nodes.deleteNode')}</Button></AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('admin:nodes.confirmDelete')}</AlertDialogTitle>
                      <AlertDialogDescription>{t('admin:nodes.confirmDeleteDesc')}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={remove}>{t('common:actions.confirm')}</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
      <InstallCommandDialog open={installOpen} onOpenChange={setInstallOpen} node={node} />
      <UpgradeNodeDialog open={upgradeOpen} onOpenChange={setUpgradeOpen} pending={upgradeNode.isPending} importing={importBinary.isPending} node={node} binaryInfo={binaryInfo} resources={binaryResources?.data} onSubmit={(values) => upgradeNode.mutate({ id: node.id, ...values }, { onSuccess: (data: { taskId: string; requested: boolean }) => data.requested && wait(data.taskId, t('admin:nodes.upgradeTitle')) })} onImport={(values) => importBinary.mutate(values)} />
      <ProbeNodeDialog open={probeOpen} onOpenChange={setProbeOpen} pending={probeNode.isPending} snapshot={node.lastProbeResult} onSubmit={(values) => probeNode.mutate({ id: node.id, ...values }, { onSuccess: (data: { taskId: string; requested: boolean }) => data.requested && wait(data.taskId, t('admin:nodes.probeTitle')) })} />
    </PageContainer>
  );
}
