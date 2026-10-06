import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
// 测试运行时生成临时证书，不提交固定私钥。
export function certificateFixture(options: {
  name?: string;
  sans?: string[];
  ca?: boolean;
  issuer?: ReturnType<typeof certificateFixture>;
  from?: Date;
  to?: Date;
} = {}): {
  certificatePem: string;
  privateKeyPem: string;
  name: string;
  privateKey: KeyObject;
} {
  const der = (tag: number, value: Buffer): Buffer => {
    const bytes: number[] = [];
    let n = value.length;
    while (n) {
      bytes.unshift(n & 255);
      n >>= 8;
    }
    return Buffer.concat([Buffer.from([tag, ...(value.length < 128 ? [value.length] : [128 | bytes.length, ...bytes])]), value]);
  };
  const seq = (...values: Buffer[]) => der(48, Buffer.concat(values));
  const oid = (bytes: number[]) => der(6, Buffer.from(bytes));
  const name = options.name ?? 'example.com';
  const dn = (cn: string) => seq(der(49, seq(oid([85, 4, 3]), der(12, Buffer.from(cn)))));
  const time = (date: Date) => der(23, Buffer.from(date.toISOString().slice(2, 19).replace(/[-:T]/g, '') + 'Z'));
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const algorithm = seq(oid([42, 134, 72, 134, 247, 13, 1, 1, 11]), der(5, Buffer.alloc(0)));
  const extensions = [seq(oid([85, 29, 19]), der(1, Buffer.from([255])), der(4, options.ca ? seq(der(1, Buffer.from([255]))) : seq()))];
  if (!options.ca)
    extensions.push(seq(oid([85, 29, 17]), der(4, seq(...(options.sans ?? [name]).map(san => san === '127.0.0.1' ? der(135, Buffer.from([127, 0, 0, 1])) : der(130, Buffer.from(san)))))));
  const tbs = seq(der(160, der(2, Buffer.from([2]))), der(2, Buffer.from([1])), algorithm, dn(options.issuer?.name ?? name), seq(time(options.from ?? new Date(Date.now() - 60000)), time(options.to ?? new Date(Date.now() + 90 * 86400000))), dn(name), publicKey.export({ type: 'spki', format: 'der' }) as Buffer, der(163, seq(...extensions)));
  const signer = createSign('RSA-SHA256');
  signer.update(tbs);
  signer.end();
  const raw = seq(tbs, algorithm, der(3, Buffer.concat([Buffer.from([0]), signer.sign(options.issuer?.privateKey ?? privateKey)])));
  return { name, privateKey, certificatePem: `-----BEGIN CERTIFICATE-----\n${raw.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}
