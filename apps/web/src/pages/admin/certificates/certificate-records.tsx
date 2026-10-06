import { useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { certificateLinesPath, positivePage } from '@/lib/certificate-navigation';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import { CertificatePager } from './certificate-pager';
import { useCertificateRecords, useCertificateMutations, type CertificateLine, type CertificateRevision, type CertificateDeployment } from './use-certificates';
import { formatDate } from '@/lib/utils';

export function CertificateLines({ id, preserveContext = false }: { id: string; preserveContext?: boolean }) {
  const { t } = useTranslation(['admin', 'common']);
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [localPage, setLocalPage] = useState(1);
  const [localFilters, setLocalFilters] = useState({ search: '', lineStatus: '', relation: '' });
  const page = preserveContext ? positivePage(params.get('linePage')) : localPage;
  const filters = preserveContext ? { search: params.get('lineSearch') ?? '', lineStatus: params.get('lineStatus') ?? '', relation: params.get('lineRelation') ?? '' } : localFilters;
  const query = useCertificateRecords<CertificateLine>(id, 'lines', page, true, filters);
  const returnTo = certificateLinesPath(location.search, id, page, filters);
  const navigationState = { certificateReturn: returnTo };
  const change = (nextPage: number, nextFilters = filters) => {
    if (preserveContext) setParams(new URLSearchParams(certificateLinesPath(location.search, id, nextPage, nextFilters).split('?')[1]), { replace: true });
    else { setLocalPage(nextPage); setLocalFilters(nextFilters); }
  };
  const nodeLink = (node: { id: string; name: string }) => <Button key={node.id} variant="link" className="h-auto p-0" asChild><Link to={'/admin/nodes/' + node.id} state={navigationState}>{node.name}</Link></Button>;
  return <div className="space-y-2">
    <div className="flex flex-wrap gap-2">
      <Input aria-label={t('admin:certificateManagement.lineSearch')} placeholder={t('admin:certificateManagement.lineSearch')} className="sm:max-w-xs" value={filters.search} onChange={event => change(1, { ...filters, search: event.target.value })} />
      <Select value={filters.lineStatus || 'all'} onValueChange={value => change(1, { ...filters, lineStatus: value === 'all' ? '' : value })}><SelectTrigger className="w-full sm:w-40" aria-label={t('admin:certificateManagement.allLineStatuses')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('admin:certificateManagement.allLineStatuses')}</SelectItem><SelectItem value="ACTIVE">{t('admin:certificateManagement.lineActive')}</SelectItem><SelectItem value="DISABLED">{t('admin:certificateManagement.lineDisabled')}</SelectItem></SelectContent></Select>
      <Select value={filters.relation || 'all'} onValueChange={value => change(1, { ...filters, relation: value === 'all' ? '' : value })}><SelectTrigger className="w-full sm:w-40" aria-label={t('admin:certificateManagement.allRelations')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('admin:certificateManagement.allRelations')}</SelectItem><SelectItem value="direct">{t('admin:certificateManagement.directBinding')}</SelectItem><SelectItem value="inherited">{t('admin:certificateManagement.inherited')}</SelectItem></SelectContent></Select>
    </div>
    {query.isPending && <p className="text-sm text-muted-foreground">{t('admin:certificateManagement.lineLoading')}</p>}
    {query.isError && <div className="flex items-center gap-2"><p className="text-sm text-destructive">{t('admin:certificateManagement.lineUnavailable')}</p><Button variant="outline" onClick={() => void query.refetch()}>{t('common:actions.retry')}</Button></div>}
    <Table><TableHeader><TableRow><TableHead>{t('admin:certificateManagement.lines')}</TableHead><TableHead>{t('admin:certificateManagement.relation')}</TableHead><TableHead>{t('admin:certificateManagement.associated')}</TableHead><TableHead>{t('admin:certificateManagement.hosting')}</TableHead><TableHead>{t('admin:certificateManagement.sni')}</TableHead><TableHead>{t('common:actions.edit')}</TableHead></TableRow></TableHeader><TableBody>
      {query.data?.data.map(row => <TableRow key={row.id}>
        <TableCell><Button variant="link" className="h-auto p-0" asChild><Link to={'/admin/lines?lineId=' + row.id} state={navigationState}>{row.name}</Link></Button><p className="text-xs">{row.protocolType} · {t(`admin:lines.type${row.type === 'RELAY' ? 'Relay' : 'Direct'}`)} · {t(`admin:certificateManagement.${row.status === 'ACTIVE' ? 'lineActive' : 'lineDisabled'}`)}</p></TableCell>
        <TableCell><Badge variant="outline">{t(`admin:certificateManagement.${row.inherited ? 'inherited' : 'directBinding'}`)}</Badge>{row.targetLine && <div className="mt-1 text-xs"><p>{t('admin:certificateManagement.targetLine')}</p><Button variant="link" className="h-auto p-0" asChild><Link to={'/admin/lines?lineId=' + row.targetLine.id} state={navigationState}>{row.targetLine.name}</Link></Button></div>}</TableCell>
        <TableCell><div className="flex flex-col items-start gap-1">{[row.entryNode, row.landingNode].filter((node): node is NonNullable<typeof node> => Boolean(node)).map(nodeLink)}</div></TableCell>
        <TableCell><div className="flex flex-col items-start gap-1">{row.hostingNodes.map(nodeLink)}</div></TableCell>
        <TableCell><p className="break-all">{row.serverNames.join(' / ')}</p><Badge variant={row.validationError ? 'destructive' : 'secondary'}>{row.matched ? t('admin:certificateManagement.matched') : t('admin:certificateManagement.mismatched')}</Badge>{row.validationError && <p className="text-xs text-destructive">{row.validationError}</p>}</TableCell>
        <TableCell><Button variant="outline" size="sm" asChild><Link to={'/admin/lines?lineId=' + row.id + '&edit=1'} state={navigationState}>{t('admin:certificateManagement.editLine')}</Link></Button></TableCell>
      </TableRow>)}
    </TableBody></Table>
    {query.data?.total === 0 && <p className="text-sm text-muted-foreground">{t('admin:certificateManagement.noRecords')}</p>}
    <CertificatePager page={page} total={query.data?.total ?? 0} onChange={value => change(value)} />
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
