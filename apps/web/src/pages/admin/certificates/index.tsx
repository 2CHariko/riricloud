import * as React from 'react';
import { Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PageContainer, PageHeader } from '@/components/shared/page-container';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import type { ApiCertificate, CertificateStatus } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { CertificateDetailDialog } from './certificate-detail-dialog';
import { CertificateFormDialog } from './certificate-form-dialog';
import { useAdminCertificates, useCertificateMutations } from './use-certificates';

function statusVariant(status: CertificateStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'EXPIRED') return 'destructive';
  if (status === 'EXPIRING') return 'outline';
  if (status === 'NOT_YET_VALID') return 'secondary';
  return 'default';
}

export default function AdminCertificatesPage() {
  const { t } = useTranslation(['admin', 'common']);
  const [search, setSearch] = React.useState('');
  const [formOpen, setFormOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [detailId, setDetailId] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<ApiCertificate | null>(null);
  const { data, isPending, isError } = useAdminCertificates(search);
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

  if (isPending) return <PageContainer><PageHeader title={t('admin:certificates.title')} description={t('admin:certificates.subtitle')} /><p className="text-sm text-muted-foreground">{t('common:actions.loading')}</p></PageContainer>;
  if (isError) return <PageContainer><PageHeader title={t('admin:certificates.title')} /><EmptyState title={t('admin:certificates.emptyCerts')} description={t('admin:certificates.subtitle')} /></PageContainer>;

  return (
    <PageContainer>
      <PageHeader title={t('admin:certificates.title')} description={t('admin:certificates.subtitle')} />
      <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative w-full min-w-0 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('admin:certificates.searchPlaceholder')} className="pl-9" />
        </div>
        <Button className="w-full lg:w-auto" onClick={openCreate}><Plus />{t('admin:certificates.uploadCert')}</Button>
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
                      </Button>
                    </TableCell>
                    <TableCell><div className="flex max-w-64 flex-wrap gap-1">{certificate.sans.slice(0, 4).map((san) => <Badge key={san} variant="secondary">{san}</Badge>)}{certificate.sans.length > 4 && <Badge variant="outline">+{certificate.sans.length - 4}</Badge>}</div></TableCell>
                    <TableCell className="max-w-56 truncate text-sm text-muted-foreground">{certificate.issuer}</TableCell>
                    <TableCell><div className="flex flex-col items-start gap-1"><Badge variant={statusVariant(certificate.status)}>{statusLabels[certificate.status]}</Badge><span className="text-xs text-muted-foreground">{t('admin:certificates.validUntil', { date: formatDate(certificate.validTo) })}</span></div></TableCell>
                    <TableCell><span className="font-medium">{certificate.lineCount}</span><span className="ml-1 text-xs text-muted-foreground">{t('admin:certificates.associatedLines')}</span></TableCell>
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
      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin:certificates.deleteDialogTitle', { name: deleting?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('admin:certificates.deleteDialogDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleting && remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}>
              {t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}
