import { useTranslation } from 'react-i18next';
import { formatDateTime } from '@/lib/utils';
import { parseLogMetadata } from '@/lib/log-contract';
import type { SystemLogItem } from '@/lib/log-types';

export function LogCorrelation({ log, compact = false }: { log: SystemLogItem; compact?: boolean }) {
  const { t } = useTranslation(['admin']);
  const metadata = parseLogMetadata(log.metadata);
  const fields = ['timeQuality', 'sequence', 'agentInstanceId', 'kernelInstanceId', 'event', 'taskId', 'operationId'] as const;
  return (
    <div className="space-y-1 break-all text-xs text-muted-foreground">
      {!compact && <p>{t('admin:logs.occurredAt')}: {formatDateTime(log.createdAt)}</p>}
      {typeof metadata.receivedAt === 'string' && <p>{t('admin:logs.receivedAt')}: {formatDateTime(metadata.receivedAt)}</p>}
      <div className={compact ? 'max-w-64 truncate font-mono' : 'space-y-1 font-mono'}>
        {fields.map((key) => {
          const value = metadata[key];
          return typeof value === 'string' || typeof value === 'number'
            ? <span key={key} className="mr-2 inline-block" title={`${key}: ${value}`}>{t(`admin:logs.correlation.${key}`)}: {String(value)}</span> : null;
        })}
      </div>
      {!compact && <p>{t('admin:logs.timeQualityHint')}</p>}
    </div>
  );
}
