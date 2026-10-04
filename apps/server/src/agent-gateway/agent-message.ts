import { isIP } from 'node:net';

// Master ↔ Agent WS 消息帧（契约见 docs/API_AND_PROTOCOLS.md §WS 协议）
export type AgentMessageType =
  | 'auth_result'
  | 'config_sync'
  | 'config_apply_result'
  | 'heartbeat'
  | 'upgrade_task'
  | 'upgrade_result'
  | 'probe_task'
  | 'probe_result'
  | 'restart_agent_task'
  | 'restart_agent_result'
  | 'kick_devices_result'
  | 'log_report'
  | 'mirror_request'
  | 'mirror_cancel'
  | 'mirror_response_headers'
  | 'mirror_response_end'
  | 'mirror_error';

export const AGENT_PROTOCOL_VERSION = 2;

export type AgentTransportMode = 'WS' | 'HTTP';

export interface AgentMessage<T = unknown> {
  type: AgentMessageType;
  data: T;
}

export interface AuthResultData {
  success: boolean;
  message: string;
  nodeId: string | null;
  protocolVersion: number;
}

export interface HeartbeatTrafficSnapshot {
  userUuid: string;
  uploadTotal: string;
  downloadTotal: string;
}

export interface AgentOnlineDeviceReportItem {
  userUuid: string;
  ip: string;
  lineId?: string;
  connections: number;
  lastSeenAt: number;
}

export interface HeartbeatData {
  protocolVersion: number;
  cpuUsage: number;
  memoryUsage: number;
  bandwidthRate: number;
  trafficSnapshots: HeartbeatTrafficSnapshot[];
  // 可选字段：拆分后的节点网卡上行/下行速率（bytes/s），旧版 Agent 不上报
  uploadRate?: number;
  downloadRate?: number;
  // 可选字段（v0.3.0，向后兼容：旧版 Agent 不上报）
  kernelRunning?: boolean; // 内核进程存活
  appliedConfigVersion?: number; // 当前生效配置版本
  lastError?: string; // 最近一次失败原因（check 失败/启动失败/异常退出 stderr 尾部）
  agentVersion?: string; // Agent 编译版本
  osArch?: string; // Agent 运行平台与架构
  kernelVersion?: string; // sing-box 内核版本
  capabilities?: string[]; // Agent 能力列表
  onlineDevices?: AgentOnlineDeviceReportItem[];
}

export interface MirrorRequestData {
  taskId: string;
  method: 'GET' | 'HEAD';
  url: string;
  allowedHosts: string[];
  requestHeaders: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
}

export interface MirrorResponseHeadersData {
  taskId: string;
  statusCode: number;
  headers: Record<string, string>;
  contentLength?: number;
  finalHost: string;
}

export interface MirrorResponseEndData {
  taskId: string;
  bytes: number;
  success: boolean;
}

export interface MirrorErrorData {
  taskId: string;
  code: string;
  message: string;
}

// config_sync 的处理回执（Agent -> Master，v0.3.0）
export interface ConfigApplyResultData {
  version: number;
  success: boolean;
  message: string;
}

export interface TunnelPortMapping {
  lineId: string;
  localPort: number;
  targetPort: number;
}

export interface TunnelConfigPayload {
  id: string;
  role: 'SERVER' | 'CLIENT';
  listenPort?: number;
  serverAddr?: string;
  secret: string;
  mappings: TunnelPortMapping[];
}

export type SingboxLogCaptureLevel = 'WARN' | 'INFO' | 'DEBUG';

export interface AgentLogRotationConfig {
  maxSizeMb: number;
  maxFiles: number;
}

export interface ConfigSyncData {
  version: number;
  singboxConfig: Record<string, unknown>;
  // 可选字段：旧版 Agent 忽略该字段，默认仅保留 WARN/ERROR。
  singboxLogCaptureLevel?: SingboxLogCaptureLevel;
  // 可选字段：旧版 Agent 忽略该字段，使用本地日志配置。
  agentLogRotation?: AgentLogRotationConfig;
  tunnelConfigs?: TunnelConfigPayload[];
  portSpeedLimits?: Record<number, number>;
  userDeviceLimits?: Record<string, number>;
}

export type UpgradeTarget = 'singbox' | 'agent';

export interface UpgradeTaskData {
  taskId: string;
  target: UpgradeTarget;
  version: string;
  url: string;
  sha256: string;
  resourceId?: string;
  assetId?: string;
  operation?: 'UPGRADE' | 'ROLLBACK';
  files?: UpgradeFileData[];
}

export interface UpgradeFileData {
  name: string;
  role?: 'main' | 'auxiliary';
  url: string;
  sha256: string;
  size?: number;
}

