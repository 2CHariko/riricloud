import { buildUpstreamClashProxy, buildUpstreamOutbound, validateUpstreamConnection } from './upstream-connection';
import { getProxyCapabilities } from './proxy-capabilities';

const socks = { protocolType: 'SOCKS', serverHost: 'example.com', serverPort: 443, params: { tls: { mode: 'tls', serverName: 'proxy.example.com' } } };
describe('engine-independent connection capabilities', () => {
  it('retains TLS SOCKS for Mihomo while rejecting it only in the Sing-box compiler', () => {
    expect(() => validateUpstreamConnection(socks)).not.toThrow();
    expect(buildUpstreamClashProxy(socks, 'proxy')).toMatchObject({ type: 'socks5', tls: true, sni: 'proxy.example.com' });
    expect(() => buildUpstreamOutbound(socks, 'proxy')).toThrow(/SINGBOX_TLS_UNSUPPORTED/);
    expect(getProxyCapabilities(socks)).toEqual({ mihomo: { supported: true, reason: null }, singbox: { supported: false, reason: 'SINGBOX_TLS_UNSUPPORTED' }, fallbackAllowed: false });
  });
  it('permits fallback only for explicitly tested capability limitations', () => {
    const naive = { ...socks, protocolType: 'NAIVE', params: { username: 'a', password: 'b' } };
    expect(getProxyCapabilities(naive)).toMatchObject({ mihomo: { supported: false, reason: 'MIHOMO_NAIVE_UNSUPPORTED' }, fallbackAllowed: true });
    expect(getProxyCapabilities({ ...socks, params: { version: '4a' } })).toMatchObject({ mihomo: { supported: false, reason: 'MIHOMO_SOCKS_VERSION_UNSUPPORTED' }, fallbackAllowed: true });
  });
  it('does not drop unsupported transports, headers, or advanced TLS parameters', () => {
    const vless = { ...socks, protocolType: 'VLESS', params: { uuid: 'a77cf184-4b56-41ee-962c-1357184acd77', transport: { type: 'httpupgrade', path: '/' } } };
    expect(getProxyCapabilities(vless).fallbackAllowed).toBe(false);
    expect(() => buildUpstreamClashProxy(vless, 'p')).toThrow(/MIHOMO_HTTPUPGRADE_UNSUPPORTED/);
    expect(() => buildUpstreamClashProxy({ ...socks, protocolType: 'HTTP', params: { headers: { 'X-Test': 'secret' } } }, 'p')).toThrow(/MIHOMO_HTTP_HEADERS_UNSUPPORTED/);
  });
  it('unknown meaningful options remain stored but cannot be silently dropped by a compiler', () => {
    const extra = { ...socks, params: { detour: 'private-route' } };
    expect(() => validateUpstreamConnection(extra)).not.toThrow();
    expect(getProxyCapabilities(extra)).toMatchObject({ mihomo: { reason: 'UNREPRESENTABLE_PARAMETERS' }, singbox: { reason: 'UNREPRESENTABLE_PARAMETERS' }, fallbackAllowed: false });
    expect(() => buildUpstreamClashProxy(extra, 'p')).toThrow('UNREPRESENTABLE_PARAMETERS');
  });
  it('显式禁用 uTLS 不从残留 fingerprint 重新启用，证书回退保持 TLS 契约', () => {
    const connection = { ...socks, protocolType: 'VLESS', params: { uuid: 'a77cf184-4b56-41ee-962c-1357184acd77', tls: { enabled: true, certificate: ['fixture-pem'], utls: { enabled: false, fingerprint: 'chrome' } } } };
    expect(getProxyCapabilities(connection).fallbackAllowed).toBe(true);
    expect((buildUpstreamOutbound(connection, 'p').tls as Record<string, unknown>).utls).toBeUndefined();
    const primary = { ...connection, params: { ...connection.params, tls: { enabled: true, utls: { enabled: false, fingerprint: 'chrome' } } } };
    expect(buildUpstreamClashProxy(primary, 'p')['client-fingerprint']).toBeUndefined();
  });
});
