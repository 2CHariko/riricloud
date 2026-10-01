import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { upstreamApi, extractErrorMessage, UpstreamNodeStatus } from '@/lib/api';

export function useAdminUpstreams(params?: { page?: number; pageSize?: number; search?: string; status?: string }) {
  return useQuery({
    queryKey: ['admin-upstreams', params],
    queryFn: async () => (await upstreamApi.list(params)).data
  });
}

export function useAdminUpstreamNodes(params?: {
  page?: number;
  pageSize?: number;
  subscriptionId?: string;
  search?: string;
  protocolType?: string;
  tag?: string;
  status?: string;
}, enabled = true) {
  return useQuery({
    queryKey: ['admin-upstream-nodes', params],
    queryFn: async () => (await upstreamApi.listNodes(params)).data,
    enabled,
  });
}

export function useAdminUpstreamMutations() {
  const queryClient = useQueryClient();
  const { t } = useTranslation(['admin']);

  const createMutation = useMutation({
    mutationFn: upstreamApi.create,
    onSuccess: () => {
      toast.success(t('admin:upstream.saveSuccess'));
      void queryClient.invalidateQueries({ queryKey: ['admin-upstreams'] });
    },
    onError: (err) => {
      toast.error(extractErrorMessage(err));
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof upstreamApi.update>[1] }) => upstreamApi.update(id, data),
    onSuccess: () => {
      toast.success(t('admin:upstream.saveSuccess'));
      void queryClient.invalidateQueries({ queryKey: ['admin-upstreams'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-upstream-nodes'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'lines'] });
      void queryClient.invalidateQueries({ queryKey: ['user'] });
    },
    onError: (err) => {
      toast.error(extractErrorMessage(err));
    }
  });

  const deleteMutation = useMutation({
    mutationFn: upstreamApi.delete,
    onSuccess: () => {
      toast.success(t('admin:upstream.deleteSuccess'));
      void queryClient.invalidateQueries({ queryKey: ['admin-upstreams'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-upstream-nodes'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'lines'] });
      void queryClient.invalidateQueries({ queryKey: ['user'] });
    },
    onError: (err) => {
      toast.error(extractErrorMessage(err));
    }
  });

  const syncMutation = useMutation({
    mutationFn: upstreamApi.sync,
    onSuccess: (res) => {
      toast.success(t('admin:upstream.syncSummary', { ...res.data, ...res.data.diagnostics }));
      void queryClient.invalidateQueries({ queryKey: ['admin-upstreams'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-upstream-nodes'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'lines'] });
      void queryClient.invalidateQueries({ queryKey: ['user'] });
    },
    onError: (err) => {
      toast.error(extractErrorMessage(err));
    }
  });


  const setNodeStatusMutation = useMutation({
    mutationFn: ({ nodeId, status }: { nodeId: string; status: UpstreamNodeStatus }) =>
      upstreamApi.setNodeStatus(nodeId, status),
    onSuccess: () => {
      toast.success(t('admin:upstream.statusSuccess'));
      void queryClient.invalidateQueries({ queryKey: ['admin-upstream-nodes'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'lines'] });
      void queryClient.invalidateQueries({ queryKey: ['user'] });
    },
    onError: (err) => {
      toast.error(extractErrorMessage(err));
    }
  });


  return {
    createMutation,
    updateMutation,
    deleteMutation,
    syncMutation,
    setNodeStatusMutation
  };
}
