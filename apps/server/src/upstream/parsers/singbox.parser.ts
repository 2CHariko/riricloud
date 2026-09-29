import {
  asBoolean,
  asPort,
  asPositiveInt,
  asStringArray,
  asTrimmedString,
  computeEntryKey,
  dedupeParsedNodes,
  emptyUpstreamParams,
  isUpstreamOutboundProtocol,
  isValidUpstreamServer,
  normalizeUpstreamTls,
  normalizeUpstreamTransport,
  type ParsedUpstreamNode,
  type SkippedUpstreamNode,
  type UpstreamOutboundParams,
  type UpstreamParseResult
} from './types';

/**
 * Sing-box 出站解析器。
 *
 * 输入：已解析的 `outbounds[]` 数组。跳过 `direct` / `block` / `dns` / `selector` /
 * `urltest` 等非代理出站，以及 `shadowsocksr` / `wireguard` / `tor` / `ssh` 等
 * RiriCloud 没有对应出站的类型。
 */
export function parseSingboxOutbounds(rawOutbounds: unknown): UpstreamParseResult {
  if (!Array.isArray(rawOutbounds)) {
    return { nodes: [], skipped: [] };
  }

  const nodes: ParsedUpstreamNode[] = [];
  const skipped: SkippedUpstreamNode[] = [];

  for (const raw of rawOutbounds) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const outbound = raw as Record<string, unknown>;
    const name = asTrimmedString(outbound.tag) ?? '未命名节点';

    const type = (asTrimmedString(outbound.type) ?? '').toLowerCase();
    const protocolType = SINGBOX_TYPE_MAP[type];
    if (!protocolType) {
      // 结构性出站（direct/block/selector/urltest/dns）不是错误，只是不导入
      if (!STRUCTURAL_OUTBOUND_TYPES.has(type)) {
        skipped.push({ name, reason: 'UNSUPPORTED_PROTOCOL', detail: type || '(缺少 type)' });
      }
      continue;
    }

    const server = asTrimmedString(outbound.server);
    if (!server || !isValidUpstreamServer(server)) {
      skipped.push({ name, reason: 'MISSING_SERVER', detail: server ?? '(缺少 server)' });
      continue;
    }
    const port = asPort(outbound.server_port ?? outbound.port);
    if (!port) {
      skipped.push({ name, reason: 'INVALID_PARAMS', detail: '端口无效' });
      continue;
    }

    const parsed = buildParams(protocolType, outbound);
    if ('reason' in parsed) {
      skipped.push({ name, reason: parsed.reason, detail: parsed.detail });
      continue;
    }

    nodes.push({
      name,
      protocolType,
      server,
      port,
      params: parsed.params,
      entryKey: computeEntryKey({ protocolType, server, port, params: parsed.params })
    });
  }

  return dedupeParsedNodes({ nodes, skipped });
}

const SINGBOX_TYPE_MAP: Record<string, ParsedUpstreamNode['protocolType']> = {
  vless: 'VLESS',
  vmess: 'VMESS',
  trojan: 'TROJAN',
  hysteria2: 'HYSTERIA2',
  tuic: 'TUIC',
  shadowsocks: 'SHADOWSOCKS',
  naive: 'NAIVE'
};

/** 非代理出站：静默跳过，不计入跳过清单，避免污染导入预览。 */
const STRUCTURAL_OUTBOUND_TYPES = new Set([
  'direct',
  'block',
  'dns',
  'selector',
  'urltest',
  'socks',
  'http',
  'mixed'
]);

type ParamsResult =
  | { params: UpstreamOutboundParams }
  | { reason: SkippedUpstreamNode['reason']; detail?: string };

