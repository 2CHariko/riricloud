import { z } from 'zod';
import i18n from '@/i18n/config';
import type { ApiLine, ProtocolType } from '@/lib/api';
import type { InboundParams } from '../../nodes/use-nodes';
import type { LinePayload } from '../use-lines';
import { canEnableProxyPool, requiresUpstreamUserAuth } from './proxy-pool-line-capabilities';
import { egressFormFields, egressToFormValues, toEgressPayload, validateEgress } from './line-egress-schema';

export const PROTOCOL_TYPES = [
  'VLESS', 'VMESS', 'TROJAN', 'HYSTERIA2', 'TUIC', 'SHADOWSOCKS',
  'NAIVE', 'SHADOWTLS', 'MIXED', 'SOCKS', 'HTTP', 'DIRECT'
] as const satisfies readonly ProtocolType[];

export const PROTOCOL_LABELS: Record<ProtocolType, string> = {
  VLESS: 'VLESS / Reality', VMESS: 'VMess', TROJAN: 'Trojan', HYSTERIA2: 'Hysteria 2', TUIC: 'TUIC v5',
  SHADOWSOCKS: 'Shadowsocks', NAIVE: 'NaiveProxy', SHADOWTLS: 'ShadowTLS', MIXED: 'Mixed', SOCKS: 'SOCKS5',
  HTTP: 'HTTP', DIRECT: 'Direct'
};

export const MANUAL_CERTIFICATE_ID = '__node_local__';

export const TARGET_LINE_PROTOCOLS = ['VLESS', 'VMESS', 'TROJAN', 'HYSTERIA2', 'TUIC', 'SHADOWSOCKS', 'NAIVE'] as const;

export const ALPN_PRESET_VALUES = ['h3', 'h2', 'http/1.1'] as const;

export function getAlpnPresets(protocolType: ProtocolType, transportType: LineFormValues['transportType'] = 'tcp'): string[] {
  if (protocolType === 'HYSTERIA2' || protocolType === 'TUIC') return ['h3'];
  if (protocolType === 'NAIVE') return ['h2'];
  if (transportType === 'grpc') return ['h2'];
  if (transportType === 'ws' || transportType === 'httpupgrade') return ['http/1.1'];
  return ['h2', 'http/1.1'];
}

export function getAlpnOptions(
  protocolType: ProtocolType,
  transportType: LineFormValues['transportType'],
  selected: string[] = []
) {
  return [...new Set([...getAlpnPresets(protocolType, transportType), ...selected.filter(Boolean)])];
}

const optionalPort = z.preprocess(
  (value) => value === '' || value === null || value === undefined ? undefined : value,
  z.coerce.number().int().min(1).max(65535).optional()
);

const optionalNonNegative = z.preprocess(
  (value) => value === '' || value === null || value === undefined ? undefined : value,
  z.coerce.number().int().min(0).optional()
);

const headersSchema = z.array(z.object({ key: z.string(), value: z.string() }));

