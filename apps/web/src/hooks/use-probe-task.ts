import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import i18n from '@/i18n';
import { isProbePending, type ProbeResultsPage, type ProbeTask, type ProbeTaskAccepted } from '@/lib/probe-types';

interface TaskUIState {
  taskIds: Record<string, string>;
  activeTaskId: string | null;
  submitting: boolean;
  remember: (key: string, taskId: string) => void;
  finish: (taskId: string) => void;
  setSubmitting: (submitting: boolean) => void;
}
// 仅记住任务标识与提交互斥；服务端任务与结果始终由 Query 持有。
const useTaskUI = create<TaskUIState>((set) => ({
  taskIds: {}, activeTaskId: null, submitting: false,
  remember: (key, taskId) => set((s) => ({ taskIds: { ...s.taskIds, [key]: taskId }, activeTaskId: taskId })),
  finish: (taskId) => set((s) => ({ activeTaskId: s.activeTaskId === taskId ? null : s.activeTaskId })),
  setSubmitting: (submitting) => set({ submitting })
}));
export interface ProbeTaskRequest { key: string; endpoint: string; subscriptionId?: string; taskId?: string; }
export function useProbeTask(request: ProbeTaskRequest, open: boolean) {
  const queryClient = useQueryClient();
  const ui = useTaskUI();
  const { finish } = ui;
  const taskId = request.taskId ?? ui.taskIds[request.key];
  const [page, setPage] = useState(1);
  const observedCompletion = useRef<string | null>(null);
  const task = useQuery({
    queryKey: ['admin', 'probe-tasks', taskId],
    queryFn: async ({ signal }) => (await api.get<ProbeTask>(`/admin/probe-tasks/${taskId}`, { signal })).data,
    enabled: open && !!taskId,
    retry: false,
    refetchInterval: (q) => open && !q.state.error && (!q.state.data || isProbePending(q.state.data.state)) ? 1000 : false
  });
  const results = useQuery({
    queryKey: ['admin', 'probe-task-results', taskId, page],
    queryFn: async ({ signal }) => (await api.get<ProbeResultsPage>(`/admin/probe-tasks/${taskId}/results`, { params: { page, pageSize: 20 }, signal })).data,
    enabled: open && !!taskId && !!task.data,
    retry: false,
    refetchInterval: () => open && !task.isError && isProbePending(task.data?.state) ? 1000 : false
  });
  useEffect(() => {
    if (taskId && task.error && typeof task.error === 'object' && 'response' in task.error) {
      const status = (task.error as { response?: { status?: number } }).response?.status;
      if (status === 404 || status === 410) finish(taskId);
    }
  }, [taskId, task.error, finish]);
  useEffect(() => {
    if (!task.data || isProbePending(task.data.state)) return;
    finish(task.data.taskId);
    if (observedCompletion.current === task.data.taskId) return;
    observedCompletion.current = task.data.taskId;
    // 已取消/截止的批量任务也可能有前序批次写回，所有终态均刷新资源。
    for (const queryKey of [['admin-upstream-nodes'], ['admin', 'lines'], ['user']]) {
      void queryClient.invalidateQueries({ queryKey });
    }
    void queryClient.invalidateQueries({ queryKey: ['admin', 'probe-task-results', task.data.taskId] });
    // eslint-disable-next-line no-restricted-syntax -- 仅观测服务端任务终态，无表单草稿同步。
  }, [task.data, finish, queryClient]);
  const start = useMutation({
    mutationKey: ['admin', 'probe-submit'],
    mutationFn: async () => {
      if (useTaskUI.getState().submitting || useTaskUI.getState().activeTaskId) throw new Error('PROBE_TASK_ACTIVE');
      ui.setSubmitting(true);
      try {
        const accepted = (await api.post<ProbeTaskAccepted>(request.endpoint, undefined, { params: request.subscriptionId ? { subscriptionId: request.subscriptionId } : undefined })).data;
        ui.remember(request.key, accepted.taskId);
        return accepted;
      } finally { ui.setSubmitting(false); }
    },
    onSuccess: () => setPage(1),
    onError: (error) => toast.error(i18n.t(error.message === 'PROBE_TASK_ACTIVE' ? 'admin:latencyTest.globalBusy' : 'admin:latencyTest.startFailed'))
  });
  const cancel = useMutation({
    mutationFn: async () => { await api.delete(`/admin/probe-tasks/${taskId}`); },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['admin', 'probe-tasks', taskId] }); },
    onError: () => toast.error(i18n.t('admin:latencyTest.cancelFailed'))
  });
  const pending = !!taskId && !task.isError && (!task.data || isProbePending(task.data.state));
  return { taskId, task, results, page, setPage, start, cancel, pending,
    blocked: ui.submitting || !!ui.activeTaskId,
    activeTaskId: ui.activeTaskId,
    activeElsewhere: !!ui.activeTaskId && ui.activeTaskId !== taskId };
}
