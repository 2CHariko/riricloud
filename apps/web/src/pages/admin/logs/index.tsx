import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { PageContainer, PageHeader } from '@/components/shared/page-container';
import { api } from '@/lib/api';
import { TelemetryCleanupDialog } from '@/components/shared/telemetry-cleanup-dialog';
import { LogDetailDrawer } from './components/log-detail-drawer';
import { LogFilterBar } from './components/log-filter-bar';
import { LogLiveTailBar } from './components/log-live-tail-bar';
import { LogMetricsCards } from './components/log-metrics-cards';
import { LogTable } from './components/log-table';
import { LogTrendChart } from './components/log-trend-chart';
import type { LogsFilter, SystemLogItem } from './types';
import { useLiveTailStream, useLogs } from './use-logs';
import { DiagnosticsSnapshotCard } from '@/components/shared/diagnostics-snapshot-card';
import { LogIngestionCard } from './components/log-ingestion-card';
import type { SnapshotNode } from './types';

const DEFAULT_FILTER: LogsFilter = {
  level: 'ALL',
  source: 'ALL',
  nodeId: 'ALL',
  module: '',
  traceId: '',
  keyword: '',
  timeRange: '24h',
  page: 1,
  pageSize: 50
};

export default function AdminLogsPage() {
  const { t } = useTranslation(['admin', 'common']);
  const [searchParams] = useSearchParams();
  const initialNodeId = searchParams.get('nodeId') || 'ALL';
  const initialModule = searchParams.get('module') || '';
  const initialLive = searchParams.get('live') === 'true';

  const [filter, setFilter] = React.useState<LogsFilter>(() => ({
    ...DEFAULT_FILTER,
    nodeId: initialNodeId,
    module: initialModule
  }));
  const [selectedLog, setSelectedLog] = React.useState<SystemLogItem | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = React.useState(false);
  const [isCleanupOpen, setIsCleanupOpen] = React.useState(false);

  // Live Tail 实时推流状态
  const [isLiveTail, setIsLiveTail] = React.useState(initialLive);
  const [isPaused, setIsPaused] = React.useState(false);
  const [autoScroll, setAutoScroll] = React.useState(true);
  const [liveTailBuffer, setLiveTailBuffer] = React.useState<SystemLogItem[]>([]);

  React.useEffect(() => {
    const qNodeId = searchParams.get('nodeId');
    const qModule = searchParams.get('module');
    const qLive = searchParams.get('live');
    if (qNodeId || qModule) {
      setLiveTailBuffer([]);
      setFilter((prev) => ({
        ...prev,
        ...(qNodeId ? { nodeId: qNodeId } : {}),
        ...(qModule ? { module: qModule } : {}),
        page: 1
      }));
    }
    if (qLive === 'true') {
      setIsLiveTail(true);
    }
  }, [searchParams]);

  const { logsQuery, metricsQuery, exportLogs, isExporting } = useLogs(filter);

  // 获取节点列表供筛选
  const nodesQuery = useQuery({
    queryKey: ['admin-logs-nodes'],
    queryFn: async ({ signal }) => {
      const res = await api.get<Array<SnapshotNode & { name: string }>>('/admin/nodes', { signal });
      return res.data;
    },
    refetchInterval: 15_000,
    staleTime: 10_000
  });
  // 处理实时日志帧
  const handleNewLiveLog = React.useCallback(
    (item: SystemLogItem) => {
      if (isPaused) return;
      setLiveTailBuffer((prev) => [item, ...prev].slice(0, 500));
    },
    [isPaused]
  );

  const { isConnected } = useLiveTailStream(isLiveTail, filter, handleNewLiveLog);

  const handleFilterChange = (patch: Partial<LogsFilter>) => {
    setFilter((prev) => ({ ...prev, ...patch }));
    setLiveTailBuffer([]);
  };

  const handleSelectLog = (log: SystemLogItem) => {
    setSelectedLog(log);
    setIsDrawerOpen(true);
  };

  const handleFilterByTraceId = (traceId: string) => {
    handleFilterChange({ traceId, page: 1 });
  };

  const handleFilterByNodeId = (nodeId: string) => {
    handleFilterChange({ nodeId, page: 1 });
  };

  const handleFilterByModule = (module: string) => {
    handleFilterChange({ module, page: 1 });
  };

  const handleResetFilter = () => {
    setFilter(DEFAULT_FILTER);
    setLiveTailBuffer([]);
  };

  // 显示数据：推流模式下展示推流缓冲区，否则展示分页数据
  const displayLogs = isLiveTail ? liveTailBuffer : (logsQuery.data?.items ?? []);
  const totalCount = isLiveTail ? liveTailBuffer.length : (logsQuery.data?.total ?? 0);
  const totalPages = isLiveTail ? 1 : (logsQuery.data?.totalPages ?? 1);

  return (
    <PageContainer>
      <PageHeader
        title={t('admin:logs.title')}
        description={t('admin:logs.subtitle')}
      />

      <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-xs text-muted-foreground">
        {t('admin:logs.infoBanner')}
      </div>

      {/* 顶部指标卡 */}
      <LogMetricsCards
        metrics={metricsQuery.data}
        hours={filter.timeRange === '7d' ? 168 : filter.timeRange === '15m' || filter.timeRange === '1h' ? 1 : 24}
        isLoading={metricsQuery.isPending}
      />

      {/* 24 小时分级趋势图 */}
      <LogTrendChart
        trend={metricsQuery.data?.trend}
        isLoading={metricsQuery.isPending}
        sampled={metricsQuery.data?.sampled}
        sampleLimit={metricsQuery.data?.sampleLimit}
      />
      <LogIngestionCard ingestion={metricsQuery.data?.ingestion} />

      {/* 过滤控制栏 */}
      <LogFilterBar
        filter={filter}
        onChange={handleFilterChange}
        onRefresh={() => void logsQuery.refetch()}
        onReset={handleResetFilter}
        onOpenCleanup={() => setIsCleanupOpen(true)}
        onExport={exportLogs}
        isExporting={isExporting}
        isLiveTail={isLiveTail}
        onToggleLiveTail={() => {
          setIsLiveTail((prev) => !prev);
          if (!isLiveTail) {
            setLiveTailBuffer([]);
          }
        }}
        nodes={nodesQuery.data}
        isRefreshing={logsQuery.isFetching}
      />
      <DiagnosticsSnapshotCard key={filter.nodeId} node={nodesQuery.data?.find((node) => node.id === filter.nodeId)} />

      {/* Live Tail 运行状态条 */}
      {isLiveTail && (
        <LogLiveTailBar
          isConnected={isConnected}
          isPaused={isPaused}
          onTogglePause={() => setIsPaused((prev) => !prev)}
          autoScroll={autoScroll}
          onToggleAutoScroll={setAutoScroll}
          streamCount={liveTailBuffer.length}
          onClearStream={() => setLiveTailBuffer([])}
        />
      )}

      {/* 日志高密度列表 */}
      <LogTable
        logs={displayLogs}
        isLoading={logsQuery.isPending && !isLiveTail}
        total={totalCount}
        page={filter.page}
        pageSize={filter.pageSize}
        totalPages={totalPages}
        onPageChange={(page) => handleFilterChange({ page })}
        onSelectLog={handleSelectLog}
        onFilterByTraceId={handleFilterByTraceId}
        onFilterByNodeId={handleFilterByNodeId}
        onFilterByModule={handleFilterByModule}
        keyword={filter.keyword}
      />

      {/* 日志详情侧滑抽屉 */}
      <LogDetailDrawer
        log={selectedLog}
        open={isDrawerOpen}
        onOpenChange={setIsDrawerOpen}
        onFilterByTraceId={handleFilterByTraceId}
        onFilterByNodeId={handleFilterByNodeId}
        onFilterByModule={handleFilterByModule}
      />

      {/* 日志清理确认模态框 */}
      <TelemetryCleanupDialog open={isCleanupOpen} onOpenChange={setIsCleanupOpen} />
    </PageContainer>
  );
}