export const lineFormSchema = z.object({
  ...egressFormFields,
  name: z.string().trim().min(1, i18n.t('admin:lineForm.validation.nameRequired')),
  tag: z.string().trim().max(64, i18n.t('admin:lineForm.validation.tagMax')),
  listen: z.string().trim().min(1, i18n.t('admin:lineForm.validation.listenRequired')).max(64, i18n.t('admin:lineForm.validation.listenMax')),
  type: z.enum(['DIRECT', 'RELAY', 'EXTERNAL']),
  protocolType: z.enum(PROTOCOL_TYPES),
  proxyPoolEnabled: z.boolean().default(false),
  relayMode: z.enum(['BLIND_FORWARD', 'PROTOCOL_PROXY', 'TARGET_LINE', 'UPSTREAM_NODE']).optional(),
  targetLineId: z.string().optional(),
  upstreamNodeId: z.string().optional(),
  entryNodeId: z.string().optional(),
  entryPort: optionalPort,
  landingNodeId: z.string().optional(),
  landingPort: optionalPort,
  certificateId: z.string(),

  transportType: z.enum(['tcp', 'ws', 'grpc', 'http', 'httpupgrade']),
  wsPath: z.string(),
  wsHost: z.string(),
  wsHeaders: headersSchema,
  wsMaxEarlyData: optionalNonNegative,
  wsEarlyDataHeaderName: z.string(),
  grpcServiceName: z.string(),
  httpPath: z.string(),
  httpHost: z.string(),
  httpHeaders: headersSchema,

  tlsMode: z.enum(['none', 'tls', 'reality', 'acme']),
  tlsServerName: z.string(),
  tlsCertPath: z.string(),
  tlsKeyPath: z.string(),
  tlsAlpn: z.array(z.string().trim().min(1)),
  tlsInsecure: z.boolean(),
  tlsMinVersion: z.string().default(''),
  tlsMaxVersion: z.string().default(''),
  tlsCipherSuites: z.string().default(''),
  realityDest: z.string(),
  realityPrivateKey: z.string(),
  realityPublicKey: z.string(),
  realityShortIds: z.string(),
  realityServerNames: z.string(),
  acmeDomain: z.string(),
  acmeEmail: z.string(),
  acmeProvider: z.string(),

  // 网络监听与物理限速
  speedLimitMbps: optionalNonNegative,
  tcpFastOpen: z.boolean().default(false),
  tcpMultiPath: z.boolean().default(false),
  udpFragment: z.boolean().default(true),
  udpTimeout: z.string().default(''),
  proxyProtocol: z.boolean().default(false),
  proxyProtocolAcceptNoHeader: z.boolean().default(false),

  // 多路复用 Multiplex
  multiplexEnabled: z.boolean().default(false),
  multiplexProtocol: z.enum(['smux', 'yamux', 'h2mux']).default('smux'),
  multiplexMaxConnections: optionalNonNegative,
  multiplexMinStreams: optionalNonNegative,
  multiplexMaxStreams: optionalNonNegative,
  multiplexPadding: z.boolean().default(false),
  multiplexBrutalEnabled: z.boolean().default(false),
  multiplexBrutalUpMbps: optionalNonNegative,
  multiplexBrutalDownMbps: optionalNonNegative,

  vlessFlow: z.string(),
  vmessAlterId: optionalNonNegative,
  hy2UpMbps: optionalNonNegative,
  hy2DownMbps: optionalNonNegative,
  hy2IgnoreClientBandwidth: z.boolean(),
  hy2ObfsPassword: z.string(),
  hy2MasqueradeType: z.enum(['none', 'file', 'proxy', 'string']).default('none'),
  hy2MasqueradeFile: z.string().default(''),
  hy2MasqueradeProxyUrl: z.string().default(''),
  hy2MasqueradeString: z.string().default(''),
  tuicCongestionControl: z.string(),
  tuicZeroRtt: z.boolean(),
  tuicHeartbeat: z.string(),
  ssMethod: z.string(),
  ssPassword: z.string(),
  ssMode: z.enum(['shared', 'multi-user']),
  ssUdpOverTcp: z.boolean().default(false),
  naiveNetwork: z.enum(['tcp', 'udp']),
  stHandshakeDest: z.string(),
  stInnerMethod: z.string(),
  stInnerPassword: z.string(),
  stStrictMode: z.boolean(),
  localAllowLan: z.boolean(),
  localUsersEnabled: z.boolean(),
  directOverrideAddress: z.string(),
  directOverridePort: optionalPort,

  endpointOverrideEnabled: z.boolean(),
  serverHost: z.string(),
  serverPort: optionalPort,
  serverName: z.string(),
  host: z.string(),
  landingEndpointOverrideEnabled: z.boolean().default(false),
  landingServerHost: z.string().default(''),
  landingServerPort: optionalPort,
  trafficRate: z.coerce.number().min(0),
  tags: z.string(),
  level: z.coerce.number().int().min(0),
  sortOrder: z.coerce.number().int().min(0),
  isPublic: z.boolean(),
  status: z.enum(['ACTIVE', 'DISABLED']),
  allowLanAccess: z.boolean().default(false),
  tunnelType: z.string().optional(),
  tunnelPort: optionalPort,
  tunnelSecret: z.string().optional()
}).superRefine((value, ctx) => {
  validateEgress(value, ctx);
  if (value.proxyPoolEnabled && !canEnableProxyPool(value)) {
    ctx.addIssue({ code: 'custom', path: ['proxyPoolEnabled'], message: i18n.t('admin:lineForm.proxyPoolInvalid') });
  }
  if (requiresUpstreamUserAuth(value) && !value.localUsersEnabled) {
    ctx.addIssue({ code: 'custom', path: ['localUsersEnabled'], message: i18n.t('admin:lineForm.upstreamUsersRequired') });
  }
  if (value.type === 'EXTERNAL') {
    if (!value.upstreamNodeId) ctx.addIssue({ code: 'custom', path: ['upstreamNodeId'], message: i18n.t('admin:lineForm.validation.upstreamNodeRequired') });
    return;
  }
  if (value.trafficRate < 0.01) ctx.addIssue({ code: 'custom', path: ['trafficRate'], message: i18n.t('admin:upstream.rateRequired') });
  if (!value.entryNodeId) ctx.addIssue({ code: 'custom', path: ['entryNodeId'], message: i18n.t('admin:lineForm.validation.entryNodeRequired') });
  if (value.type === 'RELAY' && value.relayMode !== 'TARGET_LINE' && value.relayMode !== 'UPSTREAM_NODE' && !value.landingNodeId) {
    ctx.addIssue({ code: 'custom', path: ['landingNodeId'], message: i18n.t('admin:lineForm.validation.landingNodeRequired') });
  }
  if (value.type === 'RELAY' && !value.relayMode) {
    ctx.addIssue({ code: 'custom', path: ['relayMode'], message: i18n.t('admin:lineForm.validation.relayModeRequired') });
  }
  if (value.type === 'RELAY' && value.relayMode === 'TARGET_LINE' && !value.targetLineId) {
    ctx.addIssue({ code: 'custom', path: ['targetLineId'], message: i18n.t('admin:lineForm.validation.targetLineRequired') });
  }
  if (value.type === 'RELAY' && value.relayMode === 'UPSTREAM_NODE' && !value.upstreamNodeId) {
    ctx.addIssue({ code: 'custom', path: ['upstreamNodeId'], message: i18n.t('admin:lineForm.validation.upstreamNodeRequired') });
  }

  const tlsRequired = ['TROJAN', 'HYSTERIA2', 'TUIC', 'NAIVE'].includes(value.protocolType);
  if (tlsRequired && value.tlsMode === 'none') {
    ctx.addIssue({ code: 'custom', path: ['tlsMode'], message: i18n.t('admin:lineForm.validation.tlsRequired') });
  }
  if (value.tlsMode === 'tls') {
    const usesManagedCertificate = value.certificateId !== MANUAL_CERTIFICATE_ID;
    if (!usesManagedCertificate && !value.tlsCertPath.trim()) ctx.addIssue({ code: 'custom', path: ['tlsCertPath'], message: i18n.t('admin:lineForm.validation.certRequired') });
    if (!usesManagedCertificate && !value.tlsKeyPath.trim()) ctx.addIssue({ code: 'custom', path: ['tlsKeyPath'], message: i18n.t('admin:lineForm.validation.keyRequired') });
  }
  if (value.tlsMode === 'acme') {
    if (!value.acmeDomain.trim()) ctx.addIssue({ code: 'custom', path: ['acmeDomain'], message: i18n.t('admin:lineForm.validation.acmeDomainRequired') });
    if (!value.acmeEmail.trim()) ctx.addIssue({ code: 'custom', path: ['acmeEmail'], message: i18n.t('admin:lineForm.validation.acmeEmailRequired') });
  }
  if (value.protocolType === 'SHADOWTLS' && !value.stHandshakeDest.trim()) {
    ctx.addIssue({ code: 'custom', path: ['stHandshakeDest'], message: i18n.t('admin:lineForm.validation.stDestRequired') });
  }
  if (value.protocolType === 'SHADOWTLS' && !value.stInnerMethod.trim()) {
    ctx.addIssue({ code: 'custom', path: ['stInnerMethod'], message: i18n.t('admin:lineForm.validation.stMethodRequired') });
  }

  // 规范互斥：客户端 Multiplex 中 max_connections 与 max_streams 互斥
  if (value.multiplexEnabled && value.multiplexMaxConnections && value.multiplexMaxStreams) {
    ctx.addIssue({
      code: 'custom',
      path: ['multiplexMaxStreams'],
      message: i18n.t('admin:lineForm.validation.muxMutexError')
    });
  }

  // 强校验：开启 TCP Brutal 时必须提供大于 0 的上行和下行速率期望
  if (value.multiplexEnabled && value.multiplexBrutalEnabled) {
    if (!value.multiplexBrutalUpMbps || value.multiplexBrutalUpMbps <= 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['multiplexBrutalUpMbps'],
        message: i18n.t('admin:lineForm.validation.brutalUpRequired')
      });
    }
    if (!value.multiplexBrutalDownMbps || value.multiplexBrutalDownMbps <= 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['multiplexBrutalDownMbps'],
        message: i18n.t('admin:lineForm.validation.brutalDownRequired')
      });
    }
  }

  // 规范互斥：Shadowsocks 中 UDP over TCP 与 Multiplex 互斥
  if (value.protocolType === 'SHADOWSOCKS' && value.ssUdpOverTcp && value.multiplexEnabled) {
    ctx.addIssue({
      code: 'custom',
      path: ['multiplexEnabled'],
      message: i18n.t('admin:lineForm.validation.ssUotMutexError')
    });
  }

  // 规范互斥：VLESS XTLS Vision 流控仅限原始 TCP 传输，WS/gRPC 传输不得携带 flow
  if (value.protocolType === 'VLESS' && value.transportType !== 'tcp' && value.vlessFlow) {
    ctx.addIssue({
      code: 'custom',
      path: ['vlessFlow'],
      message: i18n.t('admin:lineForm.validation.vlessFlowTcpOnly')
    });
  }
});

