import { analyzeConfigResources } from './config-resources';

describe('configuration resource analysis', () => {
  it.each(['skip-src-address', 'skip-dst-address'])('detects sniffer %s geo references even if DNS is off', (field) => {
    expect(analyzeConfigResources('MIHOMO', { sniffer: { enable: true, [field]: ['geoip:cn'] } })).toEqual([expect.objectContaining({ file: 'Country.mmdb', requirement: expect.objectContaining({ kind: 'GEOIP', location: `sniffer.${field}[0]` }) })]);
  });
  it('finds DNS fake-ip rules and disabled DNS policies', () => {
    const entries = analyzeConfigResources('MIHOMO', { dns: { enable: false, 'fake-ip-filter-mode': 'rule', 'fake-ip-filter': ['GEOSITE,cn,real-ip'], 'proxy-server-nameserver-policy': { 'geosite:cn': '1.1.1.1' } } });
    expect(entries).toEqual([expect.objectContaining({ file: 'geosite.dat', requirement: expect.objectContaining({ references: 2 }) })]);
  });
  it('finds nested/sub-rule/dns dependencies and deduplicates by resource', () => {
    const resources = analyzeConfigResources('MIHOMO', {
      rules: ['AND,((NETWORK,TCP),(GEOIP,CN)),DIRECT', 'GEOSITE,cn,DIRECT'],
      'sub-rules': { privateName: ['GEOIP,US,DIRECT'] },
      dns: { enable: true, fallback: ['1.1.1.1'], 'nameserver-policy': { 'geosite:cn': '1.1.1.1' } }
    });
    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({ file: 'Country.mmdb', requirement: { references: 3, location: 'rules[0]' } });
    expect(resources[1]).toMatchObject({ file: 'geosite.dat', requirement: { references: 2 } });
    expect(JSON.stringify(resources.map((r) => r.requirement))).not.toContain('privateName');
  });
  it('distinguishes private geo rules, inline providers and actual missing references', () => {
    expect(analyzeConfigResources('MIHOMO', { rules: ['GEOIP,private,DIRECT', 'RULE-SET,inline,DIRECT'], 'rule-providers': { inline: { type: 'inline', behavior: 'domain', payload: ['example.com'] } } })).toEqual([]);
    expect(analyzeConfigResources('MIHOMO', { rules: ['RULE-SET,missing,DIRECT'] })[0].requirement.state).toBe('UNSUPPORTED');
  });
  it('does not treat websocket paths, inline keys or metadata as files', () => {
    expect(analyzeConfigResources('MIHOMO', { proxies: [{ type: 'vless', 'ws-opts': { path: '/websocket' } }, { type: 'wireguard', 'private-key': 'inline-key' }], metadata: { type: 'local', path: '/secret' } })).toEqual([]);
    expect(analyzeConfigResources('SINGBOX', { route: { rule_set: [{ type: 'inline', rules: [{ domain_suffix: 'example.com' }] }] } })).toEqual([]);
  });
  it('blocks local certificates and remote sources without returning the secret values', () => {
    const entries = analyzeConfigResources('MIHOMO', { proxies: [{ 'certificate-path': '/secret/path' }], 'geox-url': { geoip: 'http://private/token' } });
    expect(entries).toHaveLength(2);
    expect(entries.every((r) => r.requirement.state !== 'AVAILABLE')).toBe(true);
    expect(JSON.stringify(entries)).not.toMatch(/secret|token/);
  });
  it('supports only bounded offline domain/ip provider files', () => {
    const entries = analyzeConfigResources('MIHOMO', { 'rule-providers': {
      a: { type: 'file', path: 'rules/domains.yaml', behavior: 'domain' },
      b: { type: 'file', path: 'rules/classical.yaml', behavior: 'classical' },
      c: { type: 'http', url: 'https://example.com' }
    } });
    expect(entries.map((r) => r.requirement.state)).toEqual(['MISSING', 'UNSUPPORTED', 'REMOTE_DISABLED']);
    expect(entries[0].format).toBe('mihomo-yaml-domain');
  });
});
