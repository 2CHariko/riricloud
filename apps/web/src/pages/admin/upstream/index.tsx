import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Plus, RefreshCw, Trash2, Pencil, Database } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { PageContainer, PageHeader } from '@/components/shared/page-container';
import { ServerPagination } from '@/components/shared/server-pagination';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiUpstreamSubscription, ApiUpstreamNode } from '@/lib/api';
import { formatUpstreamBytes } from '@/lib/upstream-usage';
import { formatDateTime } from '@/lib/utils';
import { useAdminUpstreams, useAdminUpstreamMutations } from './use-upstream';
import { UpstreamFormDialog, UpstreamFormSubmitValues } from './components/upstream-form-dialog';
import { UpstreamNodesSheet } from './components/upstream-nodes-sheet';

export default function AdminUpstreamPage() {
  const { t } = useTranslation(['admin', 'common']);
  const navigate = useNavigate();
  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState('ALL');
  const [page, setPage] = React.useState(1);
  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ApiUpstreamSubscription | null>(null);
  const [pool, setPool] = React.useState<ApiUpstreamSubscription | null>(null);
  const [deleting, setDeleting] = React.useState<ApiUpstreamSubscription | null>(null);
  const { data, isLoading, isError } = useAdminUpstreams({ page, pageSize: 20, search: search.trim() || undefined, status: status === 'ALL' ? undefined : status });
  const { createMutation, updateMutation, deleteMutation, syncMutation } = useAdminUpstreamMutations();
  const submit = (values: UpstreamFormSubmitValues) => editing
    ? updateMutation.mutate({ id: editing.id, data: values }, { onSuccess: () => setFormOpen(false) })
    : createMutation.mutate(values, { onSuccess: () => setFormOpen(false) });
  const createLine = (node: ApiUpstreamNode, createExternal: boolean) => {
    setPool(null);
    navigate('/admin/lines', { state: { createUpstreamNode: node, createExternal } });
  };
  const unknown = t('common:status.unknown');
  return <PageContainer>
    <PageHeader title={t('admin:upstream.title')} description={t('admin:upstream.subtitle')} />
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Input className="max-w-sm" placeholder={t('admin:upstream.searchPlaceholder')} value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
      <div className="flex gap-2">
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}><SelectTrigger className="w-32"><SelectValue /></SelectTrigger><SelectContent>{['ALL', 'ACTIVE', 'DISABLED'].map((v) => <SelectItem key={v} value={v}>{v === 'ALL' ? t('admin:upstream.statusAll') : v === 'ACTIVE' ? t('admin:upstream.statusActive') : t('admin:upstream.statusDisabled')}</SelectItem>)}</SelectContent></Select>
        <Button onClick={() => { setEditing(null); setFormOpen(true); }}><Plus className="size-4" />{t('admin:upstream.addSubscription')}</Button>
      </div>
    </div>
    <p className="text-xs text-muted-foreground">{t('admin:upstream.usageSnapshot')}</p>
    <Card><CardContent className="min-w-0 p-0"><Table>
      <TableHeader><TableRow>{(['colName', 'colType', 'colNodes', 'colQuota', 'colLastSync', 'colStatus', 'colActions'] as const).map((key) => <TableHead key={key}>{t(`admin:upstream.${key}`)}</TableHead>)}</TableRow></TableHeader>
      <TableBody>
        {isLoading || isError || !data?.data.length ? <TableRow><TableCell colSpan={7}>{isLoading ? t('common:actions.loading') : isError ? t('common:status.failed') : t('admin:upstream.emptyTitle')}</TableCell></TableRow> : data.data.map((sub) => <TableRow key={sub.id}>
          <TableCell><p className="font-medium">{sub.name}</p>{sub.url && <p className="max-w-xs truncate text-xs text-muted-foreground">{t('admin:upstream.maskedUrl')}</p>}</TableCell>
          <TableCell><Badge variant="outline">{sub.sourceType}</Badge><p className="text-xs">{sub.format}</p><p className="text-xs text-muted-foreground">{t('admin:upstream.detectedFormat', { format: sub.detectedFormat ?? unknown })}</p></TableCell>
          <TableCell><Button variant="link" onClick={() => setPool(sub)}>{sub.nodeCount}</Button></TableCell>
          <TableCell className="text-xs"><p>{formatUpstreamBytes(sub.userInfoUsedBytes, unknown)} / {formatUpstreamBytes(sub.userInfoTotalBytes, unknown)}</p><p>{t('admin:upstream.expireTime')}: {sub.userInfoExpireAt ? formatDateTime(sub.userInfoExpireAt) : unknown}</p></TableCell>
          <TableCell className="text-xs"><p>{syncMutation.isPending && syncMutation.variables === sub.id ? t('admin:upstream.syncing') : sub.lastSyncStatus}</p><p>{sub.lastSyncAt ? formatDateTime(sub.lastSyncAt) : t('admin:upstream.never')}</p><p>{t('admin:upstream.lastSuccess')}: {sub.lastSuccessAt ? formatDateTime(sub.lastSuccessAt) : t('admin:upstream.never')}</p>{sub.lastSyncMessage && <p className="max-w-xs break-words text-destructive">{sub.lastSyncMessage}</p>}{sub.autoUpdate && <p>{t('admin:upstream.intervalMinutes', { minutes: sub.updateIntervalMins })}</p>}</TableCell>
          <TableCell><Badge variant={sub.status === 'ACTIVE' ? 'default' : 'secondary'}>{sub.status === 'ACTIVE' ? t('admin:upstream.statusActive') : t('admin:upstream.statusDisabled')}</Badge></TableCell>
          <TableCell><div className="flex gap-1">
            <IconButton variant="ghost" size="icon-sm" aria-label={t('admin:upstream.syncNow')} disabled={syncMutation.isPending} onClick={() => syncMutation.mutate(sub.id)}><RefreshCw className={syncMutation.isPending && syncMutation.variables === sub.id ? 'animate-spin' : ''} /></IconButton>
            <IconButton variant="ghost" size="icon-sm" aria-label={t('admin:upstream.nodesTitle')} onClick={() => setPool(sub)}><Database /></IconButton>
            <IconButton variant="ghost" size="icon-sm" aria-label={t('common:actions.edit')} onClick={() => { setEditing(sub); setFormOpen(true); }}><Pencil /></IconButton>
            <IconButton variant="ghost" size="icon-sm" aria-label={t('common:actions.delete')} onClick={() => setDeleting(sub)}><Trash2 /></IconButton>
          </div></TableCell>
        </TableRow>)}
      </TableBody>
    </Table></CardContent></Card>
    <ServerPagination page={page} pageSize={20} total={data?.total ?? 0} onPageChange={setPage} pending={isLoading} />
    <UpstreamFormDialog open={formOpen} onOpenChange={setFormOpen} current={editing} onSubmit={submit} isPending={createMutation.isPending || updateMutation.isPending} />
    <UpstreamNodesSheet key={pool?.id ?? 'closed'} open={!!pool} onOpenChange={(v) => !v && setPool(null)} subscription={pool} onCreateRelayLine={(node) => createLine(node, false)} onCreateExternalLine={(node) => createLine(node, true)} />
    <AlertDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t('admin:upstream.deleteTitle', { name: deleting?.name ?? '' })}</AlertDialogTitle><AlertDialogDescription>{t('admin:upstream.deleteDesc')}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel><AlertDialogAction disabled={deleteMutation.isPending} onClick={() => deleting && deleteMutation.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}>{t('common:actions.delete')}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </PageContainer>;
}
