import { BadRequestException } from '@nestjs/common';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  INTERNAL_RELAY_TRANSIT_EMAIL,
  INTERNAL_RELAY_TRANSIT_UUID,
  INTERNAL_SPEEDTEST_EMAIL,
  INTERNAL_SPEEDTEST_UUID,
  ProtocolType,
  TRAFFIC_CREDENTIAL_DELIMITER
} from './constants';
import { decryptSecret, encryptSecret, isEncryptedSecret } from './secret-crypto';
import { parseProxyLineUsername } from '../proxy-pool/proxy-key.util';

export { TRAFFIC_CREDENTIAL_DELIMITER };

// 格式化入站用户名：若提供 lineId 且非系统内部中继或测速凭证，则注入复合标识以供 Sing-box 区分线路
export function formatInboundUserName(
  user: { email?: string; uuid?: string },
  lineId?: string
): string {
  const baseName = user.email || user.uuid || '';
  if (!lineId || !baseName) return baseName;
  if (
    baseName === INTERNAL_RELAY_TRANSIT_EMAIL ||
    baseName === INTERNAL_RELAY_TRANSIT_UUID ||
    baseName === INTERNAL_SPEEDTEST_EMAIL ||
    baseName === INTERNAL_SPEEDTEST_UUID
  ) {
    return baseName;
  }
  return `${baseName}${TRAFFIC_CREDENTIAL_DELIMITER}${lineId}`;
}

const AUTH_USER_PREFIX = 'riri_login_';
// HTTP Basic 按首个冒号切分 userinfo，复合统计标签不能直接作为登录用户名。
export function formatAuthUserName(user: { email?: string; uuid?: string }, lineId?: string): string {
  const composite = formatInboundUserName(user, lineId);
  const base = user.email || user.uuid || '';
  return composite === base ? base : `${AUTH_USER_PREFIX}${Buffer.from(composite).toString('base64url')}`;
}

// 解析 Agent 上报的凭证快照，分离原始用户凭证与线路 ID（若存在）
export function parseTrafficCredential(credential: string): {
  rawCredential: string;
  lineId: string | null;
} {
  if (credential.startsWith('pk_line_')) return parseProxyLineUsername(credential) ?? { rawCredential: credential, lineId: null };
  if (credential.startsWith(AUTH_USER_PREFIX)) {
    const encoded = credential.slice(AUTH_USER_PREFIX.length);
    if (/^[A-Za-z0-9_-]+$/.test(encoded)) {
      const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
      if (Buffer.from(decoded).toString('base64url') === encoded && decoded.includes(TRAFFIC_CREDENTIAL_DELIMITER)) credential = decoded;
    }
  }
  const delimiterIndex = credential.indexOf(TRAFFIC_CREDENTIAL_DELIMITER);
  if (delimiterIndex <= 0) {
    return { rawCredential: credential, lineId: null };
  }
  const rawCredential = credential.slice(0, delimiterIndex);
  const lineId = credential.slice(delimiterIndex + TRAFFIC_CREDENTIAL_DELIMITER.length);
  return {
    rawCredential,
    lineId: lineId.length > 0 ? lineId : null
  };
}

// ==============================
// 传输层 (Transport) 参数定义
// ==============================

export type TransportType = 'tcp' | 'ws' | 'grpc' | 'http' | 'httpupgrade';

export interface InboundTransport {
  type: TransportType;
  path?: string;
  host?: string;
  serviceName?: string;
  headers?: Record<string, string>;
  maxEarlyData?: number;
  earlyDataHeaderName?: string;
}

// ==============================
// 安全层 (TLS/Reality/ACME) 参数定义
// ==============================

export type TlsMode = 'none' | 'tls' | 'reality' | 'acme';

const DEFAULT_TLS_ALPN = ['h2', 'http/1.1'];

function defaultTlsAlpn(transport: TransportType): string[] {
  if (transport === 'grpc') return ['h2'];
  if (transport === 'ws' || transport === 'httpupgrade') return ['http/1.1'];
  return [...DEFAULT_TLS_ALPN];
}

export interface InboundRealityConfig {
  dest: string; // 形如 "www.apple.com:443"
  serverNames: string[];
  privateKey: string;
  publicKey: string;
  shortIds: string[];
}

export interface InboundAcmeConfig {
  domain: string;
  email: string;
  provider?: string;
}

export interface InboundTlsConfig {
  enabled: boolean;
  mode: TlsMode;
  serverName?: string;
  certificatePath?: string;
  keyPath?: string;
  certificate?: string[];
  key?: string[];
  acme?: InboundAcmeConfig;
  reality?: InboundRealityConfig;
  alpn?: string[];
  insecure?: boolean; // 客户端 skip-cert-verify
  minVersion?: string; // 最小 TLS 版本，如 "1.2", "1.3"
  maxVersion?: string; // 最大 TLS 版本，如 "1.3"
  cipherSuites?: string[]; // 自定义密码套件列表
}

// ==============================
// 多路复用 (Multiplex) 参数定义
// ==============================

export interface InboundMultiplexBrutal {
  enabled?: boolean;
  upMbps?: number;
  downMbps?: number;
}

export interface InboundMultiplexConfig {
  enabled: boolean;
  protocol?: 'smux' | 'yamux' | 'h2mux';
  maxConnections?: number;
  minStreams?: number;
  maxStreams?: number;
  padding?: boolean;
  brutal?: InboundMultiplexBrutal;
}

// ==============================
// 伪装响应 (Masquerade) 参数定义
// ==============================

export type Hysteria2MasqueradeType = 'file' | 'proxy' | 'string';

export interface Hysteria2Masquerade {
  type: Hysteria2MasqueradeType;
  dir?: string;
  url?: string;
  rewriteHost?: boolean;
  content?: string;
  statusCode?: number;
  headers?: Record<string, string>;
}

// ==============================
// 共享监听底座 (Shared Listen) 参数定义
// ==============================

export interface SharedListenOptions {
  tcpFastOpen?: boolean;
  tcpMultiPath?: boolean;
  udpFragment?: boolean | null;
  udpTimeout?: string | null;
  proxyProtocol?: boolean;
  proxyProtocolAcceptNoHeader?: boolean;
}

// ==============================
// 协议专属参数定义
// ==============================

export interface VlessParams {
  flow?: string;
  transport?: InboundTransport;
  tls?: InboundTlsConfig;
  multiplex?: InboundMultiplexConfig;
}

export interface VmessParams {
  alterId?: number;
  transport?: InboundTransport;
  tls?: InboundTlsConfig;
  multiplex?: InboundMultiplexConfig;
}

export interface TrojanParams {
  transport?: InboundTransport;
  tls?: InboundTlsConfig;
  multiplex?: InboundMultiplexConfig;
}

export interface Hysteria2Params {
  upMbps?: number;
  downMbps?: number;
  obfs?: {
    type: string;
    password?: string;
  };
  masquerade?: Hysteria2Masquerade;
  ignoreClientBandwidth?: boolean;
  tls?: InboundTlsConfig;
}

