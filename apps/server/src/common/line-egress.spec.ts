import { normalizeEgressProxy, readEgressProxy, saveEgressProxy, safeEgressProxy, egressOverrideConflict, buildEgressRoute, canConfigureEgress } from './line-egress';
import { isEncryptedSecret } from './secret-crypto';

const proxy = { protocol: 'SOCKS5' as const, serverHost: '127.0.0.1', serverPort: 1080, authEnabled: true, username: 'warp', password: 'test-secret' };
describe('最终落地代理出站', () => {
  it('整段加密、密码省略保留、认证关闭清除、null清配置', () => {
    const stored = saveEgressProxy(proxy, null);
    expect(isEncryptedSecret(stored!)).toBe(true);
    expect(stored).not.toContain('test-secret');
    expect(readEgressProxy(stored)).toMatchObject({ ...proxy, udpEnabled: false });
    const { password: _password, ...withoutPassword } = proxy;
    expect(readEgressProxy(saveEgressProxy(withoutPassword, stored))?.password).toBe('test-secret');
    expect(saveEgressProxy(undefined, stored)).toBe(stored);
    expect(saveEgressProxy(null, stored)).toBeNull();
    expect(readEgressProxy(saveEgressProxy({ ...withoutPassword, authEnabled: false }, stored))).not.toHaveProperty('password');
    expect(safeEgressProxy(stored)).toEqual({ ...withoutPassword, udpEnabled: false, hasPassword: true });
    const spaced = saveEgressProxy({ ...proxy, username: ' user ' }, null);
    const retained = saveEgressProxy({ ...withoutPassword, username: ' user ' }, spaced);
    expect(buildEgressRoute('line', retained, [{ tag: 'business' }]).outbound).toMatchObject({ username: ' user ', password: proxy.password });
  });
  it('强校验及IPv6规范化，不接受HTTPS、SOCKS4和任意JSON', () => {
    expect(normalizeEgressProxy({ ...proxy, serverHost: '[::1]' }).serverHost).toBe('::1');
    for (const input of [{ ...proxy, serverHost: 'http://localhost' }, { ...proxy, serverPort: 0 }, { ...proxy, password: '' }, { ...proxy, protocol: 'HTTPS' }, { ...proxy, protocol: 'HTTP', udpEnabled: true }, { ...proxy, tls: {} }, { ...proxy, authEnabled: null }, { ...proxy, username: '' }]) {
      expect(() => normalizeEgressProxy(input)).toThrow();
    }
    expect(() => saveEgressProxy({ ...proxy, password: undefined }, null)).toThrow();
    expect(() => readEgressProxy('not encrypted')).toThrow();
    expect(() => readEgressProxy('enc:v1:broken')).toThrow();
  });
  it('拓扑能力和高级覆盖集中判定', () => {
    expect(canConfigureEgress('DIRECT', null)).toBe(true);
    expect(canConfigureEgress('RELAY', 'BLIND_FORWARD')).toBe(true);
    for (const mode of ['TARGET_LINE', 'UPSTREAM_NODE']) expect(canConfigureEgress('RELAY', mode)).toBe(false);
    expect(canConfigureEgress('EXTERNAL', null)).toBe(false);
    expect(egressOverrideConflict('{"log":{"level":"warn"}}')).toBeNull();
    for (const key of ['route', 'dns', 'inbounds', 'outbounds']) expect(egressOverrideConflict(JSON.stringify({ [key]: {} }))).toBe(key);
  });
  it('HTTP拒绝UDP，SOCKS5显式开启UDP，ShadowTLS匹配内层', () => {
    const inbound = [{ type: 'shadowtls', tag: 'outer', detour: 'outer-inner' }, { type: 'shadowsocks', tag: 'outer-inner' }];
    const result = buildEgressRoute('line', saveEgressProxy({ ...proxy, protocol: 'HTTP' }, null), inbound);
    expect(result.outbound).toMatchObject({ type: 'http', tag: 'egress-out-line', server: '127.0.0.1', username: 'warp' });
    expect(result.rules).toEqual([{ inbound: ['outer-inner'], network: 'udp', action: 'reject' }, { inbound: ['outer-inner'], outbound: 'egress-out-line' }]);
    expect(buildEgressRoute('line', saveEgressProxy({ ...proxy, udpEnabled: true }, null), inbound).rules).toHaveLength(1);
    const corrupt = buildEgressRoute('line', 'enc:v1:broken', inbound);
    expect(corrupt.outbound).toBeNull();
    expect(corrupt.rules).toEqual([{ inbound: ['outer-inner'], action: 'reject' }]);
  });
});
