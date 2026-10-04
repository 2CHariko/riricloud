import type { ProbeResult, ProbeTaskAccepted } from '@/lib/probe-types';
import axios, { AxiosError } from 'axios';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { useAuthStore } from '@/stores/auth';
import { frontendLogger } from '@/lib/logger';
import { getLocalizedErrorMessage } from '@/i18n/error-mapping';
import { classifyApiFailure } from '@/lib/api-failure';

// 统一 API 客户端：组件内禁止裸 fetch/自建 axios 实例（CODE_REVIEW W1）
export const api = axios.create({
  baseURL: '/api/v1',
  timeout: 15_000,
  withCredentials: true
});

api.interceptors.request.use((config) => {
  const traceId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  config.headers['X-Request-Id'] = traceId;
  (config as unknown as Record<string, unknown>).__startTime = Date.now();
  (config as unknown as Record<string, unknown>).__traceId = traceId;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError<{ message?: string }>) => {
    const category = classifyApiFailure(error);
    // 取消是请求生命周期的正常结束，不上报错误，也不弹提示。
    if (category === 'CANCELED') return Promise.reject(error);
    const status = error.response?.status;
    const config = error.config as (Record<string, unknown> & { url?: string; method?: string }) | undefined;
    // 日志上传失败由 SDK 自己计数/退避，不触发 toast、注销或递归上报。
    if (config?.url?.includes('/logs/frontend')) return Promise.reject(error);
    // 普通延迟测试的底层错误只显示安全文案，不影响 Agent 探针与模板诊断。
    const latencyTestRequest = /^\/admin\/(?:probe-tasks\/[^/?]+(?:\/results)?|lines\/(?:[^/?]+\/speedtest|speedtest-all)|upstream\/(?:probe-all|nodes\/[^/?]+\/probe))(?:\?|$)/.test(config?.url ?? '');
    const message = latencyTestRequest ? i18n.t('admin:latencyTest.requestFailed') : getLocalizedErrorMessage(error, i18n.t('errors:network.serverError'));
    const traceId = typeof config?.__traceId === 'string' ? config.__traceId : undefined;
    const startTime = typeof config?.__startTime === 'number' ? config.__startTime : undefined;
    const durationMs = startTime ? Date.now() - startTime : undefined;

    // 上报 API 请求异常到前端日志 SDK（避开日志上报接口本身以防递归）
    if (status !== 401 && config?.url && !config.url.includes('/logs/frontend')) {
      const logMethod = status === 404 ? frontendLogger.warn.bind(frontendLogger) : frontendLogger.error.bind(frontendLogger);
      logMethod(
        `API ${String(config.method || 'GET').toUpperCase()} ${config.url} -> ${status ?? category}`,
        'Axios',
        {
          url: config.url,
          method: config.method,
          status,
          category,
          durationMs,
          message
        },
        traceId
      );
    }

    // 401：登录态失效，清理并跳转登录页（避免在登录页自身弹跳转循环）
    if (status === 401 && useAuthStore.getState().user) {
      useAuthStore.getState().logout();
      toast.error(latencyTestRequest ? i18n.t('errors:network.unauthorized') : getLocalizedErrorMessage(error, i18n.t('errors:network.unauthorized')));
      if (window.location.pathname !== '/login') {
        window.location.assign('/login');
      }
    } else if (status && status >= 500) {
      toast.error(latencyTestRequest ? message : getLocalizedErrorMessage(error, message));
    }
    return Promise.reject(error);
  }
);

// 注入统一客户端，logger 不反向 import api，避免模块循环。
frontendLogger.setTransport((logs) => api.post('/logs/frontend', { logs }));

// 统一错误消息提取（表单与 mutation 复用，支持多语言映射）
export function extractErrorMessage(error: unknown, fallback?: string): string {
  return getLocalizedErrorMessage(error, fallback);
}

export type LineType = 'DIRECT' | 'RELAY' | 'EXTERNAL';
export type RelayMode = 'BLIND_FORWARD' | 'PROTOCOL_PROXY' | 'TARGET_LINE' | 'UPSTREAM_NODE';
export type LineStatus = 'ACTIVE' | 'DISABLED';
export type ProtocolType = 'VLESS' | 'VMESS' | 'TROJAN' | 'HYSTERIA2' | 'TUIC' | 'SHADOWSOCKS' | 'NAIVE' | 'SHADOWTLS' | 'MIXED' | 'SOCKS' | 'HTTP' | 'DIRECT';

export interface EgressProxyPayload {
  protocol: 'HTTP' | 'SOCKS5';
  serverHost: string;
  serverPort: number;
  authEnabled: boolean;
  username?: string;
  password?: string;
  udpEnabled: boolean;
}

