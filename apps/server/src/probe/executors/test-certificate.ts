import { createSign, generateKeyPairSync } from 'node:crypto';

// 每次测试生成临时密钥，避免提交固定秘密；仅测试 fixture 调用。
export function testCertificate(commonName: string): { cert: string; key: string } {
  const der = (tag: number, value: Buffer): Buffer => {
    const bytes: number[] = [];
    let length = value.length;
    while (length > 0) { bytes.unshift(length & 255); length >>= 8; }
    return Buffer.concat([Buffer.from([tag, ...(value.length < 128 ? [value.length] : [128 | bytes.length, ...bytes])]), value]);
  };
  const sequence = (...values: Buffer[]) => der(0x30, Buffer.concat(values));
  const oid = (bytes: number[]) => der(6, Buffer.from(bytes));
  const name = () => sequence(der(0x31, sequence(oid([0x55, 4, 3]), der(0x0c, Buffer.from(commonName)))));
  const utc = (date: Date) => der(0x17, Buffer.from(date.toISOString().slice(2, 19).replace(/[-:T]/g, '') + 'Z'));
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const algorithm = sequence(oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 1, 0x0b]), der(5, Buffer.alloc(0)));
  const extensions = der(0xa3, sequence(sequence(oid([0x55, 0x1d, 0x11]), der(4, sequence(der(0x82, Buffer.from(commonName)))))));
  const tbs = sequence(der(0xa0, der(2, Buffer.from([2]))), der(2, Buffer.from([1])), algorithm, name(), sequence(utc(new Date(Date.now() - 60_000)), utc(new Date(Date.now() + 86_400_000))), name(), publicKey.export({ type: 'spki', format: 'der' }), extensions);
  const signer = createSign('RSA-SHA256'); signer.update(tbs); signer.end();
  const cert = sequence(tbs, algorithm, der(3, Buffer.concat([Buffer.from([0]), signer.sign(privateKey)])));
  return { cert: `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`, key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}
