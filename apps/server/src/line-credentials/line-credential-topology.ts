import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { isIP } from 'node:net';
import { revealInboundSecrets, SS_DEFAULT_METHOD } from '../common/inbound';

const nodeSelect = { id: true, serverHost: true, reachability: true, status: true, configOverride: true } as const;
export const relayLineSelect = {
  id: true, status: true, type: true, relayMode: true, protocolType: true, paramsJson: true,
  entryNodeId: true, landingNodeId: true, targetLineId: true,
  landingEndpointOverrideEnabled: true, landingServerHost: true,
  entryNode: { select: nodeSelect }, landingNode: { select: nodeSelect },
  targetLine: { select: { id: true, status: true, type: true, protocolType: true, paramsJson: true, entryNodeId: true, endpointOverrideEnabled: true, serverHost: true, entryNode: { select: nodeSelect } } }
} as const satisfies Prisma.LineSelect;
export type RelayLine = Prisma.LineGetPayload<{ select: typeof relayLineSelect }>;

function privateIpv4(bytes: number[]): boolean {
  const [first, second] = bytes;
  return first === 10 || first === 127 ||
    (first === 192 && second === 168) || (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 100 && second >= 64 && second <= 127);
}

function privateAddress(host: string): boolean {
  // 只接受完整 IP 字面量；域名不能因名称或未知 DNS 结果被视为私网。
  let value = host.trim();
  const bracketed = value.startsWith('[') && value.endsWith(']');
  if (bracketed) value = value.slice(1, -1);
  const family = isIP(value);
  if (family === 4) return !bracketed && privateIpv4(value.split('.').map(Number));
  if (family !== 6) return false;

  // 先经 isIP 验证，再统一展开 IPv6；点分和十六进制映射地址按同一 IPv4 边界判定。
  const address = value.split('%')[0].replace(/(?:\d{1,3}\.){3}\d{1,3}$/, tail => {
    const bytes = tail.split('.').map(Number);
    return ((bytes[0] << 8) | bytes[1]).toString(16) + ':' + ((bytes[2] << 8) | bytes[3]).toString(16);
  });
  const [left, right] = address.split('::');
  const words = (part: string) => part ? part.split(':').map(word => parseInt(word, 16)) : [];
  const leading = words(left);
  const trailing = words(right ?? '');
  const expanded = right === undefined ? leading : [...leading, ...Array<number>(8 - leading.length - trailing.length).fill(0), ...trailing];
  if (expanded.slice(0, 5).every(word => word === 0) && expanded[5] === 0xffff) {
    return privateIpv4([expanded[6] >> 8, expanded[6] & 0xff, expanded[7] >> 8, expanded[7] & 0xff]);
  }
  return (expanded[0] & 0xfe00) === 0xfc00 || (expanded[0] & 0xffc0) === 0xfe80 ||
    (expanded.slice(0, 7).every(word => word === 0) && expanded[7] === 1);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function assertControlledOverride(config: string | null) {
  if (config === null || config === '') return;
  let parsed: unknown;
  try { parsed = JSON.parse(config); } catch { throw new ConflictException('LINE_CREDENTIAL_CONFIG_OVERRIDE'); }
  // DNS 与路由同样能改变实际拨号目标，维护期间不能接管认证或目标边界。
  if (!isObject(parsed) || ['inbounds', 'outbounds', 'route', 'dns'].some(key => Object.hasOwn(parsed, key))) {
    throw new ConflictException('LINE_CREDENTIAL_CONFIG_OVERRIDE');
  }
}

function relayParams(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isObject(parsed) || (parsed.tls !== undefined && !isObject(parsed.tls))) throw new Error();
    return revealInboundSecrets(parsed);
  } catch {
    // JSON 解析和 AES-GCM 错误可能包含原始配置，边界仅返回固定安全错误码。
    throw new ConflictException('LINE_CREDENTIAL_CONFIGURATION_INVALID');
  }
}

