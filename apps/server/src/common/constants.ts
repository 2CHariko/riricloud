// 角色与节点状态常量（SQLite 无 enum，应用层以此校验，见 docs/DATA_MODELS.md）
export const ROLES = ['ADMIN', 'USER'] as const;
export type Role = (typeof ROLES)[number];

export const NODE_STATUSES = ['ONLINE', 'OFFLINE', 'DISABLED'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const PROTOCOL_TYPES = [
  'VLESS',
  'VMESS',
  'TROJAN',
  'HYSTERIA2',
  'TUIC',
  'SHADOWSOCKS',
  'NAIVE',
  'SHADOWTLS',
  'MIXED',
  'SOCKS',
  'HTTP',
  'DIRECT'
] as const;
export type ProtocolType = (typeof PROTOCOL_TYPES)[number];

export const LINE_TYPES = ['DIRECT', 'RELAY', 'EXTERNAL'] as const;
export type LineType = (typeof LINE_TYPES)[number];

export const RELAY_MODES = ['BLIND_FORWARD', 'PROTOCOL_PROXY', 'TARGET_LINE', 'UPSTREAM_NODE'] as const;
export type RelayMode = (typeof RELAY_MODES)[number];

// 入站用户凭证与线路 ID 的复合分隔符（用于 Sing-box 原生按线路区分用户流量）
export const TRAFFIC_CREDENTIAL_DELIMITER = '::';

// 可被协议重加密中继或目标线路桥接作为出口的协议；纯本地代理和传输层协议没有对应的统一出站。
export const PROTOCOL_PROXY_TARGET_TYPES = [
  'VLESS',
  'VMESS',
  'TROJAN',
  'HYSTERIA2',
  'TUIC',
  'SHADOWSOCKS',
  'NAIVE'
] as const;
export type ProtocolProxyTargetType = (typeof PROTOCOL_PROXY_TARGET_TYPES)[number];

export const LINE_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];

// 心跳超时判定：超过该秒数未见心跳即视为离线
export const HEARTBEAT_TIMEOUT_SECONDS = 30;

// ==============================
// 上游订阅常量
// ==============================
export const UPSTREAM_SOURCE_TYPES = ['URL', 'TEXT'] as const;
export type UpstreamSourceType = (typeof UPSTREAM_SOURCE_TYPES)[number];

export const UPSTREAM_FORMATS = ['AUTO', 'CLASH_META', 'SINGBOX', 'URI_LIST'] as const;
export type UpstreamFormat = (typeof UPSTREAM_FORMATS)[number];

export const UPSTREAM_SYNC_STATUSES = ['PENDING', 'SUCCESS', 'FAILED'] as const;
export type UpstreamSyncStatus = (typeof UPSTREAM_SYNC_STATUSES)[number];

export const UPSTREAM_NODE_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type UpstreamNodeStatus = (typeof UPSTREAM_NODE_STATUSES)[number];
