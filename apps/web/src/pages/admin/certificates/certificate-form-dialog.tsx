import * as React from 'react';
import { useFormResetOnKey } from '@/hooks/use-form-reset';
import { zodResolver } from '@hookform/resolvers/zod';
import { FileKey2, FileText, Loader2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import { extractErrorMessage } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { useCertificateDetail, useCertificateMutations, type CertificatePayload, type ApiCertificate } from './use-certificates';

interface CertificateFormValues {
  name: string;
  certificatePem: string;
  privateKeyPem?: string;
}

interface CertificateFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  certificateId: string | null;
  pending: boolean;
  onSubmit: (payload: CertificatePayload) => void;
}

export function CertificateFormDialog(props: CertificateFormDialogProps) {
  const { open, onOpenChange, certificateId, pending } = props;
  const { t } = useTranslation(['admin', 'common']);
  const detail = useCertificateDetail(certificateId, open);
  const ready = !certificateId || Boolean(detail.data);

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent size="wide" className="min-w-0 overflow-x-hidden">
        <DialogHeader className="min-w-0">
          <DialogTitle>{certificateId ? t('admin:certificates.formEditTitle') : t('admin:certificates.formCreateTitle')}</DialogTitle>
          <DialogDescription>{t('admin:certificates.formDesc')}</DialogDescription>
        </DialogHeader>
        {open && ready && <CertificateFormSession key={certificateId ?? 'create'} {...props} detail={detail} />}
        {!ready && <>
          <p role="status" className={detail.isError ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
            {detail.isError ? t('admin:certificates.loadFailed') : t('common:actions.loading')}
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common:actions.cancel')}</Button>
            {detail.isError && <Button type="button" variant="outline" disabled={detail.isFetching} onClick={() => void detail.refetch()}>{t('common:actions.retry')}</Button>}
            <Button type="button" disabled>{pending ? t('admin:certificates.saving') : t('admin:certificates.saveCert')}</Button>
          </DialogFooter>
        </>}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function CertificateFormSession({ onOpenChange, certificateId, pending, onSubmit, detail }: CertificateFormDialogProps & { detail: ReturnType<typeof useCertificateDetail> }) {
  const { t } = useTranslation(['admin', 'common']);

  const certificateFormSchema = React.useMemo(() => z.object({
    name: z.string().trim().min(1, t('admin:certificates.valNameRequired')).max(128, t('admin:certificates.valNameMax')),
    certificatePem: z.string().trim().min(1, t('admin:certificates.valCertPemRequired')),
    privateKeyPem: z.string().optional()
  }), [t]);

  const statusLabels: Record<ApiCertificate['status'], string> = {
    VALID: t('admin:certificates.statusValid'),
    EXPIRING: t('admin:certificates.statusExpiring'),
    EXPIRED: t('admin:certificates.statusExpired'),
    NOT_YET_VALID: t('admin:certificates.statusNotYetValid')
  };

  const form = useForm<CertificateFormValues>({
    resolver: zodResolver(certificateFormSchema),
    defaultValues: {
      name: detail.data?.name ?? '',
      certificatePem: detail.data?.certificatePem ?? '',
      privateKeyPem: detail.data?.privateKeyPem ?? ''
    }
  });
  const { parse, preview } = useCertificateMutations();
  const baseline = React.useRef(detail.data);
  const [preparedPayload, setPreparedPayload] = React.useState<CertificatePayload | null>(null);
  const { mutate: parseCertificate, reset: resetParse } = parse;
  const certificatePem = form.watch('certificatePem');
  const privateKeyPem = form.watch('privateKeyPem');

  // 会话随关闭或切换证书卸载；后台刷新不得覆盖已初始化的私钥草稿
  useFormResetOnKey({
    resetKey: certificateId ?? 'create',
    reset: () => {
      if (!certificateId) {
        form.reset({ name: '', certificatePem: '', privateKeyPem: '' });
      } else if (detail.data) {
        form.reset({ name: detail.data.name, certificatePem: detail.data.certificatePem, privateKeyPem: detail.data.privateKeyPem });
      }
    }
  });

  React.useEffect(() => {
    resetParse();
    if (!certificatePem.trim()) return undefined;
    const timer = window.setTimeout(() => {
      parseCertificate({
        certificatePem,
        ...(privateKeyPem?.trim() ? { privateKeyPem } : {})
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [certificatePem, parseCertificate, privateKeyPem, resetParse]);

  const readFile = async (field: 'certificatePem' | 'privateKeyPem', event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    form.setValue(field, await file.text(), { shouldDirty: true, shouldValidate: true });
  };

  const submit = (values: CertificateFormValues) => {
    if (pending) return;
    if (!certificateId && !values.privateKeyPem?.trim()) {
      form.setError('privateKeyPem', { message: t('admin:certificates.valKeyRequired') });
      return;
    }
    const payload: CertificatePayload = {
      name: values.name.trim(),
      certificatePem: values.certificatePem.trim(),
      ...(certificateId ? { expectedRevision: baseline.current?.currentRevision } : {}),
      ...(values.privateKeyPem?.trim() ? { privateKeyPem: values.privateKeyPem.trim() } : {})
    };
    if (!certificateId) { onSubmit(payload); return; }
    const changed = payload.certificatePem !== baseline.current?.certificatePem.trim() || Boolean(payload.privateKeyPem && payload.privateKeyPem !== baseline.current?.privateKeyPem.trim());
    if (!changed) { onSubmit({ name: payload.name, expectedRevision: payload.expectedRevision }); return; }
    preview.mutate({ id: certificateId, ...payload }, { onSuccess: result => result.contentChanged ? setPreparedPayload(payload) : onSubmit(payload) });
  };

  return (
    <><Form {...form}>
      <form noValidate onSubmit={form.handleSubmit(submit)} className="min-w-0 space-y-4">
        <FormField control={form.control} name="name" render={({ field }) => (
          <FormItem className="min-w-0">
            <FormLabel>{t('admin:certificates.nameLabel')}</FormLabel>
            <FormControl><Input placeholder={t('admin:certificates.namePlaceholder')} {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <FormField control={form.control} name="certificatePem" render={({ field }) => (
          <FormItem className="min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <FormLabel>{t('admin:certificates.labelCertPem')}</FormLabel>
              <Button type="button" variant="outline" size="sm" asChild>
                <label><FileText />{t('admin:certificates.uploadCertFile')}<Input className="sr-only" type="file" accept=".pem,.crt,.cer,text/plain" onChange={(event) => void readFile('certificatePem', event)} /></label>
              </Button>
            </div>
            <FormControl><Textarea className="min-h-44 min-w-0 max-w-full font-mono text-xs" spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" {...field} /></FormControl>
            <FormDescription>{t('admin:certificates.certPemDesc')}</FormDescription>
            <FormMessage />
          </FormItem>
        )} />
        <FormField control={form.control} name="privateKeyPem" render={({ field }) => (
          <FormItem className="min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <FormLabel>{t('admin:certificates.labelKeyPem')}</FormLabel>
              <Button type="button" variant="outline" size="sm" asChild>
                <label><FileKey2 />{t('admin:certificates.uploadKeyFile')}<Input className="sr-only" type="file" accept=".pem,.key,text/plain" onChange={(event) => void readFile('privateKeyPem', event)} /></label>
              </Button>
            </div>
            <FormControl><Textarea className="min-h-36 min-w-0 max-w-full font-mono text-xs" spellCheck={false} placeholder={certificateId ? t('admin:certificates.keyPlaceholderEdit') : t('admin:certificates.keyPlaceholderNew')} {...field} value={field.value ?? ''} /></FormControl>
            <FormDescription>{certificateId ? t('admin:certificates.keyDescEdit') : t('admin:certificates.keyDescCreate')}</FormDescription>
            <FormMessage />
          </FormItem>
        )} />

        {parse.isPending && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('admin:certificates.parsing')}</div>}
        {parse.isError && <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{extractErrorMessage(parse.error, t('admin:certificates.parseFailed'))}</p>}
        {parse.data && <div className="min-w-0 space-y-2 rounded-md border bg-muted/20 p-3 text-sm">
          <p className="text-xs text-muted-foreground">{t('admin:certificateManagement.trust')}</p>
          <p className="break-all text-xs">{t('admin:certificateManagement.fingerprint')}: {parse.data.fingerprint256} · {parse.data.keyType} · {t('admin:certificateManagement.chainLength')}: {parse.data.chainLength}</p>
          {Boolean(parse.data.duplicates?.length) && <p className="text-sm">{t('admin:certificateManagement.duplicate', { names: parse.data.duplicates.map(row => row.name).join(', ') })}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{t('admin:certificates.parseResult')}</span><span className="text-muted-foreground">{statusLabels[parse.data.status]}</span></div>
          <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
            <span>{t('admin:certificates.labelIssuer')}{parse.data.issuer}</span>
            <span>{t('admin:certificates.validitySpan', { from: formatDate(parse.data.validFrom), to: formatDate(parse.data.validTo) })}</span>
            <span className="sm:col-span-2">{t('admin:certificates.labelSans')}{parse.data.sans.join(', ')}</span>
            {parse.data.privateKeyMatched !== null && <span>{t('admin:certificates.keyMatch')}{parse.data.privateKeyMatched ? t('admin:certificates.yes') : t('admin:certificates.no')}</span>}
          </div>
        </div>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common:actions.cancel')}</Button>
          <Button type="submit" disabled={pending || preview.isPending}>{pending ? t('admin:certificates.saving') : t('admin:certificates.saveCert')}</Button>
        </DialogFooter>
      </form>
    </Form>
    <AlertDialog open={preparedPayload !== null} onOpenChange={open => !open && setPreparedPayload(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t('admin:certificateManagement.preview')}</AlertDialogTitle><AlertDialogDescription>{t('admin:certificateManagement.previewDesc')}</AlertDialogDescription></AlertDialogHeader>
      {preview.data && <div className="space-y-2 text-sm">
        <p>{t('admin:certificateManagement.before')}: {preview.data.before.validFrom && formatDate(preview.data.before.validFrom)} — {preview.data.before.validTo && formatDate(preview.data.before.validTo)} · {preview.data.before.sans?.join(', ')}</p>
        <p>{t('admin:certificateManagement.after')}: {preview.data.after.validFrom && formatDate(preview.data.after.validFrom)} — {preview.data.after.validTo && formatDate(preview.data.after.validTo)} · {preview.data.after.sans?.join(', ')}</p>
        <p>{t('admin:certificateManagement.affected')}: {preview.data.lines.length}</p><div className="max-h-48 overflow-auto">{preview.data.lines.map(row => <p key={row.id} className={row.validationError ? 'text-destructive' : ''}>{row.name} · {row.serverNames.join(' / ')} · {row.validationError ?? t('admin:certificateManagement.matched')}</p>)}</div>
      </div>}
      <AlertDialogFooter><AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel><AlertDialogAction disabled={pending || Boolean(preview.data?.lines.some(row => row.validationError))} onClick={() => preparedPayload && onSubmit(preparedPayload)}>{t('admin:certificates.saveCert')}</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog></>
  );
}
