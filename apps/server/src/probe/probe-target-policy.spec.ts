import { isPublicProbeAddress, ProbeTargetPolicy } from './probe-target-policy';

describe('central pinned probe address policy', () => {
  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.31.1.1', '192.168.1.1', '100.64.0.1', '198.18.0.1', '::1', '::ffff:192.168.1.1', '::ffff:c0a8:101', 'fc00::1', '2001:db8::1'])('rejects private, metadata and mapped address %s', (address) => {
    expect(isPublicProbeAddress(address)).toBe(false);
  });
  it('pins validated DNS, rejects mixed public/private answers and preserves original TLS SNI', async () => {
    const lookup = jest.fn(async () => [{ address: '1.1.1.1' }]);
    const policy = new ProbeTargetPolicy(lookup);
    expect(await policy.target({ id: 't', url: 'https://target.example/204', expectedStatus: 204 })).toMatchObject({ address: '1.1.1.1' });
    expect(await policy.connection({ protocolType: 'HTTP', serverHost: 'proxy.example', serverPort: 443, params: { tls: { mode: 'tls' } } }, false)).toMatchObject({ serverHost: '1.1.1.1', params: { tls: { serverName: 'proxy.example' } } });
    const unsafe = new ProbeTargetPolicy(async () => [{ address: '1.1.1.1' }, { address: '127.0.0.1' }]);
    await expect(unsafe.target({ id: 't', url: 'https://target.example/204', expectedStatus: 204 })).rejects.toThrow('ADDRESS_POLICY_REJECTED');
  });
  it('permits controlled managed private endpoints but never private targets', async () => {
    const policy = new ProbeTargetPolicy();
    const connection = { protocolType: 'SOCKS', serverHost: '127.0.0.1', serverPort: 1080, params: {} };
    await expect(policy.connection(connection, false)).rejects.toThrow();
    expect(await policy.connection(connection, true)).toEqual(connection);
    await expect(policy.target({ id: 't', url: 'http://127.0.0.1/204', expectedStatus: 204 })).rejects.toThrow();
  });
  it.each(['https://user:secret@example.com/', 'https://example.com/#secret', 'file:///etc/passwd'])('rejects unsafe target %s without echoing it', async (url) => {
    await expect(new ProbeTargetPolicy().target({ id: 't', url, expectedStatus: 204 })).rejects.toThrow('INVALID_TARGET');
  });
});
