import { BadRequestException } from '@nestjs/common';
import { createHash, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
export function parseCertificateChain(pem: string, privateKeyPem?: string) {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (!blocks.length || blocks.length > 16 || pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim())
    throw new BadRequestException('证书必须为最多 16 张证书组成的 PEM 证书链');
  let certificates: X509Certificate[];
  try {
    certificates = blocks.map(block => new X509Certificate(block));
  }
  catch {
    throw new BadRequestException('证书链包含不可解析的 X.509 证书');
  }
  if (new Set(certificates.map(cert => cert.fingerprint256)).size !== certificates.length)
    throw new BadRequestException('证书链包含重复证书');
  const leaf = certificates[0];
  if (certificates.some(cert => cert.checkIssued(cert) && !cert.verify(cert.publicKey)))
    throw new BadRequestException('自签名证书签名不正确');
  for (let i = 1; i < certificates.length; i++) {
    const issuer = certificates[i], child = certificates[i - 1];
    if (!issuer.ca || !child.checkIssued(issuer) || !child.verify(issuer.publicKey))
      throw new BadRequestException('证书链顺序、签发关系或签名不正确');
  }
  const sans = (leaf.subjectAltName ?? '').split(/,\s*(?=(?:DNS|IP Address|IP|URI|email):)/i).filter(item => /^(DNS|IP Address|IP):/i.test(item)).map(item => item.replace(/^(DNS|IP Address|IP):\s*/i, '').replace(/^"|"$/g, ''));
  if (!sans.length)
    throw new BadRequestException('证书必须包含至少一个 SAN 域名或 IP');
  const chain = certificates.map(cert => ({ subject: cert.subject, issuer: cert.issuer, fingerprint256: cert.fingerprint256, validFrom: new Date(cert.validFrom), validTo: new Date(cert.validTo), ca: cert.ca }));
  if (chain.some(cert => !Number.isFinite(cert.validFrom.getTime()) || cert.validTo <= cert.validFrom))
    throw new BadRequestException('证书有效期无效');
  if (privateKeyPem !== undefined) {
    try {
      if (!/-----BEGIN (?:PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY|DSA PRIVATE KEY)-----/.test(privateKeyPem))
        throw new Error('format');
      const key = createPrivateKey(privateKeyPem);
      const a = createPublicKey(key).export({ type: 'spki', format: 'der' });
      const b = leaf.publicKey.export({ type: 'spki', format: 'der' });
      if (!a.equals(b))
        throw new Error('mismatch');
    }
    catch {
      throw new BadRequestException('私钥必须为匹配叶子证书的未加密 PEM 私钥');
    }
  }
  return { certificatePem: certificates.map(cert => cert.toString().trim()).join('\n') + '\n', leafPem: leaf.toString(), subject: leaf.subject, issuer: leaf.issuer, serialNumber: leaf.serialNumber, sans, validFrom: chain[0].validFrom, validTo: chain[0].validTo, chain, chainLength: chain.length, fingerprint256: leaf.fingerprint256, keyType: leaf.publicKey.asymmetricKeyType ?? 'unknown', selfSigned: leaf.checkIssued(leaf) && leaf.verify(leaf.publicKey), chainValidation: 'PASSED' as const, trustValidation: 'NOT_CHECKED' as const, privateKeyMatched: privateKeyPem === undefined ? null : true };
}
export function certificateMatchesHost(pem: string, host: string): boolean {
  const value = host.trim().replace(/^\[|\]$/g, '');
  if (!value || value.includes('*'))
    return false;
  try {
    const cert = new X509Certificate(pem);
    return isIP(value) ? Boolean(cert.checkIP(value)) : Boolean(cert.checkHost(domainToASCII(value.replace(/\.$/, '').toLowerCase()), { subject: 'never', partialWildcards: false, multiLabelWildcards: false }));
  }
  catch {
    return false;
  }
}
export function certificateContentHash(pem: string, privateKeyPem: string): string {
  const publicDer = createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(pem.trim()).update(publicDer).digest('hex');
}
export function assertCertificateUsable(pem: string, host: string, now = new Date()) {
  const parsed = parseCertificateChain(pem);
  if (parsed.chain.some(cert => cert.validFrom > now || cert.validTo <= now))
    throw new BadRequestException('证书链已过期或尚未生效');
  if (!certificateMatchesHost(pem, host))
    throw new BadRequestException(`证书不覆盖线路域名或 IP：${host || '未配置'}`);
}
