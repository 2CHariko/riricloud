import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * 上游订阅解析的共享类型与工具（v0.9.10）。
 *
 * 解析产物统一归一化为"语义化出站参数"（`UpstreamOutboundParams`），
 * 该结构刻意与 `common/inbound.ts` 中的 `InboundTlsConfig` / `InboundTransport`
 * 保持同构，以便直接交给既有的 `buildClientTls` / `buildClientTransport` 组装成
 * Sing-box 客户端出站，避免在任何地方出现第二套协议知识。
 */

/** 可作为上游出口的协议白名单（与 common/upstream-egress.ts 保持一致）。 */
export const UPSTREAM_OUTBOUND_PROTOCOLS = [
  'VLESS',
  'VMESS',
  'TROJAN',
  'HYSTERIA2',
  'TUIC',
  'SHADOWSOCKS',
  'NAIVE'
] as const;
export type UpstreamOutboundProtocol = (typeof UPSTREAM_OUTBOUND_PROTOCOLS)[number];

export function isUpstreamOutboundProtocol(value: string): value is UpstreamOutboundProtocol {
  return (UPSTREAM_OUTBOUND_PROTOCOLS as readonly string[]).includes(value);
}

export type UpstreamTransportType = 'tcp' | 'ws' | 'grpc' | 'http' | 'httpupgrade';

/** 与 `InboundTransport` 同构；tcp 可省略。 */
export type UpstreamTransport = {
  type: UpstreamTransportType;
  path?: string;
  host?: string;
  headers?: Record<string, string>;
  serviceName?: string;
  maxEarlyData?: number;
  earlyDataHeaderName?: string;
};

/** 与 `InboundTlsConfig` 同构。Reality 只携带客户端侧的 publicKey / shortIds。 */
export type UpstreamTls = {
  enabled: boolean;
  mode: 'none' | 'tls' | 'reality';
  serverName?: string;
  alpn?: string[];
  insecure?: boolean;
  reality?: {
    publicKey: string;
    shortIds: string[];
  };
};

/** 归一化后的上游出站参数；凭据字段落库前会被加密。 */
export type UpstreamOutboundParams = {
  uuid?: string;
  password?: string;
  username?: string;
  method?: string;
  mode?: string;
  alterId?: number;
  flow?: string;
  upMbps?: number;
  downMbps?: number;
  obfs?: { type: string; password?: string };
  congestionControl?: string;
  zeroRttHandshake?: boolean;
  network?: string;
  tls: UpstreamTls;
  transport: UpstreamTransport;
};

export type ParsedUpstreamNode = {
  name: string;
  protocolType: UpstreamOutboundProtocol;
  server: string;
  port: number;
  params: UpstreamOutboundParams;
  entryKey: string;
};

/** 跳过原因枚举；面向导入预览 UI，需在 zh-CN 词条中各有对应文案。 */
export type UpstreamSkipReason =
  | 'UNSUPPORTED_PROTOCOL'
  | 'MISSING_SERVER'
  | 'MISSING_CREDENTIAL'
  | 'INVALID_PARAMS'
  | 'DUPLICATE';

export type SkippedUpstreamNode = {
  name: string;
  reason: UpstreamSkipReason;
  detail?: string;
};

export type UpstreamParseResult = {
  nodes: ParsedUpstreamNode[];
  skipped: SkippedUpstreamNode[];
};

/**
 * 稳定标识：**刻意排除全部凭据**。
 *
 * 机场会轮换凭据而不改服务器与端口，把凭据纳入 key 会让每次轮换都产生孤儿条目、
 * 打断已生成线路与流量归属。区分性字段使用 Reality 公钥（每台服务器稳定）
 * 与传输层类型/路径（用于同机多节点区分）。
 */
export function computeEntryKey(input: {
  protocolType: string;
  server: string;
  port: number;
  params: UpstreamOutboundParams;
}): string {
  const transport = input.params.transport;
  const parts = [
    input.protocolType.toUpperCase(),
    input.server.trim().toLowerCase(),
    String(input.port),
    transport.type,
    transport.path ?? '',
    transport.serviceName ?? '',
    input.params.tls.reality?.publicKey ?? '',
    input.params.tls.reality?.shortIds[0] ?? ''
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/** 缺省（无 TLS）参数，避免任何调用方误用入站默认值（VLESS 入站默认是 Reality）。 */
export function emptyUpstreamParams(): UpstreamOutboundParams {
  return {
    tls: { enabled: false, mode: 'none' },
    transport: { type: 'tcp' }
  };
}

export function asTrimmedString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function asPort(value: unknown): number | undefined {
  const raw = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(raw) || raw < 1 || raw > 65535) return undefined;
  return raw;
}

export function asPositiveInt(value: unknown): number | undefined {
  const raw = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(raw) || raw <= 0) return undefined;
  return raw;
}

