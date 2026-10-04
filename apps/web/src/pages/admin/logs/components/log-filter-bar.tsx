import { useTranslation } from 'react-i18next';
import { Download, Radio, RefreshCw, RotateCcw, Search, Trash2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type { LogExportFormat, LogLevel, LogsFilter, LogSource } from '../types';

interface LogFilterBarProps {
  filter: LogsFilter;
  onChange: (patch: Partial<LogsFilter>) => void;
  onRefresh: () => void;
  onReset?: () => void;
  onOpenCleanup: () => void;
  onExport: (format: LogExportFormat) => void;
  isExporting?: boolean;
  isLiveTail: boolean;
  onToggleLiveTail: () => void;
  nodes?: Array<{ id: string; name: string }>;
  isRefreshing: boolean;
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  ALL: 'data-[state=active]:bg-muted data-[state=active]:text-foreground',
  ERROR: 'data-[state=active]:bg-rose-500 data-[state=active]:text-white',
  WARN: 'data-[state=active]:bg-amber-500 data-[state=active]:text-white',
  INFO: 'data-[state=active]:bg-blue-500 data-[state=active]:text-white',
  DEBUG: 'data-[state=active]:bg-slate-500 data-[state=active]:text-white'
};

export function LogFilterBar({
  filter,
  onChange,
  onRefresh,
  onReset,
  onOpenCleanup,
  onExport,
  isExporting,
  isLiveTail,
  onToggleLiveTail,
  nodes,
  isRefreshing
}: LogFilterBarProps) {
  const { t } = useTranslation(['admin', 'common']);
  const isFiltered =
    filter.level !== 'ALL' ||
    filter.source !== 'ALL' ||
    (Boolean(filter.nodeId) && filter.nodeId !== 'ALL') ||
    Boolean(filter.module) ||
    Boolean(filter.traceId) ||
    Boolean(filter.keyword) ||
    Boolean(filter.startTime || filter.endTime) || filter.timeRange !== '24h';

  return (
    <div className="flex flex-col gap-2.5">
      {/* 顶部一排：快速时间范围、级别 Pills、右侧控制动作 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* 时间范围 */}
          <Tabs
            value={filter.timeRange}
            onValueChange={(val) => onChange({ timeRange: val as LogsFilter['timeRange'], startTime: undefined, endTime: undefined, page: 1 })}
          >
            <TabsList className="h-8 p-0.5">
              <TabsTrigger value="15m" className="h-7 text-xs px-2.5">{t('admin:logs.filter15m')}</TabsTrigger>
              <TabsTrigger value="1h" className="h-7 text-xs px-2.5">{t('admin:logs.filter1h')}</TabsTrigger>
              <TabsTrigger value="24h" className="h-7 text-xs px-2.5">{t('admin:logs.filter24h')}</TabsTrigger>
              <TabsTrigger value="7d" className="h-7 text-xs px-2.5">{t('admin:logs.filter7d')}</TabsTrigger>
              <TabsTrigger value="all" className="h-7 text-xs px-2.5">{t('admin:logs.filterAll')}</TabsTrigger>
            </TabsList>
          </Tabs>

          {/* 日志级别 Pills */}
          <Tabs
            value={filter.level}
            onValueChange={(val) => onChange({ level: val as LogLevel, page: 1 })}
          >
            <TabsList className="h-8 p-0.5">
              {(['ALL', 'ERROR', 'WARN', 'INFO', 'DEBUG'] as LogLevel[]).map((lvl) => (
                <TabsTrigger
                  key={lvl}
                  value={lvl}
                  className={cn('h-7 text-xs px-2.5 font-mono font-medium', LEVEL_COLORS[lvl])}
                >
                  {lvl}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {/* 右侧主操作区 */}
        <div className="flex flex-wrap items-center gap-1.5 ml-auto">
          {/* 重置全部筛选条件 */}
          {isFiltered && onReset && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onReset}
              className="h-8 gap-1 text-xs text-muted-foreground hover:text-foreground"
              title={t('admin:logs.resetFiltersTitle')}
            >
              <RotateCcw className="size-3" />
              <span>{t('admin:logs.reset')}</span>
            </Button>
          )}

          {/* Live Tail 实时推流开关 */}
          <Button
            type="button"
            variant={isLiveTail ? 'default' : 'outline'}
            size="sm"
            onClick={onToggleLiveTail}
            className={cn('h-8 gap-1.5 text-xs', isLiveTail && 'bg-emerald-600 hover:bg-emerald-700 text-white')}
          >
            <Radio className={cn('size-3.5', isLiveTail && 'animate-pulse text-white')} />
            {isLiveTail ? t('admin:logs.liveTailing') : t('admin:logs.liveTailStream')}
          </Button>

          {/* 刷新 */}
          <IconButton
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={onRefresh}
            disabled={isRefreshing}
            aria-label={t('admin:logs.refreshTitle')}
          >
            <RefreshCw className={cn('size-4', isRefreshing && 'animate-spin')} />
          </IconButton>

          {/* 导出下拉 */}
          <Select value="" disabled={isExporting} onValueChange={(val) => onExport(val as LogExportFormat)}>
            <SelectTrigger className="h-8 w-24 text-xs gap-1">
              <Download className="size-3.5" />
              <span>{t('admin:logs.export')}</span>
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="json">{t('admin:logs.exportJson')}</SelectItem>
              <SelectItem value="csv">{t('admin:logs.exportCsv')}</SelectItem>
              <SelectItem value="bundle">{t('admin:logs.exportBundle')}</SelectItem>
            </SelectContent>
          </Select>

          {/* 清理对话框 */}
          <IconButton
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onOpenCleanup}
            className="text-destructive hover:bg-destructive/10"
            aria-label={t('admin:logs.cleanupTitle')}
          >
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      </div>

      {/* 底部一排：来源端、节点、TraceId、关键词过滤 */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-4 xl:grid-cols-5">
        {/* 来源端 */}
        <Select
          value={filter.source}
          onValueChange={(val) => onChange({ source: val as LogSource, page: 1 })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder={t('admin:logs.filterSource')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t('admin:logs.allSources')}</SelectItem>
            <SelectItem value="SERVER">{t('admin:logs.sourceServer')}</SelectItem>
            <SelectItem value="WEB">{t('admin:logs.sourceWeb')}</SelectItem>
            <SelectItem value="AGENT">{t('admin:logs.sourceAgent')}</SelectItem>
            <SelectItem value="SINGBOX">{t('admin:logs.sourceSingbox')}</SelectItem>
          </SelectContent>
        </Select>

        {/* 关联节点 */}
        <Select
          value={filter.nodeId}
          onValueChange={(val) => onChange({ nodeId: val, page: 1 })}
        >
          <SelectTrigger className="h-8 text-xs truncate">
            <SelectValue placeholder={t('admin:logs.filterNodePlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t('admin:logs.allNodes')}</SelectItem>
            {nodes?.map((n) => (
              <SelectItem key={n.id} value={n.id}>
                {n.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input aria-label={t('admin:logs.moduleTitle')} placeholder={t('admin:logs.moduleTitle')} value={filter.module} onChange={(e) => onChange({ module: e.target.value, page: 1 })} className="h-8 text-xs" />

        {/* TraceId 精确检索 */}
        <div className="relative">
          <Input
            placeholder={t('admin:logs.traceIdPlaceholder')}
            value={filter.traceId}
            onChange={(e) => onChange({ traceId: e.target.value, page: 1 })}
            className="h-8 pr-10 text-xs font-mono"
          />
          {filter.traceId && (
            <IconButton
              type="button"
              variant="ghost"
              size="icon-xs"
              className="absolute right-1 top-1/2 -translate-y-1/2"
              aria-label={t('common:actions.clear')}
              onClick={() => onChange({ traceId: '', page: 1 })}
            >
              <X className="size-4" />
            </IconButton>
          )}
        </div>

        {/* 关键词模糊搜索 */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t('admin:logs.keywordPlaceholder')}
            value={filter.keyword}
            onChange={(e) => onChange({ keyword: e.target.value, page: 1 })}
            className="h-8 pl-8 pr-10 text-xs"
          />
          {filter.keyword && (
            <IconButton
              type="button"
              variant="ghost"
              size="icon-xs"
              className="absolute right-1 top-1/2 -translate-y-1/2"
              aria-label={t('common:actions.clear')}
              onClick={() => onChange({ keyword: '', page: 1 })}
            >
              <X className="size-4" />
            </IconButton>
          )}
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {(['startTime', 'endTime'] as const).map((key) => (
          <Label key={key} className="space-y-1 text-xs text-muted-foreground">
            <span>{t(`admin:logs.${key}`)}</span>
            <Input type="datetime-local" aria-label={t(`admin:logs.${key}`)}
              value={filter[key] ? new Date(new Date(filter[key]!).getTime() - new Date(filter[key]!).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}
              onChange={(event) => onChange({ [key]: event.target.value ? new Date(event.target.value).toISOString() : undefined, timeRange: 'all', page: 1 })} />
          </Label>
        ))}
      </div>

      {/* 活跃的快速过滤徽标（模块等） */}
      {filter.module && (
        <div className="flex items-center gap-2 pt-1 border-t border-border/40">
          <span className="text-[11px] text-muted-foreground">{t('admin:logs.filteringModule')}</span>
          <Badge variant="secondary" className="min-h-7 gap-1 py-0.5 pl-2 pr-0.5 font-mono text-[11px]">
            <span>[{filter.module}]</span>
            <IconButton
              type="button"
              variant="ghost"
              size="icon-xs"
              className="ml-0.5"
              aria-label={t('admin:logs.clearModuleFilter')}
              onClick={() => onChange({ module: '', page: 1 })}
            >
              <X className="size-4" />
            </IconButton>
          </Badge>
        </div>
      )}
    </div>
  );
}
