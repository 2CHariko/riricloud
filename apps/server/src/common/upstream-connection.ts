export interface UpstreamConnection {
  protocolType: string;
  serverHost: string;
  serverPort: number;
  params: Record<string, unknown>;
}

export function upstreamObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const protocols = new Set(['VLESS', 'VMESS', 'TROJAN', 'HYSTERIA2', 'TUIC', 'SHADOWSOCKS', 'SOCKS', 'HTTP', 'NAIVE']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateUpstreamConnection(connection: UpstreamConnection): void {
  const { protocolType: type, serverHost: host, serverPort: port, params: p } = connection;
  const invalid = () => { throw new Error('Invalid upstream connection configuration'); };
  if (!protocols.has(type) || !host || /[\s/@?#]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) invalid();
  if (!p || typeof p !== 'object' || Array.isArray(p)) invalid();
  for (const key of ['tls', 'transport', 'multiplex']) if (p[key] !== undefined && (!p[key] || typeof p[key] !== 'object' || Array.isArray(p[key]))) invalid();
  if (['VLESS', 'VMESS', 'TUIC'].includes(type) && !uuidPattern.test(text(p.uuid))) invalid();
  if (['TROJAN', 'HYSTERIA2', 'TUIC', 'SHADOWSOCKS', 'NAIVE'].includes(type) && !text(p.password)) invalid();
  if (type === 'SHADOWSOCKS' && !text(p.method)) invalid();
  if (type === 'NAIVE' && !text(p.username)) invalid();
  if (['SOCKS', 'HTTP'].includes(type) && Boolean(text(p.username)) !== Boolean(text(p.password))) invalid();
  const tls = upstreamObject(p.tls);
  const reality = upstreamObject(tls.reality);
  const transport = upstreamObject(p.transport);
  if (tls.mode === 'reality' || reality.enabled === true || Object.keys(reality).length) {
    if (type !== 'VLESS' || !text(reality.publicKey ?? reality.public_key)) invalid();
  }
  if (tls.mode && !['none', 'tls', 'reality'].includes(text(tls.mode))) invalid();
  if (type === 'SOCKS' && p.version && !['4', '4a', '5'].includes(String(p.version))) invalid();
  if (['HYSTERIA2', 'TUIC', 'NAIVE'].includes(type) && (tls.enabled === false || tls.mode === 'none')) invalid();
  if (p.plugin && !['obfs', 'obfs-local', 'v2ray-plugin'].includes(text(p.plugin))) invalid();
  if (p.flow && (type !== 'VLESS' || text(p.flow) !== 'xtls-rprx-vision' || (transport.type && transport.type !== 'tcp') || (!Object.keys(tls).length || tls.enabled === false || tls.mode === 'none'))) invalid();
  if (type === 'VMESS' && (!Number.isInteger(Number(p.alterId ?? p.alter_id ?? 0)) || Number(p.alterId ?? p.alter_id ?? 0) < 0)) invalid();
  if (type === 'HYSTERIA2' && p.obfs) {
    const obfs = upstreamObject(p.obfs);
    if ((typeof p.obfs === 'string' ? p.obfs : obfs.type) !== 'salamander' || !text(typeof p.obfs === 'string' ? p.obfsPassword : obfs.password)) invalid();
  }
  if (Object.keys(transport).length && !['tcp', 'ws', 'grpc', 'http', 'httpupgrade'].includes(text(transport.type))) invalid();
  if (p.multiplex && !['VLESS', 'VMESS', 'TROJAN', 'SHADOWSOCKS'].includes(type)) invalid();
  if (p.headers && type !== 'HTTP') invalid();
  if (Object.keys(transport).length && !['VLESS', 'VMESS', 'TROJAN'].includes(type)) invalid();
  if (p.plugin && type !== 'SHADOWSOCKS') invalid();
  if (['SHADOWSOCKS', 'SOCKS'].includes(type) && Object.keys(tls).length && tls.enabled !== false && tls.mode !== 'none') throw new Error('Sing-box does not support TLS for this upstream protocol');
}

function clientTls(connection: UpstreamConnection): Record<string, unknown> | undefined {
  const p = upstreamObject(connection.params.tls);
  if (p.mode === 'none' || p.enabled === false) return undefined;
  if (!Object.keys(p).length && !['TROJAN', 'HYSTERIA2', 'TUIC', 'NAIVE'].includes(connection.protocolType)) return undefined;
  const reality = upstreamObject(p.reality);
  const utls = upstreamObject(p.utls);
  const result: Record<string, unknown> = {
    enabled: true,
    server_name: text(p.serverName ?? p.server_name) || connection.serverHost.replace(/^\[|\]$/g, '')
  };
  if (p.insecure === true && connection.protocolType !== 'NAIVE') result.insecure = true;
  if (Array.isArray(p.alpn) && connection.protocolType !== 'NAIVE') result.alpn = p.alpn;
  if (Array.isArray(p.certificate)) result.certificate = p.certificate;
  const fingerprint = text(p.clientFingerprint ?? p.fingerprint ?? utls.fingerprint);
  if (fingerprint || p.mode === 'reality') result.utls = { enabled: true, fingerprint: fingerprint || 'chrome' };
  if (Object.keys(reality).length) result.reality = { enabled: true, public_key: reality.publicKey ?? reality.public_key, short_id: reality.shortId ?? reality.short_id ?? '' };
  return result;
}

function clientTransport(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const p = upstreamObject(params.transport);
  if (!p.type || p.type === 'tcp') return undefined;
  const result: Record<string, unknown> = { type: p.type };
  if (p.type === 'grpc') result.service_name = p.serviceName ?? p.service_name ?? '';
  else {
    result.path = p.path ?? '/';
    const headers = { ...upstreamObject(p.headers), ...(p.host ? { Host: p.host } : {}) };
    if (Object.keys(headers).length) result.headers = headers;
    if (p.type === 'httpupgrade' && p.host) result.host = p.host;
    if (p.type === 'ws') {
      if (p.maxEarlyData ?? p.max_early_data) result.max_early_data = p.maxEarlyData ?? p.max_early_data;
      if (p.earlyDataHeaderName ?? p.early_data_header_name) result.early_data_header_name = p.earlyDataHeaderName ?? p.early_data_header_name;
    }
  }
  return result;
}

function pluginOptions(p: Record<string, unknown>): string {
  const raw = p.pluginOpts ?? p.plugin_opts;
  if (typeof raw === 'string') return raw;
  const opts = upstreamObject(raw);
  return Object.entries(opts).map(([key, value]) => {
    const name = ['obfs', 'obfs-local'].includes(text(p.plugin)) ? ({ mode: 'obfs', host: 'obfs-host' }[key] ?? key) : key;
    return value === true ? name : `${name}=${String(value)}`;
  }).join(';');
}

export function buildUpstreamOutbound(connection: UpstreamConnection, tag: string): Record<string, unknown> {
  validateUpstreamConnection(connection);
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
    if (p.plugin) { result.plugin = p.plugin === 'obfs' ? 'obfs-local' : p.plugin; result.plugin_opts = pluginOptions(p); }
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
    if (type === 'SOCKS') result.version = p.version ?? '5';
    if (type === 'HTTP' && p.headers) result.headers = p.headers;
  }
  const tls = clientTls(connection);
  const transport = clientTransport(p);
  if (tls) result.tls = tls;
  if (transport) result.transport = transport;
  if (p.multiplex) {
    const m = upstreamObject(p.multiplex);
    result.multiplex = { enabled: m.enabled === true, ...(m.protocol ? { protocol: m.protocol } : {}), ...(m.maxConnections ?? m.max_connections ? { max_connections: m.maxConnections ?? m.max_connections } : {}), ...(m.minStreams ?? m.min_streams ? { min_streams: m.minStreams ?? m.min_streams } : {}), ...(m.maxStreams ?? m.max_streams ? { max_streams: m.maxStreams ?? m.max_streams } : {}), ...(m.padding !== undefined ? { padding: m.padding } : {}) };
  }
  return result;
}

export function buildUpstreamUri(connection: UpstreamConnection, name: string): string {
  const outbound = buildUpstreamOutbound(connection, name);
  const p = connection.params;
  const tls = upstreamObject(outbound.tls);
  const reality = upstreamObject(tls.reality);
  const transport = upstreamObject(outbound.transport);
  if (upstreamObject(p.multiplex).enabled === true || p.headers || tls.certificate) throw new Error('URI cannot represent upstream multiplex, custom headers or certificate pinning');
  const host = connection.serverHost.includes(':') ? `[${connection.serverHost.replace(/^\[|\]$/g, '')}]` : connection.serverHost;
  const endpoint = `${host}:${connection.serverPort}`;
  const query = new URLSearchParams();
  const put = (key: string, value: unknown) => { if (value !== undefined && value !== null && value !== '') query.set(key, String(value)); };
  if (tls.enabled) {
    put('security', reality.enabled ? 'reality' : 'tls'); put('sni', tls.server_name);
    put('alpn', Array.isArray(tls.alpn) ? tls.alpn.join(',') : undefined);
    put('allowInsecure', tls.insecure ? '1' : undefined);
    put('fp', upstreamObject(tls.utls).fingerprint); put('pbk', reality.public_key); put('sid', reality.short_id);
  } else put('security', 'none');
  put('type', transport.type ?? 'tcp'); put('path', transport.path);
  put('host', upstreamObject(transport.headers).Host ?? transport.host); put('serviceName', transport.service_name);
  put('ed', transport.max_early_data); put('eh', transport.early_data_header_name); put('flow', p.flow);
  const suffix = `?${query.toString()}#${encodeURIComponent(name)}`;
  switch (connection.protocolType) {
    case 'VLESS': return `vless://${encodeURIComponent(text(p.uuid))}@${endpoint}${suffix}`;
    case 'VMESS': {
      const config = { v: '2', ps: name, add: connection.serverHost.replace(/^\[|\]$/g, ''), port: connection.serverPort, id: p.uuid, aid: p.alterId ?? p.alter_id ?? 0, scy: p.security ?? 'auto', net: transport.type ?? 'tcp', type: 'none', host: upstreamObject(transport.headers).Host ?? '', path: transport.service_name ?? transport.path ?? '', tls: tls.enabled ? 'tls' : '', sni: tls.server_name, alpn: Array.isArray(tls.alpn) ? tls.alpn.join(',') : undefined, fp: upstreamObject(tls.utls).fingerprint, allowInsecure: tls.insecure ?? false };
      return `vmess://${Buffer.from(JSON.stringify(config)).toString('base64')}`;
    }
    case 'TROJAN': return `trojan://${encodeURIComponent(text(p.password))}@${endpoint}${suffix}`;
    case 'HYSTERIA2': {
      const obfs = upstreamObject(outbound.obfs); put('obfs', obfs.type); put('obfs-password', obfs.password); put('upmbps', outbound.up_mbps); put('downmbps', outbound.down_mbps);
      return `hysteria2://${encodeURIComponent(text(p.password))}@${endpoint}?${query.toString()}#${encodeURIComponent(name)}`;
    }
    case 'TUIC': {
      put('congestion_control', outbound.congestion_control); put('udp_relay_mode', outbound.udp_relay_mode); put('zero_rtt_handshake', outbound.zero_rtt_handshake); put('heartbeat', outbound.heartbeat);
      return `tuic://${encodeURIComponent(text(p.uuid))}:${encodeURIComponent(text(p.password))}@${endpoint}?${query.toString()}#${encodeURIComponent(name)}`;
    }
    case 'SHADOWSOCKS': {
      const plugin = p.plugin ? `?${new URLSearchParams({ plugin: `${text(outbound.plugin)}${pluginOptions(p) ? ';' + pluginOptions(p) : ''}` }).toString()}` : '';
      return `ss://${Buffer.from(`${text(p.method)}:${text(p.password)}`).toString('base64url')}@${endpoint}/${plugin}#${encodeURIComponent(name)}`;
    }
    case 'SOCKS':
    case 'HTTP':
    case 'NAIVE': {
      if (connection.protocolType === 'SOCKS' && tls.enabled) throw new Error('URI does not support TLS SOCKS upstream');
      if (connection.protocolType === 'SOCKS' && p.version && String(p.version) !== '5') throw new Error('URI supports only SOCKS5 upstream');
      const scheme = connection.protocolType === 'NAIVE' ? 'naive+https' : connection.protocolType === 'SOCKS' ? 'socks5' : tls.enabled ? 'https' : 'http';
      const auth = p.username ? `${encodeURIComponent(text(p.username))}:${encodeURIComponent(text(p.password))}@` : '';
      return `${scheme}://${auth}${endpoint}${suffix}`;
    }
    default: throw new Error('URI does not support upstream protocol');
  }
}

export function buildUpstreamClashProxy(connection: UpstreamConnection, name: string): Record<string, unknown> {
  const outbound = buildUpstreamOutbound(connection, name);
  const type = connection.protocolType;
  if (type === 'NAIVE') throw new Error('Clash does not support NAIVE upstream');
  const p = connection.params;
  if (type === 'SOCKS' && p.version && String(p.version) !== '5') throw new Error('Clash supports only SOCKS5 upstream');
  const tls = upstreamObject(outbound.tls);
  const transport = upstreamObject(outbound.transport);
  const reality = upstreamObject(tls.reality);
  if (tls.certificate) throw new Error('Clash cannot represent upstream certificate pinning');
  const multiplex = upstreamObject(outbound.multiplex);
  const result: Record<string, unknown> = { name, type: type === 'SHADOWSOCKS' ? 'ss' : type === 'SOCKS' ? 'socks5' : type.toLowerCase(), server: outbound.server, port: connection.serverPort, udp: true };
  if (multiplex.enabled) result.smux = { enabled: true, protocol: multiplex.protocol, 'max-connections': multiplex.max_connections, 'min-streams': multiplex.min_streams, 'max-streams': multiplex.max_streams, padding: multiplex.padding };
  for (const key of ['uuid', 'password', 'username', 'method']) if (outbound[key] !== undefined) result[key === 'method' ? 'cipher' : key] = outbound[key];
  if (type === 'VMESS') { result.alterId = outbound.alter_id; result.cipher = outbound.security; }
  if (p.flow) result.flow = p.flow;
  if (tls.enabled) { result.tls = true; result.servername = tls.server_name; result.sni = tls.server_name; result['skip-cert-verify'] = tls.insecure === true; if (tls.alpn) result.alpn = tls.alpn; }
  if (upstreamObject(tls.utls).fingerprint) result['client-fingerprint'] = upstreamObject(tls.utls).fingerprint;
  if (reality.enabled) result['reality-opts'] = { 'public-key': reality.public_key, 'short-id': reality.short_id };
  if (transport.type) {
    result.network = transport.type;
    if (transport.type === 'ws') result['ws-opts'] = { path: transport.path, headers: transport.headers, ...(transport.max_early_data ? { 'max-early-data': transport.max_early_data, 'early-data-header-name': transport.early_data_header_name } : {}) };
    if (transport.type === 'grpc') result['grpc-opts'] = { 'grpc-service-name': transport.service_name };
    if (transport.type === 'http') result['http-opts'] = { path: [transport.path], headers: transport.headers };
    if (transport.type === 'httpupgrade') throw new Error('Clash upstream HTTPUpgrade transport is unsupported');
  }
  if (type === 'HYSTERIA2') {
    if (outbound.up_mbps) result.up = outbound.up_mbps;
    if (outbound.down_mbps) result.down = outbound.down_mbps;
    const obfs = upstreamObject(outbound.obfs); if (obfs.type) { result.obfs = obfs.type; result['obfs-password'] = obfs.password; }
  }
  if (p.udpOverTcp === true || p.udp_over_tcp === true) result['udp-over-tcp'] = true;
  if (type === 'TUIC') { result['congestion-controller'] = outbound.congestion_control; result['udp-relay-mode'] = outbound.udp_relay_mode; result['reduce-rtt'] = outbound.zero_rtt_handshake; if (outbound.heartbeat) result['heartbeat-interval'] = outbound.heartbeat; }
  if (p.plugin) {
    const plugin = text(outbound.plugin);
    if (!['obfs-local', 'v2ray-plugin'].includes(plugin)) throw new Error('Clash does not support upstream plugin');
    result.plugin = plugin === 'obfs-local' ? 'obfs' : plugin;
    const opts: Record<string, unknown> = {};
    for (const part of pluginOptions(p).split(';').filter(Boolean)) { const split = part.indexOf('='); const key = split < 0 ? part : part.slice(0, split); opts[key === 'obfs' ? 'mode' : key === 'obfs-host' ? 'host' : key] = split < 0 ? true : part.slice(split + 1); }
    result['plugin-opts'] = opts;
  }
  return result;
}
