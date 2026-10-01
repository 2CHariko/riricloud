import { proxyObject as obj, proxyText as text, proxyPluginOptions, proxyTlsEnabled, type ProxyConnection } from '../../common/proxy-connection';
import { requireProxyCapability } from '../../common/proxy-capabilities';

export function buildSingboxClientTls(connection: ProxyConnection): Record<string, unknown> | undefined {
  if (!proxyTlsEnabled(connection)) return undefined;
  const p = obj(connection.params.tls);
  const reality = obj(p.reality);
  const result: Record<string, unknown> = { enabled: true, server_name: text(p.serverName ?? p.server_name) || connection.serverHost.replace(/^\[|\]$/g, '') };
  if (p.insecure === true) result.insecure = true;
  if (p.alpn) result.alpn = p.alpn;
  if (p.certificate) result.certificate = p.certificate;
  for (const [camel, snake] of [['minVersion', 'min_version'], ['maxVersion', 'max_version'], ['cipherSuites', 'cipher_suites']]) if (p[camel] ?? p[snake]) result[snake] = p[camel] ?? p[snake];
  const fingerprint = obj(p.utls).enabled === false ? '' : text(p.clientFingerprint ?? p.fingerprint ?? obj(p.utls).fingerprint);
  if (obj(p.utls).enabled !== false && (fingerprint || p.mode === 'reality')) result.utls = { enabled: true, fingerprint: fingerprint || 'chrome' };
  if (Object.keys(reality).length) result.reality = { enabled: true, public_key: reality.publicKey ?? reality.public_key, short_id: reality.shortId ?? reality.short_id ?? '' };
  return result;
}
export function buildSingboxClientTransport(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const p = obj(params.transport);
  if (!p.type || p.type === 'tcp') return undefined;
  const result: Record<string, unknown> = { type: p.type };
  if (p.type === 'grpc') result.service_name = p.serviceName ?? p.service_name ?? '';
  else {
    result.path = p.path ?? '/';
    const headers = { ...obj(p.headers), ...(p.host ? { Host: p.host } : {}) };
    if (Object.keys(headers).length) result.headers = headers;
    if (p.type === 'httpupgrade' && p.host) result.host = p.host;
    if (p.type === 'ws') {
      if (p.maxEarlyData ?? p.max_early_data) result.max_early_data = p.maxEarlyData ?? p.max_early_data;
      if (p.earlyDataHeaderName ?? p.early_data_header_name) result.early_data_header_name = p.earlyDataHeaderName ?? p.early_data_header_name;
    }
  }
  return result;
}
export function compileSingboxClient(connection: ProxyConnection, tag: string): Record<string, unknown> {
  requireProxyCapability(connection, 'singbox');
  const p = connection.params;
  const type = connection.protocolType;
  const result: Record<string, unknown> = { type: type.toLowerCase(), tag, server: connection.serverHost.replace(/^\[|\]$/g, ''), server_port: connection.serverPort };
  if (['VLESS', 'VMESS', 'TUIC'].includes(type)) result.uuid = p.uuid;
  if (['TROJAN', 'HYSTERIA2', 'TUIC', 'SHADOWSOCKS', 'NAIVE'].includes(type)) result.password = p.password;
  if (type === 'VLESS' && p.flow) result.flow = p.flow;
  if (['VLESS', 'VMESS'].includes(type) && (p.packetEncoding ?? p.packet_encoding)) result.packet_encoding = p.packetEncoding ?? p.packet_encoding;
  if (type === 'VMESS') Object.assign(result, { alter_id: Number(p.alterId ?? p.alter_id ?? 0), security: p.security ?? 'auto' });
  if (type === 'SHADOWSOCKS') {
    result.method = p.method;
    if (p.plugin) { result.plugin = p.plugin === 'obfs' ? 'obfs-local' : p.plugin; result.plugin_opts = proxyPluginOptions(p); }
    if (p.udpOverTcp ?? p.udp_over_tcp) result.udp_over_tcp = p.udpOverTcp ?? p.udp_over_tcp;
  }
  if (type === 'HYSTERIA2') {
    if (p.upMbps ?? p.up_mbps) result.up_mbps = p.upMbps ?? p.up_mbps;
    if (p.downMbps ?? p.down_mbps) result.down_mbps = p.downMbps ?? p.down_mbps;
    if (p.obfs) result.obfs = typeof p.obfs === 'string' ? { type: p.obfs, password: p.obfsPassword } : p.obfs;
  }
  if (type === 'TUIC') {
    result.congestion_control = p.congestionControl ?? p.congestion_control ?? 'bbr';
    if (p.udpRelayMode ?? p.udp_relay_mode) result.udp_relay_mode = p.udpRelayMode ?? p.udp_relay_mode;
    if (p.zeroRttHandshake ?? p.zero_rtt_handshake) result.zero_rtt_handshake = p.zeroRttHandshake ?? p.zero_rtt_handshake;
    if (p.heartbeat) result.heartbeat = p.heartbeat;
  }
  if (['SOCKS', 'HTTP', 'NAIVE'].includes(type)) {
    if (p.username) { result.username = p.username; result.password = p.password; }
    if (type === 'SOCKS') result.version = String(p.version ?? '5');
    if (type === 'HTTP' && p.headers) result.headers = p.headers;
  }
  const tls = buildSingboxClientTls(connection);
  const transport = buildSingboxClientTransport(p);
  if (tls) result.tls = tls;
  if (transport) result.transport = transport;
  if (p.multiplex) {
    const m = obj(p.multiplex);
    result.multiplex = { enabled: m.enabled === true };
    const multiplex = obj(result.multiplex);
    for (const [camel, snake] of [['protocol', 'protocol'], ['maxConnections', 'max_connections'], ['minStreams', 'min_streams'], ['maxStreams', 'max_streams'], ['padding', 'padding']]) if (m[camel] !== undefined || m[snake] !== undefined) multiplex[snake] = m[camel] ?? m[snake];
    if (obj(m.brutal).enabled) multiplex.brutal = { enabled: true, up_mbps: obj(m.brutal).upMbps, down_mbps: obj(m.brutal).downMbps };
  }
  return result;
}