const authenticatedSsMethods = new Set([
  'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305',
  '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305'
]);

function assertRelayProtocol(protocol: string, params: Record<string, unknown>, sharedTarget: boolean) {
  if (!['VLESS', 'VMESS', 'TROJAN', 'HYSTERIA2', 'TUIC', 'SHADOWSOCKS', 'NAIVE'].includes(protocol)) {
    throw new ConflictException('LINE_CREDENTIAL_UNSUPPORTED');
  }
  if (protocol !== 'SHADOWSOCKS') return;
  if (sharedTarget && params.mode !== 'multi-user') throw new ConflictException('LINE_CREDENTIAL_SHARED_TARGET_UNSUPPORTED');
  const method = params.method ?? SS_DEFAULT_METHOD;
  if (typeof method !== 'string' || !authenticatedSsMethods.has(method) ||
      (params.mode === 'multi-user' && !method.startsWith('2022-'))) {
    throw new ConflictException('LINE_CREDENTIAL_UNSUPPORTED');
  }
}

export function relayTopology(line: RelayLine) {
  if (!line.id || line.type !== 'RELAY' || !['PROTOCOL_PROXY', 'TARGET_LINE'].includes(line.relayMode ?? '') ||
      !line.entryNodeId || !line.entryNode || line.entryNode.id !== line.entryNodeId) {
    throw new ConflictException('LINE_CREDENTIAL_UNSUPPORTED');
  }
  const target = line.relayMode === 'TARGET_LINE' ? line.targetLine : null;
  if (line.relayMode === 'TARGET_LINE' && (!target || target.status !== 'ACTIVE' || target.type !== 'DIRECT' ||
      target.id === line.id || target.id !== line.targetLineId || !target.entryNodeId ||
      !target.entryNode || target.entryNode.id !== target.entryNodeId)) {
    throw new ConflictException('LINE_CREDENTIAL_TARGET_UNAVAILABLE');
  }
  const landing = target ? target.entryNode : line.landingNode;
  if (!landing || landing.id === line.entryNodeId || (!target && landing.id !== line.landingNodeId)) {
    throw new ConflictException('LINE_CREDENTIAL_TARGET_UNAVAILABLE');
  }
  assertControlledOverride(line.entryNode.configOverride);
  assertControlledOverride(landing.configOverride);
  const protocol = target?.protocolType ?? line.protocolType;
  const params = relayParams(target?.paramsJson ?? line.paramsJson);
  assertRelayProtocol(protocol, params, target !== null);
  const host = line.landingEndpointOverrideEnabled && line.landingServerHost ? line.landingServerHost :
    target?.endpointOverrideEnabled && target.serverHost ? target.serverHost : landing.serverHost;
  const tls = params.tls as Record<string, unknown> | undefined;
  const authenticatedTls = tls?.enabled === true && tls.insecure !== true &&
    (tls.mode === undefined || ['tls', 'reality', 'acme'].includes(String(tls.mode)));
  // 当前只有自建 PROTOCOL_PROXY 出站强制走 NAT 隧道；TARGET_LINE 仍按实际拨号地址判定。
  const tunnelLanding = target === null && landing.reachability === 'NAT';
  const publicLanding = !tunnelLanding && !privateAddress(host);
  // VMess 出站固定 security=auto，SS 上方已校验认证加密算法；二者可用协议层认证加密。
  // 即便协议本身加密，也不能以此默许显式跳过 TLS 证书校验。
  const protocolEncryption = protocol === 'VMESS' || protocol === 'SHADOWSOCKS';
  if (publicLanding && (tls?.insecure === true || (!protocolEncryption && !authenticatedTls))) {
    throw new ConflictException('LINE_CREDENTIAL_PUBLIC_TLS_REQUIRED');
  }
  return { entryNodeId: line.entryNodeId, landingNodeId: landing.id, targetLineId: target?.id ?? null };
}
