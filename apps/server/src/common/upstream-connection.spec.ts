import { encryptSecret } from './secret-crypto';
import { buildUpstreamOutbound, buildUpstreamUri, buildUpstreamClashProxy, validateUpstreamConnection } from './upstream-connection';
import { getUpstreamUnavailableReason, readUpstreamConnection } from './upstream-availability';

const connection = { protocolType: 'VLESS', serverHost: '2001:db8::1', serverPort: 443, params: { uuid: 'a77cf184-4b56-41ee-962c-1357184acd77', tls: { mode: 'reality', serverName: 'example.com', reality: { publicKey: 'key', shortId: 'abcd' } }, transport: { type: 'ws', path: '/secret', host: 'cdn.example.com' } } };
const node = () => ({ ...connection, paramsJson: encryptSecret(JSON.stringify(connection.params)), status: 'ACTIVE', presenceStatus: 'PRESENT', subscription: { status: 'ACTIVE', userInfoUsedBytes: null, userInfoTotalBytes: null, userInfoExpireAt: null } });
describe('upstream connection consumers', () => {
  it('uses real credentials and complete TLS/WS configuration in all formats', () => {
    expect(buildUpstreamOutbound(connection, 'out')).toMatchObject({ uuid: connection.params.uuid, tls: { reality: { public_key: 'key', short_id: 'abcd' } }, transport: { path: '/secret', headers: { Host: 'cdn.example.com' } } });
    const uri = new URL(buildUpstreamUri(connection, 'external'));
    expect(uri.hostname).toBe('[2001:db8::1]');
    expect(uri.searchParams.get('pbk')).toBe('key');
    expect(uri.searchParams.get('path')).toBe('/secret');
    expect(buildUpstreamClashProxy(connection, 'external')).toMatchObject({ uuid: connection.params.uuid, 'reality-opts': { 'public-key': 'key' }, 'ws-opts': { path: '/secret' } });
  });
  it('rejects plaintext persisted params and missing credentials', () => {
    expect(() => readUpstreamConnection({ ...node(), paramsJson: JSON.stringify(connection.params) })).toThrow();
    expect(() => validateUpstreamConnection({ ...connection, params: {} })).toThrow();
  });
  it('blocks disabled, missing, expired and exhausted sources', () => {
    expect(getUpstreamUnavailableReason(node())).toBeNull();
    expect(getUpstreamUnavailableReason({ ...node(), presenceStatus: 'MISSING' })).not.toBeNull();
    expect(getUpstreamUnavailableReason({ ...node(), subscription: { ...node().subscription, status: 'DISABLED' } })).not.toBeNull();
    expect(getUpstreamUnavailableReason({ ...node(), subscription: { ...node().subscription, userInfoExpireAt: new Date(0) } })).not.toBeNull();
    expect(getUpstreamUnavailableReason({ ...node(), subscription: { ...node().subscription, userInfoUsedBytes: 9007199254740993n, userInfoTotalBytes: 9007199254740993n } })).not.toBeNull();
  });
  it('preserves colon passwords, plugins and explicit unsupported format diagnostics', () => {
    const ss = { ...connection, protocolType: 'SHADOWSOCKS', params: { method: 'aes-256-gcm', password: 'a:b@c', plugin: 'obfs-local', pluginOpts: 'obfs=http;obfs-host=example.com' } };
    expect(new URL(buildUpstreamUri(ss, 'SS')).searchParams.get('plugin')).toContain('obfs-local');
    expect(buildUpstreamOutbound(ss, 'ss')).toMatchObject({ password: 'a:b@c', plugin_opts: ss.params.pluginOpts });
    expect(() => buildUpstreamClashProxy({ ...connection, protocolType: 'NAIVE', params: { username: 'a', password: 'b', tls: { mode: 'tls' } } }, 'naive')).toThrow(/Clash/);
  });
  it.each(['VLESS', 'VMESS', 'TROJAN', 'HYSTERIA2', 'TUIC', 'SHADOWSOCKS', 'SOCKS', 'HTTP', 'NAIVE'])('exports protocol %s with real external credentials', (protocolType) => {
    const resource = { protocolType, serverHost: 'example.com', serverPort: 443, params: { uuid: connection.params.uuid, username: 'external-user', password: 'external:password', method: 'aes-256-gcm', ...(!['SHADOWSOCKS', 'SOCKS'].includes(protocolType) ? { tls: { mode: 'tls', serverName: 'sni.example.com', alpn: ['h3'], insecure: true } } : {}), ...(['VLESS', 'VMESS', 'TROJAN'].includes(protocolType) ? { transport: { type: 'grpc', serviceName: 'external-service' } } : {}) } };
    const outbound = buildUpstreamOutbound(resource, 'proxy');
    if (!['SHADOWSOCKS', 'SOCKS'].includes(protocolType)) expect(JSON.stringify(outbound)).toContain('sni.example.com');
    const uri = buildUpstreamUri(resource, '外部连接');
    if (protocolType === 'VMESS') {
      const config = JSON.parse(Buffer.from(uri.slice(8), 'base64').toString());
      expect(config).toMatchObject({ id: connection.params.uuid, path: 'external-service', sni: 'sni.example.com' });
    } else {
      expect(uri).toContain('example.com:443');
      if (!['SHADOWSOCKS', 'SOCKS'].includes(protocolType)) expect(uri).toContain('sni=sni.example.com');
    }
    if (protocolType !== 'NAIVE') expect(buildUpstreamClashProxy(resource, 'proxy')).toMatchObject({ server: 'example.com', port: 443 });
  });
  it('gRPC/Reality/plugin conflicts and unsupported combinations fail visibly', () => {
    expect(() => validateUpstreamConnection({ ...connection, params: { ...connection.params, flow: 'xtls-rprx-vision' } })).toThrow();
    expect(() => validateUpstreamConnection({ ...connection, serverPort: 0 })).toThrow();
    expect(() => buildUpstreamClashProxy({ ...connection, params: { uuid: connection.params.uuid, transport: { type: 'httpupgrade', path: '/' } } }, 'proxy')).toThrow(/Clash/);
    expect(() => buildUpstreamUri({ ...connection, protocolType: 'SOCKS', params: { tls: { mode: 'tls' } } }, 'proxy')).toThrow(/TLS/);
    expect(getUpstreamUnavailableReason({ ...node(), serverHost: '' })).not.toBeNull();
  });
});
