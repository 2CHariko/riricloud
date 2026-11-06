import * as React from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n/config';
import { zodResolver } from '@/lib/zod-resolver';
import { Copy, Pencil, Plus, RefreshCw, RotateCcw, Trash2, Wifi } from 'lucide-react';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { PageContainer, PageHeader } from '@/components/shared/page-container';
import { EmptyState } from '@/components/shared/empty-state';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Card, CardContent } from '@/components/ui/card';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useFormResetOnKey } from '@/hooks/use-form-reset';
import { useAdminNodes } from '@/pages/admin/nodes/use-nodes';
import { useMirrorMutations, useAdminMirrors, type ApiMirror, type MirrorAccessMode, type MirrorPayload } from './use-mirrors';

const mirrorFormSchema = z.object({
  name: z.string().trim().min(1, i18n.t('admin:mirrors.valNameReq')).max(64, i18n.t('admin:mirrors.valNameMax')),
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{2,62}$/, i18n.t('admin:mirrors.valSlugFormat')),
  upstreamBaseUrl: z.string().trim().regex(/^https?:\/\//i, i18n.t('admin:mirrors.valUpstreamUrl')),
  allowedOrigins: z.string().trim().min(1, i18n.t('admin:mirrors.valAllowedOrigins')),
  nodeId: z.string().trim().min(1, i18n.t('admin:mirrors.valNodeIdReq')),
  accessMode: z.enum(['ADMIN', 'SHARE', 'PUBLIC']),
  enabled: z.boolean(),
  shareExpiresAt: z.string()
});

type MirrorFormValues = z.infer<typeof mirrorFormSchema>;

function emptyMirrorFormValues(): MirrorFormValues {
  return { name: '', slug: '', upstreamBaseUrl: '', allowedOrigins: '', nodeId: '', accessMode: 'ADMIN', enabled: false, shareExpiresAt: '' };
}

function mirrorToFormValues(mirror: ApiMirror): MirrorFormValues {
  return {
    name: mirror.name,
    slug: mirror.slug,
    upstreamBaseUrl: mirror.upstreamBaseUrl,
    allowedOrigins: mirror.allowedOrigins.join('\n'),
    nodeId: mirror.nodeId,
    accessMode: mirror.accessMode,
    enabled: mirror.enabled,
    shareExpiresAt: mirror.shareExpiresAt ? mirror.shareExpiresAt.slice(0, 16) : ''
  };
}

