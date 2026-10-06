import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import { CertificateLines, CertificateHistory, CertificateDeployments } from './certificate-records';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { CopyButton } from '@/components/shared/copy-button';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { formatDate } from '@/lib/utils';
import { useCertificateDetail, useCertificateMutations, type ApiCertificate } from './use-certificates';

export function CertificateDetailDialog({ open, onOpenChange, certificateId }: { open: boolean; onOpenChange: (open: boolean) => void; certificateId: string | null }) {
  const { t } = useTranslation(['admin', 'common']);
  const detail = useCertificateDetail(certificateId, open);
  const [showKey, setShowKey] = React.useState(false);
  const [secretExport, setSecretExport] = React.useState<'private-key' | 'bundle' | null>(null);
  const { download } = useCertificateMutations();

  const statusLabels: Record<ApiCertificate['status'], string> = {
    VALID: t('admin:certificates.statusValid'),
    EXPIRING: t('admin:certificates.statusExpiring'),
    EXPIRED: t('admin:certificates.statusExpired'),
    NOT_YET_VALID: t('admin:certificates.statusNotYetValid')
  };

  React.useEffect(() => {
    if (!open) setShowKey(false);
  }, [open]);

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent size="wide">
        <DialogHeader>
          <DialogTitle>{detail.data?.name ?? t('admin:certificates.certDetail')}</DialogTitle>
          <DialogDescription>{t('admin:certificates.detailDesc')}</DialogDescription>
        </DialogHeader>
        {detail.isPending && <p className="text-sm text-muted-foreground">{t('common:actions.loading')}</p>}
        {detail.isError && <div className="flex items-center gap-2"><p className="text-sm text-destructive">{t('admin:certificates.loadFailed')}</p><Button variant="outline" onClick={() => void detail.refetch()}>{t('common:actions.retry')}</Button></div>}
        {detail.data && <Tabs defaultValue="metadata">
          <TabsList className="grid h-auto grid-cols-2 sm:grid-cols-4">{(['metadata', 'lines', 'revisions', 'deployments'] as const).map(tab => <TabsTrigger value={tab} key={tab}>{t(`admin:certificateManagement.${tab}`)}</TabsTrigger>)}</TabsList>
          <TabsContent value="lines"><CertificateLines id={detail.data.id} /></TabsContent>
          <TabsContent value="revisions"><CertificateHistory id={detail.data.id} currentRevision={detail.data.currentRevision} /></TabsContent>
          <TabsContent value="deployments"><CertificateDeployments id={detail.data.id} /></TabsContent>
          <TabsContent value="metadata"><div className="space-y-4">
          <p className="text-xs text-muted-foreground">{t('admin:certificateManagement.trust')}</p>
          <div className="grid gap-2 rounded-md border bg-muted/20 p-3 text-sm sm:grid-cols-2">
            <span>{t('admin:certificateManagement.revision')}: {detail.data.currentRevision}</span>
            <span>{t('admin:certificateManagement.chain')}: {t(`admin:certificateManagement.${detail.data.chainValidation}`)}</span>
            <span>{t('admin:certificateManagement.keyType')}: {detail.data.keyType}</span>
            <span>{t('admin:certificateManagement.chainLength')}: {detail.data.chainLength}</span>
            <span className="break-all sm:col-span-2">{t('admin:certificateManagement.fingerprint')}: {detail.data.fingerprint256}</span>
            <span>{t('admin:certificates.labelStatus')}{statusLabels[detail.data.status]}</span>
            <span>{t('admin:certificates.labelLines')}{detail.data.lineCount}</span>
            <span>{t('admin:certificates.labelIssuer')}{detail.data.issuer}</span>
            <span>{t('admin:certificates.labelSerial')}{detail.data.serialNumber}</span>
            <span>{t('admin:certificates.labelValidFrom')}{formatDate(detail.data.validFrom)}</span>
            <span>{t('admin:certificates.labelValidTo')}{formatDate(detail.data.validTo)}</span>
            <span className="sm:col-span-2">{t('admin:certificates.labelSans')}{detail.data.sans.join(', ')}</span>
          </div>
          {detail.data.chain.map((cert, index) => <div key={cert.fingerprint256} className="break-all rounded-md border p-3 text-xs"><p>#{index + 1} · {cert.subject}</p><p>{cert.issuer}</p><p>{formatDate(cert.validFrom)} — {formatDate(cert.validTo)}</p><p>{cert.fingerprint256}</p></div>)}
          <div className="flex flex-wrap gap-2">{(['leaf', 'fullchain', 'private-key', 'bundle'] as const).map(format => <Button key={format} variant="outline" size="sm" disabled={download.isPending} onClick={() => format === 'private-key' || format === 'bundle' ? setSecretExport(format) : download.mutate({ id: detail.data!.id, format })}>{t(`admin:certificateManagement.${format}`)}</Button>)}<Button variant="link" asChild><Link to={'/admin/logs?module=Certificate&keyword=' + encodeURIComponent(detail.data.id)}>{t('admin:certificateManagement.logs')}</Link></Button></div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{t('admin:certificates.labelCertPem')}</span><CopyButton value={detail.data.certificatePem} /></div>
            <Textarea readOnly value={detail.data.certificatePem} className="min-h-44 font-mono text-xs" spellCheck={false} />
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">{t('admin:certificates.labelKeyPem')}</span>
              <div className="flex items-center gap-2">
                {showKey && <CopyButton value={detail.data.privateKeyPem} />}
                <Button type="button" variant="outline" size="sm" onClick={() => setShowKey((value) => !value)}>{showKey ? <EyeOff /> : <Eye />} {showKey ? t('admin:certificates.hideKey') : t('admin:certificates.showKey')}</Button>
              </div>
            </div>
            <Textarea readOnly value={showKey ? detail.data.privateKeyPem : t('admin:certificates.keyHidden')} className="min-h-36 font-mono text-xs" spellCheck={false} />
          </div>
        </div></TabsContent></Tabs>}
        <AlertDialog open={secretExport !== null} onOpenChange={open => !open && setSecretExport(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t('admin:certificateManagement.secretTitle')}</AlertDialogTitle><AlertDialogDescription>{t('admin:certificateManagement.secretDesc')}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel><AlertDialogAction disabled={download.isPending} onClick={() => certificateId && secretExport && download.mutate({ id: certificateId, format: secretExport }, { onSuccess: () => setSecretExport(null) })}>{t('admin:certificateManagement.export')}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
        <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common:actions.close')}</Button></DialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
