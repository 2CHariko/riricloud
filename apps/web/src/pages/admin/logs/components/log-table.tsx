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
import { formatLogTime } from '../log-presentation';
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
    nodes.push(<mark key={idx} className="rounded bg-amber-500/25 px-0.5 font-bold text-amber-900 dark:text-amber-200">{text.slice(idx, idx + kw.length)}</mark>);
    start = idx + kw.length;
    idx = lower.indexOf(kw.toLowerCase(), start);
  }
  nodes.push(text.slice(start));
  return nodes;
}

const SOURCE_ICONS = { SERVER: Server, WEB: Laptop, AGENT: HardDrive, SINGBOX: Terminal };
const LEVEL_COLORS = {
  ERROR: 'bg-destructive/10 text-destructive border-destructive/30',
  WARN: 'bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400',
  INFO: 'bg-blue-500/15 text-blue-600 border-blue-500/30 dark:text-blue-400',
  DEBUG: 'bg-slate-500/15 text-slate-600 border-slate-500/30 dark:text-slate-400'
};

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
    <div className="min-w-0 space-y-2">
      <Card className="min-w-0 overflow-hidden">
        <CardContent className="min-w-0 p-0">
          <Table className="min-w-[900px] table-fixed text-left text-xs font-mono [&_td]:px-2 [&_td]:py-2 [&_th]:h-9 [&_th]:px-2">
            <TableHeader><TableRow>
              <TableHead className="w-40 !pl-4">{t('admin:logs.colTime')}</TableHead>
              <TableHead className="w-20">{t('admin:logs.colLevel')}</TableHead>
              <TableHead className="w-[90px]">{t('admin:logs.colSource')}</TableHead>
              <TableHead className="w-[140px]">{t('admin:logs.colModule')}</TableHead>
              <TableHead>{t('admin:logs.colMessage')}</TableHead>
              <TableHead className="w-[140px] !pr-4 text-right">{t('admin:logs.colTrace')}</TableHead>
            </TableRow></TableHeader>
            <TableBody>{logs.map((log) => {
              const SourceIcon = SOURCE_ICONS[log.source];
              const metadata = parseLogMetadata(log.metadata);
              const repeatCount = typeof metadata.repeatCount === 'number' && Number.isFinite(metadata.repeatCount) ? Math.floor(metadata.repeatCount) : 1;
              return (
                <TableRow key={log.id} onClick={() => onSelectLog(log)} className="h-10 cursor-pointer">
                  <TableCell className="!pl-4 whitespace-nowrap text-[11px] text-muted-foreground" title={formatDateTime(log.createdAt)}>
                    {formatLogTime(log.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn('h-5 whitespace-nowrap rounded-md px-1.5 py-0 text-[10px] font-bold', LEVEL_COLORS[log.level])}>{log.level}</Badge>
                  </TableCell>
                  <TableCell><span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-muted-foreground"><SourceIcon className="size-3.5" />{log.source}</span></TableCell>
                  <TableCell>
                    <Button variant="link" size="sm" className="h-5 w-full min-w-0 justify-start p-0 font-mono text-[11px] font-semibold text-foreground/80"
                      title={t('admin:logs.filterByModuleTitle', { module: log.module })}
                      onClick={(event) => { event.stopPropagation(); onFilterByModule?.(log.module); }}>
                      <span className="truncate">[{log.module}]</span>
                    </Button>
                  </TableCell>
                  <TableCell>
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate select-text" title={log.message}>{highlightKeyword(log.message, keyword)}</span>
                      {repeatCount > 1 && <Badge variant="secondary" className="h-5 shrink-0 px-1 py-0 text-[10px]" title={t('admin:logs.repeatCountTitle', { count: repeatCount })}>x{repeatCount}</Badge>}
                      {log.node && <Button variant="outline" size="sm" className="h-5 max-w-32 shrink-0 px-1 py-0 font-mono text-[10px] shadow-none"
                        title={t('admin:logs.filterByNodeTitle', { name: log.node.name })}
                        onClick={(event) => { event.stopPropagation(); onFilterByNodeId?.(log.node!.id); }}><span className="truncate">{log.node.name}</span></Button>}
                    </div>
                  </TableCell>
                  <TableCell className="!pr-4 text-right">
                    {log.traceId ? <Button variant="ghost" size="sm" className="h-5 gap-1 bg-muted/60 px-1.5 py-0 font-mono text-[10px] text-muted-foreground"
                      title={t('admin:logs.filterByTraceTitle', { traceId: log.traceId })}
                      onClick={(event) => { event.stopPropagation(); onFilterByTraceId?.(log.traceId!); }}>
                      {log.traceId.slice(0, 8)}…<ExternalLink className="!size-2.5 opacity-70" />
                    </Button> : <span className="text-muted-foreground/40">—</span>}
                  </TableCell>
                </TableRow>
              );
            })}</TableBody>
          </Table>
        </CardContent>
      </Card>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <p>{t('admin:logs.totalRecords', { count: total })}{totalPages > 1 && <span className="ml-1">{t('admin:logs.pageNumber', { current: page, total: totalPages })}</span>}</p>
        <div className="flex gap-1">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}><ChevronLeft className="size-3.5" />{t('common:table.previous')}</Button>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>{t('common:table.next')}<ChevronRight className="size-3.5" /></Button>
        </div>
      </div>
    </div>
  );
}
