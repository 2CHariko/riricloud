import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

// 直连代理池凭据用户名前缀：pk_ 保证与用户邮箱/UUID 凭证空间天然隔离
export const PROXY_KEY_USERNAME_PREFIX = 'pk_';

// 单个凭据允许配置的白名单条目上限，避免生成超大 Sing-box 路由规则
export const PROXY_KEY_WHITELIST_LIMIT = 64;

// CIDR 后缀结构校验（主机部分交由 node:net 精确判定，这里只约束形态）
const CIDR_PREFIX_REGEX = /^\d{1,3}$/;

// 生成高熵用户名 pk_<24 位十六进制>（96 bit 熵），指纹浏览器与爬虫项目可安全公开
export function generateProxyKeyUsername(): string {
  return `${PROXY_KEY_USERNAME_PREFIX}${randomBytes(12).toString('hex')}`;
}

// 生成高熵密码：24 字节 base64url（192 bit 熵），可安全嵌入 URI 无需二次转义
export function generateProxyKeyPassword(): string {
  return randomBytes(24).toString('base64url');
}

// 判断给定字符串是否为系统生成的代理池凭据用户名
export function isProxyKeyUsername(value: string): boolean {
  return /^pk_[0-9a-f]{24}$/.test(value.trim());
}

// 校验单条白名单条目：纯 IP 或 CIDR（IPv4/IPv6 均支持）
export function isValidIpOrCidr(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  const slashIndex = value.indexOf('/');
  if (slashIndex === -1) {
    return isIP(value) !== 0;
  }
  // 只允许单个 "/" 分段
  if (value.indexOf('/', slashIndex + 1) !== -1) return false;
  const host = value.slice(0, slashIndex).trim();
  const prefixText = value.slice(slashIndex + 1).trim();
  const version = isIP(host);
  if (version === 0 || !CIDR_PREFIX_REGEX.test(prefixText)) return false;
  const prefix = Number(prefixText);
  return version === 4 ? prefix >= 0 && prefix <= 32 : prefix >= 0 && prefix <= 128;
}

// 归一化用户提交的白名单文本：拆分（逗号/分号/空白/换行）→ 去重 → 逐条严格校验
export function normalizeWhitelistIps(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    throw new BadRequestException('IP 白名单必须为字符串（多条以逗号或换行分隔）');
  }
  const entries = [...new Set(raw.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))];
  if (entries.length > PROXY_KEY_WHITELIST_LIMIT) {
    throw new BadRequestException(`IP 白名单最多 ${PROXY_KEY_WHITELIST_LIMIT} 条`);
  }
  for (const entry of entries) {
    if (!isValidIpOrCidr(entry)) {
      throw new BadRequestException(`IP 白名单条目格式非法: ${entry}（须为 IPv4/IPv6 地址或 CIDR 网段）`);
    }
  }
  return entries.join(',');
}

// 读取落库的白名单字符串
export function parseWhitelistIps(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

// 规范化用户填写的凭据名称
export function normalizeProxyKeyName(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new BadRequestException('凭据名称不能为空');
  }
  const name = raw.trim();
  if (name.length > 60) {
    throw new BadRequestException('凭据名称长度不得超过 60 个字符');
  }
  return name;
}

export const PROXY_LINE_USERNAME_PREFIX = 'pk_line_';
const RAW_PROXY_KEY_REGEX = /^pk_[0-9a-f]{24}$/;
export const PROXY_LINE_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// 规范 JSON + base64url 保证 HTTP Basic Auth/SOCKS 用户名不含冒号，且可精确还原账务线路。
export function formatProxyLineUsername(originalKey: string, lineId: string): string {
  if (!RAW_PROXY_KEY_REGEX.test(originalKey) || !PROXY_LINE_UUID_REGEX.test(lineId)) {
    throw new BadRequestException('代理池凭据或线路标识无效');
  }
  const value = PROXY_LINE_USERNAME_PREFIX + Buffer.from(JSON.stringify([originalKey, lineId]), 'utf8').toString('base64url');
  if (value.length > 255) throw new BadRequestException('代理池用户名过长');
  return value;
}

export function parseProxyLineUsername(value: string): { rawCredential: string; lineId: string } | null {
  if (typeof value !== 'string' || value.length > 255 || !value.startsWith(PROXY_LINE_USERNAME_PREFIX)) return null;
  const encoded = value.slice(PROXY_LINE_USERNAME_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') return null;
    const [rawCredential, lineId] = parsed as [string, string];
    if (formatProxyLineUsername(rawCredential, lineId) !== value) return null;
    return { rawCredential, lineId };
  } catch {
    return null;
  }
}
