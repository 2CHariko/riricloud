import type { ProxyPoolEndpoint, ProxyPoolExportFormat, ProxyPoolExportProtocol } from './use-proxy-pool';

export const PROXY_POOL_SELECTION_LIMIT = 200;
export interface ExportedProxy extends ProxyPoolEndpoint { username: string; password: string; }
export interface ProxyPoolExportV2 {
  version: 2;
  generatedAt: string;
  key: { id: string; name: string; username: string };
  proxies: ExportedProxy[];
  excludedCount: number;
}

export function supportsProtocol(endpoint: Pick<ProxyPoolEndpoint, 'tls' | 'supportedProtocols'>, protocol: ProxyPoolExportProtocol) {
  return !(protocol === 'socks5' && endpoint.tls) && endpoint.supportedProtocols.includes(protocol);
}

// 只清理失效选择；新增端点与轮询不扩大用户已明确选择的范围。
export function reconcileSelection(ids: string[], endpoints: ProxyPoolEndpoint[]): string[] {
  const available = new Set(endpoints.filter((endpoint) => endpoint.status === 'AVAILABLE').map((endpoint) => endpoint.lineId));
  return [...new Set(ids)].filter((id) => available.has(id)).slice(0, PROXY_POOL_SELECTION_LIMIT);
}

export function parseProxyPoolExport(raw: unknown, keyId: string): ProxyPoolExportV2 | null {
  try {
    const data = (typeof raw === 'string' ? JSON.parse(raw) : raw) as ProxyPoolExportV2 | null;
    if (!data || data.version !== 2 || data.key?.id !== keyId || !Array.isArray(data.proxies)) return null;
    if (!data.proxies.every((proxy) => typeof proxy.username === 'string' && proxy.username.length > 0
      && proxy.username !== data.key.username && typeof proxy.password === 'string' && proxy.password.length > 0
      && typeof proxy.lineId === 'string' && typeof proxy.host === 'string' && Number.isInteger(proxy.port)
      && proxy.status === 'AVAILABLE' && Array.isArray(proxy.supportedProtocols))) return null;
    return data;
  } catch { return null; }
}

export function buildAutomationUrl(base: string, token: string, protocol: ProxyPoolExportProtocol, format: ProxyPoolExportFormat, ids: string[]) {
  if (!token || !ids.length || ids.length > PROXY_POOL_SELECTION_LIMIT) return '';
  const params = new URLSearchParams({ token, format, protocol, lineIds: ids.join(',') });
  return `${base.replace(/\/+$/, '')}/api/v1/user/proxy-pool/export?${params.toString()}`;
}

export function proxyPoolErrorCode(error: unknown): string | null {
  const raw = (error as { response?: { data?: unknown } })?.response?.data;
  try {
    const data = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { code?: unknown } | null;
    return typeof data?.code === 'string' ? data.code : null;
  } catch { return null; }
}