export interface TuicParams {
  congestionControl?: string;
  zeroRttHandshake?: boolean;
  heartbeat?: string;
  tls?: InboundTlsConfig;
}

export interface ShadowsocksParams {
  method: string;
  password?: string;
  mode?: 'shared' | 'multi-user';
  udpOverTcp?: boolean;
  multiplex?: InboundMultiplexConfig;
}

export interface NaiveParams {
  network?: string;
  tls?: InboundTlsConfig;
}

export interface ShadowtlsParams {
  version: 3;
  handshakeDest: string;
  strictMode: boolean;
  inner: {
    type: 'SHADOWSOCKS';
    method: string;
    password: string;
  };
}

export interface MixedParams {
  allowLan?: boolean;
  usersEnabled?: boolean;
  tls?: InboundTlsConfig;
}

export interface SocksParams {
  allowLan?: boolean;
  usersEnabled?: boolean;
  tls?: InboundTlsConfig;
}

export interface HttpParams {
  allowLan?: boolean;
  usersEnabled?: boolean;
  tls?: InboundTlsConfig;
}

// ==============================
// 直连代理池凭据（ProxyKey，v0.9.0）
//
// 认证用户名必须是「冒号安全」的：Sing-box 的 HTTP CONNECT 走
// net/http.parseBasicAuth，按首个 ":" 切分 user/password，
// 因此用户名一旦包含 ":" 则 HTTP 代理认证必然失败（SOCKS5 无此限制）。
// 由于同一份凭据同时导出 socks5:// 与 http:// 两种形态，这里统一使用裸
// pk_xxxx 作为入站用户名；线路归属由节点级回退解析（resolveActiveLineForNode）完成。
// ==============================
export interface ProxyPoolCredential {
  username: string;
  password: string;
}

export interface DirectParams {
  overrideAddress?: string;
  overridePort?: number;
}

// 各协议创建入站时的默认 tag 前缀
export const INBOUND_DEFAULT_TAGS: Record<ProtocolType, string> = {
  VLESS: 'vless-in',
  VMESS: 'vmess-in',
  TROJAN: 'trojan-in',
  HYSTERIA2: 'hy2-in',
  TUIC: 'tuic-in',
  SHADOWSOCKS: 'ss-in',
  NAIVE: 'naive-in',
  SHADOWTLS: 'shadowtls-in',
  MIXED: 'mixed-in',
  SOCKS: 'socks-in',
  HTTP: 'http-in',
  DIRECT: 'direct-in'
};

// 仅在 UDP 端口监听的入站类型（可与 TCP 协议在同一端口共存）
export const UDP_INBOUND_TYPES: readonly ProtocolType[] = ['HYSTERIA2', 'TUIC'];

// Reality 创建入站时的默认值
export const REALITY_DEFAULTS = {
  serverNames: ['www.apple.com'],
  dest: 'www.apple.com:443',
  shortIds: ['0123456789abcdef'],
  flow: 'xtls-rprx-vision'
};

export const SS_DEFAULT_METHOD = '2022-blake3-aes-128-gcm';

const SS2022_KEY_LENGTHS: Record<string, number> = {
  '2022-blake3-aes-128-gcm': 16,
  '2022-blake3-aes-256-gcm': 32,
  '2022-blake3-chacha20-poly1305': 32
};

// 参与流量/资格注入的用户凭证
export interface InboundUserCredential {
  uuid: string;
  email: string;
  credential: string;
}

function shadowsocks2022KeyLength(method: string): number | undefined {
  return SS2022_KEY_LENGTHS[method.trim().toLowerCase()];
}

function isValidShadowsocks2022Key(value: string, keyLength: number): boolean {
  const candidate = value.trim();
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(candidate)) {
    return false;
  }
  try {
    const decoded = Buffer.from(candidate, 'base64');
    return decoded.length === keyLength && decoded.toString('base64') === candidate;
  } catch {
    return false;
  }
}

function deriveShadowsocks2022Key(method: string, identity: string): string {
  const keyLength = shadowsocks2022KeyLength(method);
  if (!keyLength) return identity;
  return createHash('sha256')
    .update(`riricloud:ss2022:${method.trim().toLowerCase()}:${identity}`)
    .digest()
    .subarray(0, keyLength)
    .toString('base64');
}

// SS 2022 要求用户密钥为固定长度的 Base64 原始密钥；普通用户密码或 UUID 不能直接使用。
export function normalizeShadowsocksPassword(method: string, password: string): string {
  const keyLength = shadowsocks2022KeyLength(method);
  const candidate = password.trim();
  if (!keyLength || isValidShadowsocks2022Key(candidate, keyLength)) return candidate;
  return deriveShadowsocks2022Key(method, `shared:${candidate}`);
}

export function resolveShadowsocksUserPassword(method: string, credential: string, userUuid: string): string {
  const keyLength = shadowsocks2022KeyLength(method);
  const candidate = credential.trim();
  if (!keyLength || isValidShadowsocks2022Key(candidate, keyLength)) return candidate;
  return deriveShadowsocks2022Key(method, `user:${userUuid || candidate}`);
}

// SS2022 客户端凭证由服务端主密钥和用户密钥组成；普通 SS 仍使用用户密码本身。
export function buildShadowsocksClientPassword(
  method: string,
  serverPassword: string,
  credential: string,
  userUuid: string
): string {
  const userPassword = resolveShadowsocksUserPassword(method, credential, userUuid);
  if (!shadowsocks2022KeyLength(method)) return userPassword;
  return `${normalizeShadowsocksPassword(method, serverPassword)}:${userPassword}`;
}

// X25519 Reality 密钥对生成（32 字节裸密钥 base64url）
export function generateRealityKeypair(): { privateKey: string; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  const b64 = (der: Buffer) => der.subarray(der.length - 32).toString('base64url');
  return { privateKey: b64(privDer), publicKey: b64(pubDer) };
}

// 显式生成只作用于表单草稿，不改变既有线路的缺省参数或保存行为。
export function generateRealityParameters(): { privateKey: string; publicKey: string; shortIds: string[] } {
  return { ...generateRealityKeypair(), shortIds: [randomBytes(8).toString('hex')] };
}

// 解析 "host:port" 形式的目标地址
export function parseDest(dest: string): { host: string; port: number } {
  const idx = dest.lastIndexOf(':');
  if (idx <= 0) {
    throw new BadRequestException('dest 须为 host:port 形式（如 www.apple.com:443）');
  }
  const host = dest.slice(0, idx).trim();
  const port = Number(dest.slice(idx + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BadRequestException('dest 须为 host:port 形式（如 www.apple.com:443）');
  }
  return { host, port };
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0)) {
    return value as string[];
  }
  return fallback;
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return [...new Set(value.map((v) => (v as string).trim()).filter(Boolean))];
  }
  return fallback;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  throw new BadRequestException(`${field} 不能为空`);
}

function asPositiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeTransport(raw: unknown): InboundTransport {
  const t = (raw ?? {}) as Record<string, unknown>;
  const type = (typeof t.type === 'string' ? t.type.toLowerCase() : 'tcp') as TransportType;
  if (!['tcp', 'ws', 'grpc', 'http', 'httpupgrade'].includes(type)) {
    throw new BadRequestException(`不支持的传输层类型: ${type as string}`);
  }
  const res: InboundTransport = { type };
  if (t.path && typeof t.path === 'string') res.path = t.path.trim();
  if (t.host && typeof t.host === 'string') res.host = t.host.trim();
  if (t.serviceName && typeof t.serviceName === 'string') res.serviceName = t.serviceName.trim();
  if (t.headers && typeof t.headers === 'object' && !Array.isArray(t.headers)) {
    res.headers = t.headers as Record<string, string>;
  }
  if (t.maxEarlyData != null) res.maxEarlyData = Number(t.maxEarlyData);
  if (t.earlyDataHeaderName && typeof t.earlyDataHeaderName === 'string') {
    res.earlyDataHeaderName = t.earlyDataHeaderName.trim();
  }
  return res;
}

function normalizeTlsConfig(raw: unknown, defaultMode: TlsMode = 'none', defaultAlpn: string[] = DEFAULT_TLS_ALPN): InboundTlsConfig {
  const tls = (raw ?? {}) as Record<string, unknown>;
  const enabled = tls.enabled !== false && tls.mode !== 'none';
  const mode = (typeof tls.mode === 'string' ? tls.mode.toLowerCase() : defaultMode) as TlsMode;

  if (!enabled || mode === 'none') {
    return { enabled: false, mode: 'none' };
  }

  const alpn = normalizeStringArray(tls.alpn, defaultAlpn);
  const insecure = tls.insecure === true;
  const serverName = typeof tls.serverName === 'string' ? tls.serverName.trim() : undefined;
  const certificate = Array.isArray(tls.certificate) ? asStringArray(tls.certificate, []) : undefined;
  const key = Array.isArray(tls.key) ? asStringArray(tls.key, []) : undefined;
  if ((certificate?.length ?? 0) !== 0 || (key?.length ?? 0) !== 0) {
    if (!certificate?.length || !key?.length) {
      throw new BadRequestException('内嵌 TLS 证书与私钥必须成对提供');
    }
  }

  const minVersion = typeof tls.minVersion === 'string' && tls.minVersion.trim() ? tls.minVersion.trim() : undefined;
  const maxVersion = typeof tls.maxVersion === 'string' && tls.maxVersion.trim() ? tls.maxVersion.trim() : undefined;
  const cipherSuites = Array.isArray(tls.cipherSuites)
    ? tls.cipherSuites.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((s) => s.trim())
    : undefined;
  const extraTlsFields = {
    ...(minVersion ? { minVersion } : {}),
    ...(maxVersion ? { maxVersion } : {}),
    ...(cipherSuites && cipherSuites.length ? { cipherSuites } : {})
  };

  if (mode === 'reality') {
    const rawReality = (tls.reality ?? {}) as Record<string, unknown>;
    const hasPriv = typeof rawReality.privateKey === 'string' && rawReality.privateKey.length > 0;
    const hasPub = typeof rawReality.publicKey === 'string' && rawReality.publicKey.length > 0;
    if (hasPriv !== hasPub) {
      throw new BadRequestException('Reality 密钥对必须成对提供（可由系统生成）');
    }
    const keys = hasPriv
      ? { privateKey: rawReality.privateKey as string, publicKey: rawReality.publicKey as string }
      : generateRealityKeypair();

    const dest =
      typeof rawReality.dest === 'string' && rawReality.dest.trim()
        ? rawReality.dest.trim()
        : REALITY_DEFAULTS.dest;
    parseDest(dest);

    const reality: InboundRealityConfig = {
      dest,
      serverNames: asStringArray(rawReality.serverNames ?? (serverName ? [serverName] : undefined), [
        ...REALITY_DEFAULTS.serverNames
      ]),
      shortIds: asStringArray(rawReality.shortIds, [...REALITY_DEFAULTS.shortIds]),
      ...keys
    };

    return {
      enabled: true,
      mode: 'reality',
      serverName: reality.serverNames[0],
      reality,
      insecure,
      ...extraTlsFields
    };
  }

  if (mode === 'acme') {
    const rawAcme = (tls.acme ?? {}) as Record<string, unknown>;
    const domain = asNonEmptyString(rawAcme.domain ?? serverName, 'ACME 域名 (acme.domain)');
    const email = asNonEmptyString(rawAcme.email, 'ACME 邮箱 (acme.email)');
    return {
      enabled: true,
      mode: 'acme',
      serverName: domain,
      acme: {
        domain,
        email,
        provider: typeof rawAcme.provider === 'string' ? rawAcme.provider.trim() : undefined
      },
      alpn,
      insecure,
      ...extraTlsFields
    };
  }

  // 标准 TLS
  return {
    enabled: true,
    mode: 'tls',
    serverName: serverName ? serverName : undefined,
    ...(certificate?.length && key?.length
      ? { certificate, key }
      : {
          certificatePath: asNonEmptyString(tls.certificatePath, 'tls.certificatePath（Agent 本地路径）'),
          keyPath: asNonEmptyString(tls.keyPath, 'tls.keyPath（Agent 本地路径）')
        }),
    alpn,
    insecure,
    ...extraTlsFields
  };
}

export function normalizeMultiplex(raw: unknown): InboundMultiplexConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const m = raw as Record<string, unknown>;
  if (m.enabled !== true) return undefined;
  let brutal: InboundMultiplexBrutal | undefined;
  if (m.brutal && typeof m.brutal === 'object' && !Array.isArray(m.brutal)) {
    const b = m.brutal as Record<string, unknown>;
    const brutalEnabled = b.enabled === true;
    if (brutalEnabled) {
      const upMbps = asPositiveNumber(b.upMbps ?? b.up_mbps, 0);
      const downMbps = asPositiveNumber(b.downMbps ?? b.down_mbps, 0);
      if (!upMbps || upMbps <= 0) {
        throw new BadRequestException('TCP Brutal 强力拥塞控制必须配置大于 0 的上行速率期望 (upMbps)');
      }
      if (!downMbps || downMbps <= 0) {
        throw new BadRequestException('TCP Brutal 强力拥塞控制必须配置大于 0 的下行速率期望 (downMbps)');
      }
      brutal = {
        enabled: true,
        upMbps,
        downMbps
      };
    }
  }
  const maxConnections = asPositiveNumber(m.maxConnections ?? m.max_connections, 0) || undefined;
  const maxStreams = asPositiveNumber(m.maxStreams ?? m.max_streams, 0) || undefined;
  if (maxConnections && maxStreams) {
    throw new BadRequestException('Sing-box 官方规范中最大连接数 (maxConnections) 与最大并发流数 (maxStreams) 互斥，不能同时配置');
  }

  const protocol = ['smux', 'yamux', 'h2mux'].includes(String(m.protocol).toLowerCase())
    ? (String(m.protocol).toLowerCase() as 'smux' | 'yamux' | 'h2mux')
    : 'smux';
  return {
    enabled: true,
    protocol,
    maxConnections,
    minStreams: asPositiveNumber(m.minStreams ?? m.min_streams, 0) || undefined,
    maxStreams,
    padding: m.padding === true,
    brutal
  };
}

