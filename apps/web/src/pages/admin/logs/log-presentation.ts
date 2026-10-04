import { getDefaultSystemTimezone } from '@/lib/utils';
import type { LogsFilter } from './types';

/** 列表只展示短时间，完整时间与关联证据留在详情中。 */
export function formatLogTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: getDefaultSystemTimezone(), month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  return `${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

export function toLocalDateTimeInput(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, -1);
}

export interface AdvancedFilterDraft {
  module: string;
  startTime: string;
  endTime: string;
}

export function advancedFilterPatch(draft: AdvancedFilterDraft): Partial<LogsFilter> {
  return {
    module: draft.module.trim(),
    startTime: draft.startTime ? new Date(draft.startTime).toISOString() : undefined,
    endTime: draft.endTime ? new Date(draft.endTime).toISOString() : undefined,
    ...(draft.startTime || draft.endTime ? { timeRange: 'all' as const } : {}),
    page: 1
  };
}
