import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, extractErrorMessage } from '@/lib/api';
import i18n from '@/i18n/config';
import { useAuthStore } from '@/stores/auth';
import { logFilterParams, metricsHours } from '@/lib/log-contract';
import type { LogBundle, LogExportFormat, LogMetrics, LogsFilter, LogsQueryResult, SystemLogItem } from './types';

export function useLogs(filter: LogsFilter) {
  const queryClient = useQueryClient();
  const { page, pageSize, ...metricFilter } = filter;
  const logsQuery = useQuery({
    queryKey: ['admin-logs', filter],
    queryFn: async ({ signal }) => (await api.get<LogsQueryResult>('/logs', {
      params: { ...logFilterParams(filter), page, pageSize }, signal
    })).data
  });
  const metricsQuery = useQuery({
    queryKey: ['admin-logs-metrics', metricFilter],
    queryFn: async ({ signal }) => (await api.get<LogMetrics>('/logs/metrics', {
      params: { ...logFilterParams(filter), hours: metricsHours(filter) }, signal
    })).data,
    refetchInterval: 30_000
  });
  const cleanMutation = useMutation({
    mutationFn: async (params: { retentionDays?: number; maxRecords?: number }) =>
      (await api.delete<{ deletedCount: number }>('/logs', { params })).data,
    onSuccess: (data) => {
      toast.success(i18n.t('admin:logs.cleanSuccess', { count: data.deletedCount }));
      void queryClient.invalidateQueries({ queryKey: ['admin-logs'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-logs-metrics'] });
    },
    onError: (err) => toast.error(extractErrorMessage(err, i18n.t('admin:logs.cleanFailed')))
  });
  const exportMutation = useMutation({
    mutationFn: async (format: LogExportFormat) => {
      const res = await api.get<Blob>('/logs/export', {
        params: { ...logFilterParams(filter), format }, responseType: 'blob'
      });
      let truncated = String(res.headers['x-logs-truncated']).toLowerCase() === 'true';
      let pending = false;
      if (format === 'bundle') {
        const bundle = JSON.parse(await res.data.text()) as LogBundle;
        const manifest = bundle.manifest;
        truncated ||= manifest.truncated;
        pending = (manifest.ingestion?.pendingEntries ?? 0) > 0 || (manifest.ingestion?.pendingBytes ?? 0) > 0;
        if (typeof manifest.pending === 'number') pending ||= manifest.pending > 0;
        else if (manifest.pending) pending ||= Object.values(manifest.pending).some((value) => typeof value === 'number' && value > 0);
      }
      const url = window.URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `riricloud-logs-${format}-${new Date().toISOString().slice(0, 10)}.${format === 'csv' ? 'csv' : 'json'}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      toast.success(i18n.t('admin:logs.exportSuccess'));
      if (truncated) toast.warning(i18n.t('admin:logs.exportTruncated'));
      if (pending) toast.warning(i18n.t('admin:logs.exportPending'));
      if (format === 'bundle') toast.info(i18n.t('admin:logs.exportScope'));
    },
    onError: (err) => toast.error(extractErrorMessage(err, i18n.t('admin:logs.exportFailed')))
  });
  return { logsQuery, metricsQuery, cleanMutation, exportLogs: exportMutation.mutate, isExporting: exportMutation.isPending };
}

export function useLiveTailStream(enabled: boolean, filter: LogsFilter, onNewLog: (item: SystemLogItem) => void) {
  const user = useAuthStore((s) => s.user);
  const [isConnected, setIsConnected] = React.useState(false);
  const callback = React.useRef(onNewLog);
  callback.current = onNewLog;
  const filterKey = JSON.stringify({ ...filter, page: undefined, pageSize: undefined });
  React.useEffect(() => {
    setIsConnected(false);
    if (!enabled || !user) return;
    const streamFilter = JSON.parse(filterKey) as LogsFilter;
    let eventSource: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let attempts = 0;
    const controller = new AbortController();
    const retry = () => {
      if (cancelled) return;
      eventSource?.close();
      if (eventSource) eventSource.onerror = eventSource.onopen = eventSource.onmessage = null;
      clearTimeout(retryTimer);
      setIsConnected(false);
      if (cancelled || attempts >= 5) return;
      retryTimer = setTimeout(() => { void connect(); }, Math.min(10_000, 500 * 2 ** attempts++));
    };
    const connect = async () => {
      try {
        // 每次重连都消费新票据，禁用 EventSource 对旧票据的自动重连。
        const { data } = await api.post<{ ticket: string }>('/logs/stream-ticket', undefined, { signal: controller.signal });
        if (cancelled) return;
        const query = new URLSearchParams({ ...logFilterParams(streamFilter), ticket: data.ticket });
        eventSource = new EventSource(`/api/v1/logs/stream?${query}`, { withCredentials: true });
        eventSource.onopen = () => { if (!cancelled) setIsConnected(true); };
        eventSource.onmessage = (event) => {
          if (cancelled) return;
          try { callback.current(JSON.parse(event.data) as SystemLogItem); }
          catch { /* 无效帧不影响连接 */ }
        };
        eventSource.onerror = retry;
      } catch { if (!cancelled) retry(); }
    };
    void connect();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(retryTimer);
      eventSource?.close();
    };
  }, [enabled, user, filterKey]);
  return { isConnected };
}
