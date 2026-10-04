import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { LogInfoCard } from '@/components/shared/log-info-card';
import { collectorMetrics } from '@/lib/log-detail-presentation';

export function LogCollectorStats({ stats }: { stats: unknown }) {
  const { t } = useTranslation(['admin']);
  const metrics = collectorMetrics(stats);
  if (!metrics.length) return null;
  return (
    <section className="space-y-2" aria-label={t('admin:logs.detail.collectorTitle')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold">{t('admin:logs.detail.collectorTitle')}</h3>
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {t('admin:logs.detail.cumulativeSnapshot')}
          <IconButton type="button" variant="ghost" size="icon-xs" aria-label={t('admin:logs.detail.collectorHelp')}
            tooltip={<span className="block max-w-72 whitespace-normal leading-relaxed">{t('admin:logs.detail.collectorHint')}</span>}><Info className="size-4" /></IconButton>
        </div>
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3">
        {metrics.map((metric) => <LogInfoCard key={metric.key} label={t(`admin:logs.detail.collector.${metric.key}`)}
          value={metric.value === null ? t('admin:logs.detail.notProvided') : metric.value.toLocaleString()} warning={metric.warning} numeric={metric.value !== null} />)}
      </div>
    </section>
  );
}
