import * as React from 'react';
import {
  Download,
  Eye,
  EyeOff,
  GitBranch,
  KeyRound,
  Lock,
  ScrollText,
  ShieldCheck
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Link } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { CertificateLines, CertificateHistory, CertificateDeployments } from './certificate-records';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { CopyButton } from '@/components/shared/copy-button';
import { SmoothCollapse } from '@/components/ui/smooth-collapse';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { cn, formatDate } from '@/lib/utils';
import { useCertificateDetail, useCertificateMutations, type ApiCertificate } from './use-certificates';

function formatDN(dn: string): string {
  if (!dn) return '-';
  return dn.replace(/^CN=/i, '');
}

export function CertificateDetailDialog({
  open,
  onOpenChange,
  certificateId
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  certificateId: string | null;
}) {
  const { t } = useTranslation(['admin', 'common']);
  const detail = useCertificateDetail(certificateId, open);
  const [showKey, setShowKey] = React.useState(false);
  const [showCertPem, setShowCertPem] = React.useState(false);
  const [tab, setTab] = React.useState('metadata');
  const [secretExport, setSecretExport] = React.useState<'private-key' | 'bundle' | null>(null);
  const { download } = useCertificateMutations();

  const statusLabels: Record<ApiCertificate['status'], string> = {
    VALID: t('admin:certificates.statusValid'),
    EXPIRING: t('admin:certificates.statusExpiring'),
    EXPIRED: t('admin:certificates.statusExpired'),
    NOT_YET_VALID: t('admin:certificates.statusNotYetValid')
  };

  React.useEffect(() => {
    if (!open) {
      setShowKey(false);
      setShowCertPem(false);
    }
  }, [open]);

  const totalLines =
    detail.data?.associatedLineCount ??
    (detail.data?.directLineCount ?? detail.data?.lineCount ?? 0) + (detail.data?.inheritedLineCount ?? 0);

  const getSubtitle = () => {
    switch (tab) {
      case 'lines':
        return t('admin:certificates.descLines');
      case 'revisions':
        return t('admin:certificates.descRevisions');
      case 'deployments':
        return t('admin:certificates.descDeployments');
      case 'metadata':
      default:
        return t('admin:certificates.descMetadata');
    }
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent size="wide" className="sm:max-w-4xl lg:max-w-5xl">
        <DialogHeader className="space-y-1.5 pr-10">
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle className="text-lg font-semibold tracking-tight">
              {detail.data?.name ?? t('admin:certificates.certDetail')}
            </DialogTitle>
            {detail.data && (
              <>
                <Badge
                  variant={
                    detail.data.status === 'EXPIRED'
                      ? 'destructive'
                      : detail.data.status === 'EXPIRING'
                      ? 'outline'
                      : 'secondary'
                  }
                  className="text-[10px]"
                >
                  {statusLabels[detail.data.status]}
                </Badge>
                <Badge
                  variant={detail.data.chainValidation === 'PASSED' ? 'outline' : 'destructive'}
                  className={cn(
                    'text-[10px]',
                    detail.data.chainValidation === 'PASSED' &&
                      'border-emerald-500/30 bg-emerald-500/10 text-emerald-500'
                  )}
                >
                  {t(`admin:certificateManagement.${detail.data.chainValidation}`)}
                </Badge>
                <span className="font-mono text-xs text-muted-foreground">
                  Rev #{detail.data.currentRevision}
                </span>
              </>
            )}
          </div>
          <DialogDescription className="text-xs text-muted-foreground">{getSubtitle()}</DialogDescription>
        </DialogHeader>

        {detail.isPending && <p className="text-sm text-muted-foreground">{t('common:actions.loading')}</p>}
        {detail.isError && (
          <div className="flex items-center gap-2">
            <p className="text-sm text-destructive">{t('admin:certificates.loadFailed')}</p>
            <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
              {t('common:actions.retry')}
            </Button>
          </div>
        )}

        {detail.data && (
          <Tabs value={tab} onValueChange={setTab} className="w-full">
            <TabsList className="grid h-auto w-full grid-cols-2 sm:grid-cols-4">
              <TabsTrigger value="metadata" className="text-xs">
                {t('admin:certificateManagement.metadata')}
              </TabsTrigger>
              <TabsTrigger value="lines" className="text-xs">
                {t('admin:certificateManagement.lines')}
                {totalLines > 0 && (
                  <Badge variant="secondary" className="ml-1.5 h-4 px-1 text-[10px]">
                    {totalLines}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="revisions" className="text-xs">
                {t('admin:certificateManagement.revisions')}
              </TabsTrigger>
              <TabsTrigger value="deployments" className="text-xs">
                {t('admin:certificateManagement.deployments')}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="lines" className="mt-3.5">
              <CertificateLines id={detail.data.id} />
            </TabsContent>

            <TabsContent value="revisions" className="mt-3.5">
              <CertificateHistory id={detail.data.id} currentRevision={detail.data.currentRevision} />
            </TabsContent>

            <TabsContent value="deployments" className="mt-3.5">
              <CertificateDeployments id={detail.data.id} />
            </TabsContent>

            <TabsContent value="metadata" className="mt-3.5">
              <div className="space-y-3.5">
                {/* 核心凭证护照卡 (Passport Card) */}
                <div className="rounded-lg border bg-card p-4 shadow-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-3">
                    <div className="flex items-center gap-2.5">
                      <div className="flex size-9 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground">
                        <KeyRound className="size-5" />
                      </div>
                      <div>
                        <div className="font-mono text-sm font-bold text-foreground">
                          {detail.data.sans[0] ?? formatDN(detail.data.subject)}
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          {t('admin:certificates.labelIssuer')} {formatDN(detail.data.issuer)}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => setTab('lines')}
                      >
                        <GitBranch className="mr-1.5 size-3" />
                        {t('admin:certificateManagement.totalLines', {
                          count: totalLines
                        })}
                      </Button>
                    </div>
                  </div>

                  <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
                    <div>
                      <span className="text-[11px] font-medium text-muted-foreground block">
                        {t('admin:certificates.validity')}
                      </span>
                      <span className="font-mono text-foreground">
                        {formatDate(detail.data.validFrom)} ~ {formatDate(detail.data.validTo)}
                      </span>
                    </div>

                    <div>
                      <span className="text-[11px] font-medium text-muted-foreground block">
                        {t('admin:certificateManagement.keyType')} / {t('admin:certificateManagement.chainLength')}
                      </span>
                      <span className="text-foreground">
                        {detail.data.keyType ?? 'RSA'} · {detail.data.chainLength} 阶
                      </span>
                    </div>

                    <div>
                      <span className="text-[11px] font-medium text-muted-foreground block">
                        {t('admin:certificates.labelSerial')}
                      </span>
                      <span className="font-mono text-foreground">{detail.data.serialNumber}</span>
                    </div>

                    <div className="sm:col-span-2 lg:col-span-3">
                      <span className="text-[11px] font-medium text-muted-foreground block">
                        {t('admin:certificates.labelSans')}
                      </span>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {detail.data.sans.map((san) => (
                          <Badge key={san} variant="secondary" className="font-mono text-[11px] font-normal">
                            {san}
                          </Badge>
                        ))}
                      </div>
                    </div>

                    <div className="sm:col-span-2 lg:col-span-3">
                      <span className="text-[11px] font-medium text-muted-foreground block">
                        {t('admin:certificateManagement.fingerprint')} (SHA-256)
                      </span>
                      <span className="break-all font-mono text-[11px] text-muted-foreground">
                        {detail.data.fingerprint256}
                      </span>
                    </div>
                  </div>
                </div>

                {/* 证书信任链（当链大于 1 时展现层级；单证书展示说明） */}
                {detail.data.chain.length > 1 ? (
                  <div className="rounded-lg border bg-muted/10 p-3.5 text-xs">
                    <div className="flex items-center gap-1.5 font-semibold text-foreground pb-2 border-b border-border/40">
                      <ShieldCheck className="size-4 text-emerald-500" />
                      <span>{t('admin:certificates.chainHierarchy')}</span>
                    </div>
                    <div className="mt-2.5 space-y-2">
                      {detail.data.chain.map((cert, index) => (
                        <div key={cert.fingerprint256} className="rounded-md border bg-card p-2.5 text-xs">
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-foreground">
                              #{index + 1} · {formatDN(cert.subject)}
                            </span>
                            <Badge variant="outline" className="text-[10px]">
                              {cert.ca ? 'CA' : 'Leaf'}
                            </Badge>
                          </div>
                          <p className="mt-1 text-muted-foreground">
                            {t('admin:certificates.labelIssuer')} {formatDN(cert.issuer)}
                          </p>
                          <p className="font-mono text-[10px] text-muted-foreground">
                            {formatDate(cert.validFrom)} — {formatDate(cert.validTo)}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-md border border-border/50 bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
                    {t('admin:certificates.chainSingleNote')}
                  </div>
                )}

                {/* 凭据导出工作栏 (Export Workbench) */}
                <div className="rounded-lg border bg-card p-3.5 text-xs shadow-xs">
                  <div className="flex items-center justify-between pb-2 border-b border-border/40">
                    <span className="font-semibold text-foreground">{t('admin:certificates.credentialExport')}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {t('admin:certificates.sensitiveExportHint')}
                    </span>
                  </div>

                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      disabled={download.isPending}
                      onClick={() => download.mutate({ id: detail.data!.id, format: 'leaf' })}
                    >
                      <Download className="mr-1.5 size-3.5" />
                      {t('admin:certificateManagement.leaf')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      disabled={download.isPending}
                      onClick={() => download.mutate({ id: detail.data!.id, format: 'fullchain' })}
                    >
                      <Download className="mr-1.5 size-3.5" />
                      {t('admin:certificateManagement.fullchain')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs border-amber-500/30 text-amber-500 hover:bg-amber-500/10"
                      disabled={download.isPending}
                      onClick={() => setSecretExport('private-key')}
                    >
                      <Lock className="mr-1.5 size-3.5" />
                      {t('admin:certificateManagement.private-key')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs border-amber-500/30 text-amber-500 hover:bg-amber-500/10"
                      disabled={download.isPending}
                      onClick={() => setSecretExport('bundle')}
                    >
                      <Lock className="mr-1.5 size-3.5" />
                      {t('admin:certificateManagement.bundle')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      asChild
                      className="h-8 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <Link to={'/admin/logs?module=Certificate&keyword=' + encodeURIComponent(detail.data.id)}>
                        <ScrollText className="mr-1.5 size-3.5" />
                        {t('admin:certificateManagement.logs')}
                      </Link>
                    </Button>
                  </div>
                </div>

                {/* PEM 查看器 (紧凑折叠代码区) */}
                <div className="space-y-2">
                  <div className="rounded-lg border bg-card p-3 shadow-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-foreground">
                        {t('admin:certificates.labelCertPem')}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <CopyButton value={detail.data.certificatePem} />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-muted-foreground"
                          onClick={() => setShowCertPem((prev) => !prev)}
                        >
                          {showCertPem ? <EyeOff className="mr-1 size-3" /> : <Eye className="mr-1 size-3" />}
                          {showCertPem ? t('admin:certificates.hideKey') : t('common:actions.view')}
                        </Button>
                      </div>
                    </div>
                    <SmoothCollapse open={showCertPem}>
                      <Textarea
                        readOnly
                        value={detail.data.certificatePem}
                        className="mt-2 min-h-36 font-mono text-xs"
                        spellCheck={false}
                      />
                    </SmoothCollapse>
                  </div>

                  <div className="rounded-lg border bg-card p-3 shadow-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-foreground">
                        {t('admin:certificates.labelKeyPem')}
                      </span>
                      <div className="flex items-center gap-1.5">
                        {showKey && <CopyButton value={detail.data.privateKeyPem} />}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-muted-foreground"
                          onClick={() => setShowKey((prev) => !prev)}
                        >
                          {showKey ? <EyeOff className="mr-1 size-3" /> : <Eye className="mr-1 size-3" />}
                          {showKey ? t('admin:certificates.hideKey') : t('admin:certificates.showKey')}
                        </Button>
                      </div>
                    </div>
                    <SmoothCollapse open={showKey}>
                      <Textarea
                        readOnly
                        value={detail.data.privateKeyPem}
                        className="mt-2 min-h-28 font-mono text-xs"
                        spellCheck={false}
                      />
                    </SmoothCollapse>
                  </div>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        )}

        <AlertDialog open={secretExport !== null} onOpenChange={(open) => !open && setSecretExport(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('admin:certificateManagement.secretTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('admin:certificateManagement.secretDesc')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                disabled={download.isPending}
                onClick={() =>
                  certificateId &&
                  secretExport &&
                  download.mutate({ id: certificateId, format: secretExport }, { onSuccess: () => setSecretExport(null) })
                }
              >
                {t('admin:certificateManagement.export')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <DialogFooter className="flex w-full flex-row items-center justify-between gap-2 sm:justify-between">
          {detail.data ? (
            <Button variant="outline" size="sm" asChild className="h-8 text-xs">
              <Link to={'/admin/logs?module=Certificate&keyword=' + encodeURIComponent(detail.data.id)}>
                <ScrollText className="mr-1.5 size-3.5" />
                {t('admin:certificateManagement.logs')}
              </Link>
            </Button>
          ) : (
            <div />
          )}
          <Button type="button" variant="outline" className="h-8 text-xs" onClick={() => onOpenChange(false)}>
            {t('common:actions.close')}
          </Button>
        </DialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
