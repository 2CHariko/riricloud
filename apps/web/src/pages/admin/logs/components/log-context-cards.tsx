import { useTranslation } from 'react-i18next';
import { Filter } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { LogInfoCard } from '@/components/shared/log-info-card';
import type { SystemLogItem } from '../types';

export function LogContextCards({ log, onFilterByTraceId, onFilterByNodeId, onFilterByModule }: {
  log: SystemLogItem; onFilterByTraceId: (id: string) => void;
  onFilterByNodeId?: (id: string) => void; onFilterByModule?: (module: string) => void;
}) {
  const { t } = useTranslation(['admin']);
  return (
    <section className="space-y-2" aria-label={t('admin:logs.detail.contextTitle')}>
      <h3 className="text-xs font-semibold">{t('admin:logs.detail.contextTitle')}</h3>
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        <LogInfoCard label={t('admin:logs.colSource')} value={log.source} />
        <LogInfoCard label={t('admin:logs.moduleTitle')} value={log.module} actions={onFilterByModule && (
          <IconButton type="button" variant="ghost" size="icon-xs" aria-label={t('admin:logs.filterByModuleTitle', { module: log.module })}
            onClick={() => onFilterByModule(log.module)}><Filter className="size-4" /></IconButton>
        )} />
        {log.node && <LogInfoCard label={t('admin:logs.relatedNode')} value={<>{log.node.name}<span className="block text-muted-foreground">{log.node.serverHost}</span></>}
          actions={onFilterByNodeId && <IconButton type="button" variant="ghost" size="icon-xs" aria-label={t('admin:logs.filterByNodeTitle', { name: log.node.name })}
            onClick={() => onFilterByNodeId(log.node!.id)}><Filter className="size-4" /></IconButton>} />}
        {log.user && <LogInfoCard label={t('admin:logs.relatedUser')} value={log.user.email} />}
        {log.traceId && <LogInfoCard label={t('admin:logs.traceIdTitle')} value={log.traceId} copyValue={log.traceId}
          actions={<IconButton type="button" variant="ghost" size="icon-xs" aria-label={t('admin:logs.filterByTraceTitle', { traceId: log.traceId })}
            onClick={() => onFilterByTraceId(log.traceId!)}><Filter className="size-4" /></IconButton>} />}
      </div>
    </section>
  );
}
