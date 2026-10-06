import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { positivePage } from '@/lib/certificate-navigation';
import { CertificateLinesDialog } from './certificate-lines-dialog';
import { Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PageContainer, PageHeader } from '@/components/shared/page-container';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CertificatePager } from './certificate-pager';
import { CertificateLines } from './certificate-records';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import type { ApiCertificate, CertificateStatus } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { CertificateDetailDialog } from './certificate-detail-dialog';
import { CertificateFormDialog } from './certificate-form-dialog';
import { useAdminCertificates, useCertificateMutations, useCertificateSummary } from './use-certificates';

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
    setParams(current => { const next = new URLSearchParams(current); next.set(key, value); next.set('page', '1'); return next; }, { replace: true });
  };
  const setPage = (value: number) => setParams(current => { const next = new URLSearchParams(current); next.set('page', String(value)); return next; }, { replace: true });
  const associatedId = params.get('tab') === 'lines' ? params.get('certificateId') : null;
  const openLines = (id: string) => setParams(current => { const next = new URLSearchParams(current); next.set('certificateId', id); next.set('tab', 'lines'); ['linePage', 'lineSearch', 'lineStatus', 'lineRelation'].forEach(key => next.delete(key)); return next; });
  const closeLines = () => setParams(current => { const next = new URLSearchParams(current); ['certificateId', 'tab', 'linePage', 'lineSearch', 'lineStatus', 'lineRelation'].forEach(key => next.delete(key)); return next; }, { replace: true });
  const summary = useCertificateSummary();
  const [formOpen, setFormOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [detailId, setDetailId] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<ApiCertificate | null>(null);
  const { data, isPending, isError, refetch } = useAdminCertificates(search, page, { status: status === 'all' ? undefined : status, association: association === 'all' ? undefined : association, sort });
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

  return (
    <PageContainer>
      <PageHeader title={t('admin:certificates.title')} description={t('admin:certificates.subtitle')} />
      {summary.data && <p className="rounded-md border p-3 text-sm">{t('admin:certificateManagement.summary', { ...summary.data })}</p>}
      {isError && <div className="flex items-center gap-2"><p className="text-sm text-destructive">{t('admin:certificates.loadFailed')}</p><Button variant="outline" onClick={() => void refetch()}>{t('common:actions.retry')}</Button></div>}
      {isPending && <p className="text-sm text-muted-foreground">{t('common:actions.loading')}</p>}
      <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative w-full min-w-0 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input value={search} onChange={(event) => setFilter('search', event.target.value)} placeholder={t('admin:certificates.searchPlaceholder')} className="pl-9" />
        </div>
        <Button className="w-full lg:w-auto" onClick={openCreate}><Plus />{t('admin:certificates.uploadCert')}</Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <Select value={status} onValueChange={value => setFilter('status', value)}><SelectTrigger aria-label={t('admin:certificateManagement.allStatuses')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('admin:certificateManagement.allStatuses')}</SelectItem>{Object.entries(statusLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select>
        <Select value={association} onValueChange={value => setFilter('association', value)}><SelectTrigger aria-label={t('admin:certificateManagement.allAssociations')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('admin:certificateManagement.allAssociations')}</SelectItem><SelectItem value="linked">{t('admin:certificateManagement.linked')}</SelectItem><SelectItem value="unlinked">{t('admin:certificateManagement.unlinked')}</SelectItem></SelectContent></Select>
        <Select value={sort} onValueChange={value => setFilter('sort', value)}><SelectTrigger aria-label={t('admin:certificateManagement.expiryAsc')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="expiry-asc">{t('admin:certificateManagement.expiryAsc')}</SelectItem><SelectItem value="expiry-desc">{t('admin:certificateManagement.expiryDesc')}</SelectItem><SelectItem value="updated-desc">{t('admin:certificateManagement.updatedDesc')}</SelectItem></SelectContent></Select>
      </div>
      <Card>
        <CardContent className="p-0">
          {certificates.length ? (
            <Table className="min-w-[980px]">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('admin:certificates.colCert')}</TableHead>
                  <TableHead>{t('admin:certificates.colSans')}</TableHead>
                  <TableHead>{t('admin:certificates.colIssuer')}</TableHead>
                  <TableHead>{t('admin:certificates.colValidity')}</TableHead>
                  <TableHead>{t('admin:certificates.colLines')}</TableHead>
                  <TableHead className="text-right">{t('admin:certificates.colActions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {certificates.map((certificate) => (
                  <TableRow key={certificate.id}>
                    <TableCell>
                      <Button type="button" variant="ghost" className="h-auto min-w-0 justify-start p-0 text-left hover:bg-transparent" onClick={() => openDetail(certificate)}>
                        <div className="font-medium hover:underline">{certificate.name}</div>
                        <div className="max-w-56 truncate text-xs text-muted-foreground">{certificate.subject}</div>
                      </Button>{certificate.chainValidation === 'INVALID' && <Badge variant="destructive">{t('admin:certificateManagement.INVALID')}</Badge>}
                    </TableCell>
                    <TableCell><div className="flex max-w-64 flex-wrap gap-1">{certificate.sans.slice(0, 4).map((san) => <Badge key={san} variant="secondary">{san}</Badge>)}{certificate.sans.length > 4 && <Badge variant="outline">+{certificate.sans.length - 4}</Badge>}</div></TableCell>
                    <TableCell className="max-w-56 truncate text-sm text-muted-foreground">{certificate.issuer}</TableCell>
                    <TableCell><div className="flex flex-col items-start gap-1"><Badge variant={statusVariant(certificate.status)}>{statusLabels[certificate.status]}</Badge><span className="text-xs text-muted-foreground">{t('admin:certificates.validUntil', { date: formatDate(certificate.validTo) })}</span></div></TableCell>
                    <TableCell><Button variant="link" className="h-auto p-0" onClick={() => openLines(certificate.id)}>{t('admin:certificateManagement.totalLines', { count: certificate.associatedLineCount ?? certificate.lineCount })}</Button><p className="text-xs text-muted-foreground">{t('admin:certificateManagement.associationCounts', { direct: certificate.directLineCount ?? certificate.lineCount, inherited: certificate.inheritedLineCount ?? 0 })}</p></TableCell>
                    <TableCell><div className="flex justify-end gap-1"><IconButton variant="ghost" size="icon-sm" aria-label={t('admin:certificates.editCert')} onClick={() => openEdit(certificate)}><Pencil /></IconButton><IconButton variant="ghost" size="icon-sm" aria-label={t('common:actions.delete')} onClick={() => setDeleting(certificate)}><Trash2 className="text-destructive" /></IconButton></div></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState title={t('admin:certificates.emptyCerts')} description={t('admin:certificates.subtitle')} className="border-0" />
          )}
        </CardContent>
      </Card>
      <CertificatePager page={page} total={data?.total ?? 0} onChange={setPage} />
      {formOpen && <CertificateFormDialog
        key={editingId ?? 'create'}
        open={formOpen}
        onOpenChange={setFormOpen}
        certificateId={editingId}
        pending={busy}
        onSubmit={(payload) => editingId
          ? update.mutate({ id: editingId, ...payload }, { onSuccess: () => setFormOpen(false) })
          : create.mutate(payload, { onSuccess: () => setFormOpen(false) })}
      />}
      {detailOpen && <CertificateDetailDialog open={detailOpen} onOpenChange={setDetailOpen} certificateId={detailId} />}
      {associatedId && <CertificateLinesDialog key={associatedId} id={associatedId} onClose={closeLines} />}
      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin:certificates.deleteDialogTitle', { name: deleting?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('admin:certificates.deleteDialogDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          {deleting && deleting.lineCount > 0 && <div className="max-h-72 overflow-auto"><p className="text-sm text-destructive">{t('admin:certificateManagement.deleteLinked')}</p><CertificateLines id={deleting.id} /></div>}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={remove.isPending || Boolean(deleting?.lineCount)} onClick={() => deleting && remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}>
              {t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}
