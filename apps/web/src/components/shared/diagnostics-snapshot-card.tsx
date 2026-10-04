import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useDiagnosticsSnapshot } from '@/hooks/use-diagnostics-snapshot';
import { extractErrorMessage } from '@/lib/api';
import { supportsSnapshot, parseLogMetadata } from '@/lib/log-contract';
import type { SnapshotNode } from '@/lib/log-types';
import { LogCorrelation } from './log-correlation';

export function DiagnosticsSnapshotCard({ node }: { node?: SnapshotNode }) {
  const snapshot = useDiagnosticsSnapshot(node?.id ?? '');
  return <Card><DiagnosticsSnapshotContent node={node} snapshot={snapshot} /></Card>;
}

export function DiagnosticsSnapshotContent({ node, snapshot }: { node?: SnapshotNode; snapshot: ReturnType<typeof useDiagnosticsSnapshot> }) {
  const { t } = useTranslation(['admin']);
  const { request, receipt, result, status } = snapshot;
  const available = supportsSnapshot(node);
  const busy = status === 'requesting' || status === 'waiting';
  const hint = !node ? 'snapshotSelectNode' : node.status !== 'ONLINE' ? 'snapshotOffline' : !available ? 'snapshotUnsupported' : 'snapshotDescription';
  return (
    <>
      <CardHeader className="pb-2"><CardTitle className="text-sm">{t('admin:logs.snapshotTitle')}</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-muted-foreground">{t(`admin:logs.${hint}`)}</p>
          <Button size="sm" variant="outline" disabled={!available || busy} onClick={() => request.mutate()}>
            {t('admin:logs.snapshotRequest')}
          </Button>
        </div>
        <p className="text-muted-foreground">{t('admin:logs.snapshotDisclaimer')}</p>
        <div role="status" aria-live="polite" className="space-y-2 break-words">
          {status !== 'idle' && <p>{t(`admin:logs.snapshotStatus.${status}`)}</p>}
          {receipt && <p className="font-mono break-all">{t('admin:logs.snapshotTask', { taskId: receipt.taskId })}</p>}
          {status === 'failed' && <p className="text-destructive">{extractErrorMessage(request.error ?? result.error, t('admin:logs.snapshotFailed'))}</p>}
          {result.data && (
            <>
              <LogCorrelation log={result.data} />
              <p className="whitespace-pre-wrap">{result.data.message}</p>
              <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">{JSON.stringify(parseLogMetadata(result.data.metadata), null, 2)}</pre>
            </>
          )}
        </div>
      </CardContent>
    </>
  );
}