export function normalizeMasquerade(raw: unknown): Hysteria2Masquerade | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const m = raw as Record<string, unknown>;
  const type = (typeof m.type === 'string' ? m.type.trim().toLowerCase() : '') as Hysteria2MasqueradeType;
  if (!['file', 'proxy', 'string'].includes(type)) return undefined;
  if (type === 'file') {
    const dir = typeof m.dir === 'string' && m.dir.trim()
      ? m.dir.trim()
      : (m.file && typeof m.file === 'object' ? String((m.file as Record<string, unknown>).dir ?? '').trim() : '');
    return dir ? { type: 'file', dir } : undefined;
  }
  if (type === 'proxy') {
    const url = typeof m.url === 'string' && m.url.trim()
      ? m.url.trim()
      : (m.proxy && typeof m.proxy === 'object' ? String((m.proxy as Record<string, unknown>).url ?? '').trim() : '');
    const rewriteHost = m.rewriteHost === true || (m.proxy !== null && typeof m.proxy === 'object' && (m.proxy as Record<string, unknown>).rewrite_host === true);
    return url ? { type: 'proxy', url, rewriteHost: Boolean(rewriteHost) } : undefined;
  }
  if (type === 'string') {
    const content = typeof m.content === 'string'
      ? m.content
      : (m.string && typeof m.string === 'object' && typeof (m.string as Record<string, unknown>).content === 'string'
          ? (m.string as Record<string, unknown>).content as string
          : '404 Not Found');
    const statusCode = asPositiveNumber(m.statusCode, 404) || 404;
    return { type: 'string', content, statusCode };
  }
  return undefined;
}

// 按协议归一化 paramsJson：填充默认值、生成缺失密钥、校验必填项
export function normalizeInboundParams(
  type: ProtocolType,
  raw: Record<string, unknown>
): Record<string, unknown> {
  switch (type) {
    case 'VLESS':
    case 'VLESS_REALITY' as ProtocolType: {
      const transport = raw.transport ? normalizeTransport(raw.transport) : { type: 'tcp' as const };
      // 兼容旧版扁平 Reality 参数（dest / serverNames / privateKey / publicKey / shortIds）
      let rawTls = raw.tls;
      if (!rawTls && (raw.dest || raw.serverNames || raw.publicKey || raw.privateKey || raw.shortIds)) {
        rawTls = {
          enabled: true,
          mode: 'reality',
          reality: {
            dest: raw.dest,
            serverNames: raw.serverNames,
            privateKey: raw.privateKey,
            publicKey: raw.publicKey,
            shortIds: raw.shortIds
          }
        };
      }
      const tls = normalizeTlsConfig(rawTls, rawTls ? 'tls' : 'reality', defaultTlsAlpn(transport.type));
      // Vision flow 依赖 TLS/Reality 与原始 TCP；明文 VLESS 或 WebSocket/gRPC 传输必须省略 flow。
      const requestedFlow = typeof raw.flow === 'string' && raw.flow.trim() ? raw.flow.trim() : undefined;
      const flow =
        tls.mode === 'none' || transport.type !== 'tcp'
          ? undefined
          : requestedFlow || (tls.mode === 'reality' ? REALITY_DEFAULTS.flow : undefined);

      const multiplex = normalizeMultiplex(raw.multiplex);
      const params: VlessParams = {
        flow,
        transport,
        tls,
        ...(multiplex ? { multiplex } : {})
      };
      return params as unknown as Record<string, unknown>;
    }

    case 'VMESS': {
      const transport = raw.transport ? normalizeTransport(raw.transport) : { type: 'tcp' as const };
      const tls = normalizeTlsConfig(raw.tls, 'none', defaultTlsAlpn(transport.type));
      const alterId = Number(raw.alterId) || 0;
      const multiplex = normalizeMultiplex(raw.multiplex);
      const params: VmessParams = {
        alterId,
        transport,
        tls,
        ...(multiplex ? { multiplex } : {})
      };
      return params as unknown as Record<string, unknown>;
    }

    case 'TROJAN': {
      const transport = raw.transport ? normalizeTransport(raw.transport) : { type: 'tcp' as const };
      const tls = normalizeTlsConfig(raw.tls, 'tls', defaultTlsAlpn(transport.type));
      if (!tls.enabled || tls.mode === 'none') {
        throw new BadRequestException('Trojan 协议必须启用 TLS 安全层');
      }
      const multiplex = normalizeMultiplex(raw.multiplex);
      const params: TrojanParams = {
        transport,
        tls,
        ...(multiplex ? { multiplex } : {})
      };
      return params as unknown as Record<string, unknown>;
    }

    case 'HYSTERIA2': {
      const tls = normalizeTlsConfig(raw.tls, 'tls', ['h3']);
      if (!tls.enabled || tls.mode === 'none') {
        throw new BadRequestException('Hysteria 2 协议必须配置 TLS 安全层');
      }
      let obfs: { type: string; password?: string } | undefined;
      if (raw.obfs && typeof raw.obfs === 'object') {
        const o = raw.obfs as Record<string, unknown>;
        if (typeof o.password === 'string' && o.password.trim()) {
          obfs = { type: typeof o.type === 'string' ? o.type.trim() : 'salamander', password: o.password.trim() };
        }
      }
      const masquerade = normalizeMasquerade(raw.masquerade);
      const params: Hysteria2Params = {
        upMbps: asPositiveNumber(raw.upMbps, 0),
        downMbps: asPositiveNumber(raw.downMbps, 0),
        ignoreClientBandwidth: raw.ignoreClientBandwidth === true,
        obfs,
        tls,
        ...(masquerade ? { masquerade } : {})
      };
      return params as unknown as Record<string, unknown>;
    }

    case 'TUIC': {
      const tls = normalizeTlsConfig(raw.tls, 'tls', ['h3']);
      if (!tls.enabled || tls.mode === 'none') {
        throw new BadRequestException('TUIC 协议必须配置 TLS 安全层');
      }
      const params: TuicParams = {
        congestionControl:
          typeof raw.congestionControl === 'string' && raw.congestionControl.trim()
            ? raw.congestionControl.trim()
            : 'bbr',
        zeroRttHandshake: raw.zeroRttHandshake === true,
        heartbeat: typeof raw.heartbeat === 'string' ? raw.heartbeat.trim() : undefined,
        tls
      };
      return params as unknown as Record<string, unknown>;
    }

    case 'SHADOWSOCKS': {
      const method =
        typeof raw.method === 'string' && raw.method.trim() ? raw.method.trim() : SS_DEFAULT_METHOD;
      let password = typeof raw.password === 'string' && raw.password ? raw.password : '';
      if (!password) {
        const keyBytes =
          method === '2022-blake3-aes-256-gcm' || method === '2022-blake3-chacha20-poly1305'
            ? 32
            : 16;
        password = randomBytes(keyBytes).toString('base64');
      } else {
        password = normalizeShadowsocksPassword(method, password);
      }
      const mode = raw.mode === 'multi-user' ? 'multi-user' : 'shared';
      const multiplex = normalizeMultiplex(raw.multiplex);
      const params: ShadowsocksParams = {
        method,
        password,
        mode,
        udpOverTcp: raw.udpOverTcp === true || raw.udp_over_tcp === true,
        ...(multiplex ? { multiplex } : {})
      };
      return params as unknown as Record<string, unknown>;
    }

    case 'NAIVE': {
      const tls = normalizeTlsConfig(raw.tls, 'tls', ['h2']);
      if (!tls.enabled || tls.mode === 'none') {
        throw new BadRequestException('NaiveProxy 协议必须启用 TLS 安全层');
      }
      const params: NaiveParams = {
        network: typeof raw.network === 'string' ? raw.network.trim() : 'tcp',
        tls
      };
      return params as unknown as Record<string, unknown>;
    }

    case 'SHADOWTLS': {
      if (Number(raw.version) !== 3) {
        throw new BadRequestException('ShadowTLS 仅支持 v3');
      }
      const handshakeDest = asNonEmptyString(raw.handshakeDest, 'ShadowTLS 握手目标 (handshakeDest)');
      parseDest(handshakeDest);
      const rawInner = raw.inner;
      if (!rawInner || typeof rawInner !== 'object' || Array.isArray(rawInner)) {
        throw new BadRequestException('ShadowTLS 必须配置内层 Shadowsocks 2022');
      }
      const inner = rawInner as Record<string, unknown>;
      if (inner.type !== 'SHADOWSOCKS') {
        throw new BadRequestException('ShadowTLS 内层协议必须为 SHADOWSOCKS');
      }
      const method = asNonEmptyString(inner.method, 'ShadowTLS 内层 Shadowsocks 算法');
      const keyLength = shadowsocks2022KeyLength(method);
      if (!keyLength) {
        throw new BadRequestException('ShadowTLS 内层必须使用 Shadowsocks 2022 算法');
      }
      const rawPassword = typeof inner.password === 'string' ? inner.password.trim() : '';
      const password = rawPassword
        ? normalizeShadowsocksPassword(method, rawPassword)
        : randomBytes(keyLength).toString('base64');
      const params: ShadowtlsParams = {
        version: 3,
        handshakeDest,
        strictMode: raw.strictMode !== false,
        inner: { type: 'SHADOWSOCKS', method, password }
      };
      return params as unknown as Record<string, unknown>;
    }

    case 'MIXED':
    case 'SOCKS':
    case 'HTTP': {
      // 直连代理池默认标准 TCP 明文监听以保证原生工具 100% 兼容；
      // 可按需挂载系统证书中心的一键 TLS（证书 PEM 由线路关联在构建期注入）。
      const tls = normalizeTlsConfig(raw.tls, 'none');
      return {
        allowLan: raw.allowLan === true,
        usersEnabled: raw.usersEnabled === true,
        ...(tls.enabled ? { tls } : {})
      };
    }

    case 'DIRECT': {
      return {
        overrideAddress: typeof raw.overrideAddress === 'string' ? raw.overrideAddress.trim() : undefined,
        overridePort: raw.overridePort ? Number(raw.overridePort) : undefined
      };
    }

    default:
      throw new BadRequestException(`不支持的入站协议：${type as string}`);
  }
}

