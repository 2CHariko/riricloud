import { proxyObject as obj, proxyText as text, proxyPluginOptions, proxyTlsEnabled, type ProxyConnection } from '../../common/proxy-connection';
import { requireProxyCapability } from '../../common/proxy-capabilities';

// 主客户端编译完全独立，不能先生成 Sing-box outbound 再转译。
export function compileMihomoProxy(connection: ProxyConnection, name: string): Record<string, unknown> {
  requireProxyCapability(connection, 'mihomo');
  const p = connection.params;
  const type = connection.protocolType;
  const tls = obj(p.tls);
  const transport = obj(p.transport);
  const reality = obj(tls.reality);
  const m = obj(p.multiplex);
  const result: Record<string, unknown> = { name, type: type === 'SHADOWSOCKS' || type === 'SHADOWTLS' ? 'ss' : type === 'SOCKS' ? 'socks5' : type.toLowerCase(), server: connection.serverHost.replace(/^\[|\]$/g, ''), port: connection.serverPort, udp: true };
  for (const key of ['uuid', 'password', 'username', 'method']) if (p[key] !== undefined) result[key === 'method' ? 'cipher' : key] = p[key];
  if (type === 'VMESS') { result.alterId = Number(p.alterId ?? p.alter_id ?? 0); result.cipher = p.security ?? 'auto'; }
  if (p.flow) result.flow = p.flow;
  if (p.packetEncoding === 'xudp' || p.packet_encoding === 'xudp') result['packet-encoding'] = 'xudp';
  if (proxyTlsEnabled(connection)) {
    const serverName = text(tls.serverName ?? tls.server_name) || connection.serverHost.replace(/^\[|\]$/g, '');
    result.tls = true; result.servername = serverName; result.sni = serverName;
    result['skip-cert-verify'] = tls.insecure === true;
    if (tls.alpn) result.alpn = tls.alpn;
  }
  const fingerprint = obj(tls.utls).enabled === false ? undefined : tls.clientFingerprint ?? tls.fingerprint ?? obj(tls.utls).fingerprint;
  if (obj(tls.utls).enabled !== false && (fingerprint || tls.mode === 'reality')) result['client-fingerprint'] = fingerprint || 'chrome';
  if (Object.keys(reality).length) result['reality-opts'] = { 'public-key': reality.publicKey ?? reality.public_key, 'short-id': reality.shortId ?? reality.short_id ?? '' };
  if (transport.type) {
    result.network = transport.type;
    const headers = { ...obj(transport.headers), ...(transport.host ? { Host: transport.host } : {}) };
    if (transport.type === 'ws') result['ws-opts'] = { path: transport.path ?? '/', ...(Object.keys(headers).length ? { headers } : {}), ...(transport.maxEarlyData ?? transport.max_early_data ? { 'max-early-data': transport.maxEarlyData ?? transport.max_early_data, 'early-data-header-name': transport.earlyDataHeaderName ?? transport.early_data_header_name } : {}) };
    if (transport.type === 'grpc') result['grpc-opts'] = { 'grpc-service-name': transport.serviceName ?? transport.service_name ?? '' };
    if (transport.type === 'http') result['http-opts'] = { path: [transport.path ?? '/'], ...(Object.keys(headers).length ? { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, Array.isArray(v) ? v : [v]])) } : {}) };
  }
  if (m.enabled) {
    result.smux = { enabled: true };
    const smux = obj(result.smux);
    for (const [camel, snake, clash] of [['protocol', 'protocol', 'protocol'], ['maxConnections', 'max_connections', 'max-connections'], ['minStreams', 'min_streams', 'min-streams'], ['maxStreams', 'max_streams', 'max-streams'], ['padding', 'padding', 'padding']]) if (m[camel] !== undefined || m[snake] !== undefined) smux[clash] = m[camel] ?? m[snake];
  }
  if (type === 'HYSTERIA2') {
    if (p.upMbps ?? p.up_mbps) result.up = p.upMbps ?? p.up_mbps;
    if (p.downMbps ?? p.down_mbps) result.down = p.downMbps ?? p.down_mbps;
    if (p.obfs) { result.obfs = typeof p.obfs === 'string' ? p.obfs : obj(p.obfs).type; result['obfs-password'] = typeof p.obfs === 'string' ? p.obfsPassword : obj(p.obfs).password; }
  }
  if (p.udpOverTcp !== undefined || p.udp_over_tcp !== undefined) result['udp-over-tcp'] = p.udpOverTcp ?? p.udp_over_tcp;
  if (type === 'TUIC') {
    result['congestion-controller'] = p.congestionControl ?? p.congestion_control ?? 'bbr';
    result['udp-relay-mode'] = p.udpRelayMode ?? p.udp_relay_mode ?? 'native';
    if (p.zeroRttHandshake !== undefined || p.zero_rtt_handshake !== undefined) result['reduce-rtt'] = p.zeroRttHandshake ?? p.zero_rtt_handshake;
    if (p.heartbeat) {
      const duration = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m)$/.exec(text(p.heartbeat));
      if (!duration) throw new Error('Clash: MIHOMO_HEARTBEAT_UNSUPPORTED');
      const milliseconds = Number(duration[1]) * ({ ms: 1, s: 1000, m: 60000 }[duration[2]] ?? 0);
      if (!Number.isInteger(milliseconds) || milliseconds <= 0) throw new Error('Clash: MIHOMO_HEARTBEAT_UNSUPPORTED');
      result['heartbeat-interval'] = milliseconds;
    }
  }
  if (p.plugin) {
    result.plugin = ['obfs', 'obfs-local'].includes(text(p.plugin)) ? 'obfs' : p.plugin;
    const opts: Record<string, unknown> = {};
    for (const part of proxyPluginOptions(p).split(';').filter(Boolean)) {
      const split = part.indexOf('='); const key = split < 0 ? part : part.slice(0, split);
      opts[key === 'obfs' ? 'mode' : key === 'obfs-host' ? 'host' : key] = split < 0 ? true : part.slice(split + 1);
    }
    result['plugin-opts'] = opts;
  }
  if (type === 'SHADOWTLS') {
    const inner = obj(p.inner);
    const dest = text(p.handshakeDest);
    const handshakeHost = dest.startsWith('[') ? dest.slice(1, dest.indexOf(']')) : dest.replace(/:\d+$/, '');
    result.cipher = inner.method; result.password = inner.password;
    result.plugin = 'shadow-tls'; result['client-fingerprint'] = fingerprint || 'chrome';
    result['plugin-opts'] = { host: text(tls.serverName) || handshakeHost, password: p.password, version: 3 };
    delete result.tls; delete result.sni; delete result.servername;
  }
  return result;
}
