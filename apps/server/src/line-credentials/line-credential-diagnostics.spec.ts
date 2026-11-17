import { configDiagnosticSecrets, redactConfigDiagnostic } from './line-credential-diagnostics';
describe('configuration diagnostic secret boundaries', () => {
  it('redacts rendered credentials and nested private keys without emitting input values', () => {
    const secrets = configDiagnosticSecrets({ inbounds: [{ users: [{ name: 'relay-fixture', uuid: 'uuid-fixture', password: 'password-fixture' }], tls: { key: ['private-key-fixture'] } }], outbounds: [{ username: 'encoded-fixture', password: 'derived-fixture' }] });
    const output = redactConfigDiagnostic('bad uuid-fixture password-fixture relay-fixture private-key-fixture encoded-fixture derived-fixture at port 443', secrets);
    expect(output).toContain('port 443');
    for (const secret of secrets.values) expect(output).not.toContain(secret);
  });
  it('does not expose unknown-version or oversized raw diagnostics', () => {
    expect(redactConfigDiagnostic('untrusted-secret')).toBe('Agent rejected node configuration');
    expect(redactConfigDiagnostic('x'.repeat(32_769), { complete: true, values: [] })).toBe('Agent rejected node configuration');
  });
  it('fails closed if recursive or oversized configuration prevents complete secret extraction', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(configDiagnosticSecrets(cyclic).complete).toBe(false);
    expect(redactConfigDiagnostic('sensitive', configDiagnosticSecrets(cyclic))).toBe('Agent rejected node configuration');
  });
});
