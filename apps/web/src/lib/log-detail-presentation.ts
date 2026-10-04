import { getDefaultSystemTimezone } from '@/lib/utils';

export function detailMetadata(raw?: string | null): { state: 'empty' | 'valid' | 'invalid'; data: Record<string, unknown>; text: string } {
  if (!raw?.trim()) return { state: 'empty', data: {}, text: '' };
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const data = value as Record<string, unknown>;
      return { state: Object.keys(data).length ? 'valid' : 'empty', data, text: JSON.stringify(data, null, 2) };
    }
  } catch { /* 非对象或非法 JSON 必须保留原文证据。 */ }
  return { state: 'invalid', data: {}, text: raw };
}

export function formatDetailTime(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: getDefaultSystemTimezone(), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

export function timeQualityKey(value: unknown): 'agent' | 'legacy' | 'fallback' | 'missing' | 'unknown' {
  if (value === 'agent-clock') return 'agent';
  if (value === 'legacy-received-time') return 'legacy';
  if (value === 'invalid-clock-fallback') return 'fallback';
  return value == null || value === '' ? 'missing' : 'unknown';
}

export function showReportedTime(metadata: Record<string, unknown>, createdAt: string): boolean {
  return typeof metadata.occurredAt === 'string' && Boolean(metadata.occurredAt.trim()) && (
    metadata.timeQuality === 'invalid-clock-fallback' || new Date(metadata.occurredAt).getTime() !== new Date(createdAt).getTime()
  );
}

const CORRELATION_KEYS = ['sequence', 'agentInstanceId', 'kernelInstanceId', 'event', 'taskId', 'operationId'] as const;
export function correlationFields(metadata: Record<string, unknown>) {
  return CORRELATION_KEYS.flatMap((key) => {
    const value = metadata[key];
    const valid = typeof value === 'string' ? Boolean(value.trim())
      : typeof value === 'number' && Number.isFinite(value) && (key !== 'sequence' || Number.isSafeInteger(value) && value >= 0);
    return valid ? [{ key, value: String(value), copyable: key !== 'sequence' && key !== 'event' }] : [];
  });
}

const COLLECTOR_KEYS = ['filtered', 'coalesced', 'requeued', 'dropped', 'truncated'] as const;
export function collectorMetrics(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const stats = raw as Record<string, unknown>;
  return COLLECTOR_KEYS.map((key) => {
    const count = stats[key];
    const value = typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : null;
    return { key, value, warning: (key === 'dropped' || key === 'truncated') && value !== null && value > 0 };
  });
}
