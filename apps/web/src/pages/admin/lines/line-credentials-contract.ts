import { z } from 'zod';
import type { ApiLine } from '@/lib/api';

export type CredentialLine = Pick<ApiLine, 'id' | 'name' | 'type' | 'relayMode' | 'status'>;
export const credentialStates = ['NOT_INITIALIZED', 'UNAVAILABLE', 'STOPPING_PREVIOUS_ENTRY', 'STOPPING_ENTRY', 'APPLYING_LANDING', 'RESTORING_ENTRY', 'RETIRING_PREVIOUS_LANDING', 'CONFIRMED', 'FAILED'] as const;
export type CredentialState = typeof credentialStates[number];

export const credentialErrorKeys = {
  LINE_NOT_FOUND: 'notFound',
  LINE_CREDENTIAL_UNSUPPORTED: 'unsupported',
  LINE_CREDENTIAL_LINE_INACTIVE: 'inactive',
  LINE_CREDENTIAL_TARGET_UNAVAILABLE: 'targetUnavailable',
  LINE_CREDENTIAL_CONFIG_OVERRIDE: 'configOverride',
  LINE_CREDENTIAL_SHARED_TARGET_UNSUPPORTED: 'sharedTargetUnsupported',
  LINE_CREDENTIAL_PUBLIC_TLS_REQUIRED: 'publicTlsRequired',
  LINE_CREDENTIAL_TOPOLOGY_CHANGED: 'topologyChanged',
  LINE_CREDENTIAL_INITIALIZATION_FAILED: 'initializationFailed',
  LINE_CREDENTIAL_CONFIGURATION_INVALID: 'configurationInvalid',
  LINE_CREDENTIAL_UNAVAILABLE: 'credentialUnavailable',
  LINE_CREDENTIAL_MAINTENANCE_IN_PROGRESS: 'maintenanceInProgress',
  LINE_CREDENTIAL_INVALID_RESPONSE: 'invalidResponse',
  AGENT_REJECTED: 'agentRejected',
  STAGE_TIMEOUT: 'stageTimeout',
  KERNEL_NOT_RUNNING: 'kernelNotRunning',
  UNKNOWN: 'unknownFailure'
} as const;
export type CredentialErrorCode = keyof typeof credentialErrorKeys;

export function credentialErrorCode(value: unknown): CredentialErrorCode | null {
  return typeof value === 'string' && Object.hasOwn(credentialErrorKeys, value)
    ? value as CredentialErrorCode : null;
}

const statusSchema = z.object({
  lineId: z.string().uuid(),
  operationId: z.string().uuid().nullable(),
  state: z.enum(credentialStates),
  activeVersion: z.number().int().positive().nullable(),
  targetVersion: z.number().int().positive().nullable(),
  errorCode: z.string().nullable().transform(value => value === null ? null : credentialErrorCode(value) ?? 'UNKNOWN'),
  failedStage: z.enum(credentialStates).nullish(),
  entryNodeId: z.string().uuid().nullish(),
  landingNodeId: z.string().uuid().nullish(),
  previousEntryNodeId: z.string().uuid().nullish(),
  previousLandingNodeId: z.string().uuid().nullish(),
  entryStopConfirmed: z.boolean(),
  accepted: z.boolean(),
  deadlineAt: z.string().datetime({ offset: true }).nullish(),
  confirmedAt: z.string().datetime({ offset: true }).nullable()
});
export type LineCredentialStatus = z.infer<typeof statusSchema>;

export function isCredentialLine(line: CredentialLine): boolean {
  return line.type === 'RELAY' && (line.relayMode === 'PROTOCOL_PROXY' || line.relayMode === 'TARGET_LINE');
}

export function isCredentialMaintenanceRunning(state?: CredentialState): boolean {
  return state === 'STOPPING_PREVIOUS_ENTRY' || state === 'STOPPING_ENTRY' || state === 'APPLYING_LANDING'
    || state === 'RESTORING_ENTRY' || state === 'RETIRING_PREVIOUS_LANDING';
}

export function parseLineCredentialStatus(value: unknown, lineId: string): LineCredentialStatus {
  // 先去除未声明字段，未知错误不携带服务端原文进入缓存或界面。
  const parsed = statusSchema.safeParse(value);
  if (!parsed.success || parsed.data.lineId !== lineId) throw new Error('LINE_CREDENTIAL_INVALID_RESPONSE');
  const data = parsed.data;
  if ((isCredentialMaintenanceRunning(data.state) || data.state === 'FAILED' || data.state === 'CONFIRMED') && (!data.operationId || !data.targetVersion)) {
    throw new Error('LINE_CREDENTIAL_INVALID_RESPONSE');
  }
  if (data.state === 'CONFIRMED' && (!data.confirmedAt || data.activeVersion !== data.targetVersion)) {
    throw new Error('LINE_CREDENTIAL_INVALID_RESPONSE');
  }
  return data;
}

export function canMaintainLineCredentials(line: CredentialLine, status?: LineCredentialStatus): boolean {
  if (!isCredentialLine(line) || line.status !== 'ACTIVE' || !status || status.lineId !== line.id) return false;
  return status.state === 'FAILED' || ((status.state === 'NOT_INITIALIZED' || status.state === 'CONFIRMED') && !status.errorCode);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function credentialErrorKey(error: unknown) {
  const failure = record(error);
  const response = record(failure.response);
  if (response.status === 401) return 'unauthorized';
  if (response.status === 403) return 'forbidden';
  if (response.status === 404) return 'notFound';
  const data = record(response.data);
  const code = credentialErrorCode(data.code) ?? credentialErrorCode(data.message) ?? credentialErrorCode(failure.message);
  return code ? credentialErrorKeys[code] : 'requestFailed';
}

export function parseCredentialJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

export function credentialResponseErrorCode(value: unknown): CredentialErrorCode {
  const data = record(value);
  return credentialErrorCode(data.code) ?? credentialErrorCode(data.message) ?? 'UNKNOWN';
}
