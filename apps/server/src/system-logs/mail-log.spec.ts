import { mailErrorDetails, sanitizeMailDiagnostic, sanitizeMailMetadata } from './mail-log';
import type { MailLogMetadata } from './mail-log';

const base: MailLogMetadata = { event: 'MAIL_SEND_FAILED', operationId: 'mail-op-1', mailType: 'SMTP_TEST' };

describe('mail-log', () => {
  it('保留邮箱、主机、IP、UUID MessageId，同时清理凭据和 AUTH 载荷', () => {
    const diagnostic = 'admin@example.com smtp.example.com 192.0.2.1 [2001:db8::1] <12345678-1234-1234-1234-123456789abc@example.com>';
    expect(sanitizeMailDiagnostic(diagnostic)).toBe(diagnostic);
    const output = sanitizeMailDiagnostic(diagnostic + '\nAUTH PLAIN AHVzZXIAc2VjcmV0\npassword=secret token=token-value smtp://user:pass@smtp.example.com:465');
    expect(output).toContain(diagnostic);
    expect(output).toContain('smtp.example.com:465');
    for (const secret of ['AHVzZXIAc2VjcmV0', 'secret', 'token-value', 'user:pass']) expect(output).not.toContain(secret);
    const login = sanitizeMailDiagnostic('AUTH LOGIN\r\ndXNlcg==\r\nc2VjcmV0\r\n535 Authentication failed at smtp.example.com');
    expect(login).not.toContain('dXNlcg==');
    expect(login).not.toContain('c2VjcmV0');
    expect(login).toContain('535 Authentication failed at smtp.example.com');
    const challenged = sanitizeMailDiagnostic('AUTH LOGIN\r\n334 VXNlcm5hbWU6\r\ndXNlcg==\r\n334 UGFzc3dvcmQ6\r\nc2VjcmV0\r\n535 Authentication failed at smtp.example.com');
    expect(challenged).toBe('AUTH LOGIN ***\r\n535 Authentication failed at smtp.example.com');

  });

  it.each(['one-time', '123456', 'p@ss&"\\word'])('清理已知秘密 %s 的原文与常见编码', (secret) => {
    const variants = [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1),
      Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url'),
      Buffer.from(secret).toString('hex'), Buffer.from(secret).toString('hex').toUpperCase(),
      Array.from(Buffer.from(secret), (byte) => '%' + byte.toString(16).padStart(2, '0')).join(''),
      Array.from(secret, (char) => '&#' + char.charCodeAt(0) + ';').join(''),
      Array.from(secret, (char) => '&#x' + char.charCodeAt(0).toString(16) + ';').join(''),
      Array.from(secret, (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('')];
    for (const value of variants) expect(sanitizeMailDiagnostic('failure ' + value, [secret])).toBe('failure ***');
    expect(sanitizeMailDiagnostic('safe smtp.example.com', ['', secret])).toBe('safe smtp.example.com');
  });

  it('Error 非枚举字段和六字段白名单可直接复用于巡检，不调用 toJSON', () => {
    const error = Object.assign(new Error('connect smtp.example.com password=secret otp=123456'), {
      code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN payload', response: '535 user@example.com token=hidden',
      body: 'body-content', password: 'password-content', cause: { secret: 'cause-content' },
      toJSON: () => { throw new Error('must not call'); }
    });
    expect(mailErrorDetails(error, ['123456'])).toEqual({ name: 'Error', message: 'connect smtp.example.com password=*** otp=***',
      code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN ***', response: '535 user@example.com token=***' });
    expect(mailErrorDetails('sweep failed at smtp.example.com')).toEqual({ message: 'sweep failed at smtp.example.com' });
    expect(mailErrorDetails(null)).toBeUndefined();
    expect(mailErrorDetails({ responseCode: NaN, message: {}, stack: 'private' })).toBeUndefined();
  });

  it('强制元数据与嵌套白名单，拒绝非有限数、错误类型、正文与验证码', () => {
    const input = { ...base, to: 'to@example.com', smtpHost: 'smtp.example.com', smtpPort: Infinity, durationMs: NaN,
      smtpSecure: false, body: 'private-body', verificationCode: '123456', password: 'private-password',
      accepted: ['a@example.com', { token: 'not-string' }], error: { message: 'failed', stack: 'private-stack', body: 'private-body' },
      certificateRevisions: [{ certificateId: 'cert-1', revision: 2, privateKey: 'private-key' }, { certificateId: 'bad', revision: NaN }],
      toJSON: () => ({ secret: 'private-json' }) };
    expect(sanitizeMailMetadata(input as unknown as MailLogMetadata)).toEqual({ ...base, to: 'to@example.com', smtpHost: 'smtp.example.com', smtpSecure: false,
      accepted: ['a@example.com'], error: { message: 'failed' }, certificateRevisions: [{ certificateId: 'cert-1', revision: 2 }] });
  });

  it('UTF-8 超限优先保留关联字段与错误摘要，且所有输入有界', () => {
    const input = { ...base, to: 'to@example.com', subscriptionId: 'sub-1', deliveryId: 'delivery-1', stage: 'SEND' as const,
      error: { name: 'Error', message: '错误'.repeat(20000), code: 'ETIMEDOUT', response: '响应'.repeat(20000) },
      subject: '主题'.repeat(20000), accepted: Array.from({ length: 500 }, () => 'user@example.com') };
    const output = sanitizeMailMetadata(input)!;
    expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect(output).toMatchObject({ ...base, to: input.to, subscriptionId: input.subscriptionId, deliveryId: input.deliveryId,
      stage: 'SEND', truncated: true, error: { name: 'Error', code: 'ETIMEDOUT' } });
    expect((output.error as { message: string }).message).toContain('错误');
  });
  it('控制字符转义膨胀后仍严格满足 16KiB 预算', () => {
    const huge = String.fromCharCode(0).repeat(20000);
    const output = sanitizeMailMetadata({ ...base, operationId: huge, to: huge, subscriptionId: huge, deliveryId: huge,
      stage: 'SEND', error: { name: huge, message: huge, code: huge, command: huge, response: huge } })!;
    expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect(output).toMatchObject({ event: base.event, mailType: base.mailType, stage: 'SEND', truncated: true });
    for (const key of ['operationId', 'to', 'subscriptionId', 'deliveryId', 'error']) expect(output).toHaveProperty(key);
  });

});
