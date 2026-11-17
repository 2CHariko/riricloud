import {
  LandingAuthTarget,
  matchRelayAuthRejection,
  RelayAuthRejectionCounter,
  SafeEvent
} from './line-auth-rejections';

const UUID = '00000000-0000-4000-8000-000000000099';
const SOURCE = '192.0.2.7:43123';
const START = 1_000_000;
const target = (protocol = 'VLESS', lineId = 'landing-line', port = 2443): LandingAuthTarget => ({ lineId, port, protocol });
const message = (protocol: string, body: string, tag = 'landing-in') => `ERROR [12345 10ms] inbound/${protocol}[${tag}]: ${body}`;
const connection = (reason: string, source = SOURCE) => `process connection from ${source}: ${reason}`;
const vless = (tag = 'landing-in') => message('vless', connection(`unknown UUID: ${UUID}`), tag);
const trusted = (protocol = 'VLESS') => new Map([['landing-in', target(protocol)]]);
const event = (overrides: Partial<SafeEvent> = {}): SafeEvent => ({
  nodeId: 'landing-node', lineId: 'landing-line', port: 2443, protocol: 'VLESS', configVersion: 7,
  count: 1, windowStartedAt: START, windowEndedAt: START, ...overrides
});

// 对照本地固定内核 1.14.0 与 go.mod 固定依赖的真实返回分支；一般握手错误不能代替认证拒绝。
describe('matchRelayAuthRejection', () => {
  it.each([
    ['VLESS', 'vless', connection(`unknown UUID: ${UUID}`)],
    ['VMESS', 'vmess', connection('bad request')],
    ['TROJAN', 'trojan', connection('bad request: fallback disabled')],
    ['TUIC', 'tuic', `connection failed: handle uni stream: authentication: unknown user ${UUID}`],
    ['TUIC', 'tuic', 'connection failed: handle uni stream: authentication: token mismatch'],
    ['NAIVE', 'naive', connection('authorization failed')],
    ['SHADOWSOCKS', 'shadowsocks', connection(`shadowsocks: serve TCP from ${SOURCE}: invalid request`)],
    ['SHADOWSOCKS', 'shadowsocks', `process packet from ${SOURCE}: shadowsocks: serve UDP from ${SOURCE}: invalid request`]
  ])('matches only the known %s rejection path: %s / %s', (protocol, component, body) => {
    expect(matchRelayAuthRejection(message(component, body), trusted(protocol))).toEqual(target(protocol));
  });

  it.each([
    '', 'ERROR ', 'WARN ', 'WARNING ', 'WARN: ', 'ERROR: ', 'ERROR[0001.234] ',
    'ERROR [12345 0ms] ', 'ERROR [12345 1.23s] ', 'ERROR [12345 2m15s] '
  ])('accepts the bounded kernel or Agent-normalized prefix %j', prefix => {
    const payload = `inbound/vless[landing-in]: ${connection(`unknown UUID: ${UUID}`)}`;
    expect(matchRelayAuthRejection(prefix + payload, trusted())).toEqual(target());
  });

  it('accepts IPv6 sources and lowercase trusted protocol names without retaining the source', () => {
    const targets = trusted('vless');
    const result = matchRelayAuthRejection(message('vless', connection(`unknown UUID: ${UUID}`, '[2001:db8::7]:43123')), targets);
    expect(result).toEqual(target('vless'));
    expect(JSON.stringify(result)).not.toContain('2001:db8');
    expect(JSON.stringify(result)).not.toContain(UUID);
  });

  it('uses the actual trusted target line for a shared TARGET_LINE without guessing the source', () => {
    const targets = new Map([['shared-public-in', target('VLESS', 'actual-target-line', 8443)]]);
    expect(matchRelayAuthRejection(vless('shared-public-in'), targets)).toEqual(target('VLESS', 'actual-target-line', 8443));
    expect(matchRelayAuthRejection(vless('relay-source-a'), targets)).toBeNull();
  });

  it('requires an explicit current landing map; node, applied-version and landing checks belong to the caller', () => {
    expect(matchRelayAuthRejection(vless(), new Map())).toBeNull();
    expect(matchRelayAuthRejection(vless('entry-in'), trusted())).toBeNull();
    // 不靠 tag 名字推断落地身份；即使名字含 entry，也只服从父边界实际下发的白名单。
    expect(matchRelayAuthRejection(vless('entry-in'), new Map([['entry-in', target()]]))).toEqual(target());
  });

  it('does not mutate the map and returns only the target allowlist', () => {
    const extra = { ...target(), password: 'never-return-this', rawMessage: 'never-return-this' };
    const targets = new Map([['landing-in', Object.freeze(extra)]]);
    expect(matchRelayAuthRejection(vless(), targets)).toEqual(target());
    expect(targets.get('landing-in')).toBe(extra);
  });

  it.each(['VMESS', 'TROJAN', 'HYSTERIA2', 'TUIC', 'SHADOWSOCKS', 'NAIVE', 'HTTP', 'unknown'])('rejects protocol confusion with a %s map value', protocol => {
    expect(matchRelayAuthRejection(vless(), trusted(protocol))).toBeNull();
  });

  it.each([
    ['vless', 'authentication failed'], ['vless', 'invalid user'], ['vless', 'bad request'],
    ['vless', connection('TLS handshake: unknown UUID: ' + UUID)],
    ['vless', connection('TLS handshake: remote error: tls: bad certificate')],
    ['vless', connection('i/o timeout')], ['vless', connection('connection reset by peer')],
    ['vless', connection('unknown UUID: not-a-uuid')],
    ['vless', connection(`unknown UUID: ${UUID}: i/o timeout`)],
    ['vmess', connection('bad header')], ['vmess', connection('bad timestamp')],
    ['vmess', connection('bad request: timeout')], ['vmess', connection('replayed request')],
    ['trojan', connection('bad request size: fallback disabled')], ['trojan', connection('bad request')],
    ['trojan', connection('unknown password')],
    ['hysteria2', 'authentication failed'], ['hysteria2', 'authentication: unknown user'],
    ['hysteria2', 'connection failed: authentication timeout'], ['hysteria2', 'HTTP status 404'],
    ['tuic', 'connection failed: authentication timeout'],
    ['tuic', 'connection failed: handle uni stream: authentication: multiple authentication requests'],
    ['tuic', 'connection failed: handle uni stream: authentication: read request: EOF'],
    ['tuic', 'connection failed: handle uni stream: authentication: export keying material: error'],
    ['tuic', `connection failed: handle stream request: authentication: unknown user ${UUID}`],
    ['tuic', 'connection failed: handle uni stream: authentication: unknown user arbitrary-input'],
    ['shadowsocks', connection('cipher: message authentication failed')],
    ['shadowsocks', connection('chacha20poly1305: message authentication failed')],
    ['shadowsocks', connection('invalid request')],
    ['shadowsocks', connection(`shadowsocks: serve TCP from ${SOURCE}: invalid request: EOF`)],
    ['shadowsocks', connection('shadowsocks: serve TCP from 192.0.2.8:43123: invalid request')],
    ['shadowsocks', `process packet from ${SOURCE}: shadowsocks: serve TCP from ${SOURCE}: invalid request`],
    ['naive', connection('not CONNECT request')], ['naive', connection('missing naive padding')],
    ['naive', connection('authorization failed: timeout')], ['naive', 'HTTP 407 Proxy Authentication Required'],
    ['naive', connection('TLS handshake: authorization failed')]
  ])('does not turn a general or unobservable %s error into an auth rejection: %s', (protocol, body) => {
    expect(matchRelayAuthRejection(message(protocol, body), trusted(protocol.toUpperCase()))).toBeNull();
  });

  it.each([
    'INFO ', 'DEBUG ', 'TRACE ', 'FATAL ', 'PANIC ', 'error ', 'SERVER ', 'ERROR malicious ',
    '2026-11-17T10:00:00Z ERROR ', 'ERROR [hostile-context] ', 'ERROR [12345 -1ms] '
  ])('rejects unapproved prefixes %j', prefix => {
    expect(matchRelayAuthRejection(prefix + `inbound/vless[landing-in]: ${connection(`unknown UUID: ${UUID}`)}`, trusted())).toBeNull();
  });

  it.each([
    vless().replace('inbound/', 'outbound/'), vless().replace('inbound/', 'endpoint/'),
    vless('unknown-tag'), vless('landing-in-suffix'), vless('landing-in]inbound/vless[other'),
    vless().replace(`unknown UUID: ${UUID}`, `inbound/vless[other]: unknown UUID: ${UUID}`),
    message('vless', `dial tcp: ${connection(`unknown UUID: ${UUID}`)}`),
    message('vless', connection(`unknown UUID: ${UUID}`, 'https://attacker.invalid/')),
    `${vless()} inbound/vless[other]: ${connection(`unknown UUID: ${UUID}`)}`,
    `${vless()}\n${vless()}`, `${vless()}\r`, `${vless()}\u0000`, `${vless()}\u2028`,
    `\u001b[31m${vless()}`, `${vless()}\u202e`, `${vless()}${'x'.repeat(4096)}`,
    message('vless', connection(`unknown UUID: ${UUID}`), 'a'.repeat(129))
  ])('rejects injected, untrusted or over-budget input %#', text => {
    expect(matchRelayAuthRejection(text, trusted())).toBeNull();
  });

  it.each([
    null, undefined, 3, {}, [],
    { lineId: '', port: 2443, protocol: 'VLESS' }, { lineId: 'https://secret.invalid', port: 2443, protocol: 'VLESS' },
    { lineId: 'line', port: 0, protocol: 'VLESS' }, { lineId: 'line', port: 65536, protocol: 'VLESS' },
    { lineId: 'line', port: 2443.5, protocol: 'VLESS' }, { lineId: 'line', port: 2443, protocol: 1 }
  ])('fails closed on invalid runtime target metadata %#', value => {
    expect(matchRelayAuthRejection(vless(), new Map([['landing-in', value as LandingAuthTarget]]))).toBeNull();
  });
});