export type LineFormValues = z.infer<typeof lineFormSchema>;

export const splitList = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback?: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown, fallback: string[] = []) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : fallback;
}

function headersToRows(value: unknown) {
  const headers = asRecord(value);
  return Object.entries(headers).map(([key, headerValue]) => ({ key, value: asString(headerValue) }));
}

function rowsToHeaders(rows: Array<{ key: string; value: string }>) {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) headers[key] = row.value;
  }
  return headers;
}

function protocolTlsMode(protocolType: ProtocolType): LineFormValues['tlsMode'] {
  if (protocolType === 'VLESS') return 'reality';
  if (['TROJAN', 'HYSTERIA2', 'TUIC', 'NAIVE'].includes(protocolType)) return 'tls';
  return 'none';
}

export function defaultLineFormValues(protocolType: ProtocolType = 'VLESS'): LineFormValues {
  const tlsMode = protocolTlsMode(protocolType);
  const isQuic = protocolType === 'HYSTERIA2' || protocolType === 'TUIC';
  return {
    ...egressToFormValues(),
    name: '', tag: '', listen: '0.0.0.0', type: 'DIRECT', protocolType, relayMode: 'BLIND_FORWARD', targetLineId: '', upstreamNodeId: '',
    entryNodeId: '', entryPort: undefined, landingNodeId: '', landingPort: undefined,
    proxyPoolEnabled: false,
    certificateId: MANUAL_CERTIFICATE_ID,
    transportType: 'tcp', wsPath: '/ws', wsHost: '', wsHeaders: [], wsMaxEarlyData: undefined,
    wsEarlyDataHeaderName: '', grpcServiceName: 'grpc', httpPath: '/http', httpHost: '', httpHeaders: [],
    tlsMode, tlsServerName: '', tlsCertPath: '', tlsKeyPath: '', tlsAlpn: isQuic ? ['h3'] : getAlpnPresets(protocolType),
    tlsInsecure: false, tlsMinVersion: '', tlsMaxVersion: '', tlsCipherSuites: '',
    realityDest: 'www.apple.com:443', realityPrivateKey: '', realityPublicKey: '',
    realityShortIds: '0123456789abcdef', realityServerNames: 'www.apple.com', acmeDomain: '', acmeEmail: '', acmeProvider: '',
    speedLimitMbps: undefined, tcpFastOpen: false, tcpMultiPath: false, udpFragment: true, udpTimeout: '', proxyProtocol: false, proxyProtocolAcceptNoHeader: false,
    multiplexEnabled: false, multiplexProtocol: 'smux', multiplexMaxConnections: undefined, multiplexMinStreams: undefined, multiplexMaxStreams: undefined,
    multiplexPadding: false, multiplexBrutalEnabled: false, multiplexBrutalUpMbps: undefined, multiplexBrutalDownMbps: undefined,
    vlessFlow: 'xtls-rprx-vision', vmessAlterId: 0, hy2UpMbps: 0, hy2DownMbps: 0,
    hy2IgnoreClientBandwidth: false, hy2ObfsPassword: '',
    hy2MasqueradeType: 'none', hy2MasqueradeFile: '', hy2MasqueradeProxyUrl: '', hy2MasqueradeString: '',
    tuicCongestionControl: 'bbr', tuicZeroRtt: false,
    tuicHeartbeat: '', ssMethod: '2022-blake3-aes-128-gcm', ssPassword: '', ssMode: 'shared', ssUdpOverTcp: false, naiveNetwork: 'tcp',
    stHandshakeDest: 'gateway.icloud.com:443', stInnerMethod: '2022-blake3-aes-128-gcm', stInnerPassword: '', stStrictMode: true,
    localAllowLan: false, localUsersEnabled: false, directOverrideAddress: '', directOverridePort: undefined,
    endpointOverrideEnabled: false, serverHost: '', serverPort: undefined, serverName: '', host: '',
    landingEndpointOverrideEnabled: false, landingServerHost: '', landingServerPort: undefined,
    trafficRate: 1, tags: '', level: 0, sortOrder: 0, isPublic: true, status: 'ACTIVE',
    allowLanAccess: false, tunnelType: 'TCP_MUX', tunnelPort: undefined, tunnelSecret: ''
  };
}

