import { certificateFixture } from './certificate-fixture';
import { certificateMatchesHost, parseCertificateChain } from './certificate-validation';

describe('证书链与域名校验', () => {
  const root = certificateFixture({ name: 'Root', ca: true });
  const intermediate = certificateFixture({ name: 'Intermediate', ca: true, issuer: root });
  const leaf = certificateFixture({ issuer: intermediate, sans: ['example.com', '*.example.net', '127.0.0.1'] });
  it('接受缺少根证书的 fullchain，并逐级验证签名及私钥', () => {
    const parsed = parseCertificateChain(`${leaf.certificatePem}\n${intermediate.certificatePem}`, leaf.privateKeyPem);
    expect(parsed.chainLength).toBe(2);
    expect(parsed.trustValidation).toBe('NOT_CHECKED');
    expect(parsed.privateKeyMatched).toBe(true);
    expect(parsed.fingerprint256).toBeTruthy();
  });
  it('接受单叶子及自签名，并明确区分信任', () => {
    expect(parseCertificateChain(leaf.certificatePem).chainLength).toBe(1);
    expect(parseCertificateChain(certificateFixture().certificatePem).selfSigned).toBe(true);
  });
  it('拒绝错误顺序、重复、错误签名、尾部非法内容及错误私钥', () => {
    const fake = certificateFixture({ name: 'Intermediate', ca: true });
    for (const pem of [`${intermediate.certificatePem}\n${leaf.certificatePem}`, `${leaf.certificatePem}\n${leaf.certificatePem}`, `${leaf.certificatePem}\n${fake.certificatePem}`, `${leaf.certificatePem}\ninvalid`]) expect(() => parseCertificateChain(pem)).toThrow();
    expect(() => parseCertificateChain(leaf.certificatePem, root.privateKeyPem)).toThrow();
    expect(() => parseCertificateChain(leaf.certificatePem, root.certificatePem)).toThrow();
  });
  it('匹配域名、仅一层通配符和 IP SAN，不接受通配符 SNI', () => {
    for (const host of ['example.com', 'EXAMPLE.COM', 'a.example.net', '127.0.0.1']) expect(certificateMatchesHost(leaf.certificatePem, host)).toBe(true);
    for (const host of ['example.net', 'a.b.example.net', '*.example.net', '127.0.0.2']) expect(certificateMatchesHost(leaf.certificatePem, host)).toBe(false);
  });
  it('保留已过期/尚未生效证书的解析信息', () => {
    expect(parseCertificateChain(certificateFixture({ from: new Date(Date.now() - 86400_000 * 2), to: new Date(Date.now() - 86400_000) }).certificatePem).validTo.getTime()).toBeLessThan(Date.now());
    expect(parseCertificateChain(certificateFixture({ from: new Date(Date.now() + 86400_000) }).certificatePem).validFrom.getTime()).toBeGreaterThan(Date.now());
  });
});
