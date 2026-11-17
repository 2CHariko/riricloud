import { ConflictException } from '@nestjs/common';
import type { ProtocolType } from '../common/constants';
import { encryptSecret } from '../common/secret-crypto';
import { buildClientTls, normalizeInboundParams, type InboundTlsConfig } from '../common/inbound';
import { assertControlledOverride, relayTopology, type RelayLine } from './line-credential-topology';

function node(id: string, serverHost = 'landing.example.test'): NonNullable<RelayLine['entryNode']> {
  return { id, serverHost, reachability: 'PUBLIC', status: 'ONLINE', configOverride: null };
}
function line(): RelayLine {
  return {
    id: 'source-a', status: 'ACTIVE', type: 'RELAY', relayMode: 'PROTOCOL_PROXY',
    protocolType: 'VLESS', paramsJson: JSON.stringify({ tls: { enabled: true, mode: 'tls' } }),
    entryNodeId: 'entry', landingNodeId: 'landing', targetLineId: null,
    landingEndpointOverrideEnabled: false, landingServerHost: null,
    entryNode: node('entry'), landingNode: node('landing'), targetLine: null
  };
}
function targetLine(): RelayLine {
  return {
    ...line(), relayMode: 'TARGET_LINE', landingNode: null, landingNodeId: null, targetLineId: 'target',
    targetLine: {
      id: 'target', type: 'DIRECT', status: 'ACTIVE', protocolType: 'VLESS',
      paramsJson: JSON.stringify({ tls: { enabled: true, mode: 'tls' } }),
      entryNodeId: 'target-node', entryNode: node('target-node'), endpointOverrideEnabled: false, serverHost: null
    }
  };
}
function plaintext(host: string): RelayLine {
  const value = line();
  value.paramsJson = JSON.stringify({ tls: { enabled: false, mode: 'none' } });
  value.landingNode!.serverHost = host;
  return value;
}
function expectConflict(action: () => unknown, code: string) {
  expect(action).toThrow(ConflictException);
  expect(action).toThrow(code);
}

