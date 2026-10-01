import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import i18n from '@/i18n/config';
import { api, extractErrorMessage, type ApiLine, type LineStatus, type LineType, type ProtocolType, type RelayMode } from '@/lib/api';

import type { EgressProxyPayload } from '@/lib/api';
export type { ApiLine as AdminLine };

interface LineAttributes {
  name: string;
  tag?: string | null;
  tags?: string[];
  level?: number;
  sortOrder?: number;
  isPublic?: boolean;
  status?: LineStatus;
}

export interface ExternalLinePayload extends LineAttributes {
  type: 'EXTERNAL';
  upstreamNodeId: string;
  egressProxy?: null;
}

export interface ManagedLinePayload extends LineAttributes {
  listen?: string;
  type: 'DIRECT' | 'RELAY';
  protocolType: ProtocolType;
  proxyPoolEnabled: boolean;
  params: Record<string, unknown>;
  egressProxy?: EgressProxyPayload | null;
  relayMode?: RelayMode | null;
  targetLineId?: string | null;
  upstreamNodeId?: string | null;
  entryNodeId: string;
  entryPort?: number | null;
  landingNodeId?: string | null;
  landingPort?: number | null;
  speedLimitMbps?: number | null;
  tcpFastOpen?: boolean;
  tcpMultiPath?: boolean;
  udpFragment?: boolean;
  udpTimeout?: string | null;
  proxyProtocol?: boolean;
  proxyProtocolAcceptNoHeader?: boolean;
  allowLanAccess?: boolean;
  tunnelType?: string | null;
  tunnelPort?: number | null;
  tunnelSecret?: string | null;
  certificateId?: string | null;
  endpointOverrideEnabled?: boolean;
  serverHost?: string | null;
  serverPort?: number | null;
  serverName?: string | null;
  host?: string | null;
  landingEndpointOverrideEnabled?: boolean;
  landingServerHost?: string | null;
  landingServerPort?: number | null;
  trafficRate?: number;
  tags?: string[];
  level?: number;
  sortOrder?: number;
  isPublic?: boolean;
  status?: LineStatus;
}

export type LinePayload = ManagedLinePayload | ExternalLinePayload;

export interface LineQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  type?: LineType;
  status?: LineStatus;
  tag?: string;
}


export function useAdminLines(query: LineQuery = {}) {
  return useQuery({
    queryKey: ['admin', 'lines', query],
    queryFn: async () => (await api.get<{ data: ApiLine[]; total: number; page: number; pageSize: number }>('/admin/lines', { params: { page: 1, pageSize: 20, ...query } })).data
  });
}

export function useLineOptions(enabled = true) {
  return useQuery({
    queryKey: ['admin', 'lines', 'options'], enabled,
    queryFn: async () => {
      const data: ApiLine[] = [];
      let page = 1;
      let total = 0;
      do {
        const response = (await api.get<{ data: ApiLine[]; total: number; page: number; pageSize: number }>('/admin/lines', { params: { page, pageSize: 100 } })).data;
        data.push(...response.data);
        total = response.total;
        if (response.data.length === 0) break;
        page++;
      } while (data.length < total);
      return { data, total };
    }
  });
}

export function useLineMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'lines'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'nodes'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'plans'] });
    void queryClient.invalidateQueries({ queryKey: ['user'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'proxy-pool'] });
  };
  const onError = (error: unknown, fallback: string) => toast.error(extractErrorMessage(error, fallback));
  const create = useMutation({
    mutationFn: async (payload: LinePayload) => (await api.post<{ line: ApiLine }>('/admin/lines', payload)).data,
    onSuccess: () => { toast.success(i18n.t('admin:lines.createSuccess')); invalidate(); },
    onError: (error: unknown) => onError(error, i18n.t('admin:lines.createFailed'))
  });
  const update = useMutation({
    mutationFn: async ({ id, ...payload }: LinePayload & { id: string }) => (await api.patch<{ line: ApiLine }>(`/admin/lines/${id}`, payload)).data,
    onSuccess: () => { toast.success(i18n.t('admin:lines.saveSuccess')); invalidate(); },
    onError: (error: unknown) => onError(error, i18n.t('admin:lines.saveFailed'))
  });
  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/admin/lines/${id}`)).data,
    onSuccess: () => { toast.success(i18n.t('admin:lines.deleteSuccess')); invalidate(); },
    onError: (error: unknown) => onError(error, i18n.t('admin:lines.deleteFailed'))
  });
  const duplicate = useMutation({
    mutationFn: async (id: string) => (await api.post<{ line: ApiLine }>(`/admin/lines/${id}/duplicate`)).data,
    onSuccess: () => { toast.success(i18n.t('admin:lines.duplicateSuccess')); invalidate(); },
    onError: (error: unknown) => onError(error, i18n.t('admin:lines.duplicateFailed'))
  });
  const testResolve = useMutation({
    mutationFn: async (id: string) => (await api.post(`/admin/lines/${id}/test`)).data,
    onSuccess: () => toast.success(i18n.t('admin:lines.resolveSuccess')),
    onError: (error: unknown) => onError(error, i18n.t('admin:lines.resolveFailed'))
  });
  const batchStatus = useMutation({
    mutationFn: async ({ ids, status }: { ids: string[]; status: LineStatus }) => (await api.post('/admin/lines/batch-status', { ids, status })).data,
    onSuccess: () => { toast.success(i18n.t('admin:lines.batchStatusSuccess')); invalidate(); },
    onError: (error: unknown) => onError(error, i18n.t('admin:lines.batchStatusFailed'))
  });
  const reorder = useMutation({
    mutationFn: async (items: Array<{ id: string; sortOrder: number }>) => (await api.patch('/admin/lines/reorder', { items })).data,
    onSuccess: () => { toast.success(i18n.t('admin:lines.reorderSuccess')); invalidate(); },
    onError: (error: unknown) => onError(error, i18n.t('admin:lines.reorderFailed'))
  });
  return { create, update, remove, duplicate, testResolve, batchStatus, reorder };
}

export function useRealityKeypair() {
  return useMutation({
    mutationFn: async () => (await api.post<{ privateKey: string; publicKey: string }>('/admin/nodes/reality-keypair')).data
  });
}