export interface UpgradeResultData {
  taskId: string;
  target: UpgradeTarget;
  version: string;
  success: boolean;
  message: string;
}

export type ProbeType = 'tcp' | 'dns' | 'icmp';

export interface ProbeRequest {
  type: ProbeType;
  target: string;
  port?: number;
  timeoutMs?: number;
}

export interface ProbeTaskData {
  taskId: string;
  probes: ProbeRequest[];
}

export interface ProbeResult {
  type: ProbeType;
  target: string;
  success: boolean;
  latencyMs?: number;
  addresses?: string[];
  packetLossPercent?: number;
  message?: string;
}

export interface ProbeResultData {
  taskId: string;
  success: boolean;
  results: ProbeResult[];
}

export interface RestartAgentTaskData {
  taskId: string;
}

export interface KickDevicesTaskData {
  taskId: string;
  items: Array<{ userUuid: string; ip?: string; blockDurationSecs?: number }>;
}

export interface RestartAgentResultData {
  taskId: string;
  success: boolean;
  message: string;
}

export interface KickDevicesResultData {
  taskId: string;
  success: boolean;
  message: string;
  kickedConnections: number;
}

export type AgentTaskMessage =
  | { type: 'upgrade_task'; data: UpgradeTaskData }
  | { type: 'probe_task'; data: ProbeTaskData }
  | { type: 'restart_agent_task'; data: RestartAgentTaskData }
  | { type: 'kick_devices_task'; data: KickDevicesTaskData }
  | { type: 'diagnostics_snapshot_task'; data: { taskId: string; timeoutMs: number } };

export interface AgentPollResponse {
  protocolVersion: number;
  needUpdate: boolean;
  version: number;
  singboxConfig: Record<string, unknown> | null;
  singboxLogCaptureLevel?: SingboxLogCaptureLevel;
  agentLogRotation?: AgentLogRotationConfig;
  tunnelConfigs?: TunnelConfigPayload[];
  portSpeedLimits?: Record<number, number>;
  userDeviceLimits?: Record<string, number>;
  tasks: AgentTaskMessage[];
  nextPollSecs: number;
}

export interface AgentLogItem {
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  module: string;
  source?: 'AGENT' | 'SINGBOX';
  message: string;
  metadata?: Record<string, unknown>;
  occurredAt?: string;
  sequence?: number;
  agentInstanceId?: string;
}

export interface LogReportData {
  logs: AgentLogItem[];
}

export type AgentInboundMessage =
  | AgentMessage<HeartbeatData> & { type: 'heartbeat' }
  | AgentMessage<ConfigApplyResultData> & { type: 'config_apply_result' }
  | AgentMessage<UpgradeResultData> & { type: 'upgrade_result' }
  | AgentMessage<ProbeResultData> & { type: 'probe_result' }
  | AgentMessage<RestartAgentResultData> & { type: 'restart_agent_result' }
  | AgentMessage<KickDevicesResultData> & { type: 'kick_devices_result' }
  | AgentMessage<LogReportData> & { type: 'log_report' }
  | AgentMessage<MirrorResponseHeadersData> & { type: 'mirror_response_headers' }
  | AgentMessage<MirrorResponseEndData> & { type: 'mirror_response_end' }
  | AgentMessage<MirrorErrorData> & { type: 'mirror_error' };

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maxLength = 8192): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const MAX_UINT64 = 18446744073709551615n;

function isUint64String(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value)) return false;
  try {
    return BigInt(value) <= MAX_UINT64;
  } catch {
    return false;
  }
}

function isProbeType(value: unknown): value is ProbeType {
  return value === 'tcp' || value === 'dns' || value === 'icmp';
}

