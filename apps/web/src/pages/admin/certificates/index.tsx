import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { positivePage } from '@/lib/certificate-navigation';
import { CertificateLinesDialog } from './certificate-lines-dialog';
import {
  AlertTriangle,
  Clock,
  Eye,
  GitBranch,
  KeyRound,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PageContainer, PageHeader } from '@/components/shared/page-container';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CertificatePager } from './certificate-pager';
import { CertificateLines } from './certificate-records';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog';
import type { ApiCertificate, CertificateStatus } from '@/lib/api';
import { cn, formatDate } from '@/lib/utils';
import { CertificateDetailDialog } from './certificate-detail-dialog';
import { CertificateFormDialog } from './certificate-form-dialog';
import { useAdminCertificates, useCertificateMutations, useCertificateSummary } from './use-certificates';

function formatDN(dn: string): string {
  if (!dn) return '-';
  return dn.replace(/^CN=/i, '');
}

function statusVariant(status: CertificateStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'EXPIRED') return 'destructive';
  if (status === 'EXPIRING') return 'outline';
  if (status === 'NOT_YET_VALID') return 'secondary';
  return 'default';
}

export default function AdminCertificatesPage() {
  const { t } = useTranslation(['admin', 'common']);
  const [params, setParams] = useSearchParams();
  const search = params.get('search') ?? '';
  const page = positivePage(params.get('page'));
  const status = params.get('status') ?? 'all';
  const association = params.get('association') ?? 'all';
  const sort = params.get('sort') ?? 'expiry-asc';

  const setFilter = (key: string, value: string) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set(key, value);
        next.set('page', '1');
        return next;
      },
      { replace: true }
    );
  };

  const resetFilters = () => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        ['search', 'status', 'association'].forEach((key) => next.delete(key));
        next.set('sort', 'expiry-asc');
        next.set('page', '1');
        return next;
      },
      { replace: true }
    );
  };

  const setPage = (value: number) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('page', String(value));
        return next;
      },
      { replace: true }
    );

  const associatedId = params.get('tab') === 'lines' ? params.get('certificateId') : null;
  const openLines = (id: string) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set('certificateId', id);
      next.set('tab', 'lines');
      ['linePage', 'lineSearch', 'lineStatus', 'lineRelation'].forEach((key) => next.delete(key));
      return next;
    });

  const closeLines = () =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        ['certificateId', 'tab', 'linePage', 'lineSearch', 'lineStatus', 'lineRelation'].forEach((key) =>
          next.delete(key)
        );
        return next;
      },
      { replace: true }
    );

  const summary = useCertificateSummary();
  const [formOpen, setFormOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [detailId, setDetailId] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<ApiCertificate | null>(null);

  const { data, isPending, isError, refetch } = useAdminCertificates(search, page, {
    status: status === 'all' ? undefined : status,
    association: association === 'all' ? undefined : association,
    sort
  });
  const { create, update, remove } = useCertificateMutations();
  const certificates = data?.data ?? [];
  const busy = create.isPending || update.isPending;

  const statusLabels: Record<CertificateStatus, string> = {
    VALID: t('admin:certificates.statusValid'),
    EXPIRING: t('admin:certificates.statusExpiring'),
    EXPIRED: t('admin:certificates.statusExpired'),
    NOT_YET_VALID: t('admin:certificates.statusNotYetValid')
  };

  const openCreate = () => {
    setEditingId(null);
    setFormOpen(true);
  };

  const openEdit = (certificate: ApiCertificate) => {
    setEditingId(certificate.id);
    setFormOpen(true);
  };

  const openDetail = (certificate: ApiCertificate) => {
    setDetailId(certificate.id);
    setDetailOpen(true);
  };

  const hasActiveFilters = Boolean(
    search || (status && status !== 'all') || (association && association !== 'all') || sort !== 'expiry-asc'
  );

  return (
    <PageContainer>
      <PageHeader title={t('admin:certificates.title')} description={t('admin:certificates.subtitle')} />

      {summary.data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
          <Card
            className={cn(
              'cursor-pointer transition-colors hover:border-primary/50',
              status === 'all' && 'border-primary/60 bg-primary/5'
            )}
            onClick={() => setFilter('status', 'all')}
          >
            <CardContent className="p-3.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-medium">{t('admin:certificates.metricAll')}</span>
                <KeyRound className="size-4 opacity-70" />
              </div>
              <div className="mt-1.5 font-mono text-xl font-bold tracking-tight text-foreground">
                {summary.data.total}
              </div>
            </CardContent>
          </Card>

          <Card
            className={cn(
              'cursor-pointer transition-colors hover:border-emerald-500/50',
              status === 'VALID' && 'border-emerald-500/60 bg-emerald-500/5'
            )}
            onClick={() => setFilter('status', 'VALID')}
          >
            <CardContent className="p-3.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-medium">{t('admin:certificates.metricValid')}</span>
                <span className="size-2 rounded-full bg-emerald-500" />
              </div>
              <div className="mt-1.5 font-mono text-xl font-bold tracking-tight text-emerald-500">
                {Math.max(0, summary.data.total - summary.data.needsAttention)}
              </div>
            </CardContent>
          </Card>

          <Card
            className={cn(
              'cursor-pointer transition-colors hover:border-amber-500/50',
              status === 'EXPIRING' && 'border-amber-500/60 bg-amber-500/5'
            )}
            onClick={() => setFilter('status', 'EXPIRING')}
          >
            <CardContent className="p-3.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-medium">{t('admin:certificates.metricExpiring')}</span>
                <Clock className="size-4 text-amber-500 opacity-80" />
              </div>
              <div className="mt-1.5 font-mono text-xl font-bold tracking-tight text-amber-500">
                {summary.data.expiring}
              </div>
            </CardContent>
          </Card>

          <Card
            className={cn(
              'cursor-pointer transition-colors hover:border-destructive/50',
              status === 'EXPIRED' && 'border-destructive/60 bg-destructive/5'
            )}
            onClick={() => setFilter('status', 'EXPIRED')}
          >
            <CardContent className="p-3.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-medium">{t('admin:certificates.metricExpired')}</span>
                <span className="size-2 rounded-full bg-destructive" />
              </div>
              <div className="mt-1.5 font-mono text-xl font-bold tracking-tight text-destructive">
                {summary.data.expired}
              </div>
            </CardContent>
          </Card>

          <Card
            className={cn(
              'col-span-2 cursor-pointer transition-colors hover:border-destructive/50 sm:col-span-4 lg:col-span-1',
              (status === 'NOT_YET_VALID' || (summary.data.invalid > 0 && status === 'all')) &&
                'border-destructive/60 bg-destructive/5'
            )}
            onClick={() => setFilter('status', summary.data!.invalid > 0 ? 'all' : 'NOT_YET_VALID')}
          >
            <CardContent className="p-3.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-medium">
                  {summary.data.invalid > 0
                    ? t('admin:certificates.metricInvalid')
                    : t('admin:certificates.statusNotYetValid')}
                </span>
                <AlertTriangle
                  className={cn('size-4', summary.data.invalid > 0 ? 'text-destructive' : 'opacity-70')}
                />
              </div>
              <div
                className={cn(
                  'mt-1.5 font-mono text-xl font-bold tracking-tight',
                  summary.data.invalid > 0 ? 'text-destructive' : 'text-foreground'
                )}
              >
                {summary.data.invalid > 0 ? summary.data.invalid : summary.data.notYetValid}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2">
          <p className="text-sm text-destructive">{t('admin:certificates.loadFailed')}</p>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            {t('common:actions.retry')}
          </Button>
        </div>
      )}

      {isPending && <p className="text-sm text-muted-foreground">{t('common:actions.loading')}</p>}

      <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setFilter('search', event.target.value)}
              placeholder={t('admin:certificates.searchPlaceholder')}
              className="h-9 pl-9 text-xs"
            />
          </div>
          <Select value={status} onValueChange={(value) => setFilter('status', value)}>
            <SelectTrigger className="h-9 w-36 text-xs" aria-label={t('admin:certificateManagement.allStatuses')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('admin:certificateManagement.allStatuses')}</SelectItem>
              {Object.entries(statusLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={association} onValueChange={(value) => setFilter('association', value)}>
            <SelectTrigger className="h-9 w-32 text-xs" aria-label={t('admin:certificateManagement.allAssociations')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('admin:certificateManagement.allAssociations')}</SelectItem>
              <SelectItem value="linked">{t('admin:certificateManagement.linked')}</SelectItem>
              <SelectItem value="unlinked">{t('admin:certificateManagement.unlinked')}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(value) => setFilter('sort', value)}>
            <SelectTrigger className="h-9 w-32 text-xs" aria-label={t('admin:certificateManagement.expiryAsc')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="expiry-asc">{t('admin:certificateManagement.expiryAsc')}</SelectItem>
              <SelectItem value="expiry-desc">{t('admin:certificateManagement.expiryDesc')}</SelectItem>
              <SelectItem value="updated-desc">{t('admin:certificateManagement.updatedDesc')}</SelectItem>
            </SelectContent>
          </Select>
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={resetFilters}
            >
              <RotateCcw className="mr-1 size-3.5" />
              {t('admin:certificates.resetFilters')}
            </Button>
          )}
        </div>
        <Button className="h-9 shrink-0 gap-1.5" onClick={openCreate}>
          <Plus className="size-4" />
          {t('admin:certificates.uploadCert')}
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {certificates.length ? (
            <div className="overflow-x-auto">
              <Table className="min-w-[980px]">
                <TableHeader>
                  <TableRow className="bg-muted/30 text-xs">
                    <TableHead className="w-72">{t('admin:certificates.colCert')}</TableHead>
                    <TableHead className="w-56">{t('admin:certificates.colSans')}</TableHead>
                    <TableHead className="w-48">{t('admin:certificates.colIssuer')}</TableHead>
                    <TableHead className="w-44">{t('admin:certificates.colValidity')}</TableHead>
                    <TableHead className="w-36">{t('admin:certificates.colLines')}</TableHead>
                    <TableHead className="w-28 text-right">{t('admin:certificates.colActions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {certificates.map((certificate) => {
                    const directLines = certificate.directLineCount ?? certificate.lineCount;
                    const inheritedLines = certificate.inheritedLineCount ?? 0;
                    const totalLines = certificate.associatedLineCount ?? directLines + inheritedLines;

                    return (
                      <TableRow key={certificate.id}>
                        <TableCell>
                          <div className="flex items-start gap-2.5">
                            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/30 text-muted-foreground">
                              <KeyRound className="size-4" />
                            </div>
                            <div className="min-w-0">
                              <Button
                                type="button"
                                variant="ghost"
                                className="h-auto p-0 text-left text-sm font-medium text-foreground hover:underline"
                                onClick={() => openDetail(certificate)}
                              >
                                <span className="max-w-[220px] truncate">{certificate.name}</span>
                              </Button>
                              <p
                                className="max-w-[220px] truncate font-mono text-xs text-muted-foreground"
                                title={certificate.subject}
                              >
                                {formatDN(certificate.subject)}
                              </p>
                              {certificate.chainValidation === 'INVALID' && (
                                <Badge variant="destructive" className="mt-1 h-4 px-1 text-[10px]">
                                  {t('admin:certificateManagement.INVALID')}
                                </Badge>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          {certificate.sans.length > 0 ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="inline-flex max-w-[200px] cursor-default items-center gap-1.5">
                                  <span className="truncate font-mono text-xs text-foreground">
                                    {certificate.sans[0]}
                                  </span>
                                  {certificate.sans.length > 1 && (
                                    <Badge
                                      variant="secondary"
                                      className="h-4 shrink-0 px-1 font-mono text-[10px] font-normal"
                                    >
                                      +{certificate.sans.length - 1}
                                    </Badge>
                                  )}
                                </div>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs space-y-1 p-2 font-mono text-xs">
                                <p className="font-sans font-semibold text-muted-foreground">
                                  {t('admin:certificates.sans')}:
                                </p>
                                {certificate.sans.map((san) => (
                                  <div key={san} className="truncate">
                                    {san}
                                  </div>
                                ))}
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <span className="text-xs text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <p className="max-w-[180px] cursor-default truncate text-xs text-muted-foreground">
                                {formatDN(certificate.issuer)}
                              </p>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs text-xs">{certificate.issuer}</TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col items-start gap-1">
                            <div className="flex items-center gap-1.5">
                              <Badge
                                variant={statusVariant(certificate.status)}
                                className={cn(
                                  'h-4.5 px-1.5 py-0 text-[10px] font-normal',
                                  certificate.status === 'EXPIRING' &&
                                    'border-amber-500/40 bg-amber-500/10 text-amber-500',
                                  certificate.status === 'VALID' &&
                                    'border-transparent bg-emerald-500/10 text-emerald-500'
                                )}
                              >
                                {statusLabels[certificate.status]}
                              </Badge>
                              {certificate.daysUntilExpiry !== undefined && (
                                <span className="font-mono text-[11px] text-muted-foreground">
                                  {certificate.daysUntilExpiry < 0
                                    ? t('admin:certificates.daysExpired', {
                                        days: Math.abs(certificate.daysUntilExpiry)
                                      })
                                    : t('admin:certificates.daysRemainingText', {
                                        days: certificate.daysUntilExpiry
                                      })}
                                </span>
                              )}
                            </div>
                            <span className="text-[11px] text-muted-foreground">
                              {t('admin:certificates.validUntil', { date: formatDate(certificate.validTo) })}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          {totalLines > 0 ? (
                            <div>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-6 gap-1 px-2 text-xs font-normal hover:bg-accent"
                                onClick={() => openLines(certificate.id)}
                              >
                                <GitBranch className="size-3 text-muted-foreground" />
                                <span>{t('admin:certificates.lineCount', { count: totalLines })}</span>
                              </Button>
                              <p className="mt-0.5 text-[10px] text-muted-foreground">
                                {t('admin:certificateManagement.associationCounts', {
                                  direct: directLines,
                                  inherited: inheritedLines
                                })}
                              </p>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground/70">
                              {t('admin:certificates.unlinkedCount')}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <IconButton
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t('admin:certificates.certDetail')}
                              onClick={() => openDetail(certificate)}
                            >
                              <Eye className="size-4" />
                            </IconButton>
                            <IconButton
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t('admin:certificates.editCert')}
                              onClick={() => openEdit(certificate)}
                            >
                              <Pencil className="size-4" />
                            </IconButton>
                            <IconButton
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t('common:actions.delete')}
                              onClick={() => setDeleting(certificate)}
                            >
                              <Trash2 className="size-4 text-destructive" />
                            </IconButton>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState
              title={t('admin:certificates.emptyCerts')}
              description={t('admin:certificates.subtitle')}
              className="border-0"
            />
          )}
        </CardContent>
      </Card>

      <CertificatePager page={page} total={data?.total ?? 0} onChange={setPage} />

      {formOpen && (
        <CertificateFormDialog
          key={editingId ?? 'create'}
          open={formOpen}
          onOpenChange={setFormOpen}
          certificateId={editingId}
          pending={busy}
          onSubmit={(payload) =>
            editingId
              ? update.mutate({ id: editingId, ...payload }, { onSuccess: () => setFormOpen(false) })
              : create.mutate(payload, { onSuccess: () => setFormOpen(false) })
          }
        />
      )}

      {detailOpen && (
        <CertificateDetailDialog open={detailOpen} onOpenChange={setDetailOpen} certificateId={detailId} />
      )}

      {associatedId && <CertificateLinesDialog key={associatedId} id={associatedId} onClose={closeLines} />}

      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('admin:certificates.deleteDialogTitle', { name: deleting?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('admin:certificates.deleteDialogDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          {deleting && deleting.lineCount > 0 && (
            <div className="max-h-72 overflow-auto">
              <p className="text-sm text-destructive">{t('admin:certificateManagement.deleteLinked')}</p>
              <CertificateLines id={deleting.id} />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending || Boolean(deleting?.lineCount)}
              onClick={() => deleting && remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
            >
              {t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}