// API 输出脱敏：剥离 Reality 私钥等
export function sanitizeInboundParams(params: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
  // 兼容迁移前的扁平 Reality 参数，避免旧存量配置泄露私钥。
  delete clone.privateKey;
  delete clone.key;
  if (clone.tls && typeof clone.tls === 'object') {
    const tls = clone.tls as Record<string, unknown>;
    delete tls.key;
    if (tls.reality && typeof tls.reality === 'object') {
      const reality = tls.reality as Record<string, unknown>;
      delete reality.privateKey;
    }
  }
  return clone;
}

// Reality 私钥只在 Agent 配置组装时还原，数据库中的线路参数始终保存密文。
export function protectInboundSecrets(params: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
  const tls = clone.tls;
  if (!tls || typeof tls !== 'object' || Array.isArray(tls)) return clone;
  const reality = (tls as Record<string, unknown>).reality;
  if (!reality || typeof reality !== 'object' || Array.isArray(reality)) return clone;
  const privateKey = (reality as Record<string, unknown>).privateKey;
  if (typeof privateKey === 'string' && privateKey.length > 0 && !isEncryptedSecret(privateKey)) {
    (reality as Record<string, unknown>).privateKey = encryptSecret(privateKey);
  }
  return clone;
}

export function revealInboundSecrets(params: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
  const tls = clone.tls;
  if (!tls || typeof tls !== 'object' || Array.isArray(tls)) return clone;
  const reality = (tls as Record<string, unknown>).reality;
  if (!reality || typeof reality !== 'object' || Array.isArray(reality)) return clone;
  const privateKey = (reality as Record<string, unknown>).privateKey;
  if (typeof privateKey === 'string' && isEncryptedSecret(privateKey)) {
    (reality as Record<string, unknown>).privateKey = decryptSecret(privateKey);
  }
  return clone;
}

