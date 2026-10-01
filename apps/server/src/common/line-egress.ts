import { BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { decryptSecret, encryptSecret, isEncryptedSecret } from './secret-crypto';
import { buildUpstreamOutbound } from './upstream-connection';

export interface EgressProxy {
  protocol: 'HTTP' | 'SOCKS5';
  serverHost: string;
  serverPort: number;
  authEnabled: boolean;
  username?: string;
  password?: string;
  udpEnabled: boolean;
}
export type EgressProxyInput = Omit<EgressProxy, 'udpEnabled'> & { udpEnabled?: boolean };
export type SafeEgressProxy = Omit<EgressProxy, 'password'> & { hasPassword: boolean };
const allowed = new Set(['protocol', 'serverHost', 'serverPort', 'authEnabled', 'username', 'password', 'udpEnabled']);
const invalid = (): never => { throw new BadRequestException('最终出站代理配置无效'); };

export function normalizeEgressProxy(value: unknown, previous?: EgressProxy | null): EgressProxy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(key => !allowed.has(key)) || !['HTTP', 'SOCKS5'].includes(String(p.protocol))) return invalid();
  if (typeof p.serverHost !== 'string' || typeof p.authEnabled !== 'boolean' || !Number.isInteger(p.serverPort) || Number(p.serverPort) < 1 || Number(p.serverPort) > 65535) return invalid();
  const host = p.serverHost.trim().replace(/^\[([^\]]+)\]$/, '$1');
  if (/[\s/@?#%\\]/.test(host)) return invalid();
  const ascii = domainToASCII(host).toLowerCase();
  if (!host || host.length > 253 || (!isIP(host) && (!ascii || !ascii.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))))) return invalid();
  if (p.udpEnabled !== undefined && typeof p.udpEnabled !== 'boolean') return invalid();
  if (p.protocol === 'HTTP' && p.udpEnabled === true) return invalid();
  for (const key of ['username', 'password']) {
    if (p[key] !== undefined && (typeof p[key] !== 'string' || (p[key] as string).length > 255 || [...p[key] as string].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) return invalid();
  }
  const result: EgressProxy = { protocol: p.protocol as EgressProxy['protocol'], serverHost: isIP(host) ? host.toLowerCase() : ascii, serverPort: Number(p.serverPort), authEnabled: p.authEnabled, udpEnabled: p.udpEnabled === true };
  if (result.authEnabled) {
    const password = p.password === undefined ? previous?.password : p.password;
    if (typeof p.username !== 'string' || !p.username.trim() || typeof password !== 'string' || !password) return invalid();
    result.username = p.username;
    result.password = password;
    // HTTP Basic 用户名不能包含冒号；SOCKS5 使用独立长度字段。
    if (result.protocol === 'HTTP' && result.username.includes(':')) return invalid();
    if (Buffer.byteLength(result.username) > 255 || Buffer.byteLength(password) > 255) return invalid();
  }
  return result;
}

export function readEgressProxy(stored: string | null | undefined): EgressProxy | null {
  if (stored == null) return null;
  if (!isEncryptedSecret(stored)) return invalid();
  try { return normalizeEgressProxy(JSON.parse(decryptSecret(stored))); } catch { return invalid(); }
}
export function saveEgressProxy(input: EgressProxyInput | null | undefined, stored: string | null | undefined): string | null {
  if (input === null) return null;
  if (input === undefined) { if (stored != null) readEgressProxy(stored); return stored ?? null; }
  const previous = input.authEnabled && input.password === undefined ? readEgressProxy(stored) : null;
  return encryptSecret(JSON.stringify(normalizeEgressProxy(input, previous)));
}
export function safeEgressProxy(stored: string | null | undefined): SafeEgressProxy | null {
  const p = readEgressProxy(stored);
  if (!p) return null;
  const { password, ...safe } = p;
  return { ...safe, hasPassword: Boolean(password) };
}
export function canConfigureEgress(type: string, relayMode?: string | null): boolean {
  return type === 'DIRECT' || (type === 'RELAY' && ['BLIND_FORWARD', 'PROTOCOL_PROXY'].includes(relayMode ?? ''));
}
export function egressOverrideConflict(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    return ['inbounds', 'outbounds', 'route', 'dns'].find(key => Object.prototype.hasOwnProperty.call(p, key)) ?? null;
  } catch { return 'invalid JSON'; }
}
export function assertEgressOverride(raw: string | null | undefined, lineId?: string): void {
  const conflict = egressOverrideConflict(raw);
  if (conflict) throw new BadRequestException(`最终出站与节点高级覆盖 ${conflict} 冲突${lineId ? `（线路 ${lineId}）` : ''}`);
}
export function assertEgressNotLoop(p: EgressProxy, nodeHost: string, ports: Array<number | null | undefined>): void {
  const host = p.serverHost.toLowerCase();
  if ((['localhost', '::1'].includes(host) || /^127\./.test(host) || host === nodeHost.trim().replace(/^\[|\]$/g, '').toLowerCase()) && ports.includes(p.serverPort)) {
    throw new BadRequestException('最终出站代理不能指向执行节点的业务监听端口');
  }
}

// ShadowTLS 外层仅握手，业务路由匹配其内层；坏配置拒绝业务而非落回默认直出。
export function buildEgressRoute(lineId: string, stored: string | null | undefined, inbounds: Array<Record<string, unknown>>) {
  const tags = inbounds.filter(i => i.type !== 'shadowtls').map(i => i.tag).filter((tag): tag is string => typeof tag === 'string');
  const rules: Array<Record<string, unknown>> = [];
  if (stored == null) return { outbound: null, rules, invalid: false };
  try {
    const proxy = readEgressProxy(stored)!;
    const tag = `egress-out-${lineId}`;
    const outbound = buildUpstreamOutbound({ protocolType: proxy.protocol === 'SOCKS5' ? 'SOCKS' : 'HTTP', serverHost: proxy.serverHost, serverPort: proxy.serverPort, params: { ...(proxy.authEnabled ? { username: proxy.username, password: proxy.password } : {}), ...(proxy.protocol === 'SOCKS5' ? { version: '5' } : {}) } }, tag);
    if (!proxy.udpEnabled) rules.push({ inbound: tags, network: 'udp', action: 'reject' });
    rules.push({ inbound: tags, outbound: tag });
    return { outbound, rules, invalid: false };
  } catch { return { outbound: null, rules: [{ inbound: tags, action: 'reject' }] as Array<Record<string, unknown>>, invalid: true }; }
}
