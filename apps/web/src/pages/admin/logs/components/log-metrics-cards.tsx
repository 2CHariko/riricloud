import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, FileText, Zap } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { LogMetrics } from '../types';

interface LogMetricsCardsProps {
  metrics?: LogMetrics;
  isLoading: boolean;
  hours: number;
}

export function LogMetricsCards({ metrics, isLoading, hours }: LogMetricsCardsProps) {
  const { t } = useTranslation(['admin', 'common']);

  if (isLoading && !metrics) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
    );
  }

  const cards = [
    {
      title: t('admin:logs.filteredTotal'),
      value: metrics?.totalLogs.toLocaleString() ?? '0',
      desc: t('admin:logs.filteredTotalDesc'),
      icon: FileText,
      color: 'text-blue-500'
    },
    {
      title: t('admin:logs.filteredErrors'),
      value: metrics?.errorCount24h.toLocaleString() ?? '0',
      desc: (metrics?.errorCount24h ?? 0) > 0 ? t('admin:logs.metricErrorNeedFix') : t('admin:logs.noErrors'),
      icon: AlertCircle,
      color: (metrics?.errorCount24h ?? 0) > 0 ? 'text-rose-500' : 'text-muted-foreground',
      highlight: (metrics?.errorCount24h ?? 0) > 0
    },
    {
      title: t('admin:logs.filteredWarns'),
      value: metrics?.warnCount24h.toLocaleString() ?? '0',
      desc: (metrics?.warnCount24h ?? 0) > 0 ? t('admin:logs.metricWarnRetry') : t('admin:logs.noWarnings'),
      icon: AlertTriangle,
      color: (metrics?.warnCount24h ?? 0) > 0 ? 'text-amber-500' : 'text-muted-foreground'
    },
    {
      title: t('admin:logs.httpDuration'),
      value: `${metrics?.avgLatencyMs ?? 0} ms`,
      desc: t('admin:logs.httpDurationDesc'),
      icon: Zap,
      color: 'text-emerald-500'
    }
  ];

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t('admin:logs.metricsWindow', { hours })}</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.title} className={cn('relative overflow-hidden', c.highlight && 'border-rose-500/40 bg-rose-500/5')}>
          <CardHeader className="flex flex-row items-center justify-between pb-1.5 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground">{c.title}</CardTitle>
            <c.icon className={cn('size-4 shrink-0', c.color)} />
          </CardHeader>
          <CardContent className="px-4 pb-3">
            <div className="text-xl font-bold tracking-tight font-mono">{c.value}</div>
            <p className="text-[11px] text-muted-foreground mt-0.5">{c.desc}</p>
          </CardContent>
        </Card>
      ))}
    </div>
      </div>
  );
}