const RANDOM_SERVICE_PORT_MIN = 20000;
const RANDOM_SERVICE_PORT_MAX = 65535;

function randomPort() {
  return Math.floor(Math.random() * (RANDOM_SERVICE_PORT_MAX - RANDOM_SERVICE_PORT_MIN + 1)) + RANDOM_SERVICE_PORT_MIN;
}

function randomTag() {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(16).slice(2, 10).padEnd(8, '0');
  return `line-${suffix}`;
}

export function newLineFormValues(protocolType: ProtocolType = 'VLESS', nextSortOrder = 0): LineFormValues {
  const port = randomPort();
  return {
    ...defaultLineFormValues(protocolType),
    tag: randomTag(),
    entryPort: port,
    landingPort: undefined,
    sortOrder: nextSortOrder
  };
}

export function lineToFormValues(line: ApiLine): LineFormValues {
  const defaults = defaultLineFormValues(line.protocolType);
  if (line.type === 'EXTERNAL') return {
    ...defaults, type: 'EXTERNAL', name: line.name, tag: line.tag ?? '',
    upstreamNodeId: line.upstreamNodeId ?? '', tags: line.tags.join(', '),
    level: line.level, sortOrder: line.sortOrder, isPublic: line.isPublic, status: line.status, trafficRate: 0
  };
  const params = asRecord(line.params) as InboundParams;
  const rawTransport = asRecord(params.transport);
  const rawTls = asRecord(params.tls);
  const rawReality = asRecord(rawTls.reality);
  const rawAcme = asRecord(rawTls.acme);
  const rawShadowtlsInner = asRecord(params.inner);
  const transportType = asString(rawTransport.type, defaults.transportType) as LineFormValues['transportType'];
  const tlsMode = asString(rawTls.mode, defaults.tlsMode) as LineFormValues['tlsMode'];
  const transportHeaders = rawTransport.headers;

  return {
    ...defaults,
    ...egressToFormValues(line.egressProxy),
    name: line.name,
    tag: line.tag ?? '',
    listen: line.listen,
    type: line.type,
    protocolType: line.protocolType,
    proxyPoolEnabled: line.proxyPoolEnabled === true,
    relayMode: line.relayMode ?? 'BLIND_FORWARD',
    targetLineId: line.targetLineId ?? '',
    upstreamNodeId: line.upstreamNodeId ?? '',
    entryNodeId: line.entryNodeId ?? '',
    entryPort: line.entryPort ?? undefined,
    landingNodeId: line.landingNodeId ?? '',
    landingPort: line.landingPort ?? undefined,
    certificateId: line.certificateId ?? MANUAL_CERTIFICATE_ID,
    transportType,
    wsPath: asString(rawTransport.path, defaults.wsPath),
    wsHost: asString(rawTransport.host),
    wsHeaders: transportType === 'ws' ? headersToRows(transportHeaders) : [],
    wsMaxEarlyData: asNumber(rawTransport.maxEarlyData),
    wsEarlyDataHeaderName: asString(rawTransport.earlyDataHeaderName),
    grpcServiceName: asString(rawTransport.serviceName, defaults.grpcServiceName),
    httpPath: asString(rawTransport.path, defaults.httpPath),
    httpHost: asString(rawTransport.host),
    httpHeaders: ['http', 'httpupgrade'].includes(transportType) ? headersToRows(transportHeaders) : [],
    tlsMode,
    tlsServerName: asString(rawTls.serverName),
    tlsCertPath: asString(rawTls.certificatePath),
    tlsKeyPath: asString(rawTls.keyPath),
    tlsAlpn: asStringArray(rawTls.alpn, getAlpnPresets(line.protocolType, transportType)),
    tlsInsecure: rawTls.insecure === true,
    tlsMinVersion: asString(rawTls.min_version),
    tlsMaxVersion: asString(rawTls.max_version),
    tlsCipherSuites: Array.isArray(rawTls.cipher_suites) ? rawTls.cipher_suites.join(', ') : asString(rawTls.cipher_suites),
    realityDest: asString(rawReality.dest, defaults.realityDest),
    realityPrivateKey: '',
    realityPublicKey: asString(rawReality.publicKey),
    realityShortIds: Array.isArray(rawReality.shortIds) ? rawReality.shortIds.filter((item): item is string => typeof item === 'string').join(',') : '',
    realityServerNames: Array.isArray(rawReality.serverNames) ? rawReality.serverNames.filter((item): item is string => typeof item === 'string').join(',') : '',
    acmeDomain: asString(rawAcme.domain),
    acmeEmail: asString(rawAcme.email),
    acmeProvider: asString(rawAcme.provider),
    speedLimitMbps: asNumber(line.speedLimitMbps),
    tcpFastOpen: line.tcpFastOpen === true,
    tcpMultiPath: line.tcpMultiPath === true,
    udpFragment: line.udpFragment !== false,
    udpTimeout: asString(line.udpTimeout),
    proxyProtocol: line.proxyProtocol === true || Number(line.proxyProtocol) > 0,
    proxyProtocolAcceptNoHeader: line.proxyProtocolAcceptNoHeader === true,
    multiplexEnabled: asRecord(params.multiplex).enabled === true,
    multiplexProtocol: (asString(asRecord(params.multiplex).protocol, 'smux') as LineFormValues['multiplexProtocol']),
    multiplexMaxConnections: asNumber(asRecord(params.multiplex).maxConnections ?? asRecord(params.multiplex).max_connections),
    multiplexMinStreams: asNumber(asRecord(params.multiplex).minStreams ?? asRecord(params.multiplex).min_streams),
    multiplexMaxStreams: asNumber(asRecord(params.multiplex).maxStreams ?? asRecord(params.multiplex).max_streams),
    multiplexPadding: asRecord(params.multiplex).padding === true,
    multiplexBrutalEnabled: asRecord(asRecord(params.multiplex).brutal).enabled === true,
    multiplexBrutalUpMbps: asNumber(asRecord(asRecord(params.multiplex).brutal).upMbps ?? asRecord(asRecord(params.multiplex).brutal).up_mbps),
    multiplexBrutalDownMbps: asNumber(asRecord(asRecord(params.multiplex).brutal).downMbps ?? asRecord(asRecord(params.multiplex).brutal).down_mbps),
    vlessFlow: asString(params.flow),
    vmessAlterId: asNumber(params.alterId, 0),
    hy2UpMbps: asNumber(params.upMbps, 0),
    hy2DownMbps: asNumber(params.downMbps, 0),
    hy2IgnoreClientBandwidth: params.ignoreClientBandwidth === true,
    hy2ObfsPassword: asString(asRecord(params.obfs).password),
    hy2MasqueradeType: (asString(asRecord(params.masquerade).type, 'none') as LineFormValues['hy2MasqueradeType']),
    hy2MasqueradeFile: asString(asRecord(params.masquerade).file ?? asRecord(params.masquerade).dir),
    hy2MasqueradeProxyUrl: asString(asRecord(params.masquerade).url),
    hy2MasqueradeString: asString(asRecord(params.masquerade).string ?? asRecord(params.masquerade).text),
    tuicCongestionControl: asString(params.congestionControl, 'bbr'),
    tuicZeroRtt: params.zeroRttHandshake === true,
    tuicHeartbeat: asString(params.heartbeat),
    ssMethod: asString(params.method, defaults.ssMethod),
    ssPassword: asString(params.password),
    ssMode: params.mode === 'multi-user' ? 'multi-user' : 'shared',
    ssUdpOverTcp: params.udp_over_tcp !== undefined && params.udp_over_tcp !== false,
    naiveNetwork: params.network === 'udp' ? 'udp' : 'tcp',
    stHandshakeDest: asString(params.handshakeDest, defaults.stHandshakeDest),
    stInnerMethod: asString(rawShadowtlsInner.method, defaults.stInnerMethod),
    stInnerPassword: asString(rawShadowtlsInner.password),
    stStrictMode: params.strictMode !== false,
    localAllowLan: params.allowLan === true,
    localUsersEnabled: params.usersEnabled === true,
    directOverrideAddress: asString(params.overrideAddress),
    directOverridePort: asNumber(params.overridePort),
    endpointOverrideEnabled: line.endpointOverrideEnabled,
    serverHost: line.endpointOverrides.serverHost ?? '',
    serverPort: line.endpointOverrides.serverPort ?? undefined,
    serverName: line.endpointOverrides.serverName ?? '',
    host: line.endpointOverrides.host ?? '',
    landingEndpointOverrideEnabled: line.landingEndpointOverrideEnabled === true,
    landingServerHost: line.endpointOverrides.landingServerHost ?? '',
    landingServerPort: line.endpointOverrides.landingServerPort ?? undefined,
    trafficRate: line.trafficRate,
    tags: line.tags.join(', '),
    level: line.level,
    sortOrder: line.sortOrder,
    isPublic: line.isPublic,
    status: line.status,
    allowLanAccess: line.allowLanAccess ?? false,
    tunnelType: line.tunnelType ?? 'TCP_MUX',
    tunnelPort: line.tunnelPort ?? undefined,
    tunnelSecret: line.tunnelSecret ?? ''
  };
}