export interface ApiEgressProxy extends Omit<EgressProxyPayload, 'password'> {
  hasPassword: boolean;
}

export interface ApiEffectiveEgress {
  sourceLineId: string;
  nodeId: string;
  inherited: boolean;
  proxy: ApiEgressProxy | null;
}

export interface ApiLine {
  id: string;
  name: string;
  tag: string | null;
  listen: string;
  type: LineType;
  relayMode: RelayMode | null;
  targetLineId: string | null;
  upstreamNodeId?: string | null;
  upstreamSummary?: Pick<ApiUpstreamNode, 'id' | 'name' | 'protocolType' | 'serverHost' | 'serverPort' | 'status' | 'presenceStatus'> | null;
  protocolType: ProtocolType;
  proxyPoolEnabled: boolean;
  params: Record<string, unknown>;
  egressProxy?: ApiEgressProxy | null;
  effectiveEgress?: ApiEffectiveEgress | null;
  entryNodeId: string | null;
  entryPort: number | null;
  landingNodeId?: string | null;
  landingPort?: number | null;
  allowLanAccess?: boolean;
  speedLimitMbps?: number | null;
  tcpFastOpen?: boolean | null;
  tcpMultiPath?: boolean | null;
  udpFragment?: boolean | null;
  udpTimeout?: string | null;
  proxyProtocol?: boolean | null;
  proxyProtocolAcceptNoHeader?: boolean | null;
  tunnelType?: string | null;
  tunnelPort?: number | null;
  tunnelSecret?: string | null;
  certificateId: string | null;
  endpointOverrideEnabled: boolean;
  serverHost: string;
  serverPort: number;
  serverName: string | null;
  host: string | null;
  landingEndpointOverrideEnabled?: boolean;
  landingServerHost?: string | null;
  landingServerPort?: number | null;
  endpointOverrides: {
    serverHost: string | null;
    serverPort: number | null;
    serverName: string | null;
    host: string | null;
    landingServerHost?: string | null;
    landingServerPort?: number | null;
  };
  trafficRate: number;
  tags: string[];
  level: number;
  sortOrder: number;
  isPublic: boolean;
  status: LineStatus;
  lastProbe?: ProbeResult | null;
  lastLatencyMs?: number | null;
  lastTestedAt?: string | null;
  lastTestStatus?: 'SUCCESS' | 'TIMEOUT' | 'ERROR' | null;
  lastTestMessage?: string | null;
  entryNode: { id: string; name: string; serverHost: string; status: string; isLocal: boolean; reachability?: 'PUBLIC' | 'NAT' } | null;
  landingNode?: { id: string; name: string; serverHost: string; status: string; isLocal: boolean; reachability?: 'PUBLIC' | 'NAT' } | null;
  targetLine?: {
    id: string;
    name: string;
    type: LineType;
    protocolType: ProtocolType;
    status: LineStatus;
    entryNodeId: string;
    entryPort: number;
    landingNodeId?: string | null;
    landingPort?: number | null;
    endpointOverrideEnabled?: boolean;
    serverHost?: string | null;
    serverPort?: number | null;
    serverName?: string | null;
    host?: string | null;
    entryNode: { id: string; name: string; serverHost: string; status: string; isLocal: boolean };
  } | null;
  certificate: {
    id: string;
    name: string;
    subject: string;
    issuer: string;
    sans: string[];
    validFrom: string;
    validTo: string;
  } | null;
  topology: {
    entry: { node: { id: string; name: string; serverHost: string; status: string; isLocal: boolean }; port: number } | null;
    landing?: { node: { id: string; name: string; serverHost: string; status: string; isLocal: boolean }; port: number; host?: string } | null;
  };
}

export type CertificateStatus = 'VALID' | 'EXPIRING' | 'EXPIRED' | 'NOT_YET_VALID';

export interface ApiCertificate {
  id: string;
  name: string;
  subject: string;
  issuer: string;
  serialNumber: string;
  sans: string[];
  validFrom: string;
  validTo: string;
  status: CertificateStatus;
  daysUntilExpiry: number;
  lineCount: number;
  createdAt: string;
  updatedAt: string;
}

// ==============================
// 上游订阅类型与 API
// ==============================
export type UpstreamSourceType = 'URL' | 'TEXT';
export type UpstreamFormat = 'AUTO' | 'CLASH_META' | 'SINGBOX' | 'URI_LIST';
export type UpstreamSyncStatus = 'PENDING' | 'SUCCESS' | 'FAILED';
export type UpstreamNodeStatus = 'ACTIVE' | 'DISABLED';

