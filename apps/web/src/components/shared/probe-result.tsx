import { useTranslation } from 'react-i18next';
import { cva } from 'class-variance-authority';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn, formatDateTime } from '@/lib/utils';
import { parseLastProbe, probeTone, type ProbeResult } from '@/lib/probe-types';

const resultStyles = cva('text-xs font-mono', {
  variants: {
    tone: {
      success: 'text-emerald-600 dark:text-emerald-400',
      warning: 'text-amber-600 dark:text-amber-400',
      danger: 'text-destructive',
      muted: 'text-muted-foreground'
    }
  }
});

const dotStyles = cva('size-1.5 rounded-full shrink-0', {
  variants: {
    tone: {
      success: 'bg-emerald-500',
      warning: 'bg-amber-500',
      danger: 'bg-destructive',
      muted: 'bg-muted-foreground/40'
    }
  }
});

export function ProbeMeasurementChip({
  value,
  onClick,
  className
}: {
  value: unknown;
  onClick?: () => void;
  className?: string;
}) {
  const { t } = useTranslation(['admin', 'common']);
  const result = parseLastProbe(value);
  const tone = result ? probeTone(result) : 'muted';

  const label = result
    ? result.status === 'SUCCESS'
      ? `${result.latencyMs} ms`
      : t(`admin:probes.statusShort.${result.status}`, t(`admin:probes.status.${result.status}`))
    : t('common:latency.notTested');

  const content = (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', className)}>
      <span className={dotStyles({ tone })} />
      <span className={cn('font-mono font-medium', resultStyles({ tone }))}>{label}</span>
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {onClick ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2.5 hover:bg-accent/60"
            onClick={onClick}
          >
            {content}
          </Button>
        ) : (
          <Badge variant="outline" className="h-6 px-2">
            {content}
          </Badge>
        )}
      </TooltipTrigger>
      <TooltipContent className="max-w-xs space-y-1.5 text-xs">
        <div className="flex items-center justify-between gap-2 border-b pb-1 font-semibold">
          <span>{result ? t(`admin:probes.status.${result.status}`) : t('admin:probes.measurement')}</span>
          {result?.latencyMs !== null && result?.latencyMs !== undefined && (
            <span className="font-mono text-emerald-500">{result.latencyMs} ms</span>
          )}
        </div>
        {result && (
          <>
            <p className="text-muted-foreground">
              {result.engine ? t(`admin:probes.engine.${result.engine}`) : t('admin:probes.noEngine')}
              {result.engineVersion ? ` · v${result.engineVersion}` : ''}
            </p>
            <p className="font-mono text-[11px] text-muted-foreground">
              {result.targetHost} · {t(`admin:probes.route.${result.routeKind}`)}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {t('admin:probes.perspective')} · {formatDateTime(result.testedAt)}
            </p>
            {result.message && (
              <p className="text-[11px] break-words text-foreground/80">{result.message}</p>
            )}
            {result.engine === 'SINGBOX' && result.status === 'SUCCESS' && (
              <p className="text-amber-500 text-[11px]">{t('admin:probes.fallbackWarning')}</p>
            )}
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export function ProbeResultCard({ result }: { result: ProbeResult }) {
  const { t } = useTranslation('admin');
  const tone = probeTone(result);
  const isSuccess = result.status === 'SUCCESS';

  return (
    <Card className="overflow-hidden border shadow-sm">
      {/* 核心指标看板顶部 */}
      <div
        className={cn(
          'p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b',
          tone === 'success'
            ? 'bg-emerald-500/5 border-emerald-500/20'
            : tone === 'warning'
              ? 'bg-amber-500/5 border-amber-500/20'
              : tone === 'danger'
                ? 'bg-destructive/5 border-destructive/20'
                : 'bg-muted/30'
        )}
      >
        <div className="flex items-center gap-3">
          <Badge
            variant={tone === 'danger' ? 'destructive' : tone === 'warning' ? 'outline' : 'default'}
            className="text-xs"
          >
            {t(`probes.status.${result.status}`)}
          </Badge>
          {isSuccess && result.latencyMs !== null && (
            <div className="flex items-baseline gap-1">
              <span className="text-2xl font-bold font-mono tracking-tight text-emerald-600 dark:text-emerald-400">
                {result.latencyMs}
              </span>
              <span className="text-xs text-muted-foreground font-mono">ms</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary" className="font-mono text-[11px]">
            {result.engine ? t(`probes.engine.${result.engine}`) : t('probes.noEngine')}
            {result.engineVersion ? ` · ${result.engineVersion}` : ''}
          </Badge>
        </div>
      </div>

      <CardContent className="p-4 space-y-2.5 text-xs">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-muted-foreground">
          <div>
            <span>{t('probes.measurement')}：</span>
            <span className="text-foreground">{t(`probes.route.${result.routeKind}`)}</span>
          </div>
          <div>
            <span>{t('probes.configuredTarget')}：</span>
            <span className="font-mono text-foreground">{result.targetHost}</span>
          </div>
          <div>
            <span>{t('probes.timings', { latency: isSuccess ? result.latencyMs ?? '—' : '—', duration: result.durationMs })}</span>
          </div>
          <div>
            <span>{t('probes.compatibility', { status: t(`probes.compat.${result.mihomoCompatibility}`) })}</span>
          </div>
        </div>

        {result.message && (
          <div className="rounded bg-muted/50 p-2 font-mono text-[11px] break-words text-foreground/85">
            {result.message}
          </div>
        )}

        {result.errorCode && (
          <p className="font-mono text-destructive">
            {result.errorCode} · {result.stage}
          </p>
        )}
        {result.fallbackReason && (
          <p className="text-amber-600 dark:text-amber-400">
            {t('probes.fallbackReason', { reason: result.fallbackReason })}
          </p>
        )}
        {isSuccess && result.engine === 'SINGBOX' && (
          <p className="text-amber-600 dark:text-amber-400">{t('probes.fallbackWarning')}</p>
        )}
        {!result.applied && <p className="text-muted-foreground">{t('probes.notApplied')}</p>}
      </CardContent>
    </Card>
  );
}
