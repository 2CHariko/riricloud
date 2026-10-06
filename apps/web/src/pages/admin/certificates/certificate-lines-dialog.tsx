import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type ApiCertificate } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { CertificateLines } from './certificate-records';

export function CertificateLinesDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation(['admin', 'common']);
  const detail = useQuery({ queryKey: ['admin', 'certificates', 'public', id], queryFn: async ({ signal }) => (await api.get<{ certificate: ApiCertificate }>(`/admin/certificates/${id}`, { params: { publicOnly: true }, signal })).data.certificate });
  return <ResponsiveDialog open onOpenChange={open => !open && onClose()}><ResponsiveDialogContent size="wide">
    <DialogHeader><DialogTitle>{detail.data?.name ?? t('admin:certificateManagement.lines')}</DialogTitle><DialogDescription>{t('admin:certificateManagement.viewLines')}</DialogDescription></DialogHeader>
    {detail.isError && <Button variant="outline" onClick={() => void detail.refetch()}>{t('common:actions.retry')}</Button>}
    {detail.data && <p className="text-sm text-muted-foreground">{t('admin:certificateManagement.associationCounts', { direct: detail.data.directLineCount ?? detail.data.lineCount, inherited: detail.data.inheritedLineCount ?? 0 })}</p>}
    <CertificateLines key={id} id={id} preserveContext />
    <DialogFooter><Button variant="outline" onClick={onClose}>{t('common:actions.close')}</Button></DialogFooter>
  </ResponsiveDialogContent></ResponsiveDialog>;
}
