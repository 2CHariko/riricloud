import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, extractErrorMessage } from '@/lib/api';

/** 与后端 parsers/types.ts 的 UpstreamSkipReason 一一对应，用于 i18n 文案映射。 */
export type UpstreamSkipReason =
  | 'UNSUPPORTED_PROTOCOL'
  | 'MISSING_SERVER'
  | 'MISSING_CREDENTIAL'
  | 'INVALID_PARAMS'
  | 'DUPLICATE';

export interface ApiUpstreamSubscription {
  id: string;
  name: string;
  /** 仅 host：完整 URL 内嵌机场鉴权 Token，服务端不会下发 */
  host: string;
  enabled: boolean;
  syncIntervalMins: number;
  userAgent: string | null;
  lastFetchedAt: string | null;
  lastFetchStatus: 'SUCCESS' | 'FAILED' | 'NEVER';
  lastFetchError: string | null;
  detectedFormat: string | null;
  entryCount: number;
  availableEntryCount: number;
  lineCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApiUpstreamEntry {
  id: string;
  subscriptionId: string | null;
  subscriptionName: string | null;
  name: string;
  protocolType: string;
  server: string;
  port: number;
  entryKey: string;
  available: boolean;
  materializedLineCount: number;
  lastSeenAt: string;
  createdAt: string;
}

export interface UpstreamSkipItem {
  name: string;
  reason: UpstreamSkipReason;
  detail?: string;
}

export interface UpstreamPreviewNode {
  entryKey: string;
  name: string;
  protocolType: string;
  server: string;
  port: number;
  imported: boolean;
  entryId: string | null;
}

export interface UpstreamPreviewResult {
  format: string;
  providerCount: number;
  nodes: UpstreamPreviewNode[];
  skipped: UpstreamSkipItem[];
}

export interface UpstreamSubscriptionPayload {
  name: string;
  url: string;
  enabled?: boolean;
  syncIntervalMins?: number;
  userAgent?: string | null;
}

export interface UpstreamPreviewPayload {
  url?: string;
  content?: string;
  userAgent?: string;
  followProviders?: boolean;
}

export interface UpstreamMaterializePayload {
  entryIds: string[];
  entryNodeId: string;
  entryProtocolType: string;
  namePrefix?: string;
  tags?: string[];
  isPublic?: boolean;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function useAdminUpstreams() {
  return useQuery({
    queryKey: ['admin', 'upstreams'],
    queryFn: async () => (await api.get<PaginatedResponse<ApiUpstreamSubscription>>('/admin/upstreams', { params: { pageSize: 100 } })).data
  });
}

/** 上游条目列表：默认视图展示全部条目（含手工导入的单节点条目）。 */
export function useUpstreamEntries(query: { subscriptionId?: string; page?: number; pageSize?: number; search?: string } = {}) {
  return useQuery({
    queryKey: ['admin', 'upstreams', 'entries', query],
    queryFn: async () =>
      (await api.get<PaginatedResponse<ApiUpstreamEntry>>(
        query.subscriptionId ? `/admin/upstreams/${query.subscriptionId}/entries` : '/admin/upstreams/entries',
        { params: { page: query.page ?? 1, pageSize: query.pageSize ?? 20, ...(query.search ? { search: query.search } : {}) } }
      )).data
  });
}

export function useUpstreamMutations() {
  const { t } = useTranslation(['admin', 'common']);
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'upstreams'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'lines'] });
  };
  const onError = (error: unknown, fallback: string) => toast.error(extractErrorMessage(error, fallback));

  const create = useMutation({
    mutationFn: async (payload: UpstreamSubscriptionPayload) =>
      (await api.post<{ subscription: ApiUpstreamSubscription }>('/admin/upstreams', payload)).data,
    onSuccess: () => {
      toast.success(t('admin:upstreams.toastCreated'));
      invalidate();
    },
    onError: (error: unknown) => onError(error, t('admin:upstreams.toastCreateFailed'))
  });

  const update = useMutation({
    mutationFn: async ({ id, ...payload }: UpstreamSubscriptionPayload & { id: string }) =>
      (await api.patch<{ subscription: ApiUpstreamSubscription }>(`/admin/upstreams/${id}`, payload)).data,
    onSuccess: () => {
      toast.success(t('admin:upstreams.toastSaved'));
      invalidate();
    },
    onError: (error: unknown) => onError(error, t('admin:upstreams.toastSaveFailed'))
  });

  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/admin/upstreams/${id}`)).data,
    onSuccess: () => {
      toast.success(t('admin:upstreams.toastDeleted'));
      invalidate();
    },
    onError: (error: unknown) => onError(error, t('admin:upstreams.toastDeleteFailed'))
  });

  const sync = useMutation({
    mutationFn: async (id: string) => (await api.post<Record<string, number>>(`/admin/upstreams/${id}/sync`)).data,
    onSuccess: () => {
      toast.success(t('admin:upstreams.toastSynced'));
      invalidate();
    },
    onError: (error: unknown) => onError(error, t('admin:upstreams.toastSyncFailed'))
  });

  return { create, update, remove, sync };
}

/** 预览与导入共用同一份请求体；预览不落库，导入才会写入上游条目。 */
export function useUpstreamPreview() {
  const { t } = useTranslation(['admin', 'common']);
  return useMutation({
    mutationFn: async (payload: UpstreamPreviewPayload) =>
      (await api.post<UpstreamPreviewResult>('/admin/upstreams/preview', payload)).data,
    onError: (error: unknown) => toast.error(extractErrorMessage(error, t('admin:upstreams.toastPreviewFailed')))
  });
}

export function useMaterializeUpstreams() {
  const { t } = useTranslation(['admin', 'common']);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: UpstreamMaterializePayload) =>
      (await api.post<{ created: Array<{ entryId: string; lineId: string; name: string }>; total: number }>(
        '/admin/upstreams/entries/materialize',
        payload
      )).data,
    onSuccess: (result) => {
      toast.success(t('admin:upstreams.toastMaterialized', { count: result.total }));
      void queryClient.invalidateQueries({ queryKey: ['admin', 'upstreams'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'lines'] });
    },
    onError: (error: unknown) => toast.error(extractErrorMessage(error, t('admin:upstreams.toastMaterializeFailed')))
  });
}
