export type ProbeEngine = 'MIHOMO' | 'SINGBOX';
export type ProbePolicy = 'MIHOMO_PREFERRED' | 'MIHOMO_ONLY';
export type ProbeStatus = 'SUCCESS' | 'TIMEOUT' | 'ERROR' | 'UNSUPPORTED' | 'ENVIRONMENT_UNAVAILABLE' | 'CANCELED' | 'STALE' | 'SKIPPED';
export type ProbeRouteKind = 'UPSTREAM_DIRECT' | 'MANAGED_DIRECT' | 'MANAGED_RELAY';
export interface ProbeResult {
  schemaVersion: 1;
  subjectType: 'UPSTREAM_NODE' | 'LINE';
  subjectId: string;
  status: ProbeStatus;
  errorCode: string | null;
  message: string;
  engine: ProbeEngine | null;
  engineVersion: string | null;
  fallbackReason: string | null;
  mihomoCompatibility: 'SUPPORTED' | 'UNSUPPORTED';
  measurement: 'PROXY_HTTP_DELAY';
  perspective: 'MASTER';
  routeKind: ProbeRouteKind;
  targetId: string;
  targetHost: string;
  testedAt: string;
  durationMs: number;
  latencyMs: number | null;
  stage: 'VALIDATE' | 'START_KERNEL' | 'DIAL_HTTP' | 'PERSIST';
  configHash: string;
  applied: boolean;
}
export type ProbeTaskState = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELED' | 'FAILED';
export interface ProbeTaskAccepted { taskId: string; state: ProbeTaskState; total: number; }
export interface ProbeTask extends ProbeTaskAccepted {
  completed: number;
  success: number;
  failed: number;
  skipped: number;
  createdAt: string;
  expiresAt: string;
  phase?: string;
}
export interface ProbeResultsPage { data: ProbeResult[]; total: number; page: number; pageSize: number; }
export interface KernelResourceRequirement {
  kind: 'GEOIP' | 'GEOSITE' | 'RULE_PROVIDER' | 'PROXY_PROVIDER' | 'RULE_SET' | 'CERTIFICATE' | 'EXTERNAL_FILE' | 'REMOTE_RESOURCE';
  location: string;
  state: 'AVAILABLE' | 'MISSING' | 'UNREADABLE' | 'INVALID' | 'UNSUPPORTED' | 'REMOTE_DISABLED';
  reasonCode: string;
  actionCode: 'PREPARE_RESOURCE' | 'FIX_RESOURCE' | 'CHECK_CLIENT' | 'NONE';
  references: number;
}
export interface KernelCheckResult {
  engine: ProbeEngine;
  engineVersion: string | null;
  status: 'PASSED' | 'FAILED' | 'UNAVAILABLE' | 'UNSUPPORTED' | 'EXTERNAL_RESOURCES_REQUIRED';
  executed: boolean;
  scope: 'FULL' | 'PARTIAL';
  diagnostics: string[];
  resourceRequirements?: KernelResourceRequirement[];
  resourceRequirementsTruncated?: number;
}
export interface ClientKernelProfile { engine: ProbeEngine; version: string | null; available: boolean; reason: string | null; }
export type ClientKernelStatus = ClientKernelProfile[];
export interface ProbeSettings { probeSingboxFallbackEnabled: boolean; }
export function isProbePending(state?: ProbeTaskState): boolean {
  return state === 'QUEUED' || state === 'RUNNING';
}

// 拒绝旧 TCP 快照、未知枚举和畸形数据，不以历史数字推断代理可用性。
export function parseLastProbe(value: unknown): ProbeResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  const nullableString = (v: unknown) => v === null || typeof v === 'string';
  const finiteNonnegative = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (p.schemaVersion !== 1 || p.measurement !== 'PROXY_HTTP_DELAY' || p.perspective !== 'MASTER'
    || !['UPSTREAM_NODE', 'LINE'].includes(String(p.subjectType)) || typeof p.subjectId !== 'string'
    || !['SUCCESS', 'TIMEOUT', 'ERROR', 'UNSUPPORTED', 'ENVIRONMENT_UNAVAILABLE', 'CANCELED', 'STALE', 'SKIPPED'].includes(String(p.status))
    || ![null, 'MIHOMO', 'SINGBOX'].includes(p.engine as string | null)
    || !nullableString(p.engineVersion) || !nullableString(p.fallbackReason) || !nullableString(p.errorCode)
    || !['SUPPORTED', 'UNSUPPORTED'].includes(String(p.mihomoCompatibility))
    || !['UPSTREAM_DIRECT', 'MANAGED_DIRECT', 'MANAGED_RELAY'].includes(String(p.routeKind))
    || !['VALIDATE', 'START_KERNEL', 'DIAL_HTTP', 'PERSIST'].includes(String(p.stage))
    || typeof p.message !== 'string' || typeof p.targetId !== 'string' || typeof p.targetHost !== 'string'
    || typeof p.testedAt !== 'string' || !Number.isFinite(Date.parse(p.testedAt))
    || !finiteNonnegative(p.durationMs) || !(p.latencyMs === null || finiteNonnegative(p.latencyMs))
    || typeof p.configHash !== 'string' || typeof p.applied !== 'boolean'
    || (p.status === 'SUCCESS' && (p.engine === null || p.latencyMs === null))) return null;
  return p as unknown as ProbeResult;
}
export function probeTone(result: Pick<ProbeResult, 'status' | 'engine'>): 'success' | 'warning' | 'danger' | 'muted' {
  if (result.status === 'SUCCESS') return result.engine === 'MIHOMO' ? 'success' : 'warning';
  if (result.status === 'ERROR' || result.status === 'TIMEOUT') return 'danger';
  if (result.status === 'UNSUPPORTED' || result.status === 'ENVIRONMENT_UNAVAILABLE') return 'warning';
  return 'muted';
}
export function kernelCheckPassed(check: KernelCheckResult): boolean {
  return check.executed && check.scope === 'FULL' && check.status === 'PASSED';
}

export function kernelCheckTone(check: KernelCheckResult): 'success' | 'warning' | 'danger' | 'muted' {
  if (kernelCheckPassed(check)) return 'success';
  if (check.status === 'FAILED') return 'danger';
  if (['PASSED', 'UNAVAILABLE', 'UNSUPPORTED', 'EXTERNAL_RESOURCES_REQUIRED'].includes(check.status)) return 'warning';
  return 'muted';
}

const kernelDiagnosticCodes = [
  'INVALID_CONFIG', 'KERNEL_UNAVAILABLE', 'NATIVE_CONFIG_CHECK_FAILED',
  'KERNEL_EXECUTION_UNAVAILABLE', 'KERNEL_TIMEOUT', 'KERNEL_CANCELED',
  'EXTERNAL_RESOURCES_REQUIRED', 'RESOURCE_PREPARATION_FAILED',
  'RESOURCE_AVAILABLE', 'RESOURCE_MISSING', 'RESOURCE_UNREADABLE',
  'RESOURCE_INVALID', 'RESOURCE_UNSUPPORTED', 'REMOTE_RESOURCE_DISABLED',
] as const;

// 旧响应可能包含原始内核日志；仅翻译完整匹配的安全代码，绝不回显原文。
export function kernelDiagnosticCode(code: unknown): typeof kernelDiagnosticCodes[number] | 'UNKNOWN' {
  return kernelDiagnosticCodes.find((known) => known === code) ?? 'UNKNOWN';
}