function isHeartbeatData(value: unknown): value is HeartbeatData {
  if (!isJsonObject(value)) return false;
  if (value.protocolVersion !== AGENT_PROTOCOL_VERSION) return false;
  if (!isFiniteNumber(value.cpuUsage) || value.cpuUsage < 0 || value.cpuUsage > 100) return false;
  if (!isFiniteNumber(value.memoryUsage) || value.memoryUsage < 0 || value.memoryUsage > 100) return false;
  if (!isFiniteNumber(value.bandwidthRate) || value.bandwidthRate < 0) return false;
  if (value.uploadRate !== undefined && (!isFiniteNumber(value.uploadRate) || value.uploadRate < 0)) return false;
  if (value.downloadRate !== undefined && (!isFiniteNumber(value.downloadRate) || value.downloadRate < 0)) return false;
  if (!Array.isArray(value.trafficSnapshots) || value.trafficSnapshots.length > 1024) return false;
  if (
    value.kernelRunning !== undefined &&
    typeof value.kernelRunning !== 'boolean'
  ) return false;
  if (
    value.appliedConfigVersion !== undefined &&
    !isSafeNonNegativeInteger(value.appliedConfigVersion)
  ) return false;
  if (value.lastError !== undefined && (typeof value.lastError !== 'string' || value.lastError.length > 8192)) {
    return false;
  }
  if (value.agentVersion !== undefined && value.agentVersion !== '' && !isNonEmptyString(value.agentVersion, 128)) return false;
  if (value.osArch !== undefined && value.osArch !== '' && !isNonEmptyString(value.osArch, 128)) return false;
  if (value.kernelVersion !== undefined && value.kernelVersion !== '' && !isNonEmptyString(value.kernelVersion, 128)) return false;
  if (value.capabilities !== undefined && (!Array.isArray(value.capabilities) || value.capabilities.length > 32 || !value.capabilities.every((item) => isNonEmptyString(item, 64)))) return false;
  if (value.onlineDevices !== undefined && (!Array.isArray(value.onlineDevices) || value.onlineDevices.length > 1024 || !value.onlineDevices.every(isOnlineDeviceReportItem))) return false;
  return value.trafficSnapshots.every((record) => {
    if (!isJsonObject(record)) return false;
    return (
      isNonEmptyString(record.userUuid, 256) &&
      isUint64String(record.uploadTotal) &&
      isUint64String(record.downloadTotal)
    );
  });
}

function isOnlineDeviceReportItem(value: unknown): value is AgentOnlineDeviceReportItem {
  if (!isJsonObject(value) || !isNonEmptyString(value.userUuid, 256) || !isNonEmptyString(value.ip, 64)) return false;
  if (value.lineId !== undefined && !isNonEmptyString(value.lineId, 128)) return false;
  return isSafeNonNegativeInteger(value.connections) && value.connections <= 1_000_000 &&
    isSafeNonNegativeInteger(value.lastSeenAt) && value.lastSeenAt <= Math.floor(Date.now() / 1000) + 300 && isIP(value.ip) !== 0;
}

function isConfigApplyResultData(value: unknown): value is ConfigApplyResultData {
  return (
    isJsonObject(value) &&
    isSafeNonNegativeInteger(value.version) &&
    typeof value.success === 'boolean' &&
    typeof value.message === 'string' &&
    value.message.length <= 8192
  );
}

function isUpgradeResultData(value: unknown): value is UpgradeResultData {
  return (
    isJsonObject(value) &&
    isNonEmptyString(value.taskId, 128) &&
    (value.target === 'singbox' || value.target === 'agent') &&
    isNonEmptyString(value.version, 128) &&
    typeof value.success === 'boolean' &&
    typeof value.message === 'string' &&
    value.message.length <= 8192
  );
}

function isProbeResultData(value: unknown): value is ProbeResultData {
  if (!isJsonObject(value) || !isNonEmptyString(value.taskId, 128) || typeof value.success !== 'boolean') {
    return false;
  }
  if (!Array.isArray(value.results) || value.results.length > 8) return false;
  return value.results.every((result) => {
    if (!isJsonObject(result)) return false;
    if (!isProbeType(result.type) || !isNonEmptyString(result.target, 1024) || typeof result.success !== 'boolean') {
      return false;
    }
    return (
      (result.latencyMs === undefined || isSafeNonNegativeInteger(result.latencyMs)) &&
      (result.packetLossPercent === undefined || (isFiniteNumber(result.packetLossPercent) && result.packetLossPercent >= 0 && result.packetLossPercent <= 100)) &&
      (result.addresses === undefined || (Array.isArray(result.addresses) && result.addresses.length <= 16 && result.addresses.every((address) => isNonEmptyString(address, 256)))) &&
      (result.message === undefined || (typeof result.message === 'string' && result.message.length <= 8192))
    );
  });
}

function isKickDevicesResultData(value: unknown): value is KickDevicesResultData {
  return isJsonObject(value) && isNonEmptyString(value.taskId, 128) && typeof value.success === 'boolean' && typeof value.message === 'string' && value.message.length <= 1024 && isSafeNonNegativeInteger(value.kickedConnections);
}

function isRestartAgentResultData(value: unknown): value is RestartAgentResultData {
  return (
    isJsonObject(value) &&
    isNonEmptyString(value.taskId, 128) &&
    typeof value.success === 'boolean' &&
    typeof value.message === 'string' &&
    value.message.length <= 8192
  );
}

function isMirrorResponseHeadersData(value: unknown): value is MirrorResponseHeadersData {
  if (!isJsonObject(value) || !isNonEmptyString(value.taskId, 128) || !isSafeNonNegativeInteger(value.statusCode) || !isNonEmptyString(value.finalHost, 256)) return false;
  if (value.contentLength !== undefined && !isSafeNonNegativeInteger(value.contentLength)) return false;
  return isJsonObject(value.headers) && Object.keys(value.headers).length <= 64 && Object.entries(value.headers).every(([key, item]) => key.length <= 128 && typeof item === 'string' && item.length <= 8192);
}

