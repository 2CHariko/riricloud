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
  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent size="wide" className="sm:max-w-4xl lg:max-w-5xl">
        <DialogHeader className="space-y-1">
          <DialogTitle className="text-lg font-semibold tracking-tight">
            {detail.data?.name ?? t('admin:certificateManagement.lines')}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{t('admin:certificateManagement.viewLines')}</span>
            {detail.data && (
              <>
                <span>·</span>
                <span className="font-medium text-foreground">
                  {t('admin:certificateManagement.associationCounts', {
                    direct: detail.data.directLineCount ?? detail.data.lineCount,
                    inherited: detail.data.inheritedLineCount ?? 0
                  })}
                </span>
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {detail.isError && (
          <div className="flex items-center gap-2">
            <p className="text-sm text-destructive">{t('admin:certificates.loadFailed')}</p>
            <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
              {t('common:actions.retry')}
            </Button>
          </div>
        )}
        <CertificateLines key={id} id={id} preserveContext />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common:actions.close')}
          </Button>
        </DialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
