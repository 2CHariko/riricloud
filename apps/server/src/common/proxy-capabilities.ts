import { proxyObject, proxyTlsEnabled, validateProxyConnection, type ProxyConnection } from './proxy-connection';

export interface ProxyCapability { supported: boolean; reason: string | null }
export interface ProxyCapabilities { mihomo: ProxyCapability; singbox: ProxyCapability; fallbackAllowed: boolean }
const capability = (reason: string | null): ProxyCapability => ({ supported: reason === null, reason });
// 白名单只表示协议可表达；运行依赖仍必须由执行器单独验证，绝不因网络错误回退。
const fallbackReasons = new Set(['MIHOMO_NAIVE_UNSUPPORTED', 'MIHOMO_SOCKS_VERSION_UNSUPPORTED', 'MIHOMO_CERTIFICATE_UNSUPPORTED']);
const connectionKeys = new Set(['uuid', 'username', 'password', 'method', 'tls', 'transport', 'multiplex', 'flow', 'alterId', 'alter_id', 'security', 'packetEncoding', 'packet_encoding', 'plugin', 'pluginOpts', 'plugin_opts', 'udpOverTcp', 'udp_over_tcp', 'upMbps', 'up_mbps', 'downMbps', 'down_mbps', 'obfs', 'obfsPassword', 'congestionControl', 'congestion_control', 'udpRelayMode', 'udp_relay_mode', 'zeroRttHandshake', 'zero_rtt_handshake', 'heartbeat', 'version', 'headers', 'inner', 'handshakeDest']);
const tlsKeys = new Set(['enabled', 'mode', 'serverName', 'server_name', 'insecure', 'alpn', 'certificate', 'clientFingerprint', 'fingerprint', 'utls', 'reality', 'minVersion', 'min_version', 'maxVersion', 'max_version', 'cipherSuites', 'cipher_suites']);
const transportKeys = new Set(['type', 'path', 'host', 'headers', 'serviceName', 'service_name', 'maxEarlyData', 'max_early_data', 'earlyDataHeaderName', 'early_data_header_name']);
const multiplexKeys = new Set(['enabled', 'protocol', 'maxConnections', 'max_connections', 'minStreams', 'min_streams', 'maxStreams', 'max_streams', 'padding', 'brutal']);
export function getProxyCapabilities(connection: ProxyConnection): ProxyCapabilities {
  try { validateProxyConnection(connection); } catch {
    return { mihomo: capability('INVALID_CONNECTION'), singbox: capability('INVALID_CONNECTION'), fallbackAllowed: false };
  }
  const p = connection.params;
  const type = connection.protocolType;
  const tls = proxyObject(p.tls);
  const transport = proxyObject(p.transport);
  const multiplex = proxyObject(p.multiplex);
  if (Object.keys(p).some((key) => !connectionKeys.has(key)) || Object.keys(tls).some((key) => !tlsKeys.has(key)) || Object.keys(transport).some((key) => !transportKeys.has(key)) || Object.keys(multiplex).some((key) => !multiplexKeys.has(key))) {
    return { mihomo: capability('UNREPRESENTABLE_PARAMETERS'), singbox: capability('UNREPRESENTABLE_PARAMETERS'), fallbackAllowed: false };
  }
  const transportHeaders = proxyObject(transport.headers);
  if ((['tcp', 'grpc'].includes(String(transport.type)) && Object.keys(transport).some((key) => !['type', 'serviceName', 'service_name'].includes(key)))
    || (Object.keys(transportHeaders).length > 0 && Object.values(transportHeaders).some((value) => typeof value !== 'string' && !Array.isArray(value)))
    || Object.keys(proxyObject(tls.utls)).some((key) => !['enabled', 'fingerprint'].includes(key))
    || Object.keys(proxyObject(tls.reality)).some((key) => !['enabled', 'publicKey', 'public_key', 'shortId', 'short_id', 'shortIds', 'serverNames'].includes(key))) {
    return { mihomo: capability('UNREPRESENTABLE_PARAMETERS'), singbox: capability('UNREPRESENTABLE_PARAMETERS'), fallbackAllowed: false };
  }
  let mihomo: string | null = null;
  let singbox: string | null = null;
  if (type === 'NAIVE') mihomo = 'MIHOMO_NAIVE_UNSUPPORTED';
  else if (type === 'SOCKS' && p.version && String(p.version) !== '5') mihomo = 'MIHOMO_SOCKS_VERSION_UNSUPPORTED';
  else if (tls.certificate) mihomo = 'MIHOMO_CERTIFICATE_UNSUPPORTED';
  else if (transport.type === 'httpupgrade') mihomo = 'MIHOMO_HTTPUPGRADE_UNSUPPORTED';
  else if (type === 'HTTP' && p.headers && Object.keys(proxyObject(p.headers)).length) mihomo = 'MIHOMO_HTTP_HEADERS_UNSUPPORTED';
  else if (['minVersion', 'min_version', 'maxVersion', 'max_version', 'cipherSuites', 'cipher_suites'].some((k) => tls[k] !== undefined)) mihomo = 'MIHOMO_TLS_PARAMETERS_UNSUPPORTED';
  else if ((p.packetEncoding ?? p.packet_encoding) && (p.packetEncoding ?? p.packet_encoding) !== 'xudp') mihomo = 'MIHOMO_PACKET_ENCODING_UNSUPPORTED';
  else if (proxyObject(multiplex.brutal).enabled === true) mihomo = 'MIHOMO_BRUTAL_UNSUPPORTED';
  else if ((multiplex.maxConnections ?? multiplex.max_connections) && (multiplex.maxStreams ?? multiplex.max_streams)) mihomo = 'MIHOMO_MULTIPLEX_LIMITS_UNSUPPORTED';
  else if (type === 'TUIC' && p.heartbeat && !/^([0-9]+(?:\.[0-9]+)?)(ms|s|m)$/.test(String(p.heartbeat))) mihomo = 'MIHOMO_HEARTBEAT_UNSUPPORTED';
  else if (type === 'SHADOWSOCKS' && proxyTlsEnabled(connection)) mihomo = 'MIHOMO_TLS_UNSUPPORTED';
  if (['SHADOWSOCKS', 'SOCKS'].includes(type) && proxyTlsEnabled(connection)) singbox = 'SINGBOX_TLS_UNSUPPORTED';
  else if (type === 'SHADOWTLS') singbox = 'SINGBOX_SHADOWTLS_CHAIN_REQUIRED';
  else if (type === 'NAIVE' && (tls.insecure === true || tls.alpn !== undefined || tls.clientFingerprint || tls.fingerprint || Object.keys(proxyObject(tls.utls)).length)) singbox = 'SINGBOX_NAIVE_TLS_PARAMETERS_UNSUPPORTED';
  // 多个限制同时出现时不能让白名单首个原因遮蔽未授权限制。
  const fallbackAllowed = mihomo !== null && fallbackReasons.has(mihomo) && singbox === null
    && transport.type !== 'httpupgrade' && !(type === 'HTTP' && p.headers)
    && !proxyObject(multiplex.brutal).enabled
    && !((p.packetEncoding ?? p.packet_encoding) && (p.packetEncoding ?? p.packet_encoding) !== 'xudp')
    && !((multiplex.maxConnections ?? multiplex.max_connections) && (multiplex.maxStreams ?? multiplex.max_streams))
    && !(type === 'TUIC' && p.heartbeat && !/^([0-9]+(?:\.[0-9]+)?)(ms|s|m)$/.test(String(p.heartbeat)))
    && !['minVersion', 'min_version', 'maxVersion', 'max_version', 'cipherSuites', 'cipher_suites'].some((k) => tls[k] !== undefined);
  return { mihomo: capability(mihomo), singbox: capability(singbox), fallbackAllowed };
}

export function requireProxyCapability(connection: ProxyConnection, engine: 'mihomo' | 'singbox'): void {
  validateProxyConnection(connection);
  const result = getProxyCapabilities(connection)[engine];
  if (!result.supported) throw new Error(`${engine === 'mihomo' ? 'Clash' : 'Sing-box'}: ${result.reason}`);
}
