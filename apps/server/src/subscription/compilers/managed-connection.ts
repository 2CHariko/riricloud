import { buildShadowsocksClientPassword, normalizeShadowsocksPassword, formatAuthUserName } from '../../common/inbound';
import { proxyObject as obj, proxyText as text, type ProxyConnection } from '../../common/proxy-connection';

export interface ManagedConnectionInput { protocolType: string; serverHost: string; serverPort: number; params: Record<string, unknown>; lineId?: string; serverName?: string; host?: string }
export function bindManagedConnection(input: ManagedConnectionInput, user: { uuid: string; email?: string; credential: string }): ProxyConnection {
  const type = input.protocolType === 'MIXED' ? 'SOCKS' : input.protocolType === 'VLESS_REALITY' ? 'VLESS' : input.protocolType;
  const p = { ...input.params };
  const tls = { ...obj(p.tls) };
  if (tls.mode === 'acme') tls.mode = 'tls';
  const reality = obj(tls.reality);
  if (tls.mode === 'reality') tls.reality = { publicKey: reality.publicKey ?? reality.public_key, shortId: (reality.shortIds as string[] | undefined)?.[0] ?? reality.shortId ?? reality.short_id ?? '' };
  if (input.serverName || tls.serverName || (reality.serverNames as string[] | undefined)?.[0]) tls.serverName = input.serverName || tls.serverName || (reality.serverNames as string[])[0];
  // 服务端证书和密钥不是客户端信任钉扎；不把服务端秘密带入订阅。
  for (const key of ['key', 'keyPath', 'certificate', 'certificatePath', 'acme']) delete tls[key];
  if (Object.keys(tls).length) p.tls = tls;
  const transport = { ...obj(p.transport) };
  if (input.host && transport.type) transport.host = input.host;
  if (Object.keys(transport).length) p.transport = transport;
  if (['VLESS', 'VMESS', 'TUIC'].includes(type)) p.uuid = p.uuid || user.uuid;
  if (['TROJAN', 'HYSTERIA2', 'TUIC'].includes(type)) p.password = p.password || user.credential;
  if (type === 'SHADOWSOCKS') {
    p.password = p.mode === 'multi-user' ? buildShadowsocksClientPassword(text(p.method), text(p.password), user.credential, user.uuid) : normalizeShadowsocksPassword(text(p.method), text(p.password));
    if (p.udpOverTcp) delete p.multiplex;
  }
  if (type === 'SHADOWTLS') {
    p.password = user.credential;
    const inner = obj(p.inner);
    p.inner = { ...inner, password: normalizeShadowsocksPassword(text(inner.method), text(inner.password)) };
  }
  if (['SOCKS', 'HTTP', 'NAIVE'].includes(type)) {
    if (type === 'NAIVE' || p.usersEnabled !== false) { p.username = formatAuthUserName(user, input.lineId); p.password = user.credential; }
    else { delete p.username; delete p.password; }
  }
  for (const key of ['mode', 'usersEnabled', 'users_enabled', 'allowLan', 'network', 'strictMode', 'masquerade', 'ignoreClientBandwidth', 'tcpFastOpen', 'tcpMultiPath', 'udpFragment', 'udpTimeout', 'proxyProtocol', 'proxyProtocolAcceptNoHeader']) delete p[key];
  return { protocolType: type, serverHost: input.serverHost, serverPort: input.serverPort, params: p };
}