export function buildParamsFromValues(values: LineFormValues): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const transportHeaders = values.transportType === 'ws' ? rowsToHeaders(values.wsHeaders) : rowsToHeaders(values.httpHeaders);

  if (['VLESS', 'VMESS', 'TROJAN'].includes(values.protocolType)) {
    params.transport = {
      type: values.transportType,
      ...(values.transportType === 'ws' || values.transportType === 'httpupgrade' ? {
        path: (values.transportType === 'ws' ? values.wsPath : values.httpPath).trim() || '/',
        host: (values.transportType === 'ws' ? values.wsHost : values.httpHost).trim() || undefined,
        headers: Object.keys(transportHeaders).length ? transportHeaders : undefined,
        ...(values.transportType === 'ws' ? {
          maxEarlyData: values.wsMaxEarlyData,
          earlyDataHeaderName: values.wsEarlyDataHeaderName.trim() || undefined
        } : {})
      } : {}),
      ...(values.transportType === 'grpc' ? { serviceName: values.grpcServiceName.trim() || undefined } : {}),
      ...(values.transportType === 'http' ? {
        path: values.httpPath.trim() || '/',
        host: values.httpHost.trim() || undefined,
        headers: Object.keys(transportHeaders).length ? transportHeaders : undefined
      } : {})
    };
  }

  if (['VLESS', 'VMESS', 'TROJAN', 'HYSTERIA2', 'TUIC', 'NAIVE', 'MIXED', 'SOCKS', 'HTTP'].includes(values.protocolType)) {
    const tls: Record<string, unknown> = {
      enabled: values.tlsMode !== 'none',
      mode: values.tlsMode,
      serverName: values.tlsServerName.trim() || undefined,
      ...(values.tlsMode !== 'none' && values.tlsMode !== 'reality' ? { alpn: values.tlsAlpn } : {}),
      insecure: values.tlsInsecure
    };
    if (values.tlsMode === 'tls') {
      if (values.certificateId === MANUAL_CERTIFICATE_ID) {
        tls.certificatePath = values.tlsCertPath.trim();
        tls.keyPath = values.tlsKeyPath.trim();
      }
    }
    if (values.tlsMode === 'reality') {
      const reality: Record<string, unknown> = {
        dest: values.realityDest.trim() || 'www.apple.com:443',
        serverNames: splitList(values.realityServerNames),
        shortIds: splitList(values.realityShortIds)
      };
      if (values.realityPrivateKey.trim()) reality.privateKey = values.realityPrivateKey.trim();
      if (values.realityPublicKey.trim()) reality.publicKey = values.realityPublicKey.trim();
      tls.reality = reality;
    }
    if (values.tlsMode === 'acme') {
      tls.acme = {
        domain: values.acmeDomain.trim(),
        email: values.acmeEmail.trim(),
        provider: values.acmeProvider.trim() || undefined
      };
    }
    if (values.tlsMinVersion.trim()) tls.min_version = values.tlsMinVersion.trim();
    if (values.tlsMaxVersion.trim()) tls.max_version = values.tlsMaxVersion.trim();
    if (values.tlsCipherSuites.trim()) tls.cipher_suites = splitList(values.tlsCipherSuites);
    params.tls = tls;
  }

  if (['VLESS', 'VMESS', 'TROJAN', 'SHADOWSOCKS'].includes(values.protocolType) && values.multiplexEnabled) {
    params.multiplex = {
      enabled: true,
      protocol: values.multiplexProtocol,
      ...(values.multiplexMaxConnections ? { maxConnections: values.multiplexMaxConnections } : {}),
      ...(values.multiplexMinStreams ? { minStreams: values.multiplexMinStreams } : {}),
      ...(values.multiplexMaxStreams ? { maxStreams: values.multiplexMaxStreams } : {}),
      padding: values.multiplexPadding,
      ...(values.multiplexBrutalEnabled && (values.multiplexBrutalUpMbps ?? 0) > 0 && (values.multiplexBrutalDownMbps ?? 0) > 0 ? {
        brutal: {
          enabled: true,
          upMbps: values.multiplexBrutalUpMbps,
          downMbps: values.multiplexBrutalDownMbps
        }
      } : {})
    };
  }

  switch (values.protocolType) {
    case 'VLESS':
      if (values.vlessFlow.trim()) params.flow = values.vlessFlow.trim();
      break;
    case 'VMESS':
      params.alterId = values.vmessAlterId ?? 0;
      break;
    case 'HYSTERIA2':
      params.upMbps = values.hy2UpMbps ?? 0;
      params.downMbps = values.hy2DownMbps ?? 0;
      params.ignoreClientBandwidth = values.hy2IgnoreClientBandwidth;
      if (values.hy2ObfsPassword.trim()) params.obfs = { type: 'salamander', password: values.hy2ObfsPassword.trim() };
      if (values.hy2MasqueradeType === 'file' && values.hy2MasqueradeFile.trim()) {
        params.masquerade = { type: 'file', file: values.hy2MasqueradeFile.trim() };
      } else if (values.hy2MasqueradeType === 'proxy' && values.hy2MasqueradeProxyUrl.trim()) {
        params.masquerade = { type: 'proxy', url: values.hy2MasqueradeProxyUrl.trim() };
      } else if (values.hy2MasqueradeType === 'string' && values.hy2MasqueradeString.trim()) {
        params.masquerade = { type: 'string', string: values.hy2MasqueradeString.trim() };
      }
      break;
    case 'TUIC':
      params.congestionControl = values.tuicCongestionControl.trim() || 'bbr';
      params.zeroRttHandshake = values.tuicZeroRtt;
      if (values.tuicHeartbeat.trim()) params.heartbeat = values.tuicHeartbeat.trim();
      break;
    case 'SHADOWSOCKS':
      params.method = values.ssMethod.trim() || '2022-blake3-aes-128-gcm';
      if (values.ssPassword.trim()) params.password = values.ssPassword.trim();
      params.mode = values.ssMode;
      if (values.ssUdpOverTcp) {
        params.udpOverTcp = true;
        params.udp_over_tcp = true;
      }
      break;
    case 'NAIVE':
      params.network = values.naiveNetwork;
      break;
    case 'SHADOWTLS':
      params.version = 3;
      params.handshakeDest = values.stHandshakeDest.trim();
      params.inner = {
        type: 'SHADOWSOCKS',
        method: values.stInnerMethod.trim(),
        ...(values.stInnerPassword.trim() ? { password: values.stInnerPassword.trim() } : {})
      };
      params.strictMode = values.stStrictMode;
      break;
    case 'MIXED':
    case 'SOCKS':
    case 'HTTP':
      params.allowLan = values.localAllowLan;
      params.usersEnabled = values.localUsersEnabled;
      break;
    case 'DIRECT':
      if (values.directOverrideAddress.trim()) params.overrideAddress = values.directOverrideAddress.trim();
      if (values.directOverridePort) params.overridePort = values.directOverridePort;
      break;
  }

  return params;
}

