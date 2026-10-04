import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { matchesSnapshot } from '@/lib/log-contract';
import type { DiagnosticsReceipt, LogsQueryResult } from '@/lib/log-types';

type Observation = { receipt: DiagnosticsReceipt; deadline: number; controller: AbortController };

export function useDiagnosticsSnapshot(nodeId: string) {
  const queryClient = useQueryClient();
  const [expired, setExpired] = React.useState(false);
  const [session, setSession] = React.useState<Observation>();
  const requestController = React.useRef<AbortController>();
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestController.current?.abort(); };
  }, [nodeId]);
  const request = useMutation({
    mutationFn: async () => (await api.post<DiagnosticsReceipt>(`/admin/nodes/${nodeId}/diagnostics-snapshot`, undefined, {
      signal: requestController.current?.signal
    })).data,
    onMutate: () => {
      requestController.current?.abort();
      requestController.current = new AbortController();
      session?.controller.abort();
      setSession(undefined);
      setExpired(false);
    },
    onSuccess: (receipt) => {
      if (!mounted.current || receipt.nodeId !== nodeId) return;
      setSession({ receipt, deadline: Date.now() + 30_000, controller: new AbortController() });
      void queryClient.invalidateQueries({ queryKey: ['admin-logs'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-logs-metrics'] });
    }
  });
  const observation = session?.receipt.nodeId === nodeId ? session : undefined;
  const receipt = observation?.receipt;
  const result = useQuery({
    queryKey: ['admin-diagnostics-snapshot', nodeId, receipt?.taskId],
    enabled: !!receipt?.requested && !expired && !request.isPending,
    queryFn: async ({ signal }) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const observer = observation!.controller.signal;
      signal.addEventListener('abort', abort, { once: true });
      observer.addEventListener('abort', abort, { once: true });
      if (signal.aborted || observer.aborted) controller.abort();
      try {
        const { data } = await api.get<LogsQueryResult>('/logs', {
          params: { nodeId, source: 'AGENT', module: 'NodeDiagnostics', keyword: receipt!.taskId, page: 1, pageSize: 50 },
          signal: controller.signal, timeout: Math.max(1, Math.min(4000, observation!.deadline - Date.now()))
        });
        return data.items.find((log) => matchesSnapshot(log, nodeId, receipt!.taskId)) ?? null;
      } finally {
        signal.removeEventListener('abort', abort);
        observer.removeEventListener('abort', abort);
      }
    },
    retry: false,
    refetchInterval: (query) => !expired && !query.state.data && !query.state.error ? 1500 : false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  });
  React.useEffect(() => {
    if (!observation?.receipt.requested) return;
    // 清理捕获本轮 controller，不能误取消下一次任务的观察。
    const { controller, deadline } = observation;
    const timer = setTimeout(() => { setExpired(true); controller.abort(); }, Math.max(0, deadline - Date.now()));
    return () => { clearTimeout(timer); controller.abort(); };
  }, [observation]);
  const status: 'idle' | 'requesting' | 'waiting' | 'received' | 'timeout' | 'failed' = request.isPending ? 'requesting' : request.isError || receipt?.requested === false ? 'failed'
    : result.data ? 'received' : expired ? 'timeout' : result.isError ? 'failed' : receipt ? 'waiting' : 'idle';
  return { request, receipt, result, status };
}
