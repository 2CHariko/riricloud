import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { credentialErrorKey, isCredentialLine, isCredentialMaintenanceRunning, type CredentialLine } from '../line-credentials-contract';
import { useLineCredentials } from '../use-line-credentials';
import { LineCredentialStatusDetails } from './line-credential-status';

interface Props { line: CredentialLine; open: boolean; onOpenChange: (open: boolean) => void; }

export function LineCredentialsDialog({ line, open, onOpenChange }: Props) {
  const { t } = useTranslation(['admin', 'common']);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const { query, rotation, mutationPending, canRotate, requestRotation, refresh } = useLineCredentials(line, open);
  const retry = query.data?.state === 'FAILED';
  const running = isCredentialMaintenanceRunning(query.data?.state);
  const confirmationKey = [line.id, query.data?.operationId, query.data?.targetVersion, query.data?.state].join(':');
  const canConfirm = canRotate && confirmation === confirmationKey;
  const close = (next: boolean) => { if (!next) setConfirmation(null); onOpenChange(next); };
  if (!isCredentialLine(line)) return null;

  return <ResponsiveDialog open={open} onOpenChange={close}>
    <ResponsiveDialogContent>
      <DialogHeader>
        <DialogTitle>{t('admin:lineCredentials.title')}</DialogTitle>
        <DialogDescription>{t('admin:lineCredentials.description', { name: line.name })}</DialogDescription>
      </DialogHeader>
      {line.status !== 'ACTIVE' && <p className="text-sm text-muted-foreground" role="status">{t('admin:lineCredentials.inactiveHelp')}</p>}
      {(query.isPending || mutationPending) && <div className="space-y-3" role="status" aria-label={t('common:actions.loading')}>
        <Skeleton className="h-5 w-36" /><Skeleton className="h-24 w-full" />
      </div>}
      {query.isError && <p className="text-sm text-destructive" role="alert">
        {t(`admin:lineCredentials.errors.${credentialErrorKey(query.error)}`)}
      </p>}
      {query.data && !query.isError && !rotation.isError && !mutationPending && <LineCredentialStatusDetails status={query.data} />}
      {rotation.isError && <div role="alert" className="space-y-1 text-sm text-destructive">
        <p>{t(`admin:lineCredentials.errors.${credentialErrorKey(rotation.error)}`)}</p>
        <p>{t('admin:lineCredentials.requestUnconfirmed')}</p>
      </div>}
      <p className="text-xs text-muted-foreground">{t('admin:lineCredentials.closeHelp')}</p>
      <DialogFooter className="flex-wrap">
        <Button variant="outline" onClick={() => close(false)}>{t('common:actions.close')}</Button>
        <Button variant="outline" disabled={query.isFetching || mutationPending} onClick={() => void refresh()}>
          <RefreshCw className="size-4" />{t('admin:lineCredentials.refresh')}
        </Button>
        <Button disabled={!canRotate} onClick={() => { if (canRotate) setConfirmation(confirmationKey); }}>
          <ShieldCheck className="size-4" />
          {mutationPending ? t('admin:lineCredentials.submitting') : running ? t('admin:lineCredentials.inProgress') : t(retry ? 'admin:lineCredentials.retry' : 'admin:lineCredentials.rotate')}
        </Button>
      </DialogFooter>
      <AlertDialog open={open && confirmation !== null} onOpenChange={next => { if (!next) setConfirmation(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(retry ? 'admin:lineCredentials.retryTitle' : 'admin:lineCredentials.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('admin:lineCredentials.confirmDescription', { name: line.name })}</AlertDialogDescription>
          </AlertDialogHeader>
          {retry && <p className="text-sm text-muted-foreground">{t('admin:lineCredentials.retryHelp')}</p>}
          {confirmation !== null && confirmation !== confirmationKey && <p role="alert" className="text-sm text-destructive">{t('admin:lineCredentials.confirmationChanged')}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={!canConfirm} onClick={() => {
              if (!canConfirm) return;
              setConfirmation(null);
              requestRotation();
            }}>{t(retry ? 'admin:lineCredentials.confirmRetry' : 'admin:lineCredentials.confirmRotate')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ResponsiveDialogContent>
  </ResponsiveDialog>;
}
