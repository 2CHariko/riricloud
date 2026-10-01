import { createHash } from 'node:crypto';

export interface ProxyConnection {
  protocolType: string;
  serverHost: string;
  serverPort: number;
  params: Record<string, unknown>;
}
export function proxyObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export const proxyText = (value: unknown): string => typeof value === 'string' ? value : '';
const protocols = new Set(['VLESS', 'VMESS', 'TROJAN', 'HYSTERIA2', 'TUIC', 'SHADOWSOCKS', 'SOCKS', 'HTTP', 'NAIVE', 'SHADOWTLS']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 只判定连接结构；具体消费端限制在能力层，不让 Sing-box 限制主客户端。
export function validateProxyConnection(connection: ProxyConnection): void {
  const { protocolType: type, serverHost: host, serverPort: port, params: p } = connection;
  const invalid = () => { throw new Error('Invalid upstream connection configuration'); };
  if (!protocols.has(type) || !host || /[\s/@?#%\\]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) invalid();
  if (!p || typeof p !== 'object' || Array.isArray(p)) invalid();
  for (const key of ['tls', 'transport', 'multiplex']) if (p[key] !== undefined && (!p[key] || typeof p[key] !== 'object' || Array.isArray(p[key]))) invalid();
  if (['VLESS', 'VMESS', 'TUIC'].includes(type) && !uuidPattern.test(proxyText(p.uuid))) invalid();
  if (['TROJAN', 'HYSTERIA2', 'TUIC', 'SHADOWSOCKS', 'NAIVE', 'SHADOWTLS'].includes(type) && !proxyText(p.password)) invalid();
  if (type === 'SHADOWSOCKS' && !proxyText(p.method)) invalid();
  if (type === 'NAIVE' && !proxyText(p.username)) invalid();
  if (['SOCKS', 'HTTP'].includes(type) && Boolean(proxyText(p.username)) !== Boolean(proxyText(p.password))) invalid();
  const tls = proxyObject(p.tls);
  const reality = proxyObject(tls.reality);
  const transport = proxyObject(p.transport);
  if (tls.mode === 'reality' || reality.enabled === true || Object.keys(reality).length) {
    if (type !== 'VLESS' || !proxyText(reality.publicKey ?? reality.public_key)) invalid();
  }
  if (tls.mode && !['none', 'tls', 'reality'].includes(proxyText(tls.mode))) invalid();
  if (tls.alpn !== undefined && (!Array.isArray(tls.alpn) || tls.alpn.some((v) => typeof v !== 'string'))) invalid();
  if (tls.certificate !== undefined && (!Array.isArray(tls.certificate) || !tls.certificate.length || tls.certificate.some((v) => typeof v !== 'string'))) invalid();
  if (type === 'SOCKS' && p.version && !['4', '4a', '5'].includes(String(p.version))) invalid();
  if (['HYSTERIA2', 'TUIC', 'NAIVE', 'SHADOWTLS'].includes(type) && (tls.enabled === false || tls.mode === 'none')) invalid();
  if (p.plugin && !['obfs', 'obfs-local', 'v2ray-plugin'].includes(proxyText(p.plugin))) invalid();
  if (p.flow && (type !== 'VLESS' || proxyText(p.flow) !== 'xtls-rprx-vision' || (transport.type && transport.type !== 'tcp') || (!Object.keys(tls).length || tls.enabled === false || tls.mode === 'none'))) invalid();
  if (type === 'VMESS' && (!Number.isInteger(Number(p.alterId ?? p.alter_id ?? 0)) || Number(p.alterId ?? p.alter_id ?? 0) < 0)) invalid();
  if (type === 'HYSTERIA2' && p.obfs) {
    const obfs = proxyObject(p.obfs);
    if ((typeof p.obfs === 'string' ? p.obfs : obfs.type) !== 'salamander' || !proxyText(typeof p.obfs === 'string' ? p.obfsPassword : obfs.password)) invalid();
  }
  if (Object.keys(transport).length && !['tcp', 'ws', 'grpc', 'http', 'httpupgrade'].includes(proxyText(transport.type))) invalid();
  if (p.multiplex && !['VLESS', 'VMESS', 'TROJAN', 'SHADOWSOCKS'].includes(type)) invalid();
  if (p.headers && type !== 'HTTP') invalid();
  if (Object.keys(transport).length && !['VLESS', 'VMESS', 'TROJAN'].includes(type)) invalid();
  if (p.plugin && type !== 'SHADOWSOCKS') invalid();
  if (type === 'SHADOWTLS') {
    const inner = proxyObject(p.inner);
    if (p.version !== 3 || inner.type !== 'SHADOWSOCKS' || !proxyText(inner.method) || !proxyText(inner.password) || !proxyText(p.handshakeDest)) invalid();
  }
}

export function proxyTlsEnabled(connection: ProxyConnection): boolean {
  const tls = proxyObject(connection.params.tls);
  return tls.mode !== 'none' && tls.enabled !== false && (Object.keys(tls).length > 0 || ['TROJAN', 'HYSTERIA2', 'TUIC', 'NAIVE', 'SHADOWTLS'].includes(connection.protocolType));
}
export function proxyPluginOptions(p: Record<string, unknown>): string {
  const raw = p.pluginOpts ?? p.plugin_opts;
  if (typeof raw === 'string') return raw;
  return Object.entries(proxyObject(raw)).map(([key, value]) => {
    const name = ['obfs', 'obfs-local'].includes(proxyText(p.plugin)) ? ({ mode: 'obfs', host: 'obfs-host' }[key] ?? key) : key;
    return value === true ? name : `${name}=${String(value)}`;
  }).join(';');
}
export function proxyConnectionHash(connection: ProxyConnection): string {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : value;
  return createHash('sha256').update(JSON.stringify(stable(connection))).digest('hex');
}