function MirrorForm({ open, editing, nodes, pending, onOpenChange, onSubmit }: { open: boolean; editing: ApiMirror | null; nodes: ReturnType<typeof useAdminNodes>['data']; pending: boolean; onOpenChange: (open: boolean) => void; onSubmit: (payload: MirrorPayload) => void }) {
  const { t } = useTranslation(['admin', 'common']);
  const availableNodes = React.useMemo(
    () => (nodes ?? []).filter((node) => node.communicationMode === 'WS' && node.status === 'ONLINE' && node.supportsMirrorProxy),
    [nodes]
  );
  const form = useForm<MirrorFormValues>({
    resolver: zodResolver(mirrorFormSchema),
    defaultValues: emptyMirrorFormValues()
  });

  useFormResetOnKey({
    open,
    resetKey: editing?.id ?? 'create',
    reset: () => form.reset(editing ? mirrorToFormValues(editing) : emptyMirrorFormValues())
  });

  React.useEffect(() => {
    if (!open) return;
    const firstAvailable = availableNodes[0]?.id;
    if (firstAvailable && !form.getValues('nodeId')) form.setValue('nodeId', firstAvailable);
  }, [availableNodes, form, open]);

  const accessMode = form.watch('accessMode');
  const nodeId = form.watch('nodeId');
  const selectedNodeMissing = Boolean(nodeId) && !availableNodes.some((node) => node.id === nodeId);

  const submit = form.handleSubmit((values) => onSubmit({
    name: values.name.trim(),
    slug: values.slug.trim().toLowerCase(),
    upstreamBaseUrl: values.upstreamBaseUrl.trim(),
    allowedOrigins: values.allowedOrigins.split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
    nodeId: values.nodeId,
    accessMode: values.accessMode,
    enabled: values.enabled,
    ...(values.accessMode === 'SHARE' && values.shareExpiresAt ? { shareExpiresAt: new Date(values.shareExpiresAt).toISOString() } : {})
  }));

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent size="wide">
        <DialogHeader>
          <DialogTitle>{editing ? t('admin:mirrors.editMirror') : t('admin:mirrors.addMirror')}</DialogTitle>
          <DialogDescription>{t('admin:mirrors.formDesc')}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-4" onSubmit={submit}>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>{t('admin:mirrors.name')}</FormLabel><FormControl><Input placeholder="GitHub Raw" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="slug" render={({ field }) => (
                <FormItem><FormLabel>{t('admin:mirrors.slug')}</FormLabel><FormControl><Input placeholder="github-raw" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
            </div>
            <FormField control={form.control} name="upstreamBaseUrl" render={({ field }) => (
              <FormItem><FormLabel>{t('admin:mirrors.upstream')}</FormLabel><FormControl><Input type="url" placeholder="https://raw.githubusercontent.com" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="allowedOrigins" render={({ field }) => (
              <FormItem>
                <FormLabel>{t('admin:mirrors.allowedOrigins')}</FormLabel>
                <FormControl><Textarea rows={3} placeholder={'raw.githubusercontent.com\nobjects.githubusercontent.com'} {...field} /></FormControl>
                <FormDescription>{t('admin:mirrors.allowedOriginsDesc')}</FormDescription>
                <FormMessage />
              </FormItem>
            )} />
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField control={form.control} name="nodeId" render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('admin:mirrors.outboundNode')}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl><SelectTrigger><SelectValue placeholder={t('admin:mirrors.selectNode')} /></SelectTrigger></FormControl>
                    <SelectContent>{availableNodes.map((node) => <SelectItem key={node.id} value={node.id}>{node.name} · {node.serverHost}</SelectItem>)}</SelectContent>
                  </Select>
                  {!availableNodes.length && <p className="text-xs text-destructive">{t('admin:mirrors.noAvailableNodes')}</p>}
                  {selectedNodeMissing && <p className="text-xs text-destructive">{t('admin:mirrors.nodeUnavailable')}</p>}
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="accessMode" render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('admin:mirrors.accessPolicy')}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="ADMIN">{t('admin:mirrors.modeAdminSession')}</SelectItem>
                      <SelectItem value="SHARE">{t('admin:mirrors.modeShareToken')}</SelectItem>
                      <SelectItem value="PUBLIC">{t('admin:mirrors.modePublicAccess')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            {accessMode === 'SHARE' && (
              <FormField control={form.control} name="shareExpiresAt" render={({ field }) => (
                <FormItem><FormLabel>{t('admin:mirrors.shareExpiresAt')}</FormLabel><FormControl><Input type="datetime-local" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
            )}
            <FormField control={form.control} name="enabled" render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-md border p-3">
                <div><FormLabel>{t('admin:mirrors.enableMirror')}</FormLabel><FormDescription>{t('admin:mirrors.enableMirrorDesc')}</FormDescription></div>
                <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
              </FormItem>
            )} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common:actions.cancel')}</Button>
              <Button type="submit" disabled={!availableNodes.length || pending}>{pending ? t('common:actions.saving') : editing ? t('common:actions.save') : t('common:actions.create')}</Button>
            </DialogFooter>
          </form>
        </Form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

export default function AdminMirrorsPage() {
  const { t } = useTranslation(['admin', 'common']);
  const { data, isPending, isError } = useAdminMirrors();
  const { data: nodes } = useAdminNodes();
  const mutations = useMirrorMutations();
  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ApiMirror | null>(null);
  const [deleting, setDeleting] = React.useState<ApiMirror | null>(null);
  const [shareToken, setShareToken] = React.useState<string | null>(null);
  const [testResult, setTestResult] = React.useState<Record<string, unknown> | null>(null);

  const accessLabels: Record<MirrorAccessMode, string> = {
    ADMIN: t('admin:mirrors.modeAdmin'),
    SHARE: t('admin:mirrors.modeShare'),
    PUBLIC: t('admin:mirrors.modePublic')
  };

  const openCreate = () => { setEditing(null); setFormOpen(true); };
  const submit = (payload: MirrorPayload) => {
    const onSuccess = (result: { shareToken?: string }) => { if (result.shareToken) setShareToken(result.shareToken); setFormOpen(false); };
    if (editing) mutations.update.mutate({ id: editing.id, ...payload }, { onSuccess });
    else mutations.create.mutate(payload, { onSuccess });
  };

  if (isPending) {
    return (
      <PageContainer>
        <PageHeader title={t('admin:mirrors.title')} description={t('admin:mirrors.subtitle')} />
        <p className="text-sm text-muted-foreground">{t('common:actions.loading')}</p>
      </PageContainer>
    );
  }

  if (isError) {
    return (
      <PageContainer>
        <PageHeader title={t('admin:mirrors.title')} />
        <EmptyState title={t('admin:mirrors.loadErrorTitle')} description={t('admin:mirrors.loadErrorDesc')} />
      </PageContainer>
    );
  }

  const items = data?.items ?? [];

  return (
    <PageContainer>
      <PageHeader title={t('admin:mirrors.title')} description={t('admin:mirrors.subtitle')} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={openCreate}><Plus />{t('admin:mirrors.addMirror')}</Button>
      </div>
      <Card>
        <CardContent className="min-w-0 p-0">
          {items.length ? (
            <Table className="min-w-[980px]">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('admin:mirrors.colMirror')}</TableHead>
                  <TableHead>{t('admin:mirrors.colUpstream')}</TableHead>
                  <TableHead>{t('admin:mirrors.colNode')}</TableHead>
                  <TableHead>{t('admin:mirrors.colAccess')}</TableHead>
                  <TableHead>{t('admin:mirrors.colStatus')}</TableHead>
                  <TableHead className="text-right">{t('admin:mirrors.colActions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((mirror) => (
                  <TableRow key={mirror.id}>
                    <TableCell>
                      <div className="font-medium">{mirror.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">/mirror/{mirror.slug}</div>
                    </TableCell>
                    <TableCell className="max-w-64 truncate text-sm">{mirror.upstreamBaseUrl}</TableCell>
                    <TableCell>
                      <div>{mirror.node.name}</div>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Wifi className="size-3" />
                        {mirror.node.status === 'ONLINE' && mirror.node.supportsMirrorProxy ? t('admin:mirrors.wsAvailable') : t('admin:mirrors.wsUnavailable')}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={mirror.accessMode === 'PUBLIC' ? 'outline' : 'secondary'}>{accessLabels[mirror.accessMode]}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={mirror.enabled ? 'default' : 'secondary'}>
                        {mirror.enabled ? t('common:status.enabled') : t('common:status.disabled')}
                      </Badge>
                      {mirror.lastErrorCode && <div className="mt-1 text-xs text-destructive">{mirror.lastErrorCode}</div>}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <IconButton
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('admin:mirrors.testMirror')}
                          title={t('admin:mirrors.testMirror')}
                          disabled={mutations.test.isPending}
                          onClick={() => mutations.test.mutate(mirror.id, { onSuccess: setTestResult })}
                        >
                          <RefreshCw />
                        </IconButton>
                        {mirror.accessMode === 'SHARE' && (
                          <IconButton
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('admin:mirrors.rotateToken')}
                            title={t('admin:mirrors.rotateToken')}
                            onClick={() => mutations.rotate.mutate(mirror.id, { onSuccess: (result) => setShareToken(result.shareToken) })}
                          >
                            <RotateCcw />
                          </IconButton>
                        )}
                        <IconButton
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('admin:mirrors.editMirror')}
                          title={t('admin:mirrors.editMirror')}
                          onClick={() => { setEditing(mirror); setFormOpen(true); }}
                        >
                          <Pencil />
                        </IconButton>
                        <IconButton
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('common:actions.delete')}
                          title={t('common:actions.delete')}
                          onClick={() => setDeleting(mirror)}
                        >
                          <Trash2 className="text-destructive" />
                        </IconButton>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState title={t('admin:mirrors.emptyMirrors')} description={t('admin:mirrors.subtitle')} className="border-0" />
          )}
        </CardContent>
      </Card>

      <MirrorForm
        open={formOpen}
        editing={editing}
        nodes={nodes}
        pending={mutations.create.isPending || mutations.update.isPending}
        onOpenChange={setFormOpen}
        onSubmit={submit}
      />

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin:mirrors.deleteDialogTitle', { name: deleting?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('admin:mirrors.deleteDialogDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleting && mutations.remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}>
              {t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ResponsiveDialog open={!!shareToken} onOpenChange={(open) => !open && setShareToken(null)}>
        <ResponsiveDialogContent size="compact">
          <DialogHeader>
            <DialogTitle>{t('admin:mirrors.shareTokenTitle')}</DialogTitle>
            <DialogDescription>{t('admin:mirrors.shareTokenDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Token</Label>
            <div className="flex gap-2">
              <Input readOnly value={shareToken ?? ''} className="font-mono text-xs" />
              <IconButton size="icon-sm" aria-label={t('common:actions.copy')} title={t('common:actions.copy')} onClick={() => shareToken && void navigator.clipboard.writeText(`${window.location.origin}/mirror/share/${shareToken}`)}>
                <Copy />
              </IconButton>
            </div>
            <p className="break-all text-xs text-muted-foreground">{window.location.origin}/mirror/share/{shareToken}</p>
          </div>
          <DialogFooter>
            <Button onClick={() => setShareToken(null)}>{t('common:actions.close')}</Button>
          </DialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      <ResponsiveDialog open={!!testResult} onOpenChange={(open) => !open && setTestResult(null)}>
        <ResponsiveDialogContent size="compact">
          <DialogHeader>
            <DialogTitle>{t('admin:mirrors.testResultTitle')}</DialogTitle>
            <DialogDescription>{t('admin:mirrors.testResultDesc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">{t('admin:mirrors.result')}</span>
              <span>{testResult?.success ? t('admin:mirrors.success') : t('admin:mirrors.failure')}</span>
            </div>
            {Object.entries(testResult ?? {}).filter(([key]) => key !== 'success').map(([key, value]) => (
              <div key={key} className="flex justify-between gap-4">
                <span className="text-muted-foreground">{key}</span>
                <span className="break-all text-right">{String(value)}</span>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button onClick={() => setTestResult(null)}>{t('common:actions.close')}</Button>
          </DialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </PageContainer>
  );
}
