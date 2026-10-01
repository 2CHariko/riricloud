import { BadRequestException } from '@nestjs/common';
import {
  PROXY_KEY_WHITELIST_LIMIT,
  formatProxyLineUsername,
  parseProxyLineUsername,
  generateProxyKeyPassword,
  generateProxyKeyUsername,
  isProxyKeyUsername,
  isValidIpOrCidr,
  normalizeProxyKeyName,
  normalizeWhitelistIps,
  parseWhitelistIps
} from './proxy-key.util';

describe('proxy-key.util', () => {
  it('生成 pk_ 前缀的高熵用户名，且 1000 次生成无重复', () => {
    const samples = new Set<string>();
    for (let index = 0; index < 1000; index += 1) {
      const username = generateProxyKeyUsername();
      expect(isProxyKeyUsername(username)).toBe(true);
      expect(username).toMatch(/^pk_[0-9a-f]{24}$/);
      samples.add(username);
    }
    expect(samples.size).toBe(1000);
  });

  it('生成冒号安全的 base64url 密码（可直接嵌入 socks5:// 与 http:// URI）', () => {
    for (let index = 0; index < 200; index += 1) {
      const password = generateProxyKeyPassword();
      expect(password).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(password).not.toContain(':');
      expect(password).not.toContain('@');
      expect(Buffer.from(password, 'base64url').length).toBe(24);
    }
  });

  it('isProxyKeyUsername 拒绝非规范形态', () => {
    expect(isProxyKeyUsername('user@example.com')).toBe(false);
    expect(isProxyKeyUsername('pk_short')).toBe(false);
    expect(isProxyKeyUsername('pk_0123456789ABCDEF01234567')).toBe(false);
    expect(isProxyKeyUsername(' pk_0123456789abcdef01234567 ')).toBe(true);
  });

  it('isValidIpOrCidr 精确校验 IPv4/IPv6 与 CIDR 前缀范围', () => {
    expect(isValidIpOrCidr('203.0.113.10')).toBe(true);
    expect(isValidIpOrCidr('198.51.100.0/24')).toBe(true);
    expect(isValidIpOrCidr('198.51.100.0/32')).toBe(true);
    expect(isValidIpOrCidr('10.0.0.0/0')).toBe(true);
    expect(isValidIpOrCidr('2001:db8::1')).toBe(true);
    expect(isValidIpOrCidr('2001:db8::/32')).toBe(true);
    expect(isValidIpOrCidr('2001:db8::/129')).toBe(false);

    expect(isValidIpOrCidr('198.51.100.0/33')).toBe(false);
    expect(isValidIpOrCidr('198.51.100.256')).toBe(false);
    expect(isValidIpOrCidr('198.51.100.0/')).toBe(false);
    expect(isValidIpOrCidr('198.51.100.0/24/8')).toBe(false);
    expect(isValidIpOrCidr('not-an-ip')).toBe(false);
    expect(isValidIpOrCidr('')).toBe(false);
  });

  it('normalizeWhitelistIps 兼容逗号/分号/空白分隔并去重排序保留原始顺序', () => {
    expect(normalizeWhitelistIps('203.0.113.1, 198.51.100.0/24\n203.0.113.1')).toBe('203.0.113.1,198.51.100.0/24');
    expect(normalizeWhitelistIps('')).toBe('');
    expect(normalizeWhitelistIps(undefined)).toBe('');
    expect(normalizeWhitelistIps('  10.0.0.1;10.0.0.2 ')).toBe('10.0.0.1,10.0.0.2');
  });

  it('normalizeWhitelistIps 对非法条目与超限条目抛出 BadRequest', () => {
    expect(() => normalizeWhitelistIps('203.0.113.1, evil.example.com')).toThrow(BadRequestException);
    expect(() => normalizeWhitelistIps('10.0.0.0/33')).toThrow('格式非法');
    expect(() => normalizeWhitelistIps(123 as unknown as string)).toThrow('必须为字符串');
    expect(() =>
      normalizeWhitelistIps(Array.from({ length: PROXY_KEY_WHITELIST_LIMIT + 1 }, (_, i) => `10.0.${Math.floor(i / 256)}.${i % 256}`).join(','))
    ).toThrow(`最多 ${PROXY_KEY_WHITELIST_LIMIT} 条`);
  });

  it('normalizeProxyKeyName 去空白并限制长度', () => {
    expect(normalizeProxyKeyName('  爬虫项目 A  ')).toBe('爬虫项目 A');
    expect(() => normalizeProxyKeyName('   ')).toThrow('不能为空');
    expect(() => normalizeProxyKeyName('x'.repeat(61))).toThrow('不得超过 60');
    expect(() => normalizeProxyKeyName(undefined)).toThrow(BadRequestException);
  });

  it('parseWhitelistIps 读取落库白名单字符串', () => {
    expect(parseWhitelistIps('10.0.0.1,10.0.0.2')).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(parseWhitelistIps('')).toEqual([]);
    expect(parseWhitelistIps(null)).toEqual([]);
  });

  it('派生用户名无冒号且可规范还原普通 UUID', () => {
    const rawCredential = 'pk_0123456789abcdef01234567';
    const lineId = '11111111-1111-4111-8111-111111111111';
    const username = formatProxyLineUsername(rawCredential, lineId);
    expect(username).toMatch(/^pk_line_[A-Za-z0-9_-]+$/);
    expect(username.length).toBeLessThanOrEqual(255);
    expect(parseProxyLineUsername(username)).toEqual({ rawCredential, lineId });
    expect(parseProxyLineUsername(username + '=')).toBeNull();
    expect(parseProxyLineUsername(' ' + username)).toBeNull();
    expect(parseProxyLineUsername(rawCredential)).toBeNull();
    expect(() => formatProxyLineUsername(rawCredential, 'not-uuid')).toThrow(BadRequestException);
  });

  it('拒绝非规范 JSON/base64url、非法 key/UUID 和超长用户名', () => {
    const encoded = (json: string) => 'pk_line_' + Buffer.from(json).toString('base64url');
    const key = 'pk_0123456789abcdef01234567';
    const id = '11111111-1111-4111-8111-111111111111';
    for (const value of [encoded(`[ "${key}","${id}"]`), encoded(JSON.stringify([key, id, 'extra'])), encoded(JSON.stringify(['pk_short', id])), encoded(JSON.stringify([key, 'bad'])), encoded('{}'), 'pk_line_!', 'pk_line_' + 'a'.repeat(256)]) {
      expect(parseProxyLineUsername(value)).toBeNull();
    }
  });
});
