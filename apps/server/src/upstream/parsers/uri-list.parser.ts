import {
  asPort,
  asPositiveInt,
  asTrimmedString,
  computeEntryKey,
  dedupeParsedNodes,
  emptyUpstreamParams,
  isValidUpstreamServer,
  normalizeUpstreamTls,
  normalizeUpstreamTransport,
  type ParsedUpstreamNode,
  type SkippedUpstreamNode,
  type UpstreamOutboundParams,
  type UpstreamParseResult
} from './types';

/**
 * 通用 Base64 / 明文 URI 列表解析器。
 *
 * 支持的 scheme 与 `subscription/builders.ts` 的 URI 输出一一对应：
 * `vless://`、`vmess://`、`trojan://`、`hy2://` / `hysteria2://`、
 * `tuic://`、`ss://`、`naive+https://`。
 *
 * 明文列表与整体 Base64 编码的列表都能识别（由 `looksLikeUriList` 判定后再解码）。
 */
export function parseUriList(raw: string): UpstreamParseResult {
  const nodes: ParsedUpstreamNode[] = [];
  const skipped: SkippedUpstreamNode[] = [];

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const scheme = /^([a-zA-Z0-9+.-]+):\/\//.exec(line)?.[1]?.toLowerCase();
    if (!scheme) continue;

    if (!SUPPORTED_SCHEMES.has(scheme)) {
      skipped.push({ name: line.slice(0, 48), reason: 'UNSUPPORTED_PROTOCOL', detail: scheme });
      continue;
    }

    try {
      const parsed = parseSingleUri(line, scheme);
      if (!parsed) {
        skipped.push({ name: line.slice(0, 48), reason: 'INVALID_PARAMS', detail: 'URI 无法解析' });
        continue;
      }
      if ('reason' in parsed) {
        skipped.push(parsed);
        continue;
      }
      nodes.push(parsed);
    } catch (error) {
      skipped.push({
        name: line.slice(0, 48),
        reason: 'INVALID_PARAMS',
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return dedupeParsedNodes({ nodes, skipped });
}

const SUPPORTED_SCHEMES = new Set(['vless', 'vmess', 'trojan', 'hy2', 'hysteria2', 'tuic', 'ss', 'naive+https']);

/** 判定一段文本是否是 URI 列表：含至少一行受支持的 scheme。 */
export function looksLikeUriList(raw: string): boolean {
  return raw.split(/\r?\n/).some((line) => {
    const scheme = /^([a-zA-Z0-9+.-]+):\/\//.exec(line.trim())?.[1]?.toLowerCase();
    return scheme ? SUPPORTED_SCHEMES.has(scheme) : false;
  });
}

type UriResult = ParsedUpstreamNode | SkippedUpstreamNode | null;

function parseSingleUri(line: string, scheme: string): UriResult {
  if (scheme === 'vmess') return parseVmessUri(line);
  if (scheme === 'ss') return parseShadowsocksUri(line);

  const url = new URL(line);
  const name = decodeURIComponent(url.hash.replace(/^#/, '')) || `${scheme} 节点`;
  const server = url.hostname;
  const port = asPort(url.port);

  if (!server || !isValidUpstreamServer(server)) {
    return { name, reason: 'MISSING_SERVER', detail: server || '(缺少地址)' };
  }
  if (!port) return { name, reason: 'INVALID_PARAMS', detail: '端口无效' };

  // naive+https 的用户名/密码在 userinfo 中；其余协议凭据在 username 段，
  // TUIC 例外：`tuic://uuid:password@host:port` 的密码在 password 段。
  const credential = scheme === 'naive+https' ? url.password : url.username;
  const username = scheme === 'naive+https' ? url.username : undefined;

  switch (scheme) {
    case 'vless':
      return parseVless(name, server, port, credential, url.searchParams);
    case 'trojan':
      return parseTrojan(name, server, port, credential, url.searchParams);
    case 'hy2':
    case 'hysteria2':
      return parseHysteria2(name, server, port, credential, url.searchParams);
    case 'tuic':
      return parseTuic(name, server, port, url.username, url.password, url.searchParams);
    case 'naive+https':
      return parseNaive(name, server, port, username, credential);
    default:
      return { name, reason: 'UNSUPPORTED_PROTOCOL', detail: scheme };
  }
}

/** 共用部分：type / sni / alpn / allowInsecure / Reality 参数 → 语义化 TLS 与传输层。 */
function sharedFromSearchParams(searchParams: URLSearchParams): {
  tls: UpstreamOutboundParams['tls'];
  transport: UpstreamOutboundParams['transport'];
} {
  const security = (searchParams.get('security') ?? '').toLowerCase();
  const isReality = security === 'reality' || Boolean(searchParams.get('pbk'));
  const insecureRaw = searchParams.get('allowInsecure') ?? searchParams.get('insecure') ?? searchParams.get('allow_insecure');

  const tls = normalizeUpstreamTls({
    enabled: isReality || security === 'tls' || security === 'xtls' || Boolean(searchParams.get('sni')),
    realityPublicKey: searchParams.get('pbk'),
    shortId: searchParams.get('sid'),
    serverName: searchParams.get('sni'),
    alpn: searchParams.get('alpn'),
    insecure: insecureRaw === '1' || insecureRaw === 'true'
  });

  const transport = normalizeUpstreamTransport({
    network: searchParams.get('type') ?? searchParams.get('net'),
    path: searchParams.get('path'),
    host: searchParams.get('host'),
    serviceName: searchParams.get('serviceName'),
    maxEarlyData: searchParams.get('ed'),
    earlyDataHeaderName: searchParams.get('eh')
  });

  return { tls, transport };
}

function parseVless(
  name: string,
  server: string,
  port: number,
  uuid: string,
  searchParams: URLSearchParams
): UriResult {
  if (!uuid) return { name, reason: 'MISSING_CREDENTIAL', detail: '缺少 uuid' };
  const params = emptyUpstreamParams();
  const shared = sharedFromSearchParams(searchParams);
  params.tls = shared.tls;
  params.transport = shared.transport;
  params.uuid = uuid;
  const flow = asTrimmedString(searchParams.get('flow'));
  if (flow) params.flow = flow;
  return finalize(name, 'VLESS', server, port, params);
}

function parseTrojan(
  name: string,
  server: string,
  port: number,
  password: string,
  searchParams: URLSearchParams
): UriResult {
  if (!password) return { name, reason: 'MISSING_CREDENTIAL', detail: '缺少 password' };
  const params = emptyUpstreamParams();
  const shared = sharedFromSearchParams(searchParams);
  // Trojan 必须启用 TLS：URI 中通常不显式携带 security 参数
  params.tls = shared.tls.enabled ? shared.tls : { enabled: true, mode: 'tls' };
  params.transport = shared.transport;
  params.password = password;
  return finalize(name, 'TROJAN', server, port, params);
}

function parseHysteria2(
  name: string,
  server: string,
  port: number,
  password: string,
  searchParams: URLSearchParams
): UriResult {
  if (!password) return { name, reason: 'MISSING_CREDENTIAL', detail: '缺少 password' };
  const params = emptyUpstreamParams();
  const shared = sharedFromSearchParams(searchParams);
  params.tls = shared.tls.enabled ? shared.tls : { enabled: true, mode: 'tls', alpn: ['h3'] };
  params.password = password;
  const upMbps = asPositiveInt(searchParams.get('upmbps') ?? searchParams.get('up'));
  const downMbps = asPositiveInt(searchParams.get('downmbps') ?? searchParams.get('down'));
  if (upMbps) params.upMbps = upMbps;
  if (downMbps) params.downMbps = downMbps;
  const obfsType = asTrimmedString(searchParams.get('obfs'));
  const obfsPassword = asTrimmedString(searchParams.get('obfs-password'));
  if (obfsType || obfsPassword) {
    params.obfs = { type: obfsType ?? 'salamander', ...(obfsPassword ? { password: obfsPassword } : {}) };
  }
  return finalize(name, 'HYSTERIA2', server, port, params);
}

function parseTuic(
  name: string,
  server: string,
  port: number,
  uuid: string,
  password: string,
  searchParams: URLSearchParams
): UriResult {
  // tuic://uuid:password@host:port —— uuid 在 username 段，密码在 password 段
  const params = emptyUpstreamParams();
  const shared = sharedFromSearchParams(searchParams);
  params.tls = shared.tls.enabled ? shared.tls : { enabled: true, mode: 'tls', alpn: ['h3'] };
  if (uuid) params.uuid = uuid;
  if (password) params.password = password;
  if (!uuid && !password) {
    return { name, reason: 'MISSING_CREDENTIAL', detail: '缺少 uuid 与 password' };
  }
  const congestion = asTrimmedString(searchParams.get('congestion_control') ?? searchParams.get('congestion'));
  if (congestion) params.congestionControl = congestion;
  return finalize(name, 'TUIC', server, port, params);
}

function parseNaive(
  name: string,
  server: string,
  port: number,
  username: string | undefined,
  password: string
): UriResult {
  if (!username || !password) return { name, reason: 'MISSING_CREDENTIAL', detail: '缺少 username 或 password' };
  const params = emptyUpstreamParams();
  params.tls = { enabled: true, mode: 'tls' };
  params.username = username;
  params.password = password;
  return finalize(name, 'NAIVE', server, port, params);
}

/**
 * `vmess://<base64(JSON)>`：JSON 与 `buildVmessUri` 的输出字段完全对应。
 */
function parseVmessUri(line: string): UriResult {
  const payload = line.slice('vmess://'.length).trim();
  const decoded = decodeBase64Loose(payload);
  if (!decoded) return { name: payload.slice(0, 32), reason: 'INVALID_PARAMS', detail: 'vmess 负载不是合法 Base64' };

  let json: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { name: payload.slice(0, 32), reason: 'INVALID_PARAMS', detail: 'vmess 负载不是 JSON 对象' };
    }
    json = parsed as Record<string, unknown>;
  } catch {
    return { name: payload.slice(0, 32), reason: 'INVALID_PARAMS', detail: 'vmess 负载 JSON 解析失败' };
  }

  const name = asTrimmedString(json.ps) ?? 'vmess 节点';
  const server = asTrimmedString(json.add);
  const port = asPort(json.port);
  const uuid = asTrimmedString(json.id);
  if (!server || !isValidUpstreamServer(server)) {
    return { name, reason: 'MISSING_SERVER', detail: server ?? '(缺少 add)' };
  }
  if (!port) return { name, reason: 'INVALID_PARAMS', detail: '端口无效' };
  if (!uuid) return { name, reason: 'MISSING_CREDENTIAL', detail: '缺少 id' };

  const params = emptyUpstreamParams();
  const tlsFlag = (asTrimmedString(json.tls) ?? '').toLowerCase();
  const isReality = tlsFlag === 'reality';
  params.tls = normalizeUpstreamTls({
    enabled: isReality || tlsFlag === 'tls' || Boolean(asTrimmedString(json.sni)),
    realityPublicKey: json.pbk,
    shortId: json.sid,
    serverName: json.sni,
    alpn: json.alpn
  });
  params.transport = normalizeUpstreamTransport({
    network: json.net,
    path: json.path,
    host: json.host,
    // vmess URI 没有独立的 serviceName 字段，gRPC 场景复用 path 承载
    serviceName: json.net === 'grpc' || json.net === 'gun' ? json.path : undefined
  });
  params.uuid = uuid;
  params.alterId = asPositiveInt(json.aid) ?? 0;
  return finalize(name, 'VMESS', server, port, params);
}

/**
 * `ss://<base64url(method:password)>@host:port#name`，
 * 兼容旧式 `ss://<base64(method:password@host:port)>#name` 整串编码形态。
 */
function parseShadowsocksUri(line: string): UriResult {
  const withoutScheme = line.slice('ss://'.length);
  const hashIndex = withoutScheme.indexOf('#');
  const name = hashIndex >= 0
    ? decodeURIComponent(withoutScheme.slice(hashIndex + 1)) || 'ss 节点'
    : 'ss 节点';
  const body = hashIndex >= 0 ? withoutScheme.slice(0, hashIndex) : withoutScheme;

  if (body.includes('@')) {
    const atIndex = body.lastIndexOf('@');
    const userinfo = body.slice(0, atIndex);
    const hostPort = body.slice(atIndex + 1);
    const decodedUserinfo = userinfo.includes(':') ? userinfo : decodeBase64Loose(userinfo);
    if (!decodedUserinfo) return { name, reason: 'INVALID_PARAMS', detail: 'ss userinfo 不是合法 Base64' };
    const separator = decodedUserinfo.indexOf(':');
    if (separator < 0) return { name, reason: 'INVALID_PARAMS', detail: 'ss userinfo 缺少 method:password' };
    const method = decodedUserinfo.slice(0, separator);
    const password = decodedUserinfo.slice(separator + 1);
    const [host, portText] = splitHostPort(hostPort);
    return buildShadowsocks(name, host, portText, method, password);
  }

  // 旧式：整段 Base64 编码 method:password@host:port
  const decoded = decodeBase64Loose(body);
  if (!decoded) return { name, reason: 'INVALID_PARAMS', detail: 'ss 负载不是合法 Base64' };
  const atIndex = decoded.lastIndexOf('@');
  if (atIndex < 0) return { name, reason: 'INVALID_PARAMS', detail: 'ss 负载缺少 @' };
  const credential = decoded.slice(0, atIndex);
  const [host, portText] = splitHostPort(decoded.slice(atIndex + 1));
  const separator = credential.indexOf(':');
  if (separator < 0) return { name, reason: 'INVALID_PARAMS', detail: 'ss 负载缺少 method:password' };
  return buildShadowsocks(name, host, portText, credential.slice(0, separator), credential.slice(separator + 1));
}

function buildShadowsocks(
  name: string,
  host: string,
  portText: string,
  method: string,
  password: string
): UriResult {
  if (!host || !isValidUpstreamServer(host)) {
    return { name, reason: 'MISSING_SERVER', detail: host || '(缺少地址)' };
  }
  const port = asPort(portText);
  if (!port) return { name, reason: 'INVALID_PARAMS', detail: '端口无效' };
  if (!method) return { name, reason: 'INVALID_PARAMS', detail: '缺少加密方式' };
  if (!password) return { name, reason: 'MISSING_CREDENTIAL', detail: '缺少密码' };

  const params = emptyUpstreamParams();
  params.method = method;
  params.password = password;
  return finalize(name, 'SHADOWSOCKS', host, port, params);
}

function finalize(
  name: string,
  protocolType: ParsedUpstreamNode['protocolType'],
  server: string,
  port: number,
  params: UpstreamOutboundParams
): ParsedUpstreamNode {
  return {
    name,
    protocolType,
    server,
    port,
    params,
    entryKey: computeEntryKey({ protocolType, server, port, params })
  };
}

function splitHostPort(value: string): [string, string] {
  // 兼容 IPv6 字面量 [::1]:443
  const ipv6Match = /^\[(.+)\]:(\d+)$/.exec(value);
  if (ipv6Match) return [ipv6Match[1], ipv6Match[2]];
  const lastColon = value.lastIndexOf(':');
  if (lastColon < 0) return [value, ''];
  return [value.slice(0, lastColon), value.slice(lastColon + 1)];
}

/** Base64 / Base64URL 宽松解码；失败返回 null。 */
function decodeBase64Loose(value: string): string | null {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  if (!normalized) return null;
  const padding = normalized.length % 4;
  const padded = padding === 0 ? normalized : normalized + '='.repeat(4 - padding);
  try {
    const buffer = Buffer.from(padded, 'base64');
    if (!buffer.length) return null;
    const text = buffer.toString('utf8');
    // 解码结果出现替换字符说明输入并不是该编码
    return text.includes('\uFFFD') ? null : text;
  } catch {
    return null;
  }
}