function isMirrorResponseEndData(value: unknown): value is MirrorResponseEndData {
  return isJsonObject(value) && isNonEmptyString(value.taskId, 128) && isSafeNonNegativeInteger(value.bytes) && typeof value.success === 'boolean';
}

function isMirrorErrorData(value: unknown): value is MirrorErrorData {
  return isJsonObject(value) && isNonEmptyString(value.taskId, 128) && isNonEmptyString(value.code, 64) && typeof value.message === 'string' && value.message.length <= 1024;
}

export function isLogReportData(value: unknown, maxItems = 50): value is LogReportData {
  if (!isJsonObject(value) || !Array.isArray(value.logs)) return false;
  if (value.logs.length > maxItems) return false;
  let totalBytes = 0;
  return value.logs.every((item) => {
    if (!isJsonObject(item)) return false;
    const validLevel = ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(item.level as string);
    const validMessage = typeof item.message === 'string' && item.message.length <= 8192;
    const validModule = typeof item.module === 'string' && item.module.length <= 128;
    const validSource = item.source === undefined || item.source === 'AGENT' || item.source === 'SINGBOX';
    const validMetadata = item.metadata === undefined || isSafeMetadata(item.metadata);
    const validTime = item.occurredAt === undefined || (typeof item.occurredAt === 'string' && item.occurredAt.length <= 64 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(item.occurredAt) && Number.isFinite(Date.parse(item.occurredAt)));
    const validSequence = item.sequence === undefined || isSafeNonNegativeInteger(item.sequence);
    const validInstance = item.agentInstanceId === undefined || isNonEmptyString(item.agentInstanceId, 128);
    if (item.metadata !== undefined) totalBytes += Buffer.byteLength(JSON.stringify(item.metadata), 'utf8');
    if (validMessage) totalBytes += Buffer.byteLength(item.message as string, 'utf8');
    if (validModule) totalBytes += Buffer.byteLength(item.module as string, 'utf8');
    return validLevel && validMessage && validModule && validSource && validMetadata && validTime && validSequence && validInstance && totalBytes <= 64 * 1024;
  });
}

function isSafeMetadata(value: unknown, depth = 0): boolean {
  if (depth > 5) return false;
  if (value === null) return true;
  if (typeof value !== 'object') return typeof value === 'string' ? value.length <= 4096 : typeof value === 'boolean' || isFiniteNumber(value);
  if (Array.isArray(value) && value.length > 100) return false;
  if (!Array.isArray(value) && Object.keys(value).length > 100) return false;
  const entries = Array.isArray(value) ? value : Object.entries(value);
  return entries.every((item) => {
    if (Array.isArray(value)) return isSafeMetadata(item, depth + 1);
    const [key, child] = item as [string, unknown];
    return key.length <= 128 && isSafeMetadata(child, depth + 1);
  });
}

// 解析并校验 Agent 上行消息，避免类型断言绕过外部输入校验。
export function parseAgentInboundMessage(raw: string): AgentInboundMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isJsonObject(parsed) || !isJsonObject(parsed.data) || typeof parsed.type !== 'string') {
    return null;
  }

  switch (parsed.type) {
    case 'heartbeat':
      return isHeartbeatData(parsed.data)
        ? { type: parsed.type, data: parsed.data }
        : null;
    case 'config_apply_result':
      return isConfigApplyResultData(parsed.data)
        ? { type: parsed.type, data: parsed.data }
        : null;
    case 'upgrade_result':
      return isUpgradeResultData(parsed.data)
        ? { type: parsed.type, data: parsed.data }
        : null;
    case 'probe_result':
      return isProbeResultData(parsed.data)
        ? { type: parsed.type, data: parsed.data }
        : null;
    case 'restart_agent_result':
      return isRestartAgentResultData(parsed.data)
        ? { type: parsed.type, data: parsed.data }
        : null;
    case 'kick_devices_result':
      return isKickDevicesResultData(parsed.data)
        ? { type: parsed.type, data: parsed.data }
        : null;
    case 'log_report':
      return isLogReportData(parsed.data)
        ? { type: parsed.type, data: parsed.data }
        : null;
    case 'mirror_response_headers':
      return isMirrorResponseHeadersData(parsed.data)
        ? { type: parsed.type, data: parsed.data }
        : null;
    case 'mirror_response_end':
      return isMirrorResponseEndData(parsed.data)
        ? { type: parsed.type, data: parsed.data }
        : null;
    case 'mirror_error':
      return isMirrorErrorData(parsed.data)
        ? { type: parsed.type, data: parsed.data }
        : null;
    default:
      return null;
  }
}