describe('relay topology transport boundary', () => {
  it.each([
    '[::1]', '[fd12:3456::1]', '[fe80::1]', '[::ffff:192.168.3.4]',
    '::ffff:c0a8:304', '[0:0:0:0:0:ffff:0a00:0001]',
    '0:0:0:0:0:0:0:1', '[::ffff:172.31.1.2]'
  ])('accepts valid private IPv6 spelling %s', host => {
    expect(relayTopology(plaintext(host))).toEqual({ entryNodeId: 'entry', landingNodeId: 'landing', targetLineId: null });
  });

  it.each([
    '10.0.0.1', '127.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1',
    '169.254.1.1', '100.64.0.1', '100.127.255.254', 'fc00::1', 'fdff::2', 'febf::1', 'fe80::1%eth0'
  ])('permits private or link-local literal %s', host => {
    expect(() => relayTopology(plaintext(host))).not.toThrow();
  });

  it.each([
    '8.8.8.8', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1',
    '192.169.1.1', '169.255.1.1', '2001:4860:4860::8888', '[2001:4860::8888]',
    '::ffff:8.8.8.8', '[::ffff:0808:0808]', '0:0:0:0:0:ffff:0808:0808',
    'fec0::1', 'ff02::1', '::', '0.0.0.0', 'localhost', 'intranet.local',
    '10.1.2.3.example.test', 'fd00.internal.test', '[::1].example.test',
    '127.1', '2130706433', '0x7f000001', '0127.0.0.1', '[::1', '::1]', '[[::1]]', '[127.0.0.1]'
  ])('does not trust public, ambiguous or unknown host %s', host => {
    expectConflict(() => relayTopology(plaintext(host)), 'LINE_CREDENTIAL_PUBLIC_TLS_REQUIRED');
  });

  it('allows NAT only through the existing tunnel topology despite a public stored hostname', () => {
    const value = plaintext('public.example.test');
    value.landingNode!.reachability = 'NAT';
    value.landingEndpointOverrideEnabled = true;
    value.landingServerHost = '8.8.8.8';
    expect(relayTopology(value).landingNodeId).toBe('landing');
  });

  it('does not treat TARGET_LINE NAT metadata as proof of a tunnel the gateway does not create', () => {
    const value = targetLine();
    value.targetLine!.entryNode!.reachability = 'NAT';
    value.targetLine!.paramsJson = JSON.stringify({ tls: { enabled: false, mode: 'none' } });
    expectConflict(() => relayTopology(value), 'LINE_CREDENTIAL_PUBLIC_TLS_REQUIRED');
    value.landingEndpointOverrideEnabled = true;
    value.landingServerHost = '10.0.0.1';
    expect(() => relayTopology(value)).not.toThrow();
  });

  it.each([
    {}, { enabled: false }, { enabled: true, mode: 'none' }, { enabled: 'true', mode: 'tls' },
    { enabled: true, mode: 'tls', insecure: true }, { enabled: true, mode: 'invalid' }
  ])('rejects unencrypted or unauthenticated public TLS settings %j', tls => {
    const value = line();
    value.paramsJson = JSON.stringify({ tls });
    expectConflict(() => relayTopology(value), 'LINE_CREDENTIAL_PUBLIC_TLS_REQUIRED');
  });

  it.each(['PROTOCOL_PROXY', 'TARGET_LINE'])('accepts normalized VMess without TLS via protocol encryption in %s', mode => {
    const value = mode === 'TARGET_LINE' ? targetLine() : line();
    const endpoint = mode === 'TARGET_LINE' ? value.targetLine! : value;
    endpoint.protocolType = 'VMESS';
    const params = normalizeInboundParams('VMESS', {});
    expect(params.tls).toEqual({ enabled: false, mode: 'none' });
    endpoint.paramsJson = JSON.stringify(params);
    expect(() => relayTopology(value)).not.toThrow();
  });

  it.each(['VLESS', 'VMESS', 'TROJAN', 'HYSTERIA2', 'TUIC', 'NAIVE'])('respects normalized and certificate-verified TLS for %s', protocol => {
    const value = line();
    value.protocolType = protocol;
    const params = normalizeInboundParams(protocol as ProtocolType, { tls: {
      enabled: true, mode: 'tls', insecure: false, serverName: 'landing.example.test',
      certificatePath: '/fixture/cert.pem', keyPath: '/fixture/key.pem'
    } });
    expect(buildClientTls(params.tls as InboundTlsConfig)).toMatchObject({ enabled: true, insecure: false });
    value.paramsJson = JSON.stringify(params);
    expect(() => relayTopology(value)).not.toThrow();
    value.paramsJson = JSON.stringify({ ...params, tls: { ...(params.tls as object), insecure: true } });
    expectConflict(() => relayTopology(value), 'LINE_CREDENTIAL_PUBLIC_TLS_REQUIRED');
  });

  it('accepts normalized VLESS Reality authentication without weakening certificate checks', () => {
    const value = line();
    const params = normalizeInboundParams('VLESS', {});
    expect(buildClientTls(params.tls as InboundTlsConfig)).toMatchObject({ enabled: true, reality: { enabled: true } });
    value.paramsJson = JSON.stringify(params);
    expect(() => relayTopology(value)).not.toThrow();
  });

  it('requires TLS for normalized public VLESS and preserves existing rejection for TLS-only protocols', () => {
    const value = line();
    value.paramsJson = JSON.stringify(normalizeInboundParams('VLESS', { tls: { enabled: false, mode: 'none' } }));
    expectConflict(() => relayTopology(value), 'LINE_CREDENTIAL_PUBLIC_TLS_REQUIRED');
    for (const protocol of ['TROJAN', 'HYSTERIA2', 'TUIC', 'NAIVE'] as ProtocolType[]) {
      expect(() => normalizeInboundParams(protocol, { tls: { enabled: false, mode: 'none' } })).toThrow();
      value.protocolType = protocol;
      expectConflict(() => relayTopology(value), 'LINE_CREDENTIAL_PUBLIC_TLS_REQUIRED');
    }
  });

  it.each(['VLESS', 'VMESS', 'TROJAN', 'HYSTERIA2', 'TUIC', 'NAIVE'])('allows authenticated TLS for %s', protocol => {
    const value = line();
    value.protocolType = protocol;
    expect(() => relayTopology(value)).not.toThrow();
  });

  it('uses enabled landing override and ignores a disabled stale private override', () => {
    const value = plaintext('public.example.test');
    value.landingServerHost = '10.0.0.1';
    expectConflict(() => relayTopology(value), 'LINE_CREDENTIAL_PUBLIC_TLS_REQUIRED');
    value.landingEndpointOverrideEnabled = true;
    expect(() => relayTopology(value)).not.toThrow();
    value.landingServerHost = 'public.example.test';
    value.landingNode!.serverHost = '10.0.0.1';
    expectConflict(() => relayTopology(value), 'LINE_CREDENTIAL_PUBLIC_TLS_REQUIRED');
  });

  it('follows the same target endpoint then source landing override precedence as the gateway', () => {
    const value = targetLine();
    value.targetLine!.paramsJson = '{}';
    value.targetLine!.serverHost = '10.0.0.1';
    expectConflict(() => relayTopology(value), 'LINE_CREDENTIAL_PUBLIC_TLS_REQUIRED');
    value.targetLine!.endpointOverrideEnabled = true;
    expect(() => relayTopology(value)).not.toThrow();
    value.landingEndpointOverrideEnabled = true;
    value.landingServerHost = 'unknown.example.test';
    expectConflict(() => relayTopology(value), 'LINE_CREDENTIAL_PUBLIC_TLS_REQUIRED');
  });
});

