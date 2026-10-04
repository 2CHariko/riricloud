import type { LogsFilter, SnapshotNode, SystemLogItem } from './log-types';

export function logFilterParams(filter: LogsFilter, now = Date.now()): Record<string, string> {
  const params: Record<string, string> = {};
  if (filter.level !== 'ALL') params.level = filter.level;
  if (filter.source !== 'ALL') params.source = filter.source;
  if (filter.nodeId && filter.nodeId !== 'ALL') params.nodeId = filter.nodeId;
  for (const key of ['module', 'traceId', 'keyword', 'startTime', 'endTime'] as const) {
    const value = filter[key]?.trim();
    if (value) params[key] = value;
  }
  const durations = { '15m': 900_000, '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000 };
  if (!params.startTime && filter.timeRange !== 'all') params.startTime = new Date(now - durations[filter.timeRange]).toISOString();
  return params;
}

export function metricsHours(filter: LogsFilter): number {
  if (filter.timeRange === '7d') return 168;
  if (filter.timeRange === '15m' || filter.timeRange === '1h') return 1;
  return 24;
}

export function parseLogMetadata(value: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

export function supportsSnapshot(node?: SnapshotNode): boolean {
  if (!node || node.status !== 'ONLINE') return false;
  let capabilities: unknown = node.capabilities;
  if (!Array.isArray(capabilities)) {
    try { capabilities = typeof node.capabilitiesJson === 'string' ? JSON.parse(node.capabilitiesJson) : node.capabilitiesJson; }
    catch { return false; }
  }
  return Array.isArray(capabilities) && capabilities.includes('singbox_diagnostics_snapshot');
}

export function matchesSnapshot(log: SystemLogItem, nodeId: string, taskId: string): boolean {
  const metadata = parseLogMetadata(log.metadata);
  return log.nodeId === nodeId && log.source === 'AGENT' && log.module === 'NodeDiagnostics' && metadata.event === 'diagnostics_snapshot' && metadata.taskId === taskId;
}
