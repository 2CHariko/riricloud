import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { LogCorrelation } from '@/components/shared/log-correlation';
import { LogCopyButton } from '@/components/shared/log-copy-button';
import { cn } from '@/lib/utils';
import { detailMetadata } from '@/lib/log-detail-presentation';
import type { SystemLogItem } from '../types';
import { LogContextCards } from './log-context-cards';
import { LogCollectorStats } from './log-collector-stats';
import { LogMetadataSection } from './log-metadata-section';

interface LogDetailDrawerProps {
  log: SystemLogItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFilterByTraceId: (traceId: string) => void;
  onFilterByNodeId?: (nodeId: string) => void;
  onFilterByModule?: (module: string) => void;
}

function LogDetailContent({ log, onOpenChange, onFilterByTraceId, onFilterByNodeId, onFilterByModule }: Omit<LogDetailDrawerProps, 'log' | 'open'> & { log: SystemLogItem }) {
  const { t } = useTranslation(['admin']);
  const metadata = detailMetadata(log.metadata);
  const stack = typeof metadata.data.errorStack === 'string' ? metadata.data.errorStack
    : typeof metadata.data.stack === 'string' ? metadata.data.stack : null;
  const filterAndClose = (callback: (value: string) => void) => (value: string) => {
    callback(value);
    onOpenChange(false);
  };
  return (
    <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden py-4 pr-1 text-xs">
      <section className="space-y-2" aria-label={t('admin:logs.detail.messageTitle')}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold">{t('admin:logs.detail.messageTitle')}</h3>
          <LogCopyButton value={log.message} label={t('admin:logs.detail.messageTitle')} />
        </div>
        <Card className="min-w-0"><CardContent className="max-h-48 overflow-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words select-text [overflow-wrap:anywhere]">{log.message}</CardContent></Card>
      </section>
      <LogCorrelation log={log} />
      <LogContextCards log={log} onFilterByTraceId={filterAndClose(onFilterByTraceId)}
        onFilterByModule={onFilterByModule ? filterAndClose(onFilterByModule) : undefined}
        onFilterByNodeId={onFilterByNodeId ? filterAndClose(onFilterByNodeId) : undefined} />
      <LogCollectorStats stats={metadata.data.collectorStats} />
      {stack && (
        <section className="space-y-2" aria-label={t('admin:logs.detail.stackTitle')}>
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-1 text-xs font-semibold text-destructive"><AlertCircle className="size-3.5" />{t('admin:logs.detail.stackTitle')}</h3>
            <LogCopyButton value={stack} label={t('admin:logs.detail.stackTitle')} />
          </div>
          <Card className="min-w-0 border-destructive/30 bg-destructive/5"><CardContent className="p-3">
            <pre className="max-h-64 max-w-full overflow-auto font-mono text-[11px] leading-relaxed text-destructive select-text">{stack}</pre>
          </CardContent></Card>
        </section>
      )}
      <LogMetadataSection metadata={metadata} />
    </div>
  );
}

export function LogDetailDrawer({ log, open, onOpenChange, ...filters }: LogDetailDrawerProps) {
  const { t } = useTranslation(['admin']);
  if (!log) return null;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full min-w-0 flex-col overflow-hidden p-4 sm:max-w-xl sm:p-6">
        <SheetHeader className="shrink-0 border-b pb-3 pr-8">
          <SheetTitle className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <Badge variant="outline" className={cn('shrink-0 font-mono text-xs',
              log.level === 'ERROR' && 'border-destructive/30 bg-destructive/10 text-destructive',
              log.level === 'WARN' && 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
              log.level === 'INFO' && 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
              log.level === 'DEBUG' && 'bg-muted text-muted-foreground')}>
              {log.level}
            </Badge>
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">[{log.module}] {t('admin:logs.detailTitle')}</span>
          </SheetTitle>
          <SheetDescription className="sr-only">{t('admin:logs.detail.description')}</SheetDescription>
        </SheetHeader>
        <LogDetailContent key={log.id} log={log} onOpenChange={onOpenChange} {...filters} />
      </SheetContent>
    </Sheet>
  );
}
