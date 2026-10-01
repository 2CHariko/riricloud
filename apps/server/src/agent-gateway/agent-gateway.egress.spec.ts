import { AgentService } from './agent-gateway.service';
import { saveEgressProxy } from '../common/line-egress';
import { formatProxyLineUsername } from '../proxy-pool/proxy-key.util';

const proxy = { protocol: 'SOCKS5' as const, serverHost: '127.0.0.1', serverPort: 1080, authEnabled: true, username: 'warp', password: 'egress-secret' };
const line = { id: '11111111-1111-4111-8111-111111111111', name: 'Line', type: 'DIRECT', relayMode: null as string | null, tag: 'business', listen: '0.0.0.0', protocolType: 'MIXED', paramsJson: '{"usersEnabled":true}', entryNodeId: 'entry', entryPort: 24443, landingNodeId: null as string | null, landingPort: null as number | null, certificate: null, status: 'ACTIVE', isPublic: true, tagsJson: '[]', egressProxyJson: saveEgressProxy(proxy, null) };
function setup(node: Record<string, unknown>, bindings: unknown[] = []) {
  const prisma = { node: { findUnique: jest.fn(async () => node) }, user: { findMany: jest.fn(async () => []) } };
  const service = new AgentService(prisma as never, undefined, undefined, undefined, { getNodeBindings: async () => bindings } as never);
  return service;
}
const rulesOf = (config: Record<string, unknown>) => (config.route as { rules: Array<Record<string, unknown>> }).rules;
describe('Agent最终落地配置', () => {
  it('只指定线路转发，白名单优先，UDP拒绝，不更改全局出口', async () => {
    const username = formatProxyLineUsername('pk_0123456789abcdef01234567', line.id);
    const service = setup({ id: 'entry', status: 'ONLINE', serverHost: '198.51.100.1', entryLines: [{ ...line, proxyPoolEnabled: true }, { ...line, id: 'other', tag: 'other', entryPort: 24444, egressProxyJson: null }], landingLines: [] }, [{ lineId: line.id, username, password: 'key-password', whitelistIps: ['192.0.2.1'] }]);
    const config = (await service.buildConfigSync('entry')).singboxConfig;
    const rules = rulesOf(config);
    expect(rules[0]).toMatchObject({ action: 'reject' });
    expect(rules.slice(1)).toEqual([{ inbound: ['business'], network: 'udp', action: 'reject' }, { inbound: ['business'], outbound: `egress-out-${line.id}` }]);
    expect(config.outbounds).toEqual(expect.arrayContaining([{ type: 'direct', tag: 'direct' }, expect.objectContaining({ type: 'socks', version: '5', password: proxy.password })]));
    expect(config.route).not.toHaveProperty('final');
  });
  it.each(['BLIND_FORWARD', 'PROTOCOL_PROXY'])('%s中继仅向落地下发秘密', async relayMode => {
    const relay = { ...line, type: 'RELAY', relayMode, protocolType: 'VLESS', paramsJson: '{"tls":{"mode":"none"}}', landingNodeId: 'exit', landingPort: 24444, landingNode: { serverHost: '198.51.100.2', status: 'ONLINE' } };
    const entry = (await setup({ id: 'entry', status: 'ONLINE', serverHost: '198.51.100.1', entryLines: [relay], landingLines: [] }).buildConfigSync('entry')).singboxConfig;
    expect(JSON.stringify(entry)).not.toContain(proxy.password);
    expect(JSON.stringify(entry)).not.toContain('egress-out');
    const exit = (await setup({ id: 'exit', status: 'ONLINE', serverHost: '198.51.100.2', entryLines: [], landingLines: [relay] }).buildConfigSync('exit')).singboxConfig;
    expect(JSON.stringify(exit)).toContain(proxy.password);
    expect(rulesOf(exit).at(-1)).toMatchObject({ inbound: ['business-landing'], outbound: `egress-out-${line.id}` });
  });
  it('NAT ShadowTLS私网保护先于内层出站，损坏配置拒绝且无出口秘密', async () => {
    const relay = { ...line, type: 'RELAY', relayMode: 'BLIND_FORWARD', landingNodeId: 'exit', landingPort: 24444, allowLanAccess: false, protocolType: 'SHADOWTLS', paramsJson: JSON.stringify({ version: 3, handshakeDest: 'example.com:443', inner: { type: 'SHADOWSOCKS', method: '2022-blake3-aes-128-gcm', password: 'fixture' } }) };
    const config = (await setup({ id: 'exit', status: 'ONLINE', serverHost: '127.0.0.1', reachability: 'NAT', entryLines: [], landingLines: [relay] }).buildConfigSync('exit')).singboxConfig;
    expect(rulesOf(config)[0]).toMatchObject({ inbound: ['business-landing-inner'], outbound: 'block' });
    expect(rulesOf(config).at(-1)).toMatchObject({ inbound: ['business-landing-inner'], outbound: `egress-out-${line.id}` });
    const broken = (await setup({ id: 'entry', status: 'ONLINE', serverHost: '198.51.100.1', entryLines: [{ ...line, egressProxyJson: 'enc:v1:broken' }], landingLines: [] }).buildConfigSync('entry')).singboxConfig;
    expect(rulesOf(broken)).toEqual([{ inbound: ['business'], action: 'reject' }]);
    expect(broken.outbounds).toEqual([{ type: 'direct', tag: 'direct' }]);
  });
  it('DIRECT固定目标与代理出站共存，覆盖冲突不能悄悄覆盖', async () => {
    const direct = { ...line, protocolType: 'DIRECT', paramsJson: '{"overrideAddress":"example.com","overridePort":443}' };
    const config = (await setup({ id: 'entry', status: 'ONLINE', serverHost: '198.51.100.1', entryLines: [direct], landingLines: [] }).buildConfigSync('entry')).singboxConfig;
    expect(config.inbounds).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'direct', override_address: 'example.com', override_port: 443 })]));
    await expect(setup({ id: 'entry', status: 'ONLINE', serverHost: '198.51.100.1', configOverride: '{"route":{}}', entryLines: [line], landingLines: [] }).buildConfigSync('entry')).rejects.toThrow(/高级覆盖/);
  });
});
