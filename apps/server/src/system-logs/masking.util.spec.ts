import { maskSensitiveString, sanitizeLogMetadata } from './masking.util';

describe('masking.util', () => {
  it('完全掩码凭据、URL 认证、参数和私钥', () => {
    const input = 'Bearer abc.def token=very-secret password:pass123 https://user:pass@example.com/?ticket=abcdef -----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----';
    const output = maskSensitiveString(input);
    for (const secret of ['abc.def', 'very-secret', 'pass123', 'user:pass', 'abcdef', 'BEGIN PRIVATE KEY']) expect(output).not.toContain(secret);
    expect(output).toContain('Bearer ***');
    const data = sanitizeLogMetadata({ password: 'long-password', agentToken: 'secret-agent-token', headers: { authorization: 'Bearer token' } });
    expect(data).toEqual({ password: '***', agentToken: '***', headers: { authorization: '***' } });
  });

  it('不误伤时间、标识符、文件名和浏览器版本', () => {
    const input = '06:05:57 ConfigService.apply config.service.js Client.Timeout Chrome/140.0.0.0 version=1.14.0';
    expect(maskSensitiveString(input)).toBe(input);
  });

  it('JSON凭据完全遮蔽，显式目标不能借代码名/扩展名绕过', () => {
    const result = maskSensitiveString('config {"password":"secret-123","private_key":"key-456"} dial ConfigService.apply:443 dial example.js:443');
    for (const value of ['secret-123', 'key-456', 'ConfigService.apply', 'example.js']) expect(result).not.toContain(value);
    expect(maskSensitiveString(maskSensitiveString('dial example.com:443'))).toBe(maskSensitiveString('dial example.com:443'));
  });

  it('匿名目标具有同进程相关性但不暴露明文', () => {
    const first = maskSensitiveString('\x1b[31mdial proxy.example.com:443 from 192.0.2.10 and [2001:db8::1]:443');
    expect(first).not.toContain('\x1b');
    for (const target of ['proxy.example.com', '192.0.2.10', '2001:db8::1']) expect(first).not.toContain(target);
    expect(first).toContain('[redacted-host:');
    expect(first).toContain('[redacted-ip:');
    expect(maskSensitiveString('proxy.example.com')).toBe(maskSensitiveString('proxy.example.com'));
    expect(maskSensitiveString('other.example.com')).not.toBe(maskSensitiveString('proxy.example.com'));
  });

  it('按目标字段遮蔽单标签主机、邮件和 UUID 凭据，保留实例关联', () => {
    const data = sanitizeLogMetadata({ target: 'localhost', serverHost: 'PRIVATE', userUuid: '12345678-1234-1234-1234-123456789abc', agentInstanceId: 'abc-123', error: 'dial localhost:443: timeout' });
    expect(data.target).not.toBe('localhost');
    expect(data.serverHost).not.toBe('PRIVATE');
    expect(data.userUuid).toBe('***');
    expect(data.agentInstanceId).toBe('abc-123');
    expect(data.error).not.toContain('localhost');
  });
  it('裸JWT和UUID凭据不泄露，标记后的非凭据关联ID保留', () => {
    const credential = '12345678-1234-1234-1234-123456789abc';
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYWRtaW4ifQ.signature';
    expect(maskSensitiveString(`authentication failed ${credential} ${jwt}`)).not.toContain(credential);
    expect(maskSensitiveString(`authentication failed ${jwt}`)).not.toContain(jwt);
    expect(sanitizeLogMetadata({ uuid: credential, hash: 'password-hash', operationId: credential, taskId: credential, kernelInstanceId: credential })).toEqual({ uuid: '***', hash: '***', operationId: credential, taskId: credential, kernelInstanceId: credential });
  });
  it('Cookie多项与非UUID形态uuid赋值也完整遮蔽', () => {
    const output = maskSensitiveString('Cookie: theme=dark; session=secret-session; csrf=secret-csrf');
    for (const value of ['secret-session', 'secret-csrf']) expect(output).not.toContain(value);
    expect(maskSensitiveString('uuid=nonstandard-credential')).not.toContain('nonstandard-credential');
    expect(maskSensitiveString('{"uuid":"nonstandard-credential"}')).not.toContain('nonstandard-credential');
  });
});
