import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Check, Copy, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import type { SystemLogItem } from '../types';
import { LogCorrelation } from '@/components/shared/log-correlation';
import { parseLogMetadata } from '@/lib/log-contract';

interface LogDetailDrawerProps {
  log: SystemLogItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFilterByTraceId: (traceId: string) => void;
  onFilterByNodeId?: (nodeId: string) => void;
  onFilterByModule?: (module: string) => void;
}

export function LogDetailDrawer({
  log,
  open,
  onOpenChange,
  onFilterByTraceId,
  onFilterByNodeId,
  onFilterByModule
}: LogDetailDrawerProps) {
  const { t } = useTranslation(['admin', 'common']);
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);

  if (!log) return null;

  const copyText = (text: string, key: string, label: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedKey(key);
    toast.success(t('admin:logs.copiedLabel', { label }));
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const parsedMetadata = parseLogMetadata(log.metadata);
  const parseError = !Object.keys(parsedMetadata).length && log.metadata !== '{}';

  const stackTrace = typeof parsedMetadata.errorStack === 'string'
    ? parsedMetadata.errorStack
    : typeof parsedMetadata.stack === 'string'
      ? parsedMetadata.stack
      : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-xl w-full flex flex-col p-6 overflow-hidden">
        <SheetHeader className="pb-3 border-b">
          <SheetTitle className="flex items-center gap-2 text-sm font-semibold">
            <Badge
              variant={log.level === 'ERROR' ? 'destructive' : 'outline'}
              className={cn(
                'font-mono uppercase text-xs',
                log.level === 'WARN' && 'bg-amber-500/10 text-amber-500 border-amber-500/30',
                log.level === 'INFO' && 'bg-blue-500/10 text-blue-500 border-blue-500/30'
              )}
            >
              {log.level}
            </Badge>
            <span>[{log.module}] {t('admin:logs.detailTitle')}</span>
          </SheetTitle>
          <SheetDescription className="text-xs font-mono text-muted-foreground mt-1">
            {t('admin:logs.generatedAt', {
              local: new Date(log.createdAt).toLocaleString(),
              iso: new Date(log.createdAt).toISOString()
            })}
          </SheetDescription>
        </SheetHeader>

        {/* 内容滚动区 */}
        <div className="flex-1 overflow-y-auto space-y-4 py-4 pr-1 text-xs">
          <LogCorrelation log={log} />
          {/* 全链路 Trace 追踪栏 */}
          {log.traceId ? (
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="flex items-center justify-between text-muted-foreground mb-1.5">
                <span className="font-semibold text-[11px] uppercase tracking-wider">{t('admin:logs.traceIdTitle')}</span>
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => copyText(log.traceId!, 'trace', 'Trace ID')}
                    className="h-6 px-2 text-[10px] gap-1"
                  >
                    {copiedKey === 'trace' ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
                    {t('common:actions.copy')}
                  </Button>
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
              <div className="font-mono text-xs select-all text-foreground break-all bg-background/80 p-1.5 rounded border">
                {log.traceId}
              </div>
            </div>
          ) : null}

          {/* 基础归属上下文信息 */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg border p-2.5 bg-muted/10">
              <div className="text-muted-foreground text-[10px] uppercase font-semibold">{t('admin:logs.colSource')}</div>
              <div className="mt-1 font-mono font-medium">{log.source}</div>
            </div>
            <div className="rounded-lg border p-2.5 bg-muted/10">
              <div className="flex items-center justify-between text-muted-foreground text-[10px] uppercase font-semibold">
                <span>{t('admin:logs.moduleTitle')}</span>
                {onFilterByModule && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      onFilterByModule(log.module);
                      onOpenChange(false);
                    }}
                    className="h-4 px-1 text-[10px] text-primary hover:text-primary gap-0.5"
                  >
                    <ExternalLink className="size-2.5" />
                    {t('admin:logs.filterModule')}
                  </Button>
                )}
              </div>
              <div className="mt-1 font-mono font-medium">{log.module}</div>
            </div>
            {log.node && (
              <div className="rounded-lg border p-2.5 bg-muted/10">
                <div className="flex items-center justify-between text-muted-foreground text-[10px] uppercase font-semibold">
                  <span>{t('admin:logs.relatedNode')}</span>
                  {onFilterByNodeId && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        onFilterByNodeId(log.node!.id);
                        onOpenChange(false);
                      }}
                      className="h-4 px-1 text-[10px] text-primary hover:text-primary gap-0.5"
                    >
                      <ExternalLink className="size-2.5" />
                      {t('admin:logs.filterThisNode')}
                    </Button>
                  )}
                </div>
                <div className="mt-1 font-mono font-medium">{log.node.name} ({log.node.serverHost})</div>
              </div>
            )}
            {log.user && (
              <div className="rounded-lg border p-2.5 bg-muted/10">
                <div className="text-muted-foreground text-[10px] uppercase font-semibold">{t('admin:logs.relatedUser')}</div>
                <div className="mt-1 font-mono font-medium">{log.user.email}</div>
              </div>
            )}
          </div>

          {/* 日志消息核心正文 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground font-semibold text-[11px] uppercase tracking-wider">{t('admin:logs.logDesc')}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => copyText(log.message, 'msg', t('admin:logs.logDesc'))}
                className="h-6 px-2 text-[10px] gap-1"
              >
                {copiedKey === 'msg' ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
                {t('common:actions.copy')}
              </Button>
            </div>
            <div className="rounded-lg border bg-muted/30 p-3 font-mono text-xs select-text whitespace-pre-wrap break-all leading-relaxed">
              {log.message}
            </div>
          </div>

          {/* 错误堆栈（如果存在） */}
          {stackTrace && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-destructive">
                <div className="flex items-center gap-1">
                  <AlertCircle className="size-3.5" />
                  <span className="font-semibold text-[11px] uppercase tracking-wider">{t('admin:logs.stackTraceTitle')}</span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => copyText(stackTrace, 'stack', t('admin:logs.copyStack'))}
                  className="h-6 px-2 text-[10px] gap-1 text-destructive hover:bg-destructive/10"
                >
                  {copiedKey === 'stack' ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
                  {t('admin:logs.copyStack')}
                </Button>
              </div>
              <pre className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 font-mono text-[11px] text-destructive select-text overflow-x-auto leading-relaxed">
                {stackTrace}
              </pre>
            </div>
          )}

          {/* 结构化元数据 JSON */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground font-semibold text-[11px] uppercase tracking-wider">{t('admin:logs.metadataTitle')}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => copyText(JSON.stringify(parsedMetadata, null, 2), 'meta', 'JSON')}
                className="h-6 px-2 text-[10px] gap-1"
              >
                {copiedKey === 'meta' ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
                {t('admin:logs.copyJson')}
              </Button>
            </div>
            <pre className="rounded-lg border bg-muted/40 p-3 font-mono text-[11px] select-text overflow-x-auto leading-relaxed">
              {parseError ? log.metadata : JSON.stringify(parsedMetadata, null, 2)}
            </pre>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
