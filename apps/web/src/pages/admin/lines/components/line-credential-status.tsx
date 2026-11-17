import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/utils';
import { credentialErrorKeys, type LineCredentialStatus } from '../line-credentials-contract';

export function LineCredentialStatusDetails({ status }: { status: LineCredentialStatus }) {
  const { t } = useTranslation('admin');
  const confirmed = status.state === 'CONFIRMED' && !!status.confirmedAt && !status.errorCode;
  const displayState = status.state === 'CONFIRMED' && status.errorCode ? 'UNAVAILABLE' : status.state;
  const stopExpected = ['STOPPING_PREVIOUS_ENTRY', 'STOPPING_ENTRY', 'APPLYING_LANDING', 'RETIRING_PREVIOUS_LANDING', 'FAILED'].includes(status.state);
  const stopConfirmation = !stopExpected ? 'stopNotRequired' : status.entryStopConfirmed ? 'stopConfirmed' : 'stopUnconfirmed';
  const expectation = status.state === 'STOPPING_PREVIOUS_ENTRY' ? 'expectedPreviousStopped' : stopExpected ? 'expectedStopped' : status.state === 'RESTORING_ENTRY' ? 'expectedRestoring' : confirmed ? 'expectedEnabled' : 'expectedUnknown';
  const items = [
    [t('lineCredentials.activeVersion'), status.activeVersion === null ? t('lineCredentials.noVersion') : t('lineCredentials.versionValue', { version: status.activeVersion })],
    [t('lineCredentials.targetVersion'), status.targetVersion === null ? t('lineCredentials.noVersion') : t('lineCredentials.versionValue', { version: status.targetVersion })],
    [t('lineCredentials.expectedEntry'), t(`lineCredentials.${expectation}`)],
    [t('lineCredentials.entryStopConfirmation'), t(`lineCredentials.${stopConfirmation}`)],
    [t('lineCredentials.configurationReceipt'), t(confirmed ? 'lineCredentials.receiptCompleted' : status.accepted ? 'lineCredentials.receiptAccepted' : 'lineCredentials.receiptPending')],
    [t('lineCredentials.runtimeConfirmation'), confirmed ? t('lineCredentials.runtimeConfirmed') : t('lineCredentials.runtimeUnconfirmed')],
    ...(status.previousEntryNodeId ? [[t('lineCredentials.previousEntryNode'), status.previousEntryNodeId]] : []),
    ...(status.previousLandingNodeId ? [[t('lineCredentials.previousLandingNode'), status.previousLandingNodeId]] : []),
    ...(status.operationId ? [[t('lineCredentials.operationId'), status.operationId]] : []),
    ...(status.failedStage ? [[t('lineCredentials.failedStage'), t(`lineCredentials.states.${status.failedStage}`)]] : []),
    ...(status.deadlineAt && !confirmed ? [[t('lineCredentials.deadlineAt'), formatDateTime(status.deadlineAt)]] : []),
    ...(confirmed ? [[t('lineCredentials.confirmedAt'), formatDateTime(status.confirmedAt)]] : [])
  ];
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-2" role="status" aria-live="polite">
      <span className="text-sm text-muted-foreground">{t('lineCredentials.stage')}</span>
      <Badge variant={status.state === 'FAILED' || status.errorCode ? 'destructive' : confirmed ? 'default' : 'secondary'}>
        {t(`lineCredentials.states.${displayState}`)}
      </Badge>
    </div>
    {status.errorCode && <p className="text-sm text-destructive" role="alert">
      {t(`lineCredentials.errors.${credentialErrorKeys[status.errorCode]}`)}
    </p>}
    <dl className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
      {items.map(([label, value]) => <div key={label} className="min-w-0 space-y-1">
        <dt className="text-sm text-muted-foreground">{label}</dt>
        <dd className="break-words text-sm font-medium [overflow-wrap:anywhere]">{value}</dd>
      </div>)}
    </dl>
    <p className="text-xs text-muted-foreground">{t('lineCredentials.confirmationHelp')}</p>
    {status.state === 'FAILED' && <p className="text-sm text-destructive">{t('lineCredentials.failureHelp')}</p>}
  </div>;
}
