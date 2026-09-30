import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, RefreshCw, Loader2, CheckCircle2, XCircle, MinusCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { formatDateTime } from '@/lib/utils';
import { useLineMutations, type AdminLine, type SpeedTestExecutionResult } from '../use-lines';

export interface LineSpeedtestDialogProps { open: boolean; onOpenChange: (open: boolean) => void; line: AdminLine | null; }
export function LineSpeedtestDialog({ open, onOpenChange, line }: LineSpeedtestDialogProps) {
  const { t } = useTranslation(['admin', 'common']);
  const { speedtest } = useLineMutations();
  const [result, setResult] = useState<SpeedTestExecutionResult | null>(null);
  const [failed, setFailed] = useState(false);
  const requestKey = useRef(0);
  const run = () => {
    if (!line) return;
    const key = ++requestKey.current;
    setResult(null); setFailed(false);
    speedtest.mutate(line.id, { onSuccess: (data) => { if (key === requestKey.current) setResult(data); }, onError: () => { if (key === requestKey.current) setFailed(true); } });
  };
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    const activeRequest = requestKey;
    if (open) runRef.current();
    return () => { activeRequest.current++; };
  }, [open, line?.id]);
  if (!line) return null;
  const pending = speedtest.isPending && speedtest.variables === line.id;
  const entryName = line.type === 'EXTERNAL' ? line.upstreamSummary?.name ?? t('admin:upstream.externalType') : line.entryNode?.name;
  const landingName = line.relayMode === 'UPSTREAM_NODE' ? line.upstreamSummary?.name : line.relayMode === 'TARGET_LINE' ? line.targetLine?.name : line.landingNode?.name;
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
    <DialogHeader><DialogTitle className="flex items-center gap-2"><Activity className="size-5" />{t('admin:lineSpeedtest.title')} · {line.name}</DialogTitle><DialogDescription>{t('admin:lineSpeedtest.desc')}</DialogDescription></DialogHeader>
    <Card><CardContent className="p-4 space-y-2">
      <p className="text-xs text-muted-foreground">{t('admin:lineSpeedtest.topoPath')}</p>
      <p>{t('admin:lineSpeedtest.masterServer')} ➔ {entryName}{line.type === 'RELAY' && <> ➔ {landingName}</>} ➔ {t('admin:lineSpeedtest.defaultStages.targetHttp')}</p>
      <p className="font-mono text-xs">{line.serverHost}:{line.serverPort} · {line.protocolType}</p>
      <Badge variant="outline">{line.type === 'EXTERNAL' ? t('admin:upstream.externalType') : line.type === 'DIRECT' ? t('admin:lines.typeDirect') : t('admin:lines.typeRelay')}</Badge>
    </CardContent></Card>
    <div className="space-y-2">
      <p className="text-sm font-medium">{t('admin:lineSpeedtest.currentResult')}</p>
      {pending ? <p className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" />{t('admin:lineSpeedtest.testing')}</p> : failed ? <p className="text-destructive">{t('common:status.failed')}</p> : result ? <>
        <Badge variant={result.status === 'SUCCESS' ? 'default' : 'destructive'}>{result.status === 'SUCCESS' ? `${result.latencyMs ?? '—'} ms` : result.status === 'TIMEOUT' ? t('admin:lineSpeedtest.statusTimeout') : t('admin:lineSpeedtest.statusFailed')}</Badge>
        <p className="text-xs text-muted-foreground">{formatDateTime(result.testedAt)}</p>
        <p className="text-sm break-words">{result.message}</p>
        {result.status !== 'SUCCESS' && <p className="text-xs text-destructive">{t('admin:lineSpeedtest.strictFailureNotice')}</p>}
      </> : <p>{t('admin:lineSpeedtest.readyToTest')}</p>}
    </div>
    <p className="text-sm font-medium">{t('admin:lineSpeedtest.stagesTitle')}</p>
    {result?.stages.map((stage) => <Card key={stage.id}><CardContent className="flex items-start gap-3 p-3">
      {stage.status === 'SUCCESS' ? <CheckCircle2 className="size-4 text-emerald-600" /> : stage.status === 'SKIPPED' ? <MinusCircle className="size-4 text-muted-foreground" /> : <XCircle className="size-4 text-destructive" />}
      <div className="min-w-0 flex-1"><p className="text-sm font-medium">{stage.name}</p><p className="break-words text-xs font-mono">{stage.target}</p><p className="text-xs text-muted-foreground">{stage.message}</p></div>
      <span className="text-xs">{stage.latencyMs == null ? stage.status === 'SKIPPED' ? t('admin:lineSpeedtest.stageSkipped') : '—' : `${stage.latencyMs} ms`}</span>
    </CardContent></Card>)}
    <DialogFooter><Button variant="outline" disabled={pending} onClick={run}><RefreshCw className="size-4" />{t('admin:lineSpeedtest.retest')}</Button><Button onClick={() => onOpenChange(false)}>{t('common:actions.close')}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
