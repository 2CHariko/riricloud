import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import { CertificatePager } from './certificate-pager';
import { useCertificateRecords, useCertificateMutations, type CertificateLine, type CertificateRevision, type CertificateDeployment } from './use-certificates';
import { formatDate } from '@/lib/utils';

export function CertificateLines({ id }: { id: string }) {
  const { t } = useTranslation(['admin', 'common']);
  const [page, setPage] = useState(1);
  const query = useCertificateRecords<CertificateLine>(id, 'lines', page);
  return <div className="space-y-2">
    {query.isError && <Button variant="outline" onClick={() => void query.refetch()}>{t('common:actions.retry')}</Button>}
    <Table><TableHeader><TableRow><TableHead>{t('admin:certificateManagement.lines')}</TableHead><TableHead>{t('admin:certificateManagement.associated')}</TableHead><TableHead>{t('admin:certificateManagement.hosting')}</TableHead><TableHead>{t('admin:certificateManagement.sni')}</TableHead></TableRow></TableHeader><TableBody>
      {query.data?.data.map(row => <TableRow key={row.id}>
        <TableCell><Button variant="link" asChild><Link to={'/admin/lines?lineId=' + row.id}>{row.name}</Link></Button><p className="text-xs">{row.protocolType} · {row.status}{row.inherited && <Badge variant="outline">{t('admin:certificateManagement.inherited')}</Badge>}</p></TableCell>
        <TableCell>{[row.entryNode?.name, row.landingNode?.name].filter(Boolean).join(' / ')}</TableCell>
        <TableCell>{row.hostingNodeIds.map(nodeId => [row.entryNode, row.landingNode].find(node => node?.id === nodeId)?.name ?? nodeId).join(' / ')}</TableCell>
        <TableCell><p className="break-all">{row.serverNames.join(' / ')}</p><Badge variant={row.validationError ? 'destructive' : 'secondary'}>{row.matched ? t('admin:certificateManagement.matched') : t('admin:certificateManagement.mismatched')}</Badge>{row.validationError && <p className="text-xs text-destructive">{row.validationError}</p>}</TableCell>
      </TableRow>)}
    </TableBody></Table>
    {query.data?.total === 0 && <p className="text-sm text-muted-foreground">{t('admin:certificateManagement.noRecords')}</p>}
    <CertificatePager page={page} total={query.data?.total ?? 0} onChange={setPage} />
  </div>;
}

export function CertificateHistory({ id, currentRevision }: { id: string; currentRevision: number }) {
  const { t } = useTranslation(['admin', 'common']);
  const [page, setPage] = useState(1), [selected, setSelected] = useState<number | null>(null);
  const query = useCertificateRecords<CertificateRevision>(id, 'revisions', page);
  const { rollback } = useCertificateMutations();
  return <div className="space-y-2">
    {query.isError && <Button variant="outline" onClick={() => void query.refetch()}>{t('common:actions.retry')}</Button>}
    {query.data?.data.map(row => <div key={row.revision} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
      <div><p>#{row.revision} · {formatDate(row.createdAt)}</p><p className="text-xs text-muted-foreground">{row.metadata.sans?.join(', ')} · {row.metadata.validTo && formatDate(row.metadata.validTo)}</p></div>
      <Button variant="outline" size="sm" disabled={row.revision === currentRevision || rollback.isPending} onClick={() => setSelected(row.revision)}>{t('admin:certificateManagement.rollback')}</Button>
    </div>)}
    <CertificatePager page={page} total={query.data?.total ?? 0} onChange={setPage} />
    <AlertDialog open={selected !== null} onOpenChange={open => !open && setSelected(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t('admin:certificateManagement.rollback')}</AlertDialogTitle><AlertDialogDescription>{t('admin:certificateManagement.rollbackConfirm', { revision: selected ?? 0 })}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel><AlertDialogAction disabled={rollback.isPending} onClick={() => selected !== null && rollback.mutate({ id, revision: selected, expectedRevision: currentRevision }, { onSuccess: () => setSelected(null) })}>{t('admin:certificateManagement.rollback')}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>;
}

export function CertificateDeployments({ id }: { id: string }) {
  const { t } = useTranslation(['admin', 'common']);
  const [page, setPage] = useState(1);
  const query = useCertificateRecords<CertificateDeployment>(id, 'deployments', page);
  const { retry } = useCertificateMutations();
  const labels: Record<string, string> = Object.fromEntries((['WAITING', 'SENT', 'ACCEPTED', 'CONFIRMED', 'FAILED', 'TIMEOUT', 'SUPERSEDED', 'UNCONFIRMED', 'UNMANAGED'] as const).map(state => [state, t(`admin:certificateManagement.${state}`)]));
  return <div className="space-y-3"><p className="text-xs text-muted-foreground">{t('admin:certificateManagement.runtimeNote')}</p>
    {query.isError && <Button variant="outline" onClick={() => void query.refetch()}>{t('common:actions.retry')}</Button>}
    {query.data?.data.map(row => <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
      <div><p>{row.nodeName} · {row.nodeStatus} · #{row.revision}</p>{row.configVersion !== null && <p className="text-xs text-muted-foreground">{t('admin:certificateManagement.configVersion', { version: row.configVersion })}</p>}<Badge variant={row.state === 'FAILED' || row.state === 'TIMEOUT' ? 'destructive' : 'secondary'}>{labels[row.state] ?? row.state}</Badge>{row.error && <p className="text-xs text-destructive">{row.error}</p>}</div>
      {['FAILED', 'TIMEOUT', 'UNCONFIRMED', 'WAITING'].includes(row.state) && row.nodeStatus !== 'REMOVED' && <Button variant="outline" disabled={retry.isPending} onClick={() => retry.mutate({ id, nodeIds: [row.nodeId] })}>{t('admin:certificateManagement.retry')}</Button>}
    </div>)}
    {query.data?.total === 0 && <p className="text-sm text-muted-foreground">{t('admin:certificateManagement.noRecords')}</p>}
    <CertificatePager page={page} total={query.data?.total ?? 0} onChange={setPage} />
  </div>;
}