describe('relay topology scope and controlled configuration', () => {
  it('uses the actual target node and target protocol without leaking configuration or secrets', () => {
    const value = targetLine();
    value.protocolType = 'HTTP';
    value.paramsJson = JSON.stringify({ password: 'source-secret' });
    const before = JSON.stringify(value);
    expect(relayTopology(value)).toEqual({ entryNodeId: 'entry', landingNodeId: 'target-node', targetLineId: 'target' });
    expect(JSON.stringify(value)).toBe(before);
  });

  it.each(['DISABLED', 'PENDING', 'DELETED', ''])('rejects target status %s', status => {
    const value = targetLine();
    value.targetLine!.status = status;
    expectConflict(() => relayTopology(value), 'LINE_CREDENTIAL_TARGET_UNAVAILABLE');
  });

  const invalidTargets: Array<[string, (value: RelayLine) => void]> = [
    ['missing target', value => { value.targetLine = null; }],
    ['non-direct target', value => { value.targetLine!.type = 'RELAY'; }],
    ['missing target node', value => { value.targetLine!.entryNode = null; }],
    ['missing target node relation', value => { value.targetLine!.entryNodeId = null; }],
    ['wrong target node relation', value => { value.targetLine!.entryNodeId = 'other-node'; }],
    ['wrong target relation', value => { value.targetLineId = 'other-target'; }],
    ['missing target relation', value => { value.targetLineId = null; }],
    ['self target', value => { value.id = 'target'; }],
    ['same node target', value => { value.targetLine!.entryNodeId = 'entry'; value.targetLine!.entryNode = node('entry'); }]
  ];
  it.each(invalidTargets)('rejects %s instead of borrowing another landing scope', (_name, mutate) => {
    const value = targetLine();
    value.landingNode = node('stale-landing');
    value.landingNodeId = 'stale-landing';
    mutate(value);
    expectConflict(() => relayTopology(value), 'LINE_CREDENTIAL_TARGET_UNAVAILABLE');
  });

  it('keeps existing offline target nodes eligible for maintenance reconciliation', () => {
    const value = targetLine();
    value.entryNode!.status = 'OFFLINE';
    value.targetLine!.entryNode!.status = 'OFFLINE';
    expect(relayTopology(value).landingNodeId).toBe('target-node');
  });

  it('keeps two source lines bound to the same valid target without changing either object', () => {
    const first = targetLine();
    const second = { ...targetLine(), id: 'source-b', entryNodeId: 'entry-b', entryNode: node('entry-b') };
    expect(relayTopology(first)).toEqual({ entryNodeId: 'entry', landingNodeId: 'target-node', targetLineId: 'target' });
    expect(relayTopology(second)).toEqual({ entryNodeId: 'entry-b', landingNodeId: 'target-node', targetLineId: 'target' });
  });

  it.each(['shared', 'single', undefined, 'invalid'])('rejects shared SS target mode %s', mode => {
    const value = targetLine();
    value.targetLine!.protocolType = 'SHADOWSOCKS';
    value.targetLine!.paramsJson = JSON.stringify({ mode, method: '2022-blake3-aes-128-gcm' });
    expectConflict(() => relayTopology(value), 'LINE_CREDENTIAL_SHARED_TARGET_UNSUPPORTED');
  });

  it('allows SS2022 multi-user targets and separately owned shared protocol-proxy landings', () => {
    const target = targetLine();
    target.targetLine!.protocolType = 'SHADOWSOCKS';
    target.targetLine!.paramsJson = JSON.stringify({ mode: 'multi-user', method: '2022-blake3-aes-128-gcm' });
    expect(() => relayTopology(target)).not.toThrow();
    const proxy = plaintext('public.example.test');
    proxy.protocolType = 'SHADOWSOCKS';
    proxy.paramsJson = JSON.stringify({ mode: 'shared', method: 'aes-256-gcm' });
    expect(relayTopology(proxy)).toEqual({ entryNodeId: 'entry', landingNodeId: 'landing', targetLineId: null });
  });

  it.each(['none', 'plain', 'unknown-cipher'])('rejects SS method without authenticated encryption %s', method => {
    const value = line();
    value.protocolType = 'SHADOWSOCKS';
    value.paramsJson = JSON.stringify({ mode: 'shared', method });
    expectConflict(() => relayTopology(value), 'LINE_CREDENTIAL_UNSUPPORTED');
  });

  it('rejects multi-user SS on a cipher that cannot provide SS2022 user authentication', () => {
    const value = targetLine();
    value.targetLine!.protocolType = 'SHADOWSOCKS';
    value.targetLine!.paramsJson = JSON.stringify({ mode: 'multi-user', method: 'aes-256-gcm' });
    expectConflict(() => relayTopology(value), 'LINE_CREDENTIAL_UNSUPPORTED');
  });

  it.each(['inbounds', 'outbounds', 'route', 'dns'])('rejects %s override on either endpoint even when null', key => {
    for (const mode of ['entry', 'landing', 'target'] as const) {
      const value = mode === 'target' ? targetLine() : line();
      const endpoint = mode === 'target' ? value.targetLine!.entryNode : mode === 'entry' ? value.entryNode : value.landingNode;
      endpoint!.configOverride = JSON.stringify({ [key]: null });
      expectConflict(() => relayTopology(value), 'LINE_CREDENTIAL_CONFIG_OVERRIDE');
    }
  });

  it.each(['null', '[]', '1', 'false', '"inbounds"', '{"route":secret-do-not-expose}'])('fails closed on malformed override %s', config => {
    expectConflict(() => assertControlledOverride(config), 'LINE_CREDENTIAL_CONFIG_OVERRIDE');
  });

  it.each([null, '', '{}', '{"log":{"level":"warn"}}'])('allows absent or non-routing override %s', config => {
    expect(() => assertControlledOverride(config)).not.toThrow();
  });

  it.each(['null', '[]', '1', '{"password":secret-do-not-expose}'])('returns a stable redacted error for malformed params %s', paramsJson => {
    const value = line();
    value.paramsJson = paramsJson;
    expectConflict(() => relayTopology(value), 'LINE_CREDENTIAL_CONFIGURATION_INVALID');
  });

  it('redacts corrupted Reality ciphertext errors and leaves encrypted input unchanged', () => {
    const value = line();
    value.paramsJson = JSON.stringify({ tls: { enabled: true, mode: 'reality', reality: { privateKey: encryptSecret('fixture-private-key').slice(0, -4) } } });
    const before = value.paramsJson;
    expectConflict(() => relayTopology(value), 'LINE_CREDENTIAL_CONFIGURATION_INVALID');
    expect(value.paramsJson).toBe(before);
  });

  it('rejects stale or missing protocol-proxy node relations', () => {
    for (const mutate of [
      (value: RelayLine) => { value.landingNode = null; },
      (value: RelayLine) => { value.landingNodeId = 'other-node'; },
      (value: RelayLine) => { value.landingNodeId = null; }
    ]) {
      const value = line();
      mutate(value);
      expectConflict(() => relayTopology(value), 'LINE_CREDENTIAL_TARGET_UNAVAILABLE');
    }
  });

  it('rejects unmanaged source types and mismatched source node relations', () => {
    for (const mutate of [
      (value: RelayLine) => { value.type = 'DIRECT'; },
      (value: RelayLine) => { value.relayMode = 'BLIND_FORWARD'; },
      (value: RelayLine) => { value.entryNode = null; },
      (value: RelayLine) => { value.entryNodeId = 'other-node'; }
    ]) {
      const value = line();
      mutate(value);
      expectConflict(() => relayTopology(value), 'LINE_CREDENTIAL_UNSUPPORTED');
    }
  });
});
