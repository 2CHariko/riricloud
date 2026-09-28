import axios, { AxiosError } from 'axios';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { useAuthStore } from '@/stores/auth';
import { frontendLogger } from '@/lib/logger';
import { getLocalizedErrorMessage } from '@/i18n/error-mapping';

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
    const status = error.response?.status;
    const message = getLocalizedErrorMessage(error, i18n.t('errors:network.serverError'));
    const config = error.config as (Record<string, unknown> & { url?: string; method?: string }) | undefined;
    const traceId = typeof config?.__traceId === 'string' ? config.__traceId : undefined;
    const startTime = typeof config?.__startTime === 'number' ? config.__startTime : undefined;
    const durationMs = startTime ? Date.now() - startTime : undefined;

    // 上报 API 请求异常到前端日志 SDK（避开日志上报接口本身以防递归）
    if (status !== 401 && config?.url && !config.url.includes('/logs/frontend')) {
      const logMethod = status === 404 ? frontendLogger.warn.bind(frontendLogger) : frontendLogger.error.bind(frontendLogger);
      logMethod(
        `API ${String(config.method || 'GET').toUpperCase()} ${config.url} -> ${status ?? 'Network Error'}`,
        'Axios',
        {
          url: config.url,
          method: config.method,
          status,
          durationMs,
          message
        },
        traceId
      );
    }

    // 401：登录态失效，清理并跳转登录页（避免在登录页自身弹跳转循环）
    if (status === 401 && useAuthStore.getState().user) {
      useAuthStore.getState().logout();
      toast.error(getLocalizedErrorMessage(error, i18n.t('errors:network.unauthorized')));
      if (window.location.pathname !== '/login') {
        window.location.assign('/login');
      }
    } else if (status && status >= 500) {
      toast.error(getLocalizedErrorMessage(error, message));
    }
    return Promise.reject(error);
  }
);

// 统一错误消息提取（表单与 mutation 复用，支持多语言映射）
export function extractErrorMessage(error: unknown, fallback?: string): string {
  return getLocalizedErrorMessage(error, fallback);
}

export type LineType = 'DIRECT' | 'RELAY';
export type RelayMode = 'BLIND_FORWARD' | 'PROTOCOL_PROXY' | 'TARGET_LINE';
export type LineStatus = 'ACTIVE' | 'DISABLED';
export type ProtocolType = 'VLESS' | 'VMESS' | 'TROJAN' | 'HYSTERIA2' | 'TUIC' | 'SHADOWSOCKS' | 'NAIVE' | 'SHADOWTLS' | 'MIXED' | 'SOCKS' | 'HTTP' | 'DIRECT';

export interface ApiLine {
  id: string;
  name: string;
  tag: string | null;
  listen: string;
  type: LineType;
  relayMode: RelayMode | null;
  targetLineId: string | null;
  protocolType: ProtocolType;
  params: Record<string, unknown>;
  entryNodeId: string;
  entryPort: number;
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
  lastLatencyMs?: number | null;
  lastTestedAt?: string | null;
  lastTestStatus?: 'SUCCESS' | 'TIMEOUT' | 'ERROR' | null;
  lastTestMessage?: string | null;
  entryNode: { id: string; name: string; serverHost: string; status: string; isLocal: boolean; reachability?: 'PUBLIC' | 'NAT' };
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
    entry: { node: { id: string; name: string; serverHost: string; status: string; isLocal: boolean }; port: number };
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
