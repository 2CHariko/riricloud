import { useTranslation } from 'react-i18next';
import { cva } from 'class-variance-authority';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn, formatDateTime } from '@/lib/utils';
import { parseLastProbe, probeTone, type ProbeResult } from '@/lib/probe-types';

const chipToneStyles = cva('border font-mono select-none transition-colors', {
  variants: {
    tone: {
      success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 hover:border-emerald-500/50',
      warning: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 hover:border-amber-500/50',
      danger: 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300 hover:bg-rose-500/20 hover:border-rose-500/50',
      muted: 'border-border bg-muted/30 text-muted-foreground hover:bg-muted/50'
    }
  },
  defaultVariants: {
    tone: 'muted'
  }
});

const resultStyles = cva('text-xs font-mono', {
  variants: {
    tone: {
      success: 'text-emerald-600 dark:text-emerald-400',
      warning: 'text-amber-600 dark:text-amber-400',
      danger: 'text-rose-600 dark:text-rose-400',
      muted: 'text-muted-foreground'
    }
  }
});

const dotStyles = cva('size-1.5 rounded-full shrink-0', {
  variants: {
    tone: {
      success: 'bg-emerald-500',
      warning: 'bg-amber-500',
      danger: 'bg-rose-500',
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
      : t(`admin:latencyTest.statusShort.${result.status}`)
    : t('admin:latencyTest.notTested');

  const content = (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', className)}>
      <span className={dotStyles({ tone })} />
      <span className={cn('font-mono font-medium', resultStyles({ tone }))}>{label}</span>
    </span>
  );
  const qualityText = result?.status === 'SUCCESS' && result.latencyMs !== null
    ? result.latencyMs < 150
      ? t('admin:latencyTest.qualityExcellent')
      : result.latencyMs < 400
        ? t('admin:latencyTest.qualityNormal')
        : t('admin:latencyTest.qualityHigh')
    : null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {onClick ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn('h-7 px-2.5 font-normal cursor-pointer', chipToneStyles({ tone }), className)}
            onClick={onClick}
          >
            {content}
          </Button>
        ) : (
          <Badge variant="outline" className={cn('h-6 px-2 font-normal', chipToneStyles({ tone }), className)}>
            {content}
          </Badge>
        )}
      </TooltipTrigger>
      <TooltipContent className="max-w-xs space-y-1.5 text-xs shadow-lg">
        <div className="flex items-center justify-between gap-2 border-b border-primary-foreground/15 pb-1 font-semibold text-primary-foreground">
          <div className="flex items-center gap-1.5">
            <span>{result ? t(`admin:latencyTest.status.${result.status}`) : t('admin:latencyTest.title')}</span>
            {qualityText && <span className="text-[11px] font-normal opacity-80">({qualityText})</span>}
          </div>
          {result?.status === 'SUCCESS' && <span className="font-mono font-bold">{result.latencyMs} ms</span>}
        </div>
        {result && (
          <>
            <p className="font-mono text-[11px] text-primary-foreground/70">{result.targetHost}</p>
            <p className="text-[11px] text-primary-foreground/65">{formatDateTime(result.testedAt)}</p>
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
            variant={isSuccess ? 'default' : tone === 'danger' ? 'destructive' : tone === 'warning' ? 'outline' : 'secondary'}
            className="text-xs"
          >
            {t(`latencyTest.status.${result.status}`)}
          </Badge>
          {isSuccess && result.latencyMs !== null && (
            <div className="flex items-baseline gap-1">
              <span className={cn('text-2xl font-bold font-mono tracking-tight', resultStyles({ tone }))}>
                {result.latencyMs}
              </span>
              <span className="text-xs text-muted-foreground font-mono">ms</span>
            </div>
          )}
        </div>

      </div>

      <CardContent className="p-4 space-y-2.5 text-xs">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-muted-foreground">
          <div>
            <span>{t('latencyTest.configuredTarget')}：</span>
            <span className="font-mono text-foreground break-all">{result.targetHost}</span>
          </div>
          <div>{t('latencyTest.testTime', { time: formatDateTime(result.testedAt) })}</div>
        </div>
        {!isSuccess && <p className="text-muted-foreground">{t(`latencyTest.statusHelp.${result.status}`)}</p>}
      </CardContent>
    </Card>
  );
}