export interface ApiUpstreamSubscription {
  id: string;
  name: string;
  sourceType: UpstreamSourceType;
  format: UpstreamFormat;
  detectedFormat: Exclude<UpstreamFormat, 'AUTO'> | null;
  url: string | null;
  hasContent: boolean;
  customHeaders: Record<string, string>;
  autoUpdate: boolean;
  updateIntervalMins: number;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastSyncStatus: UpstreamSyncStatus;
  lastSyncMessage: string | null;
  userInfoUsedBytes: string | null;
  userInfoTotalBytes: string | null;
  userInfoExpireAt: string | null;
  nodeCount: number;
  status: UpstreamNodeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ApiUpstreamDetail extends ApiUpstreamSubscription {
  content: string | null;
}

export interface UpstreamSyncResult {
  created: number;
  updated: number;
  missing: number;
  nodeCount: number;
  format: Exclude<UpstreamFormat, 'AUTO'>;
  userInfo: { uploadBytes: string | null; downloadBytes: string | null; usedBytes: string | null; totalBytes: string | null; expireAt: string | null } | null;
  diagnostics: { recognized: number; duplicates: number; skipped: number };
}

export interface ApiUpstreamNode {
  id: string;
  subscriptionId: string;
  subscription?: { id: string; name: string; status: UpstreamNodeStatus } | null;
  name: string;
  protocolType: ProtocolType;
  serverHost: string;
  serverPort: number;
  tags: string[];
  lastProbe?: ProbeResult | null;
  latencyMs: number | null;
  lastTestedAt: string | null;
  lastTestStatus: 'SUCCESS' | 'TIMEOUT' | 'ERROR' | 'NOT_APPLICABLE' | null;
  lastTestMessage: string | null;
  status: UpstreamNodeStatus;
  presenceStatus: 'PRESENT' | 'MISSING';
  sourceKey?: string | null;
  missingSince?: string | null;
  relayLines?: Array<{ id: string; name: string; status: string }>;
  createdAt: string;
  updatedAt: string;
}

export const upstreamApi = {
  list: (params?: { page?: number; pageSize?: number; search?: string; status?: string }) =>
    api.get<{ data: ApiUpstreamSubscription[]; total: number; page: number; pageSize: number }>('/admin/upstream', { params }),
  detail: (id: string) =>
    api.get<{ subscription: ApiUpstreamDetail }>(`/admin/upstream/${id}`, { headers: { 'Cache-Control': 'no-cache' } }),
  create: (data: {
    name: string;
    sourceType?: UpstreamSourceType;
    format?: UpstreamFormat;
    url?: string;
    content?: string;
    customHeaders?: Record<string, string>;
    autoUpdate?: boolean;
    updateIntervalMins?: number;
    status?: UpstreamNodeStatus;
  }) => api.post<{ subscription: ApiUpstreamSubscription }>('/admin/upstream', data),
  update: (
    id: string,
    data: Partial<{
      name: string;
      sourceType: UpstreamSourceType;
      format: UpstreamFormat;
      url: string;
      content: string;
      customHeaders: Record<string, string>;
      autoUpdate: boolean;
      updateIntervalMins: number;
      status: UpstreamNodeStatus;
    }>
  ) => api.put<{ subscription: ApiUpstreamSubscription }>(`/admin/upstream/${id}`, data),
  delete: (id: string) =>
    api.delete<{ deleted: boolean; id: string }>(`/admin/upstream/${id}`),
  sync: (id: string) =>
    api.post<UpstreamSyncResult>(`/admin/upstream/${id}/sync`),
  probeAll: (subscriptionId?: string) =>
    api.post<ProbeTaskAccepted>('/admin/upstream/probe-all', undefined, { params: subscriptionId ? { subscriptionId } : undefined }),
  listNodes: (params?: {
    page?: number;
    pageSize?: number;
    subscriptionId?: string;
    search?: string;
    protocolType?: string;
    tag?: string;
    status?: string;
    presenceStatus?: 'PRESENT' | 'MISSING';
    probeStatus?: 'SUCCESS' | 'FAILED' | 'UNTESTED';
  }) =>
    api.get<{ data: ApiUpstreamNode[]; total: number; page: number; pageSize: number }>('/admin/upstream/nodes', { params }),
  setNodeStatus: (nodeId: string, status: UpstreamNodeStatus) =>
    api.put<{ node: ApiUpstreamNode }>(`/admin/upstream/nodes/${nodeId}/status`, { status }),
  probeNode: (nodeId: string) =>
    api.post<ProbeTaskAccepted>(`/admin/upstream/nodes/${nodeId}/probe`),
  exportNodes: (params?: { nodeIds?: string; subscriptionId?: string; format?: 'uri' | 'json' }) =>
    api.get<string>('/admin/upstream/nodes/export', { params, responseType: 'text' })
};
