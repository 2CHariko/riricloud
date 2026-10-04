import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, ExternalLink, HardDrive, Laptop, Server, Terminal } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn, formatDateTime } from '@/lib/utils';
import { parseLogMetadata } from '@/lib/log-contract';
import { LogCorrelation } from '@/components/shared/log-correlation';
import type { SystemLogItem } from '../types';

interface LogTableProps {
  logs: SystemLogItem[];
  isLoading: boolean;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  onPageChange: (newPage: number) => void;
  onSelectLog: (log: SystemLogItem) => void;
  onFilterByTraceId?: (traceId: string) => void;
  onFilterByNodeId?: (nodeId: string) => void;
  onFilterByModule?: (module: string) => void;
  keyword?: string;
}

function highlightKeyword(text: string, keyword?: string): React.ReactNode {
  const kw = keyword?.trim();
  if (!kw) return text;
  const nodes: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  let start = 0;
  let idx = lower.indexOf(kw.toLowerCase());
  while (idx !== -1) {
    nodes.push(text.slice(start, idx));
    nodes.push(<mark key={idx} className="rounded bg-warning/20 px-0.5 font-bold">{text.slice(idx, idx + kw.length)}</mark>);
    start = idx + kw.length;
    idx = lower.indexOf(kw.toLowerCase(), start);
  }
  nodes.push(text.slice(start));
  return nodes;
}

const SOURCE_ICONS = { SERVER: Server, WEB: Laptop, AGENT: HardDrive, SINGBOX: Terminal };

export function LogTable({ logs, isLoading, total, page, totalPages, onPageChange, onSelectLog, onFilterByTraceId, onFilterByNodeId, onFilterByModule, keyword }: LogTableProps) {
  const { t } = useTranslation(['admin', 'common']);
  if (isLoading && !logs.length) return <div className="space-y-2">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div>;
  if (!logs.length) return (
    <Card><CardContent className="flex h-64 flex-col items-center justify-center text-center">
      <Terminal className="mb-2 size-8 text-muted-foreground" />
      <p>{t('admin:logs.emptySearchTitle')}</p><p className="text-xs text-muted-foreground">{t('admin:logs.emptySearchDesc')}</p>
    </CardContent></Card>
  );
  return (
    <Card className="min-w-0 overflow-hidden">
      <CardContent className="min-w-0 p-0">
        <Table className="min-w-[800px] text-xs font-mono">
          <TableHeader><TableRow>
            {(['colTime', 'colLevel', 'colSource', 'colModule', 'colMessage', 'colTrace'] as const).map((key) => <TableHead key={key}>{t(`admin:logs.${key}`)}</TableHead>)}
          </TableRow></TableHeader>
          <TableBody>{logs.map((log) => {
            const SourceIcon = SOURCE_ICONS[log.source];
            const metadata = parseLogMetadata(log.metadata);
            const repeatCount = typeof metadata.repeatCount === 'number' ? metadata.repeatCount : 1;
            return (
              <TableRow key={log.id} onClick={() => onSelectLog(log)} className="cursor-pointer">
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {formatDateTime(log.createdAt)}
                  <LogCorrelation log={log} compact />
                </TableCell>
                <TableCell><Badge variant={log.level === 'ERROR' ? 'destructive' : 'outline'} className={cn('text-[10px]', log.level === 'WARN' && 'text-warning')}>{log.level}</Badge></TableCell>
                <TableCell><span className="inline-flex items-center gap-1"><SourceIcon className="size-3.5" />{log.source}</span></TableCell>
                <TableCell>
                  <Button variant="ghost" size="sm" className="max-w-32 truncate px-1 text-xs" title={t('admin:logs.filterByModuleTitle', { module: log.module })} onClick={(event) => { event.stopPropagation(); onFilterByModule?.(log.module); }}>[{log.module}]</Button>
                </TableCell>
                <TableCell>
                  <div className="flex max-w-xl items-center gap-2">
                    <Button variant="ghost" size="sm" className="min-w-0 justify-start truncate px-1 font-mono text-xs" title={log.message} onClick={(event) => { event.stopPropagation(); onSelectLog(log); }}>
                      <span className="truncate">{highlightKeyword(log.message, keyword)}</span>
                    </Button>
                    {repeatCount > 1 && <Badge variant="secondary" title={t('admin:logs.repeatCountTitle', { count: repeatCount })}>x{repeatCount}</Badge>}
                    {log.node && <Button variant="outline" size="sm" className="h-6 shrink-0 px-1 text-[10px]" title={t('admin:logs.filterByNodeTitle', { name: log.node.name })} onClick={(event) => { event.stopPropagation(); onFilterByNodeId?.(log.node!.id); }}>{log.node.name}</Button>}
                  </div>
                </TableCell>
                <TableCell>
                  {log.traceId ? <Button variant="ghost" size="sm" className="h-6 px-1 text-xs" title={t('admin:logs.filterByTraceTitle', { traceId: log.traceId })} onClick={(event) => { event.stopPropagation(); onFilterByTraceId?.(log.traceId!); }}>{log.traceId.slice(0, 8)}…<ExternalLink className="size-3" /></Button> : '—'}
                </TableCell>
              </TableRow>
            );
          })}</TableBody>
        </Table>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-xs text-muted-foreground">
          <p>{t('admin:logs.totalRecords', { count: total })} {t('admin:logs.pageNumber', { current: page, total: totalPages })}</p>
          <div className="flex gap-1">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}><ChevronLeft className="size-3.5" />{t('common:table.previous')}</Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>{t('common:table.next')}<ChevronRight className="size-3.5" /></Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
