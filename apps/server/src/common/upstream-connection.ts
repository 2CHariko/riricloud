import { proxyObject as upstreamObject, proxyText as text, proxyPluginOptions as pluginOptions, validateProxyConnection as validateUpstreamConnection, type ProxyConnection as UpstreamConnection } from './proxy-connection';
import { compileSingboxClient as buildUpstreamOutbound, buildSingboxClientTls, buildSingboxClientTransport } from '../subscription/compilers/singbox-client';
import { compileMihomoProxy as buildUpstreamClashProxy } from '../subscription/compilers/mihomo-proxy';
import { getProxyCapabilities } from './proxy-capabilities';

export { upstreamObject, validateUpstreamConnection, buildUpstreamOutbound, buildUpstreamClashProxy };
export type { UpstreamConnection };

export function buildUpstreamUri(connection: UpstreamConnection, name: string): string {
  validateUpstreamConnection(connection);
  if (getProxyCapabilities(connection).singbox.reason === 'UNREPRESENTABLE_PARAMETERS') throw new Error('URI cannot represent upstream advanced parameters');
  const outbound: Record<string, unknown> = { ...connection.params, tls: buildSingboxClientTls(connection), transport: buildSingboxClientTransport(connection.params) };
  const p = connection.params;
  const tls = upstreamObject(outbound.tls);
  const reality = upstreamObject(tls.reality);
  const transport = upstreamObject(outbound.transport);
  if (upstreamObject(p.multiplex).enabled === true || p.headers || tls.certificate) throw new Error('URI cannot represent upstream multiplex, custom headers or certificate pinning');
  if (['min_version', 'max_version', 'cipher_suites'].some((key) => tls[key] !== undefined)) throw new Error('URI cannot represent upstream TLS parameters');
  if (connection.protocolType === 'SHADOWSOCKS' && (tls.enabled || p.udpOverTcp || p.udp_over_tcp)) throw new Error('URI cannot represent upstream Shadowsocks TLS or UDP over TCP');
  if (transport.type === 'grpc' && Object.keys(upstreamObject(transport.headers)).length) throw new Error('URI cannot represent upstream gRPC headers');
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
      const obfs = typeof p.obfs === 'string' ? { type: p.obfs, password: p.obfsPassword } : upstreamObject(p.obfs); put('obfs', obfs.type); put('obfs-password', obfs.password); put('upmbps', p.upMbps ?? p.up_mbps); put('downmbps', p.downMbps ?? p.down_mbps);
      return `hysteria2://${encodeURIComponent(text(p.password))}@${endpoint}?${query.toString()}#${encodeURIComponent(name)}`;
    }
    case 'TUIC': {
      put('congestion_control', p.congestionControl ?? p.congestion_control ?? 'bbr'); put('udp_relay_mode', p.udpRelayMode ?? p.udp_relay_mode); put('zero_rtt_handshake', p.zeroRttHandshake ?? p.zero_rtt_handshake); put('heartbeat', p.heartbeat);
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
