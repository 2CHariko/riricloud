import { useTranslation } from 'react-i18next';
import { Activity, AlertCircle, ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { LogCorrelation } from '@/components/shared/log-correlation';
import { LogCopyButton } from '@/components/shared/log-copy-button';
import { cn } from '@/lib/utils';
import {
  detailMetadata,
  formatDetailTime,
  timeQualityKey,
  correlationFields,
  collectorMetrics
} from '@/lib/log-detail-presentation';
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

function LogDetailContent({
  log,
  onOpenChange,
  onFilterByTraceId,
  onFilterByNodeId,
  onFilterByModule
}: Omit<LogDetailDrawerProps, 'log' | 'open'> & { log: SystemLogItem }) {
  const { t } = useTranslation(['admin', 'common']);
  const metadata = detailMetadata(log.metadata);
  const stack = typeof metadata.data.errorStack === 'string'
    ? metadata.data.errorStack
    : typeof metadata.data.stack === 'string'
      ? metadata.data.stack
      : null;

  const filterAndClose = (callback: (value: string) => void) => (value: string) => {
    callback(value);
    onOpenChange(false);
  };

  const metrics = collectorMetrics(metadata.data.collectorStats);
  const fields = correlationFields(metadata.data);
  const identities = fields.filter((f) => f.key !== 'sequence');
  const quality = timeQualityKey(metadata.data.timeQuality);
  const hasAnomaly = metrics.some((m) => m.warning) || quality === 'fallback';
  const hasDiagnostics = identities.length > 0 || metrics.length > 0;

  return (
    <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden py-4 pr-1 text-xs">
      {/* 全链路 Trace 追踪栏 */}
      {log.traceId ? (
        <section className="space-y-1.5 rounded-lg border bg-muted/30 p-3" aria-label={t('admin:logs.traceIdTitle')}>
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[11px] font-semibold uppercase tracking-wider">
              {t('admin:logs.traceIdTitle')}
            </span>
            <div className="flex items-center gap-1.5">
              <LogCopyButton
                value={log.traceId}
                label={t('admin:logs.traceIdTitle')}
                className="h-6 px-2 text-[10px] gap-1"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  onFilterByTraceId(log.traceId!);
                  onOpenChange(false);
                }}
                className="h-6 px-2 text-[10px] gap-1"
              >
                <ExternalLink className="size-3" />
                {t('admin:logs.filterByTrace')}
              </Button>
            </div>
          </div>
          <div className="rounded border bg-background/80 p-2 font-mono text-xs select-all break-all text-foreground">
            {log.traceId}
          </div>
        </section>
      ) : null}

      {/* 基础归属上下文信息 */}
      <LogContextCards
        log={log}
        onFilterByModule={onFilterByModule ? filterAndClose(onFilterByModule) : undefined}
        onFilterByNodeId={onFilterByNodeId ? filterAndClose(onFilterByNodeId) : undefined}
      />

      {/* 日志消息核心正文 */}
      <section className="space-y-1.5" aria-label={t('admin:logs.logDesc')}>
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t('admin:logs.logDesc')}
          </span>
          <LogCopyButton
            value={log.message}
            label={t('admin:logs.logDesc')}
            className="h-6 px-2 text-[10px] gap-1"
          />
        </div>
        <div className="rounded-lg border bg-muted/30 p-3 font-mono text-xs select-text whitespace-pre-wrap break-all leading-relaxed max-h-48 overflow-auto">
          {log.message}
        </div>
      </section>

      {/* 错误堆栈（如果存在） */}
      {stack && (
        <section className="space-y-1.5" aria-label={t('admin:logs.stackTraceTitle')}>
          <div className="flex items-center justify-between text-destructive">
            <div className="flex items-center gap-1 font-semibold text-[11px] uppercase tracking-wider">
              <AlertCircle className="size-3.5" />
              <span>{t('admin:logs.stackTraceTitle')}</span>
            </div>
            <LogCopyButton
              value={stack}
              label={t('admin:logs.copyStack')}
              className="h-6 px-2 text-[10px] gap-1 text-destructive hover:bg-destructive/10"
            />
          </div>
          <pre className="max-h-64 max-w-full overflow-auto rounded-lg border border-destructive/30 bg-destructive/5 p-3 font-mono text-[11px] leading-relaxed text-destructive select-text">
            {stack}
          </pre>
        </section>
      )}

      {/* 结构化元数据 JSON（深色代码块直接呈现） */}
      <LogMetadataSection metadata={metadata} />

      {/* 底层采集与实例诊断（折叠收纳） */}
      {hasDiagnostics && (
        <Accordion type="single" collapsible defaultValue={hasAnomaly ? 'diagnostics' : undefined}>
          <AccordionItem value="diagnostics" className="rounded-lg border bg-muted/10 px-3">
            <AccordionTrigger className="py-2.5 text-xs font-semibold text-muted-foreground hover:text-foreground">
              <div className="flex items-center gap-1.5">
                <Activity className="size-3.5" />
                <span>{t('admin:logs.detail.diagnosticsSection')}</span>
                {hasAnomaly && (
                  <Badge
                    variant="outline"
                    className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400"
                  >
                    {t('admin:logs.detail.hasAnomaly')}
                  </Badge>
                )}
              </div>
            </AccordionTrigger>
            <AccordionContent className="space-y-3 pt-1 pb-3">
              <LogCorrelation log={log} />
              <LogCollectorStats stats={metadata.data.collectorStats} />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}
    </div>
  );
}

export function LogDetailDrawer({ log, open, onOpenChange, ...filters }: LogDetailDrawerProps) {
  const { t } = useTranslation(['admin']);
  if (!log) return null;

  const metadata = detailMetadata(log.metadata);
  const quality = timeQualityKey(metadata.data.timeQuality);
  const qualityLabels = {
    agent: t('admin:logs.detail.qualityAgent'),
    legacy: t('admin:logs.detail.qualityLegacy'),
    fallback: t('admin:logs.detail.qualityFallback'),
    missing: t('admin:logs.detail.notProvided'),
    unknown: t('admin:logs.detail.qualityUnknown'),
  };
  const sequenceField = correlationFields(metadata.data).find((f) => f.key === 'sequence');

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full min-w-0 flex-col overflow-hidden p-4 sm:max-w-xl sm:p-6">
        <SheetHeader className="shrink-0 border-b pb-3 pr-8">
          <SheetTitle className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <Badge
              variant="outline"
              className={cn(
                'shrink-0 font-mono text-xs',
                log.level === 'ERROR' && 'border-destructive/30 bg-destructive/10 text-destructive',
                log.level === 'WARN' && 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
                log.level === 'INFO' && 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
                log.level === 'DEBUG' && 'bg-muted text-muted-foreground'
              )}
            >
              {log.level}
            </Badge>
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">
              [{log.module}] {t('admin:logs.detailTitle')}
            </span>
          </SheetTitle>
          <SheetDescription className="mt-1 flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
            <span>
              {t('admin:logs.generatedAt', {
                local: formatDetailTime(log.createdAt),
                iso: new Date(log.createdAt).toISOString()
              })}
            </span>
            {quality === 'fallback' && (
              <Badge
                variant="outline"
                className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400"
              >
                {qualityLabels[quality]}
              </Badge>
            )}
            {sequenceField && (
              <span className="text-[11px] text-muted-foreground">
                #{sequenceField.value}
              </span>
            )}
          </SheetDescription>
        </SheetHeader>
        <LogDetailContent key={log.id} log={log} onOpenChange={onOpenChange} {...filters} />
      </SheetContent>
    </Sheet>
  );
}
