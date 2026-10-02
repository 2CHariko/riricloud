import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, extractErrorMessage } from '@/lib/api';
import i18n from '@/i18n/config';

import type { ProbeResult } from '@/lib/probe-types';
import { parseProxyPoolExport, type ProxyPoolExportV2 } from './proxy-pool-contract';
export interface ProxyKey {
  id: string;
  userId: string;
  name: string;
  username: string;
  password: string;
  whitelistIps: string[];
  exportToken: string;
  isActive: boolean;
  trafficUsedBytes: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyPoolEndpoint {
  lineId: string;
  name: string;
  region: string | null;
  tags: string[];
  protocol: 'MIXED';
  host: string;
  port: number;
  nodeId: string;
  nodeName: string;
  nodeStatus: string;
  online: boolean;
  latencyMs: number | null;
  lastTestedAt: string | null;
  lastTestStatus: string | null;
  routeKind: 'DIRECT' | 'UPSTREAM_RELAY';
  lineType: 'DIRECT' | 'RELAY';
  status: 'AVAILABLE' | 'CAPACITY_EXCLUDED';
  reason: string | null;
  tls: boolean;
  serverName: string | null;
  supportedProtocols: ProxyPoolExportProtocol[];
  trafficRate: number;
  lastProbe: ProbeResult | null;
}

export interface ProxyKeyPayload {
  name: string;
  whitelistIps?: string;
}

export type ProxyPoolExportFormat = 'text' | 'uri' | 'json';
export type ProxyPoolExportProtocol = 'socks5' | 'http';

const KEYS_QUERY_KEY = ['user', 'proxy-pool', 'keys'] as const;
const ENDPOINTS_QUERY_KEY = ['user', 'proxy-pool', 'endpoints'] as const;

export function useProxyPoolKeys() {
  return useQuery({
    queryKey: KEYS_QUERY_KEY,
    queryFn: async () => (await api.get<{ keys: ProxyKey[]; limit: number }>('/user/proxy-pool/keys')).data
  });
}

export function useProxyPoolEndpoints(keyId?: string, lineIds?: string[]) {
  return useQuery({
    queryKey: [...ENDPOINTS_QUERY_KEY, keyId ?? null, (lineIds ?? []).join(',')],
    queryFn: async () => (await api.get<{ keyId: string | null; endpoints: ProxyPoolEndpoint[]; excludedCount: number }>('/user/proxy-pool/nodes', {
      params: { keyId, ...(lineIds?.length ? { lineIds: lineIds.join(',') } : {}) }
    })).data,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: 30_000
  });
}

export interface ProxyPoolExportParams {
  keyId?: string;
  format: ProxyPoolExportFormat;
  protocol: ProxyPoolExportProtocol;
  lineIds?: string[];
  enabled?: boolean;
}

export function useProxyPoolExport(params: ProxyPoolExportParams) {
  const { keyId, format, protocol, lineIds, enabled = true } = params;
  const lineIdsValue = (lineIds ?? []).join(',');
  return useQuery({
    queryKey: ['user', 'proxy-pool', 'export', keyId ?? '', format, protocol, lineIdsValue],
    enabled: enabled && Boolean(keyId) && Boolean(lineIds?.length),
    retry: false,
    placeholderData: (previousData) => previousData,
    gcTime: 60_000,
    queryFn: async () => {
      const response = await api.get('/user/proxy-pool/export', {
        params: {
          keyId,
          format,
          protocol,
          ...(lineIdsValue ? { lineIds: lineIdsValue } : {})
        },
        responseType: 'text'
      });
      const raw: unknown = response.data;
      if (typeof raw !== 'string') throw new Error('PROXY_POOL_EXPORT_FORMAT_INVALID');
      return raw;
    }
  });
}

export function useProxyPoolExportCredentials(params: Omit<ProxyPoolExportParams, 'format'>) {
  const { keyId, protocol, lineIds, enabled = true } = params;
  return useQuery<ProxyPoolExportV2>({
    queryKey: ['user', 'proxy-pool', 'credentials-v2', keyId, protocol, (lineIds ?? []).join(',')],
    enabled: enabled && Boolean(keyId) && Boolean(lineIds?.length),
    retry: false,
    placeholderData: (previousData) => previousData,
    gcTime: 60_000,
    staleTime: 30_000,
    queryFn: async () => {
      const response = await api.get('/user/proxy-pool/export', { params: { keyId, protocol, format: 'json', lineIds: lineIds!.join(',') } });
      const result = parseProxyPoolExport(response.data, keyId!);
      if (result && (result.proxies.length !== lineIds!.length || result.proxies.some((proxy) => !lineIds!.includes(proxy.lineId)))) {
        throw new Error('PROXY_POOL_SELECTION_UNAVAILABLE');
      }
      if (!result) throw new Error('PROXY_POOL_REEXPORT_REQUIRED');
      return result;
    }
  });
}

export function useProxyPoolMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['user', 'proxy-pool'] });
  };

  const createKey = useMutation({
    mutationFn: async (payload: ProxyKeyPayload) => (await api.post<{ key: ProxyKey }>('/user/proxy-pool/keys', payload)).data,
    onSuccess: () => {
      toast.success(i18n.t('user:proxyPool.createdSuccess'));
      invalidate();
    },
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('user:proxyPool.createFailed')))
  });

  const updateKey = useMutation({
    mutationFn: async ({ id, ...payload }: ProxyKeyPayload & { id: string; isActive?: boolean }) =>
      (await api.patch<{ key: ProxyKey }>(`/user/proxy-pool/keys/${id}`, payload)).data,
    onSuccess: () => {
      toast.success(i18n.t('user:proxyPool.updatedSuccess'));
      invalidate();
    },
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('user:proxyPool.updateFailed')))
  });

  const deleteKey = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/user/proxy-pool/keys/${id}`)).data,
    onSuccess: () => {
      toast.success(i18n.t('user:proxyPool.deletedSuccess'));
      invalidate();
    },
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('user:proxyPool.deleteFailed')))
  });

  const rotatePassword = useMutation({
    mutationFn: async (id: string) => (await api.post<{ key: ProxyKey }>(`/user/proxy-pool/keys/${id}/rotate-password`)).data,
    onSuccess: () => {
      toast.success(i18n.t('user:proxyPool.rotatePasswordSuccess'));
      invalidate();
    },
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('user:proxyPool.rotatePasswordFailed')))
  });

  const rotateToken = useMutation({
    mutationFn: async (id: string) => (await api.post<{ key: ProxyKey }>(`/user/proxy-pool/keys/${id}/rotate-token`)).data,
    onSuccess: () => {
      toast.success(i18n.t('user:proxyPool.rotateTokenSuccess'));
      invalidate();
    },
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('user:proxyPool.rotateTokenFailed')))
  });

  return { createKey, updateKey, deleteKey, rotatePassword, rotateToken };
}
