import {
  asBoolean,
  asPort,
  asPositiveInt,
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
 * Mihomo / Clash Meta 解析器。
 *
 * 输入：已解析的 `proxies[]` 数组（YAML 由调用方负责解析成对象）。
 * 输出：归一化上游节点 + 逐条跳过原因。
 *
 * 仅覆盖 `UPSTREAM_OUTBOUND_PROTOCOLS` 白名单内的协议；`ssr` / `snell` /
 * `wireguard` / `anytls` 等 RiriCloud 没有对应出站的类型记为 UNSUPPORTED_PROTOCOL。
 */
export function parseMihomoProxies(rawProxies: unknown): UpstreamParseResult {
  if (!Array.isArray(rawProxies)) {
    return { nodes: [], skipped: [] };
  }

  const nodes: ParsedUpstreamNode[] = [];
  const skipped: SkippedUpstreamNode[] = [];

  for (const raw of rawProxies) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const proxy = raw as Record<string, unknown>;
    const name = asTrimmedString(proxy.name) ?? '未命名节点';

    const type = (asTrimmedString(proxy.type) ?? '').toLowerCase();
    const protocolType = MIHOMO_TYPE_MAP[type];
    if (!protocolType) {
      skipped.push({ name, reason: 'UNSUPPORTED_PROTOCOL', detail: type || '(缺少 type)' });
      continue;
    }

    const server = asTrimmedString(proxy.server);
    if (!server || !isValidUpstreamServer(server)) {
      skipped.push({ name, reason: 'MISSING_SERVER', detail: server ?? '(缺少 server)' });
      continue;
    }
    const port = asPort(proxy.port);
    if (!port) {
      skipped.push({ name, reason: 'INVALID_PARAMS', detail: '端口无效' });
      continue;
    }

    const parsed = buildParams(protocolType, proxy);
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

const MIHOMO_TYPE_MAP: Record<string, ParsedUpstreamNode['protocolType']> = {
  vless: 'VLESS',
  vmess: 'VMESS',
  trojan: 'TROJAN',
  hysteria2: 'HYSTERIA2',
  hy2: 'HYSTERIA2',
  tuic: 'TUIC',
  ss: 'SHADOWSOCKS',
  shadowsocks: 'SHADOWSOCKS',
  naive: 'NAIVE'
};

type ParamsResult =
  | { params: UpstreamOutboundParams }
  | { reason: SkippedUpstreamNode['reason']; detail?: string };

function buildParams(
  protocolType: ParsedUpstreamNode['protocolType'],
  proxy: Record<string, unknown>
): ParamsResult {
  const params = emptyUpstreamParams();

  // Reality 优先于普通 TLS：mihomo 用 reality-opts.public-key 表达 Reality，
  // 此时 tls: true 与 servername 依然存在，但安全层语义是 Reality。
  const realityOpts = asObject(proxy['reality-opts']);
  const tls = normalizeUpstreamTls({
    enabled: asBoolean(proxy.tls) === true || Boolean(realityOpts),
    realityPublicKey: realityOpts?.['public-key'],
    shortId: realityOpts?.['short-id'],
    // mihomo 新旧字段并存：servername 优先，其次 sni
    serverName: proxy.servername ?? proxy.sni,
    alpn: proxy.alpn,
    insecure: proxy['skip-cert-verify']
  });
  params.tls = tls;
  params.transport = normalizeUpstreamTransport({
    network: proxy.network,
    path: asObject(proxy['ws-opts'])?.path ?? asObject(proxy['h2-opts'])?.path,
    host: firstHeaderHost(asObject(proxy['ws-opts'])) ?? asStringArrayValue(asObject(proxy['h2-opts'])?.host),
    headers: asObject(proxy['ws-opts'])?.['headers'],
    serviceName: asObject(proxy['grpc-opts'])?.['grpc-service-name'],
    maxEarlyData: asObject(proxy['ws-opts'])?.['max-early-data'],
    earlyDataHeaderName: asObject(proxy['ws-opts'])?.['early-data-header-name']
  });

  switch (protocolType) {
    case 'VLESS': {
      const uuid = asTrimmedString(proxy.uuid);
      if (!uuid) return { reason: 'MISSING_CREDENTIAL', detail: '缺少 uuid' };
      params.uuid = uuid;
      const flow = asTrimmedString(proxy.flow);
      if (flow) params.flow = flow;
      return { params };
    }

    case 'VMESS': {
      const uuid = asTrimmedString(proxy.uuid);
      if (!uuid) return { reason: 'MISSING_CREDENTIAL', detail: '缺少 uuid' };
      params.uuid = uuid;
      params.alterId = asPositiveInt(proxy.alterId ?? proxy.alterid) ?? 0;
      return { params };
    }

    case 'TROJAN': {
      const password = asTrimmedString(proxy.password);
      if (!password) return { reason: 'MISSING_CREDENTIAL', detail: '缺少 password' };
      params.password = password;
      return { params };
    }

    case 'HYSTERIA2': {
      const password = asTrimmedString(proxy.password) ?? asTrimmedString(proxy['auth-str']);
      if (!password) return { reason: 'MISSING_CREDENTIAL', detail: '缺少 password' };
      params.password = password;
      const upMbps = parseBandwidthMbps(proxy.up);
      const downMbps = parseBandwidthMbps(proxy.down);
      if (upMbps) params.upMbps = upMbps;
      if (downMbps) params.downMbps = downMbps;
      const obfs = parseObfs(proxy.obfs, proxy['obfs-password']);
      if (obfs) params.obfs = obfs;
      return { params };
    }

    case 'TUIC': {
      const uuid = asTrimmedString(proxy.uuid);
      const password = asTrimmedString(proxy.password);
      if (!uuid && !password) return { reason: 'MISSING_CREDENTIAL', detail: '缺少 uuid 与 password' };
      if (uuid) params.uuid = uuid;
      if (password) params.password = password;
      const congestion = asTrimmedString(proxy['congestion-controller']);
      if (congestion) params.congestionControl = congestion;
      const zeroRtt = asBoolean(proxy['reduce-rtt'] ?? proxy['zero-rtt-handshake']);
      if (zeroRtt !== undefined) params.zeroRttHandshake = zeroRtt;
      return { params };
    }

    case 'SHADOWSOCKS': {
      const method = asTrimmedString(proxy.cipher);
      const password = asTrimmedString(proxy.password);
      if (!method) return { reason: 'INVALID_PARAMS', detail: '缺少 cipher' };
      if (!password) return { reason: 'MISSING_CREDENTIAL', detail: '缺少 password' };
      params.method = method;
      params.password = password;
      // SS 的 udp-over-tcp 与多路复用互斥由出站组装侧处理，此处只保留协议事实
      const mode = asTrimmedString(proxy.mode);
      if (mode === 'multi-user') params.mode = mode;
      return { params };
    }

    case 'NAIVE': {
      const username = asTrimmedString(proxy.username);
      const password = asTrimmedString(proxy.password);
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

/** mihomo 的 ws-opts.headers.Host 是 Host 覆盖的推荐位置。 */
function firstHeaderHost(opts?: Record<string, unknown>): unknown {
  const headers = asObject(opts?.headers);
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'host') return value;
  }
  return undefined;
}

function asStringArrayValue(value: unknown): unknown {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * hysteria2 的 `up` / `down` 形如 `"100 Mbps"`、`"100"`、`100`。
 * 无法解析时返回 undefined，交由内核使用自适应带宽。
 */
function parseBandwidthMbps(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
  const text = asTrimmedString(value);
  if (!text) return undefined;
  const match = /^([\d.]+)\s*(mbps|mb\/s|m)?$/i.exec(text);
  if (!match) return undefined;
  const numeric = Number.parseFloat(match[1]);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return Math.round(numeric);
}

function parseObfs(obfs: unknown, obfsPassword: unknown): { type: string; password?: string } | undefined {
  const type = asTrimmedString(obfs);
  // mihomo 允许 `obfs: salamander` + `obfs-password: xxx`，也允许内联对象
  const inline = asObject(obfs);
  if (inline) {
    const inlineType = asTrimmedString(inline.type) ?? 'salamander';
    const password = asTrimmedString(inline.password);
    return password ? { type: inlineType, password } : undefined;
  }
  const password = asTrimmedString(obfsPassword);
  if (!type && !password) return undefined;
  return password ? { type: type ?? 'salamander', password } : undefined;
}

/** 供格式识别与测试使用的类型白名单判断。 */
export function isMihomoSupportedType(type: string): boolean {
  return Boolean(MIHOMO_TYPE_MAP[type.toLowerCase()]);
}

/** 保持与 types.ts 白名单一致性的编译期校验。 */
export function assertMihomoTypesInWhitelist(): void {
  for (const protocol of Object.values(MIHOMO_TYPE_MAP)) {
    if (!isUpstreamOutboundProtocol(protocol)) {
      throw new Error(`mihomo 协议映射超出上游出口白名单: ${protocol}`);
    }
  }
}
