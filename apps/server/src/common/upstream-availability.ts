import { decryptSecret, isEncryptedSecret } from './secret-crypto';
import { validateUpstreamConnection, type UpstreamConnection } from './upstream-connection';

export interface UpstreamAvailabilityNode {
  status: string;
  presenceStatus: string;
  protocolType: string;
  paramsJson: string;
  serverHost: string;
  serverPort: number;
  subscription: {
    status: string;
    userInfoUsedBytes: bigint | null;
    userInfoTotalBytes: bigint | null;
    userInfoExpireAt: Date | null;
  } | null;
}

export function readUpstreamConnection(node: { protocolType: string; serverHost: string; serverPort: number; paramsJson: string }): UpstreamConnection {
  try {
    if (!isEncryptedSecret(node.paramsJson)) throw new Error();
    const params: unknown = JSON.parse(decryptSecret(node.paramsJson));
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error();
    const connection = { protocolType: node.protocolType, serverHost: node.serverHost, serverPort: node.serverPort, params: params as Record<string, unknown> };
    validateUpstreamConnection(connection);
    return connection;
  } catch {
    throw new Error('Invalid encrypted upstream connection');
  }
}

export function getUpstreamUnavailableReason(node: UpstreamAvailabilityNode, now = new Date()): string | null {
  if (node.subscription?.status !== 'ACTIVE') return '上游订阅已禁用';
  if (node.status !== 'ACTIVE') return '上游节点已禁用';
  if (node.presenceStatus !== 'PRESENT') return '上游节点不在最近成功快照中';
  const source = node.subscription;
  if (source.userInfoExpireAt && source.userInfoExpireAt.getTime() <= now.getTime()) return '上游订阅已到期';
  if (source.userInfoTotalBytes !== null && source.userInfoTotalBytes > 0n && source.userInfoUsedBytes !== null && source.userInfoUsedBytes >= source.userInfoTotalBytes) return '上游订阅流量已耗尽';
  try {
    readUpstreamConnection(node);
  } catch {
    return '上游连接配置无效或协议不支持';
  }
  return null;
}

export function isMeteredUpstreamEntry(protocolType: string, params: Record<string, unknown>): boolean {
  if (['DIRECT', 'SHADOWTLS', 'MIXED'].includes(protocolType)) return false;
  if (params.usersEnabled === false || params.users_enabled === false) return false;
  if (protocolType === 'SHADOWSOCKS') return params.mode === 'multi-user' && typeof params.method === 'string' && params.method.startsWith('2022-');
  return ['VLESS', 'VMESS', 'TROJAN', 'HYSTERIA2', 'TUIC', 'NAIVE', 'SOCKS', 'HTTP'].includes(protocolType);
}
