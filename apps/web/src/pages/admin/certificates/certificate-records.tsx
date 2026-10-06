import { useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Search, Pencil } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { certificateLinesPath, positivePage } from '@/lib/certificate-navigation';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
  const nodeLink = (node: { id: string; name: string }) => (
    <Button key={node.id} variant="link" className="h-auto p-0 text-xs font-normal text-muted-foreground hover:text-foreground" asChild>
      <Link to={'/admin/nodes/' + node.id} state={navigationState}>
        {node.name}
      </Link>
    </Button>
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label={t('admin:certificateManagement.lineSearch')}
            placeholder={t('admin:certificateManagement.lineSearch')}
            className="h-9 pl-8 text-xs"
            value={filters.search}
            onChange={event => change(1, { ...filters, search: event.target.value })}
          />
        </div>
        <Select value={filters.lineStatus || 'all'} onValueChange={value => change(1, { ...filters, lineStatus: value === 'all' ? '' : value })}>
          <SelectTrigger className="h-9 w-36 text-xs" aria-label={t('admin:certificateManagement.allLineStatuses')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('admin:certificateManagement.allLineStatuses')}</SelectItem>
            <SelectItem value="ACTIVE">{t('admin:certificateManagement.lineActive')}</SelectItem>
            <SelectItem value="DISABLED">{t('admin:certificateManagement.lineDisabled')}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filters.relation || 'all'} onValueChange={value => change(1, { ...filters, relation: value === 'all' ? '' : value })}>
          <SelectTrigger className="h-9 w-36 text-xs" aria-label={t('admin:certificateManagement.allRelations')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('admin:certificateManagement.allRelations')}</SelectItem>
            <SelectItem value="direct">{t('admin:certificateManagement.directBinding')}</SelectItem>
            <SelectItem value="inherited">{t('admin:certificateManagement.inherited')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {query.isPending && <p className="text-sm text-muted-foreground">{t('admin:certificateManagement.lineLoading')}</p>}
      {query.isError && (
        <div className="flex items-center gap-2">
          <p className="text-sm text-destructive">{t('admin:certificateManagement.lineUnavailable')}</p>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            {t('common:actions.retry')}
          </Button>
        </div>
      )}
      <div className="space-y-2.5">
        {query.data?.data.map((row) => {
          const distinctHostingNodes = row.hostingNodes.filter(
            (hn) => hn.id !== row.entryNode?.id && hn.id !== row.landingNode?.id
          );
          const hasNodes = Boolean(row.entryNode || row.landingNode || row.hostingNodes.length);

          return (
            <div
              key={row.id}
              className="rounded-lg border bg-card p-3.5 shadow-xs transition-colors hover:border-border/80"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`size-2 shrink-0 rounded-full ${
                      row.status === 'ACTIVE' ? 'bg-emerald-500' : 'bg-muted-foreground/40'
                    }`}
                  />
                  <Button variant="link" className="h-auto p-0 font-medium text-foreground hover:underline" asChild>
                    <Link to={'/admin/lines?lineId=' + row.id} state={navigationState}>
                      {row.name}
                    </Link>
                  </Button>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {row.protocolType}
                  </Badge>
                  <Badge variant="secondary" className="text-[10px] font-normal">
                    {t(`admin:lines.type${row.type === 'RELAY' ? 'Relay' : 'Direct'}`)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {t(`admin:certificateManagement.${row.status === 'ACTIVE' ? 'lineActive' : 'lineDisabled'}`)}
                  </span>
                </div>
                <Button variant="outline" size="sm" className="h-7 text-xs shrink-0" asChild>
                  <Link to={'/admin/lines?lineId=' + row.id + '&edit=1'} state={navigationState}>
                    <Pencil className="mr-1.5 size-3" />
                    {t('admin:certificateManagement.editLine')}
                  </Link>
                </Button>
              </div>

              <div className="mt-2.5 grid gap-3 text-xs sm:grid-cols-3">
                <div className="space-y-1">
                  <p className="text-[11px] font-medium text-muted-foreground">
                    {t('admin:certificateManagement.relation')}
                  </p>
                  <div>
                    <Badge variant={row.inherited ? 'secondary' : 'outline'} className="text-[10px] font-normal">
                      {t(`admin:certificateManagement.${row.inherited ? 'inherited' : 'directBinding'}`)}
                    </Badge>
                  </div>
                  {row.targetLine && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      <span className="text-[10px] block">{t('admin:certificateManagement.targetLine')}:</span>
                      <Button variant="link" className="h-auto p-0 text-xs font-normal" asChild>
                        <Link to={'/admin/lines?lineId=' + row.targetLine.id} state={navigationState}>
                          {row.targetLine.name}
                        </Link>
                      </Button>
                    </div>
                  )}
                </div>

                <div className="space-y-1">
                  <p className="text-[11px] font-medium text-muted-foreground">
                    {t('admin:certificates.topologyNodes')}
                  </p>
                  {hasNodes ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {[row.entryNode, row.landingNode]
                        .filter((node): node is NonNullable<typeof node> => Boolean(node))
                        .map(nodeLink)}
                      {distinctHostingNodes.map(nodeLink)}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </div>

                <div className="space-y-1">
                  <p className="text-[11px] font-medium text-muted-foreground">
                    {t('admin:certificates.clientSni')}
                  </p>
                  <p className="break-all font-mono text-xs text-foreground">
                    {row.serverNames.length ? row.serverNames.join(' / ') : '-'}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <Badge
                      variant={row.validationError ? 'destructive' : row.matched ? 'outline' : 'secondary'}
                      className="text-[10px] font-normal"
                    >
                      {row.matched
                        ? t('admin:certificateManagement.matched')
                        : t('admin:certificateManagement.mismatched')}
                    </Badge>
                    {row.validationError && (
                      <span className="text-[11px] text-destructive">{row.validationError}</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {query.data?.total === 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">{t('admin:certificateManagement.noRecords')}</p>
      )}
      <CertificatePager page={page} total={query.data?.total ?? 0} onChange={value => change(value)} />
    </div>
  );
}

export function CertificateHistory({ id, currentRevision }: { id: string; currentRevision: number }) {
  const { t } = useTranslation(['admin', 'common']);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number | null>(null);
  const query = useCertificateRecords<CertificateRevision>(id, 'revisions', page);
  const { rollback } = useCertificateMutations();

  return (
    <div className="space-y-3">
      {query.isError && (
        <div className="flex items-center gap-2">
          <p className="text-sm text-destructive">{t('admin:certificateManagement.lineUnavailable')}</p>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            {t('common:actions.retry')}
          </Button>
        </div>
      )}

      <div className="space-y-2">
        {query.data?.data.map((row) => {
          const isCurrent = row.revision === currentRevision;

          return (
            <div
              key={row.revision}
              className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3.5 text-xs shadow-xs transition-colors ${
                isCurrent ? 'border-primary/40 bg-primary/5' : 'bg-card'
              }`}
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-foreground">
                    #{row.revision}
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-muted-foreground">{formatDate(row.createdAt)}</span>
                  {isCurrent && (
                    <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-500">
                      {t('admin:certificates.currentActiveVersion')}
                    </Badge>
                  )}
                </div>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {row.metadata.sans?.length ? row.metadata.sans.join(', ') : '-'}
                  {row.metadata.validTo && ` · ${t('admin:certificates.validity')}: ${formatDate(row.metadata.validTo)}`}
                </p>
              </div>

              <div>
                <Button
                  variant={isCurrent ? 'ghost' : 'outline'}
                  size="sm"
                  className="h-7 text-xs"
                  disabled={isCurrent || rollback.isPending}
                  onClick={() => setSelected(row.revision)}
                >
                  {isCurrent ? t('admin:certificates.currentActiveVersion') : t('admin:certificates.rollbackToRevision')}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {query.data?.total === 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">{t('admin:certificateManagement.noRecords')}</p>
      )}

      <CertificatePager page={page} total={query.data?.total ?? 0} onChange={setPage} />

      <AlertDialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin:certificateManagement.rollback')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin:certificateManagement.rollbackConfirm', { revision: selected ?? 0 })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={rollback.isPending}
              onClick={() =>
                selected !== null &&
                rollback.mutate(
                  { id, revision: selected, expectedRevision: currentRevision },
                  { onSuccess: () => setSelected(null) }
                )
              }
            >
              {t('admin:certificateManagement.rollback')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function CertificateDeployments({ id }: { id: string }) {
  const { t } = useTranslation(['admin', 'common']);
  const [page, setPage] = useState(1);
  const query = useCertificateRecords<CertificateDeployment>(id, 'deployments', page);
  const { retry } = useCertificateMutations();

  const labels: Record<string, string> = Object.fromEntries(
    ([
      'WAITING',
      'SENT',
      'ACCEPTED',
      'CONFIRMED',
      'FAILED',
      'TIMEOUT',
      'SUPERSEDED',
      'UNCONFIRMED',
      'UNMANAGED'
    ] as const).map((state) => [state, t(`admin:certificateManagement.${state}`)])
  );

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        {t('admin:certificateManagement.runtimeNote')}
      </div>

      {query.isError && (
        <div className="flex items-center gap-2">
          <p className="text-sm text-destructive">{t('admin:certificateManagement.lineUnavailable')}</p>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            {t('common:actions.retry')}
          </Button>
        </div>
      )}

      <div className="space-y-2">
        {query.data?.data.map((row) => (
          <div
            key={row.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3.5 text-xs shadow-xs transition-colors"
          >
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-foreground">{row.nodeName}</span>
                <span className="text-muted-foreground">·</span>
                <Badge variant="outline" className="text-[10px]">
                  {row.nodeStatus}
                </Badge>
                <span className="font-mono text-[10px] text-muted-foreground">#{row.revision}</span>
              </div>
              {row.configVersion !== null && (
                <p className="text-[11px] text-muted-foreground">
                  {t('admin:certificateManagement.configVersion', { version: row.configVersion })}
                </p>
              )}
              {row.error && <p className="text-xs text-destructive">{row.error}</p>}
            </div>

            <div className="flex items-center gap-2">
              <Badge
                variant={
                  row.state === 'CONFIRMED'
                    ? 'outline'
                    : row.state === 'FAILED' || row.state === 'TIMEOUT'
                    ? 'destructive'
                    : 'secondary'
                }
                className={
                  row.state === 'CONFIRMED'
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500 text-[10px]'
                    : 'text-[10px]'
                }
              >
                {labels[row.state] ?? row.state}
              </Badge>
              {['FAILED', 'TIMEOUT', 'UNCONFIRMED', 'WAITING'].includes(row.state) && row.nodeStatus !== 'REMOVED' && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={retry.isPending}
                  onClick={() => retry.mutate({ id, nodeIds: [row.nodeId] })}
                >
                  {t('admin:certificateManagement.retry')}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      {query.data?.total === 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">{t('admin:certificateManagement.noRecords')}</p>
      )}

      <CertificatePager page={page} total={query.data?.total ?? 0} onChange={setPage} />
    </div>
  );
}
