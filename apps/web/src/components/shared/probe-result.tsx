import { useTranslation } from 'react-i18next';
import { cva } from 'class-variance-authority';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn, formatDateTime } from '@/lib/utils';
import { parseLastProbe, probeTone, type ProbeResult } from '@/lib/probe-types';

const resultStyles = cva('text-xs', { variants: { tone: {
  success: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  danger: 'text-destructive', muted: 'text-muted-foreground'
} } });
export function ProbeMeasurementChip({ value, onClick, className }: { value: unknown; onClick?: () => void; className?: string }) {
  const { t } = useTranslation(['admin', 'common']);
  const result = parseLastProbe(value);
  const label = result ? result.status === 'SUCCESS' ? `${result.latencyMs} ms` : t(`admin:probes.status.${result.status}`) : t('common:latency.notTested');
  const content = <span className={cn(resultStyles({ tone: result ? probeTone(result) : 'muted' }), 'flex flex-wrap items-center gap-1', className)}>
    <span>{label}</span>{result?.engine && <span>· {t(`admin:probes.engine.${result.engine}`)}</span>}
  </span>;
  return <Tooltip><TooltipTrigger asChild>{onClick
    ? <Button type="button" variant="outline" size="sm" onClick={onClick}>{content}</Button>
    : <Badge variant="outline">{content}</Badge>}</TooltipTrigger><TooltipContent className="max-w-sm space-y-1">
    <p>{t('admin:probes.measurement')}</p>
    {result && <><p>{t('admin:probes.metadata', { version: result.engineVersion ?? '—', host: result.targetHost, route: t(`admin:probes.route.${result.routeKind}`), duration: result.durationMs })}</p>
      <p>{t('admin:probes.perspective')} · {formatDateTime(result.testedAt)}</p>
      <p>{result.message}</p>{result.engine === 'SINGBOX' && result.status === 'SUCCESS' && <p>{t('admin:probes.fallbackWarning')}</p>}</>}
  </TooltipContent></Tooltip>;
}
export function ProbeResultCard({ result }: { result: ProbeResult }) {
  const { t } = useTranslation('admin');
  const tone = probeTone(result);
  return <Card><CardContent className="space-y-2 p-4 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={tone === 'danger' ? 'destructive' : 'outline'} className={resultStyles({ tone })}>{t(`probes.status.${result.status}`)}</Badge>
      <Badge variant="secondary">{result.engine ? t(`probes.engine.${result.engine}`) : t('probes.noEngine')} · {result.engineVersion ?? '—'}</Badge>
      <span className="font-mono break-all">{result.subjectId}</span>
    </div>
    <p>{t('probes.measurement')} · {t('probes.perspective')} · {t(`probes.route.${result.routeKind}`)}</p>
    <p className="break-all">{result.targetHost} · {formatDateTime(result.testedAt)}</p>
    <p>{t('probes.timings', { latency: result.status === 'SUCCESS' ? result.latencyMs ?? '—' : '—', duration: result.durationMs })}</p>
    <p>{t('probes.compatibility', { status: t(`probes.compat.${result.mihomoCompatibility}`) })}</p>
    <p className="break-words">{result.message}</p>
    {result.errorCode && <p className="font-mono">{result.errorCode} · {result.stage}</p>}
    {result.fallbackReason && <p className="text-amber-600 dark:text-amber-400">{t('probes.fallbackReason', { reason: result.fallbackReason })}</p>}
    {result.status === 'SUCCESS' && result.engine === 'SINGBOX' && <p className="text-amber-600 dark:text-amber-400">{t('probes.fallbackWarning')}</p>}
    {!result.applied && <p className="text-muted-foreground">{t('probes.notApplied')}</p>}
  </CardContent></Card>;
}