export function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => asTrimmedString(item)).filter((item): item is string => Boolean(item));
  return items.length ? items : undefined;
}

/** 服务器地址必须是可解析的主机名或 IP；拒绝空值、URL 形态与内嵌凭据。 */
export function isValidUpstreamServer(server: string): boolean {
  if (!server || server.length > 253) return false;
  if (server.includes('://') || server.includes('/') || server.includes('@')) return false;
  if (server.includes(' ')) return false;
  if (isIP(server) !== 0) return true;
  // 域名：至少两段且每段合法
  return /^(?=.{1,253}$)([a-zA-Z0-9_](?:[a-zA-Z0-9_-]{0,61}[a-zA-Z0-9_])?\.)+[a-zA-Z]{2,}$/.test(server);
}

/**
 * 归一化传输层。`network` 为 Clash 的开关值，其余字段按各自命名的变体解析。
 */
export function normalizeUpstreamTransport(input: {
  network?: unknown;
  path?: unknown;
  host?: unknown;
  headers?: unknown;
  serviceName?: unknown;
  maxEarlyData?: unknown;
  earlyDataHeaderName?: unknown;
}): UpstreamTransport {
  const rawNetwork = (asTrimmedString(input.network) ?? 'tcp').toLowerCase();
  const network: UpstreamTransportType = rawNetwork === 'h2' || rawNetwork === 'http'
    ? 'http'
    : rawNetwork === 'ws' || rawNetwork === 'grpc' || rawNetwork === 'httpupgrade'
      ? rawNetwork
      : 'tcp';

  const transport: UpstreamTransport = { type: 'tcp' };
  if (network === 'tcp') return transport;
  transport.type = network;

  const path = asTrimmedString(input.path);
  if (path) transport.path = path;
  const host = asTrimmedString(input.host);
  if (host) transport.host = host;
  const serviceName = asTrimmedString(input.serviceName);
  if (serviceName) transport.serviceName = serviceName;
  const maxEarlyData = asPositiveInt(input.maxEarlyData);
  if (maxEarlyData) transport.maxEarlyData = maxEarlyData;
  const earlyDataHeaderName = asTrimmedString(input.earlyDataHeaderName);
  if (earlyDataHeaderName) transport.earlyDataHeaderName = earlyDataHeaderName;

  if (input.headers && typeof input.headers === 'object' && !Array.isArray(input.headers)) {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.headers as Record<string, unknown>)) {
      const text = asTrimmedString(value);
      if (text && typeof key === 'string' && key.trim()) headers[key.trim()] = text;
    }
    if (Object.keys(headers).length) transport.headers = headers;
  }
  return transport;
}

/**
 * 归一化 TLS/Reality。`enabled` 必须由调用方显式判定：
 * 此处不接受任何"缺省即开启"的推断，避免把明文上游误判成 Reality。
 */
export function normalizeUpstreamTls(input: {
  enabled?: unknown;
  realityPublicKey?: unknown;
  shortId?: unknown;
  serverName?: unknown;
  alpn?: unknown;
  insecure?: unknown;
}): UpstreamTls {
  const publicKey = asTrimmedString(input.realityPublicKey);
  const shortIds = asStringArray(input.shortId);
  const serverName = asTrimmedString(input.serverName);
  const alpn = asStringArray(input.alpn);
  const insecure = asBoolean(input.insecure) === true;

  if (publicKey) {
    return {
      enabled: true,
      mode: 'reality',
      ...(serverName ? { serverName } : {}),
      ...(insecure ? { insecure } : {}),
      reality: { publicKey, shortIds: shortIds ?? [] }
    };
  }

  const enabled = asBoolean(input.enabled) === true || Boolean(serverName);
  if (!enabled) return { enabled: false, mode: 'none' };

  return {
    enabled: true,
    mode: 'tls',
    ...(serverName ? { serverName } : {}),
    ...(alpn ? { alpn } : {}),
    ...(insecure ? { insecure } : {})
  };
}

/**
 * 同服务器 + 同端口的重复条目去重。
 * 名称冲突由 `parseUpstreamContent` 统一收口处理，此处只负责丢弃完全同 key 的重复项。
 */
export function dedupeParsedNodes(result: UpstreamParseResult): UpstreamParseResult {
  const seen = new Set<string>();
  const nodes: ParsedUpstreamNode[] = [];
  const skipped = [...result.skipped];
  for (const node of result.nodes) {
    if (seen.has(node.entryKey)) {
      skipped.push({ name: node.name, reason: 'DUPLICATE', detail: `${node.server}:${node.port}` });
      continue;
    }
    seen.add(node.entryKey);
    nodes.push(node);
  }
  return { nodes, skipped };
}