function buildParams(
  protocolType: ParsedUpstreamNode['protocolType'],
  outbound: Record<string, unknown>
): ParamsResult {
  const params = emptyUpstreamParams();

  const tlsObject = asObject(outbound.tls);
  const realityObject = asObject(tlsObject?.reality);
  const tls = normalizeUpstreamTls({
    enabled: tlsObject ? asBoolean(tlsObject.enabled) !== false : false,
    realityPublicKey: realityObject?.public_key ?? realityObject?.publicKey,
    shortId: realityObject?.short_id ?? realityObject?.shortId,
    serverName: tlsObject?.server_name ?? tlsObject?.serverName,
    alpn: tlsObject?.alpn,
    insecure: tlsObject?.insecure
  });
  params.tls = tls;

  const transportObject = asObject(outbound.transport);
  params.transport = normalizeUpstreamTransport({
    network: transportObject?.type,
    path: transportObject?.path,
    // sing-box 的 WebSocket Host 落在 headers.Host；HTTPUpgrade 用顶层 host
    host: transportObject?.host ?? firstHeaderHost(transportObject?.headers),
    headers: transportObject?.headers,
    serviceName: transportObject?.service_name ?? transportObject?.serviceName,
    maxEarlyData: transportObject?.max_early_data ?? transportObject?.maxEarlyData,
    earlyDataHeaderName: transportObject?.early_data_header_name ?? transportObject?.earlyDataHeaderName
  });

  switch (protocolType) {
    case 'VLESS': {
      const uuid = asTrimmedString(outbound.uuid);
      if (!uuid) return { reason: 'MISSING_CREDENTIAL', detail: '缺少 uuid' };
      params.uuid = uuid;
      const flow = asTrimmedString(outbound.flow);
      if (flow) params.flow = flow;
      return { params };
    }

    case 'VMESS': {
      const uuid = asTrimmedString(outbound.uuid);
      if (!uuid) return { reason: 'MISSING_CREDENTIAL', detail: '缺少 uuid' };
      params.uuid = uuid;
      params.alterId = asPositiveInt(outbound.alter_id ?? outbound.alterId) ?? 0;
      return { params };
    }

    case 'TROJAN': {
      const password = asTrimmedString(outbound.password);
      if (!password) return { reason: 'MISSING_CREDENTIAL', detail: '缺少 password' };
      params.password = password;
      return { params };
    }

    case 'HYSTERIA2': {
      const password = asTrimmedString(outbound.password);
      if (!password) return { reason: 'MISSING_CREDENTIAL', detail: '缺少 password' };
      params.password = password;
      const upMbps = asPositiveInt(outbound.up_mbps ?? outbound.upMbps);
      const downMbps = asPositiveInt(outbound.down_mbps ?? outbound.downMbps);
      if (upMbps) params.upMbps = upMbps;
      if (downMbps) params.downMbps = downMbps;
      const obfs = asObject(outbound.obfs);
      const obfsPassword = asTrimmedString(obfs?.password);
      if (obfsPassword) {
        params.obfs = { type: asTrimmedString(obfs?.type) ?? 'salamander', password: obfsPassword };
      }
      return { params };
    }

    case 'TUIC': {
      const uuid = asTrimmedString(outbound.uuid);
      const password = asTrimmedString(outbound.password);
      if (!uuid && !password) return { reason: 'MISSING_CREDENTIAL', detail: '缺少 uuid 与 password' };
      if (uuid) params.uuid = uuid;
      if (password) params.password = password;
      const congestion = asTrimmedString(outbound.congestion_control ?? outbound.congestionControl);
      if (congestion) params.congestionControl = congestion;
      const zeroRtt = asBoolean(outbound.zero_rtt_handshake ?? outbound.zeroRttHandshake);
      if (zeroRtt !== undefined) params.zeroRttHandshake = zeroRtt;
      return { params };
    }

    case 'SHADOWSOCKS': {
      const method = asTrimmedString(outbound.method);
      const password = asTrimmedString(outbound.password);
      if (!method) return { reason: 'INVALID_PARAMS', detail: '缺少 method' };
      if (!password) return { reason: 'MISSING_CREDENTIAL', detail: '缺少 password' };
      params.method = method;
      params.password = password;
      return { params };
    }

    case 'NAIVE': {
      const username = asTrimmedString(outbound.username);
      const password = asTrimmedString(outbound.password);
      if (!username || !password) {
        return { reason: 'MISSING_CREDENTIAL', detail: '缺少 username 或 password' };
      }
      params.username = username;
      params.password = password;
      return { params };
    }

    default:
      return { reason: 'UNSUPPORTED_PROTOCOL', detail: protocolType as string };
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** sing-box 的 WebSocket Host 覆盖落在 headers.Host（大小写不敏感）。 */
function firstHeaderHost(headers: unknown): unknown {
  const map = asObject(headers);
  if (!map) return undefined;
  for (const [key, value] of Object.entries(map)) {
    if (key.toLowerCase() === 'host') return value;
  }
  return undefined;
}

/** 供格式识别使用：顶层是否是一个包含 outbounds 数组的 sing-box 配置。 */
export function looksLikeSingboxConfig(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Array.isArray((value as Record<string, unknown>).outbounds);
}

export { asStringArray, isUpstreamOutboundProtocol };