describe('RelayAuthRejectionCounter', () => {
  it('alerts immediately, merges for 30 seconds, and never repeats already emitted deltas', () => {
    const counter = new RelayAuthRejectionCounter();
    expect(counter.observe('landing-node', 7, target(), START)).toEqual([event()]);
    expect(counter.flush(START)).toEqual([]);
    expect(counter.observe('landing-node', 7, target(), START + 1)).toEqual([]);
    expect(counter.observe('landing-node', 7, target(), START + 29_999)).toEqual([]);
    expect(counter.flush(START + 29_999)).toEqual([]);
    expect(counter.flush(START + 30_000)).toEqual([event({ count: 2, windowStartedAt: START + 1, windowEndedAt: START + 29_999 })]);
    expect(counter.flush(START + 30_000, true)).toEqual([]);
    expect(counter.observe('landing-node', 7, target(), START + 30_001)).toEqual([]);
    expect(counter.flush(START + 60_000)).toEqual([event({ windowStartedAt: START + 30_001, windowEndedAt: START + 30_001 })]);
    expect(counter.clear()).toEqual([]);
  });

  it('also flushes the due bucket synchronously on observation', () => {
    const counter = new RelayAuthRejectionCounter();
    counter.observe('landing-node', 7, target(), START);
    counter.observe('landing-node', 7, target(), START + 1);
    expect(counter.observe('landing-node', 7, target(), START + 30_000)).toEqual([
      event({ count: 2, windowStartedAt: START + 1, windowEndedAt: START + 30_000 })
    ]);
    expect(counter.flush(START + 30_000, true)).toEqual([]);
  });

  it('isolates node, line, and port; keeps separator-containing identifiers collision free', () => {
    const counter = new RelayAuthRejectionCounter();
    const entries: [string, LandingAuthTarget][] = [
      ['a:b', target('VLESS', 'c')], ['a', target('VLESS', 'b:c')],
      ['a', target('VLESS', 'b:c', 2444)], ['a', target('VLESS', 'other')]
    ];
    for (const [nodeId, item] of entries) {
      expect(counter.observe(nodeId, 7, item, START)).toHaveLength(1);
      expect(counter.observe(nodeId, 7, item, START + 1)).toEqual([]);
    }
    expect(counter.flush(START + 2, true)).toHaveLength(4);
  });

  it.each([
    [8, target(), { configVersion: 8 }],
    [7, target('VMESS'), { protocol: 'VMESS' }]
  ])('flushes pending before changing version or protocol %#', (version, changed, delta) => {
    const counter = new RelayAuthRejectionCounter();
    counter.observe('landing-node', 7, target(), START);
    counter.observe('landing-node', 7, target(), START + 1);
    expect(counter.observe('landing-node', version, changed, START + 2)).toEqual([
      event({ windowStartedAt: START + 1, windowEndedAt: START + 1 }),
      event({ ...delta, windowStartedAt: START + 2, windowEndedAt: START + 2 })
    ]);
  });

  it('counts same-tick concurrent callbacks exactly once each without promises or timers in the helper', async () => {
    const counter = new RelayAuthRejectionCounter();
    const results = await Promise.all(Array.from({ length: 512 }, async () => counter.observe('landing-node', 7, target(), START)));
    const events = results.flat().concat(counter.flush(START, true));
    expect(events.map(item => item.count)).toEqual([1, 511]);
    expect(counter.flush(START, true)).toEqual([]);
  });

  it('force flushes shutdown deltas without waiting for cooldown', () => {
    const counter = new RelayAuthRejectionCounter();
    counter.observe('landing-node', 7, target(), START);
    counter.observe('landing-node', 7, target(), START + 1);
    expect(counter.flush(START + 2, true)).toEqual([event({ windowStartedAt: START + 1, windowEndedAt: START + 1 })]);
    expect(counter.clear()).toEqual([]);
  });

  it('returns pending deltas on clear and resets the first-alert state', () => {
    const counter = new RelayAuthRejectionCounter();
    counter.observe('landing-node', 7, target(), START);
    counter.observe('landing-node', 7, target(), START + 1);
    expect(counter.clear()).toEqual([event({ windowStartedAt: START + 1, windowEndedAt: START + 1 })]);
    expect(counter.clear()).toEqual([]);
    expect(counter.observe('landing-node', 7, target(), START)).toEqual([event()]);
  });

  it('expires idle buckets after five minutes and returns their pending deltas', () => {
    const counter = new RelayAuthRejectionCounter();
    counter.observe('landing-node', 7, target(), START);
    counter.observe('landing-node', 7, target(), START + 1);
    expect(counter.flush(START + 300_001)).toEqual([event({ windowStartedAt: START + 1, windowEndedAt: START + 1 })]);
    expect(counter.observe('landing-node', 7, target(), START + 300_001)).toEqual([
      event({ windowStartedAt: START + 300_001, windowEndedAt: START + 300_001 })
    ]);
  });

  it('also returns expired pending deltas while observing a different bucket', () => {
    const counter = new RelayAuthRejectionCounter();
    counter.observe('landing-node', 7, target(), START);
    counter.observe('landing-node', 7, target(), START + 1);
    expect(counter.observe('other-node', 7, target(), START + 300_001)).toEqual([
      event({ windowStartedAt: START + 1, windowEndedAt: START + 1 }),
      event({ nodeId: 'other-node', windowStartedAt: START + 300_001, windowEndedAt: START + 300_001 })
    ]);
  });

  it('caps storage at 1024 buckets and flushes the least recently observed bucket instead of losing counts', () => {
    const counter = new RelayAuthRejectionCounter();
    const events: SafeEvent[] = [];
    for (let i = 0; i < 1024; i++) {
      const item = target('VLESS', `line-${i}`);
      events.push(...counter.observe('landing-node', 7, item, START));
      events.push(...counter.observe('landing-node', 7, item, START));
    }
    expect(counter.observe('landing-node', 7, target('VLESS', 'line-0'), START)).toEqual([]);
    const evicted = counter.observe('landing-node', 7, target('VLESS', 'line-1024'), START);
    expect(evicted).toEqual([
      event({ lineId: 'line-1' }), event({ lineId: 'line-1024' })
    ]);
    events.push(...evicted, ...counter.clear());
    expect(events.reduce((total, item) => total + item.count, 0)).toBe(2050);
    expect(events.filter(item => item.lineId === 'line-0').reduce((total, item) => total + item.count, 0)).toBe(3);
  });

  it('retains no raw message, UUID, password, URL, source IP, or caller-owned extra fields', () => {
    const counter = new RelayAuthRejectionCounter();
    const item = { ...target(), rawMessage: vless(), password: 'never-return-this', url: 'https://private.invalid', ip: SOURCE };
    const first = counter.observe('landing-node', 7, item, START);
    expect(first).toEqual([event()]);
    first[0].lineId = 'mutated-event';
    counter.observe('landing-node', 7, item, START + 1);
    item.lineId = 'mutated-target';
    expect(counter.clear()).toEqual([event({ windowStartedAt: START + 1, windowEndedAt: START + 1 })]);
    expect(JSON.stringify(counter)).not.toContain(UUID);
    expect(JSON.stringify(counter)).not.toContain('never-return-this');
  });

  it('clamps clock rollback without extending or reversing observed windows', () => {
    const counter = new RelayAuthRejectionCounter();
    counter.observe('landing-node', 7, target(), START);
    expect(counter.observe('landing-node', 7, target(), START - 100)).toEqual([]);
    expect(counter.flush(START - 200)).toEqual([]);
    expect(counter.flush(START + 30_000)).toEqual([event()]);
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('ignores an invalid clock %s without losing pending deltas', now => {
    const counter = new RelayAuthRejectionCounter();
    counter.observe('landing-node', 7, target(), START);
    counter.observe('landing-node', 7, target(), START + 1);
    expect(counter.observe('landing-node', 7, target(), now)).toEqual([]);
    expect(counter.flush(now, true)).toEqual([]);
    expect(counter.clear()).toEqual([event({ windowStartedAt: START + 1, windowEndedAt: START + 1 })]);
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects missing or invalid runtime config versions %s', version => {
    expect(new RelayAuthRejectionCounter().observe('landing-node', version, target(), START)).toEqual([]);
  });

  it.each([
    ['', target()], ['a'.repeat(129), target()], ['https://private.invalid', target()],
    ['landing-node', target('unknown')], ['landing-node', target('VLESS', '')],
    ['landing-node', target('VLESS', 'line', 0)], ['landing-node', target('VLESS', 'line', 65536)],
    ['landing-node', null as unknown as LandingAuthTarget]
  ])('fails closed on invalid identities or target metadata %#', (nodeId, item) => {
    const counter = new RelayAuthRejectionCounter();
    expect(counter.observe(nodeId, 7, item, START)).toEqual([]);
    expect(counter.clear()).toEqual([]);
  });
});