// 组装客户端侧 V2Ray Transport；WebSocket 的 Host 必须落在 headers.Host。
export function buildClientTransport(
  transport?: InboundTransport,
  hostOverride?: string | null
): Record<string, unknown> | undefined {
  if (!transport || transport.type === 'tcp') return undefined;
  const rawTransport = transport as unknown as Record<string, unknown>;
  const host = hostOverride?.trim() || (typeof transport.host === 'string' ? transport.host : undefined);
  const headers = transport.headers ? { ...transport.headers } : {};
  const maxEarlyData = typeof transport.maxEarlyData === 'number'
    ? transport.maxEarlyData
    : (typeof rawTransport.max_early_data === 'number' ? rawTransport.max_early_data : undefined);
  const earlyDataHeaderName = typeof transport.earlyDataHeaderName === 'string'
    ? transport.earlyDataHeaderName
    : (typeof rawTransport.early_data_header_name === 'string' ? rawTransport.early_data_header_name : undefined);
  const serviceName = typeof transport.serviceName === 'string' && transport.serviceName
    ? transport.serviceName
    : (typeof rawTransport.service_name === 'string' ? rawTransport.service_name : undefined);

  switch (transport.type) {
    case 'ws':
      if (host) headers.Host = host;
      return {
        type: 'ws',
        ...(transport.path ? { path: transport.path } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(maxEarlyData && maxEarlyData > 0 ? { max_early_data: maxEarlyData } : {}),
        ...(earlyDataHeaderName ? { early_data_header_name: earlyDataHeaderName } : {})
      };
    case 'grpc':
      return {
        type: 'grpc',
        ...(serviceName ? { service_name: serviceName } : {})
      };
    case 'http': {
      const hostList = host
        ? [host]
        : (Array.isArray(rawTransport.host) ? rawTransport.host.filter((h): h is string => typeof h === 'string' && Boolean(h)) : undefined);
      return {
        type: 'http',
        ...(hostList?.length ? { host: hostList } : {}),
        ...(transport.path ? { path: transport.path } : {}),
        ...(Object.keys(headers).length ? { headers } : {})
      };
    }
    case 'httpupgrade':
      return {
        type: 'httpupgrade',
        ...(host ? { host } : {}),
        ...(transport.path ? { path: transport.path } : {}),
        ...(Object.keys(headers).length ? { headers } : {})
      };
    default:
      return undefined;
  }
}

// 组装客户端侧 TLS；Reality 需要同时携带公钥、Short ID 和 uTLS 参数。
export function buildClientTls(
  tls?: InboundTlsConfig,
  serverNameOverride?: string | null,
  options: { includeAlpn?: boolean; includeInsecure?: boolean } = {}
): Record<string, unknown> | undefined {
  if (!tls || !tls.enabled || tls.mode === 'none') return undefined;
  const rawTls = tls as unknown as Record<string, unknown>;
  const reality = tls.reality;
  const rawReality = (reality ?? undefined) as unknown as Record<string, unknown> | undefined;
  const serverName =
    serverNameOverride?.trim() ||
    tls.serverName ||
    (typeof rawTls.server_name === 'string' ? rawTls.server_name.trim() : undefined) ||
    (Array.isArray(reality?.serverNames) ? reality.serverNames[0] : undefined);
  const rawUtls = rawTls.utls && typeof rawTls.utls === 'object' && !Array.isArray(rawTls.utls)
    ? (rawTls.utls as Record<string, unknown>)
    : undefined;
  const customFingerprint = typeof rawTls.clientFingerprint === 'string' && rawTls.clientFingerprint.trim()
    ? rawTls.clientFingerprint.trim()
    : (typeof rawUtls?.fingerprint === 'string' && rawUtls.fingerprint.trim() ? rawUtls.fingerprint.trim() : undefined);

  const isReality = Boolean(
    rawReality &&
    (tls.mode === 'reality' || rawReality.enabled === true || Boolean(rawReality.publicKey || rawReality.public_key))
  );

  if (isReality && rawReality) {
    const publicKey = typeof rawReality.publicKey === 'string'
      ? rawReality.publicKey
      : (typeof rawReality.public_key === 'string' ? rawReality.public_key : '');
    const shortId = Array.isArray(reality?.shortIds) && reality.shortIds.length > 0
      ? reality.shortIds[0]
      : (typeof rawReality.shortId === 'string'
          ? rawReality.shortId
          : (typeof rawReality.short_id === 'string' ? rawReality.short_id : ''));
    return {
      enabled: true,
      ...(serverName ? { server_name: serverName } : {}),
      utls: { enabled: true, fingerprint: customFingerprint || 'chrome' },
      reality: {
        enabled: true,
        public_key: publicKey,
        short_id: shortId
      }
    };
  }

  return {
    enabled: true,
    ...(serverName ? { server_name: serverName } : {}),
    ...(customFingerprint ? { utls: { enabled: true, fingerprint: customFingerprint } } : {}),
    ...(options.includeAlpn !== false && Array.isArray(tls.alpn) && tls.alpn.length ? { alpn: tls.alpn } : {}),
    ...(options.includeInsecure !== false ? { insecure: tls.insecure === true } : {})
  };
}

// 构建 Sing-box Transport 配置块
function buildServerTransport(transport?: InboundTransport): Record<string, unknown> | undefined {
  if (!transport || transport.type === 'tcp') return undefined;

  switch (transport.type) {
    case 'ws': {
      const ws: Record<string, unknown> = { type: 'ws' };
      const headers = transport.headers ? { ...transport.headers } : {};
      // sing-box 的 WebSocket transport 没有顶层 host 字段，统一映射到 Host 请求头。
      if (transport.host) headers.Host = transport.host;
      if (transport.path) ws.path = transport.path;
      if (Object.keys(headers).length) ws.headers = headers;
      if (transport.maxEarlyData) ws.max_early_data = transport.maxEarlyData;
      if (transport.earlyDataHeaderName) ws.early_data_header_name = transport.earlyDataHeaderName;
      return ws;
    }
    case 'grpc': {
      const grpc: Record<string, unknown> = { type: 'grpc' };
      if (transport.serviceName) grpc.service_name = transport.serviceName;
      return grpc;
    }
    case 'http': {
      const http: Record<string, unknown> = { type: 'http' };
      if (transport.host) http.host = [transport.host];
      if (transport.path) http.path = transport.path;
      if (transport.headers) http.headers = transport.headers;
      return http;
    }
    case 'httpupgrade': {
      const hup: Record<string, unknown> = { type: 'httpupgrade' };
      if (transport.host) hup.host = transport.host;
      if (transport.path) hup.path = transport.path;
      if (transport.headers) hup.headers = transport.headers;
      return hup;
    }
    default:
      return undefined;
  }
}

// 构建 Sing-box TLS 配置块
function buildServerTls(tls?: InboundTlsConfig): Record<string, unknown> | undefined {
  if (!tls || !tls.enabled || tls.mode === 'none') return undefined;

  const extraOptions: Record<string, unknown> = {};
  if (tls.minVersion) extraOptions.min_version = tls.minVersion;
  if (tls.maxVersion) extraOptions.max_version = tls.maxVersion;
  if (tls.cipherSuites && tls.cipherSuites.length) extraOptions.cipher_suites = tls.cipherSuites;

  if (tls.mode === 'reality' && tls.reality) {
    const { host, port } = parseDest(tls.reality.dest);
    return {
      enabled: true,
      server_name: tls.serverName || tls.reality.serverNames[0],
      reality: {
        enabled: true,
        handshake: { server: host, server_port: port },
        private_key: tls.reality.privateKey,
        short_id: tls.reality.shortIds
      },
      ...extraOptions
    };
  }

  if (tls.mode === 'acme' && tls.acme) {
    return {
      enabled: true,
      server_name: tls.serverName || tls.acme.domain,
      acme: {
        domain: tls.acme.domain,
        email: tls.acme.email,
        ...(tls.acme.provider ? { provider: tls.acme.provider } : {})
      },
      ...(tls.alpn && tls.alpn.length ? { alpn: tls.alpn } : {}),
      ...extraOptions
    };
  }

  if (tls.certificate?.length && tls.key?.length) {
    return {
      enabled: true,
      ...(tls.serverName ? { server_name: tls.serverName } : {}),
      certificate: tls.certificate,
      key: tls.key,
      ...(tls.alpn && tls.alpn.length ? { alpn: tls.alpn } : {}),
      ...extraOptions
    };
  }

  // 标准 TLS (证书路径)
  return {
    enabled: true,
    ...(tls.serverName ? { server_name: tls.serverName } : {}),
    certificate_path: tls.certificatePath,
    key_path: tls.keyPath,
    ...(tls.alpn && tls.alpn.length ? { alpn: tls.alpn } : {}),
    ...extraOptions
  };
}

// 构建 Sing-box Inbound Multiplex 配置块
export function buildServerMultiplex(multiplex?: InboundMultiplexConfig): Record<string, unknown> | undefined {
  if (!multiplex || !multiplex.enabled) return undefined;
  const res: Record<string, unknown> = { enabled: true };
  if (multiplex.padding !== undefined) res.padding = multiplex.padding;
  if (multiplex.brutal && multiplex.brutal.enabled) {
    const upMbps = multiplex.brutal.upMbps ?? 0;
    const downMbps = multiplex.brutal.downMbps ?? 0;
    if (upMbps > 0 && downMbps > 0) {
      res.brutal = {
        enabled: true,
        up_mbps: upMbps,
        down_mbps: downMbps
      };
    }
  }
  return res;
}

// 构建 Sing-box Hysteria2 Masquerade 配置块
export function buildServerMasquerade(masquerade?: Hysteria2Masquerade): Record<string, unknown> | undefined {
  if (!masquerade || !masquerade.type) return undefined;
  if (masquerade.type === 'file' && masquerade.dir) {
    return { type: 'file', dir: masquerade.dir };
  }
  if (masquerade.type === 'proxy' && masquerade.url) {
    return {
      type: 'proxy',
      url: masquerade.url,
      ...(masquerade.rewriteHost ? { rewrite_host: true } : {})
    };
  }
  if (masquerade.type === 'string' && masquerade.content !== undefined) {
    return {
      type: 'string',
      content: masquerade.content,
      ...(masquerade.statusCode ? { status_code: masquerade.statusCode } : {}),
      ...(masquerade.headers ? { headers: masquerade.headers } : {})
    };
  }
  return undefined;
}

// 构建 Sing-box 入站共享监听底座字段
export function buildSharedListenFields(options?: SharedListenOptions): Record<string, unknown> {
  if (!options) return {};
  const res: Record<string, unknown> = {};
  if (options.tcpFastOpen === true) res.tcp_fast_open = true;
  if (options.tcpMultiPath === true) res.tcp_multi_path = true;
  if (typeof options.udpFragment === 'boolean') res.udp_fragment = options.udpFragment;
  if (options.udpTimeout && options.udpTimeout.trim()) res.udp_timeout = options.udpTimeout.trim();
  if (options.proxyProtocol === true) {
    res.proxy_protocol = true;
    if (options.proxyProtocolAcceptNoHeader === true) {
      res.proxy_protocol_accept_no_header = true;
    }
  }
  return res;
}

// 组装 Sing-box 服务端入站 JSON（用于 Agent 的 config_sync）
export function buildServerInbound(input: {
  type: ProtocolType;
  tag: string;
  listen: string;
  port: number;
  params: Record<string, unknown>;
  users: InboundUserCredential[];
  lineId?: string;
  proxyPoolUsers?: ProxyPoolCredential[];
  listenOptions?: SharedListenOptions;
}): Record<string, unknown> {
  const { type, tag, listen, port, params, users, lineId, listenOptions } = input;
  const listenFields = buildSharedListenFields(listenOptions);
  // VLESS 需要在运行时修复旧版明文 + Vision 数据；其余协议已在入站 CRUD 边界完成归一化，
  // 中继组装还可能只携带客户端侧 TLS 参数，不能在这里重复要求 Agent 证书路径。
  const rawVlessTls = params.tls;
  const vlessTlsDisabled =
    rawVlessTls && typeof rawVlessTls === 'object' && !Array.isArray(rawVlessTls)
      ? (rawVlessTls as Record<string, unknown>).enabled === false ||
        (rawVlessTls as Record<string, unknown>).mode === 'none'
      : false;
  const normalizedParams =
    type === 'VLESS' && (!rawVlessTls || vlessTlsDisabled)
      ? normalizeInboundParams(type, params)
      : params;

  switch (type) {
    case 'VLESS':
    case 'VLESS_REALITY' as ProtocolType: {
      const normalized = normalizedParams as unknown as VlessParams;
      const transport = buildServerTransport(normalized.transport);
      const tls = buildServerTls(normalized.tls);
      const multiplex = buildServerMultiplex(normalized.multiplex);
      return {
        type: 'vless',
        tag,
        listen,
        listen_port: port,
        ...listenFields,
        users: users.map((u) => ({
          uuid: u.uuid,
          name: formatInboundUserName(u, lineId),
          ...(normalized.flow ? { flow: normalized.flow } : {})
        })),
        ...(transport ? { transport } : {}),
        ...(tls ? { tls } : {}),
        ...(multiplex ? { multiplex } : {})
      };
    }

    case 'VMESS': {
      const p = normalizedParams as unknown as VmessParams;
      const transport = buildServerTransport(p.transport);
      const tls = buildServerTls(p.tls);
      const multiplex = buildServerMultiplex(p.multiplex);
      return {
        type: 'vmess',
        tag,
        listen,
        listen_port: port,
        ...listenFields,
        users: users.map((u) => ({
          uuid: u.uuid,
          name: formatInboundUserName(u, lineId),
          alterId: p.alterId ?? 0
        })),
        ...(transport ? { transport } : {}),
        ...(tls ? { tls } : {}),
        ...(multiplex ? { multiplex } : {})
      };
    }

    case 'TROJAN': {
      const p = normalizedParams as unknown as TrojanParams;
      const transport = buildServerTransport(p.transport);
      const tls = buildServerTls(p.tls);
      const multiplex = buildServerMultiplex(p.multiplex);
      return {
        type: 'trojan',
        tag,
        listen,
        listen_port: port,
        ...listenFields,
        users: users.map((u) => ({
          password: u.credential,
          name: formatInboundUserName(u, lineId)
        })),
        ...(transport ? { transport } : {}),
        ...(tls ? { tls } : {}),
        ...(multiplex ? { multiplex } : {})
      };
    }

    case 'HYSTERIA2': {
      const p = normalizedParams as unknown as Hysteria2Params;
      const tls = buildServerTls(p.tls);
      const masquerade = buildServerMasquerade(p.masquerade);
      return {
        type: 'hysteria2',
        tag,
        listen,
        listen_port: port,
        ...listenFields,
        ...(p.upMbps && p.upMbps > 0 ? { up_mbps: p.upMbps } : {}),
        ...(p.downMbps && p.downMbps > 0 ? { down_mbps: p.downMbps } : {}),
        ...(p.ignoreClientBandwidth ? { ignore_client_bandwidth: true } : {}),
        ...(p.obfs ? { obfs: p.obfs } : {}),
        ...(masquerade ? { masquerade } : {}),
        users: users.map((u) => ({ name: formatInboundUserName(u, lineId), password: u.credential })),
        ...(tls ? { tls } : {})
      };
    }

    case 'TUIC': {
      const p = normalizedParams as unknown as TuicParams;
      const tls = buildServerTls(p.tls);
      return {
        type: 'tuic',
        tag,
        listen,
        listen_port: port,
        ...listenFields,
        users: users.map((u) => ({ uuid: u.uuid, name: formatInboundUserName(u, lineId), password: u.credential })),
        congestion_control: p.congestionControl || 'bbr',
        ...(p.zeroRttHandshake ? { zero_rtt_handshake: true } : {}),
        ...(p.heartbeat ? { heartbeat: p.heartbeat } : {}),
        ...(tls ? { tls } : {})
      };
    }

    case 'SHADOWSOCKS': {
      const p = normalizedParams as unknown as ShadowsocksParams;
      const password = normalizeShadowsocksPassword(p.method, p.password || '');
      // Sing-box 官方规范：udp_over_tcp 与 multiplex 互斥
      const multiplex = p.udpOverTcp ? undefined : buildServerMultiplex(p.multiplex);
      if (p.mode === 'multi-user') {
        return {
          type: 'shadowsocks',
          tag,
          listen,
          listen_port: port,
          ...listenFields,
          method: p.method,
          password,
          ...(p.udpOverTcp ? { udp_over_tcp: true } : {}),
          ...(multiplex ? { multiplex } : {}),
          users: users.map((u) => ({
            name: formatInboundUserName(u, lineId),
            password: resolveShadowsocksUserPassword(p.method, u.credential, u.uuid)
          }))
        };
      }
      return {
        type: 'shadowsocks',
        tag,
        listen,
        listen_port: port,
        ...listenFields,
        method: p.method,
        password,
        ...(p.udpOverTcp ? { udp_over_tcp: true } : {}),
        ...(multiplex ? { multiplex } : {})
      };
    }

    case 'NAIVE': {
      const p = normalizedParams as unknown as NaiveParams;
      const tls = buildServerTls(p.tls);
      return {
        type: 'naive',
        tag,
        listen,
        listen_port: port,
        ...listenFields,
        network: p.network || 'tcp',
        users: users.map((u) => ({ username: formatAuthUserName(u, lineId), password: u.credential })),
        ...(tls ? { tls } : {})
      };
    }

    case 'SHADOWTLS': {
      const p = normalizeInboundParams('SHADOWTLS', normalizedParams) as unknown as ShadowtlsParams;
      const { host, port: destPort } = parseDest(p.handshakeDest);
      return {
        type: 'shadowtls',
        tag,
        listen,
        listen_port: port,
        ...listenFields,
        detour: `${tag}-inner`,
        version: 3,
        users: users.map((u) => ({ name: formatInboundUserName(u, lineId), password: u.credential })),
        handshake: { server: host, server_port: destPort },
        strict_mode: p.strictMode !== false
      };
    }

    case 'MIXED':
    case 'SOCKS':
    case 'HTTP': {
      const p = normalizedParams as unknown as MixedParams;
      const tls = buildServerTls(p.tls);
      const inboundObj: Record<string, unknown> = {
        type: type.toLowerCase(),
        tag,
        listen,
        listen_port: port,
        ...listenFields
      };
      const inboundUsers: Array<Record<string, unknown>> = [];
      if (p.usersEnabled && users.length) {
        inboundUsers.push(
          ...users.map((u) => ({ username: formatAuthUserName(u, lineId), password: u.credential }))
        );
      }
      // 直连代理池凭据：独立凭据空间，与订阅用户在同一个 mixed 单端口内并列承接 SOCKS5/HTTP
      for (const proxyUser of input.proxyPoolUsers ?? []) {
        const username = proxyUser?.username?.trim();
        const password = proxyUser?.password;
        if (!username || !password) continue;
        if (inboundUsers.some((item) => item.username === username)) continue;
        inboundUsers.push({ username, password });
      }
      if (inboundUsers.length) {
        inboundObj.users = inboundUsers;
      }
      if (tls) inboundObj.tls = tls;
      return inboundObj;
    }

    case 'DIRECT': {
      const p = normalizedParams as unknown as DirectParams;
      return {
        type: 'direct',
        tag,
        listen,
        listen_port: port,
        ...listenFields,
        ...(p.overrideAddress ? { override_address: p.overrideAddress } : {}),
        ...(p.overridePort ? { override_port: p.overridePort } : {})
      };
    }

    default:
      throw new BadRequestException(`不支持的入站协议：${type as string}`);
  }
}

// ShadowTLS v3 只作为外层伪装，内层 SS 入站仅绑定回环地址并由 detour 注入。
export function buildServerInbounds(input: Parameters<typeof buildServerInbound>[0]): Array<Record<string, unknown>> {
  if (input.type !== 'SHADOWTLS') return [buildServerInbound(input)];
  const params = normalizeInboundParams('SHADOWTLS', input.params) as unknown as ShadowtlsParams;
  const normalizedInput = { ...input, params: params as unknown as Record<string, unknown> };
  const primary = buildServerInbound(normalizedInput);
  return [
    primary,
    {
      type: 'shadowsocks',
      tag: `${input.tag}-inner`,
      listen: '127.0.0.1',
      listen_port: 0,
      method: params.inner.method,
      password: normalizeShadowsocksPassword(params.inner.method, params.inner.password)
    }
  ];
}

// ==============================
// 直连代理池来源 IP 白名单路由规则
//
// 语义：命中 inbound 且命中该凭据、但来源 IP 不在白名单内 → 直接拒绝。
// 必须使用 logical/and 内层 invert：若在顶层规则上 invert，会连同其他凭据
// 与订阅用户的流量一起被反转命中而误伤整条入站。相同白名单的凭据会合并为一条规则。
// ==============================
export function buildProxyPoolWhitelistRules(input: {
  tag: string;
  credentials: Array<{ username: string; whitelistIps: string[] }>;
}): Array<Record<string, unknown>> {
  const groups = new Map<string, string[]>();
  for (const credential of input.credentials) {
    const username = credential.username?.trim();
    const whitelist = (credential.whitelistIps ?? []).map((item) => item.trim()).filter(Boolean);
    if (!username || !whitelist.length) continue;
    const key = [...new Set(whitelist)].join(',');
    const existing = groups.get(key);
    if (existing) existing.push(username);
    else groups.set(key, [username]);
  }
  return [...groups.entries()].map(([key, usernames]) => ({
    type: 'logical',
    mode: 'and',
    rules: [
      { inbound: [input.tag] },
      { auth_user: usernames },
      { source_ip_cidr: key.split(','), invert: true }
    ],
    action: 'reject'
  }));
}
