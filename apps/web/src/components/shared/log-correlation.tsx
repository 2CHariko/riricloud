import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { IconButton } from '@/components/ui/icon-button';
import { cn, getDefaultSystemTimezone } from '@/lib/utils';
import { detailMetadata, formatDetailTime, correlationFields, showReportedTime, timeQualityKey } from '@/lib/log-detail-presentation';
import type { SystemLogItem } from '@/lib/log-types';
import { LogInfoCard } from './log-info-card';

export function LogCorrelation({ log }: { log: SystemLogItem }) {
  const { t } = useTranslation(['admin']);
  const metadata = detailMetadata(log.metadata).data;
  const quality = timeQualityKey(metadata.timeQuality);
  const fields = correlationFields(metadata);
  const sequence = fields.find((field) => field.key === 'sequence');
  const identities = fields.filter((field) => field.key !== 'sequence');
  const qualityLabels = {
    agent: t('admin:logs.detail.qualityAgent'), legacy: t('admin:logs.detail.qualityLegacy'),
    fallback: t('admin:logs.detail.qualityFallback'), missing: t('admin:logs.detail.notProvided'), unknown: t('admin:logs.detail.qualityUnknown')
  };
  return (
    <div className="min-w-0 space-y-4">
      <section className="space-y-2" aria-label={t('admin:logs.detail.timeTitle')}>
        <div className="flex min-w-0 items-center justify-between gap-2">
          <h3 className="text-xs font-semibold">{t('admin:logs.detail.timeTitle')}</h3>
          <IconButton type="button" variant="ghost" size="icon-xs" aria-label={t('admin:logs.detail.timeHelp')}
            tooltip={<span className="block max-w-72 whitespace-normal leading-relaxed">{t('admin:logs.timeQualityHint')}</span>}><Info className="size-4" /></IconButton>
        </div>
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <LogInfoCard label={t('admin:logs.detail.recordedAt')} value={formatDetailTime(log.createdAt)} />
          <LogInfoCard label={t('admin:logs.receivedAt')} value={formatDetailTime(metadata.receivedAt)} />
          {showReportedTime(metadata, log.createdAt) && <LogInfoCard label={t('admin:logs.detail.reportedAt')}
            value={typeof metadata.occurredAt === 'string' ? metadata.occurredAt : '—'} />}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <Badge variant="outline" title={typeof metadata.timeQuality === 'string' ? metadata.timeQuality : undefined}
            className={cn('whitespace-nowrap text-[10px]', quality === 'fallback' && 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400')}>
            {qualityLabels[quality]}
          </Badge>
          {sequence && <span>{t('admin:logs.correlation.sequence')} <span className="font-mono text-foreground">{sequence.value}</span></span>}
          <span className="break-words">{getDefaultSystemTimezone()}</span>
        </div>
      </section>
      {identities.length > 0 && (
        <section className="space-y-2" aria-label={t('admin:logs.detail.identityTitle')}>
          <h3 className="text-xs font-semibold">{t('admin:logs.detail.identityTitle')}</h3>
          <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
            {identities.map((field) => <LogInfoCard key={field.key} label={t(`admin:logs.correlation.${field.key}`)}
              value={field.value} copyValue={field.copyable ? field.value : undefined} />)}
          </div>
        </section>
      )}
    </div>
  );
}
