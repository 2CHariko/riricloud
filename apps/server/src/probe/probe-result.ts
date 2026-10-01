import type { ProbeResult } from './probe.types';

const statuses = new Set(['SUCCESS', 'TIMEOUT', 'ERROR', 'UNSUPPORTED', 'ENVIRONMENT_UNAVAILABLE', 'CANCELED', 'STALE', 'SKIPPED']);
// 禁止把数据库 JSON 整体展开到 API，旧 TCP 记录和未知嵌套字段一律丢弃。
export function safeProbeResult(value: unknown): ProbeResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.schemaVersion !== 1 || !statuses.has(String(r.status)) || !['LINE', 'UPSTREAM_NODE'].includes(String(r.subjectType)) || r.measurement !== 'PROXY_HTTP_DELAY' || r.perspective !== 'MASTER') return null;
  if (!['UPSTREAM_DIRECT', 'MANAGED_DIRECT', 'MANAGED_RELAY'].includes(String(r.routeKind)) || !['VALIDATE', 'START_KERNEL', 'DIAL_HTTP', 'PERSIST'].includes(String(r.stage))) return null;
  if (typeof r.subjectId !== 'string' || typeof r.configHash !== 'string' || typeof r.testedAt !== 'string' || !Number.isFinite(Date.parse(r.testedAt))) return null;
  const text = (key: string): string => typeof r[key] === 'string' ? (r[key] as string).slice(0, 1024) : '';
  const nullableText = (key: string): string | null => typeof r[key] === 'string' ? text(key) : null;
  return {
    schemaVersion: 1, subjectType: r.subjectType as ProbeResult['subjectType'], subjectId: r.subjectId,
    status: r.status as ProbeResult['status'], errorCode: nullableText('errorCode'), message: text('message'),
    engine: r.engine === 'MIHOMO' || r.engine === 'SINGBOX' ? r.engine : null,
    engineVersion: nullableText('engineVersion'), fallbackReason: nullableText('fallbackReason'),
    mihomoCompatibility: r.mihomoCompatibility === 'SUPPORTED' ? 'SUPPORTED' : 'UNSUPPORTED',
    measurement: 'PROXY_HTTP_DELAY', perspective: 'MASTER', routeKind: r.routeKind as ProbeResult['routeKind'],
    targetId: text('targetId'), targetHost: text('targetHost'), testedAt: r.testedAt,
    durationMs: typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) ? Math.max(0, r.durationMs) : 0,
    latencyMs: r.status === 'SUCCESS' && typeof r.latencyMs === 'number' && Number.isFinite(r.latencyMs) && r.latencyMs >= 0 ? r.latencyMs : null,
    stage: r.stage as ProbeResult['stage'], configHash: r.configHash, applied: r.applied === true
  };
}
export function readLastProbe(json: string | null | undefined, available = true, expectedHash?: string): ProbeResult | null {
  if (!json) return null;
  try {
    const result = safeProbeResult(JSON.parse(json));
    return result && (!available || (expectedHash !== undefined && result.configHash !== expectedHash)) ? { ...result, status: 'STALE', errorCode: 'RESOURCE_UNAVAILABLE', latencyMs: null, applied: false, stage: 'PERSIST', message: '资源状态已变更，请重新测试' } : result;
  } catch { return null; }
}