export function toLinePayload(values: LineFormValues): LinePayload {
  if (values.type === 'EXTERNAL') return {
    type: 'EXTERNAL', name: values.name.trim(), tag: values.tag.trim() || null,
    upstreamNodeId: values.upstreamNodeId || '', tags: splitList(values.tags),
    level: values.level, sortOrder: values.sortOrder, isPublic: values.isPublic, status: values.status,
    ...(values.egressClearConfirmed ? { egressProxy: null } : {})
  };
  const entryNodeId = values.entryNodeId || '';
  const isRelayWithLanding = values.type === 'RELAY' && values.relayMode !== 'TARGET_LINE' && values.relayMode !== 'UPSTREAM_NODE';
  const landingNodeId = isRelayWithLanding ? values.landingNodeId || null : null;
  const landingPort = isRelayWithLanding ? values.landingPort ?? null : null;
  return {
    name: values.name.trim(),
    tag: values.tag.trim() || null,
    listen: values.listen.trim(),
    type: values.type,
    protocolType: values.protocolType,
    proxyPoolEnabled: values.proxyPoolEnabled,
    ...(toEgressPayload(values) !== undefined ? { egressProxy: toEgressPayload(values) } : {}),
    params: buildParamsFromValues(values),
    relayMode: values.type === 'RELAY' ? values.relayMode : null,
    targetLineId: values.type === 'RELAY' && values.relayMode === 'TARGET_LINE' ? values.targetLineId || null : null,
    upstreamNodeId: values.type === 'RELAY' && values.relayMode === 'UPSTREAM_NODE' ? values.upstreamNodeId || null : null,
    entryNodeId,
    entryPort: values.entryPort,
    landingNodeId,
    landingPort,
    speedLimitMbps: values.speedLimitMbps ?? null,
    tcpFastOpen: values.tcpFastOpen,
    tcpMultiPath: values.tcpMultiPath,
    udpFragment: values.udpFragment,
    udpTimeout: values.udpTimeout.trim() || null,
    proxyProtocol: values.proxyProtocol ?? false,
    proxyProtocolAcceptNoHeader: values.proxyProtocol ? values.proxyProtocolAcceptNoHeader : false,
    certificateId: values.tlsMode === 'tls' && values.certificateId !== MANUAL_CERTIFICATE_ID ? values.certificateId : null,
    endpointOverrideEnabled: values.endpointOverrideEnabled,
    serverHost: values.serverHost.trim() || null,
    serverPort: values.serverPort ?? null,
    serverName: values.serverName.trim() || null,
    host: values.host.trim() || null,
    landingEndpointOverrideEnabled: values.type === 'RELAY' ? values.landingEndpointOverrideEnabled : false,
    landingServerHost: values.type === 'RELAY' ? (values.landingServerHost.trim() || null) : null,
    landingServerPort: values.type === 'RELAY' ? (values.landingServerPort ?? null) : null,
    trafficRate: values.trafficRate,
    tags: splitList(values.tags),
    level: values.level,
    sortOrder: values.sortOrder,
    isPublic: values.isPublic,
    status: values.status,
    allowLanAccess: values.allowLanAccess,
    tunnelType: values.tunnelType || null,
    tunnelPort: values.tunnelPort ?? null,
    tunnelSecret: values.tunnelSecret?.trim() || null
  };
}
