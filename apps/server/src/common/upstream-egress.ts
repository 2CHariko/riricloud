import { protectInboundSecrets, revealInboundSecrets } from './inbound';
import { decryptSecret, encryptSecret, isEncryptedSecret } from './secret-crypto';

/**
 * 上游订阅出口编排的共享定义（v0.9.10）。
 *
 * 上游出口线路（`Line.upstreamEntryId != null`）不监听任何入站，只提供一份指向第三方
 * 服务器的 client outbound 定义；其他线路通过 `Line.egressLineId` 把用户流量路由过去。
 * 该文件是 Agent 配置编译器、线路服务与订阅健康门共用的单一真理源。
 */

/** 可作为上游出口的协议白名单：纯本地代理与传输层协议没有对应的统一出站。 */
export const UPSTREAM_EGRESS_PROTOCOL_TYPES = [
  'VLESS',
  'VMESS',
  'TROJAN',
  'HYSTERIA2',
  'TUIC',
  'SHADOWSOCKS',
  'NAIVE'
] as const;
export type UpstreamEgressProtocolType = (typeof UPSTREAM_EGRESS_PROTOCOL_TYPES)[number];

export function isUpstreamEgressProtocol(value: string): value is UpstreamEgressProtocolType {
  return (UPSTREAM_EGRESS_PROTOCOL_TYPES as readonly string[]).includes(value);
}

/** 纯 UDP 协议：入口协议与之必须同族，否则 Sing-box 无法承载。 */
export const UDP_ONLY_PROTOCOL_TYPES = new Set(['HYSTERIA2', 'TUIC']);

/** 上游节点条目快照（配置编译器/测速探针所需的全部字段）。 */
export type UpstreamEntrySnapshot = {
  id: string;
  name: string;
  protocolType: string;
  server: string;
  port: number;
  paramsJson: string;
  available: boolean;
};

/**
 * 上游出口线路快照：入口/落地线路通过 `egressLineId` 引用它。
 * 形态与 Prisma 关系一致——线路自身的协议与端点字段，外加它绑定的上游条目。
 */
export type EgressLineSnapshot = {
  id: string;
  name: string;
  status: string;
  protocolType: string;
  paramsJson: string;
  upstreamEntry: UpstreamEntrySnapshot | null;
  upstreamEntryId?: string | null;
};

/**
 * Prisma include 片段：同时加载线路自身的上游条目，以及它所引用的上游出口线路。
 * 供 `buildConfigSync`、线路服务与测速服务复用，避免三处各写一份。
 */
export const UPSTREAM_EGRESS_INCLUDE = {
  upstreamEntry: true,
  egressLine: {
    include: { upstreamEntry: true }
  }
} as const;

/** 指向远端协议服务端进行握手所需的凭证三元组。 */
export type UpstreamOutboundCredentials = {
  uuid: string;
  email: string;
  secret: string;
};

/**
 * 从上游条目的出站参数中提取真实凭证。
 *
 * 与 `buildProtocolRelayOutbound` 的协议分支一一对应：
 * - uuid 类（VLESS/VMESS/TUIC）：条目 `uuid`，缺失时用 `id` 兜底避免生成空凭证；
 * - password 类（TROJAN/HYSTERIA2）：条目 `password`；
 * - SHADOWSOCKS：`params.password` 在编译分支内单独处理，此处仅提供 uuid 供多用户模式拼接；
 * - NAIVE：`username` + `password`。
 */
export function resolveUpstreamCredentials(
  entry: { id: string; name: string; paramsJson: string }
): UpstreamOutboundCredentials {
  const params = revealEntryParams(entry.paramsJson);
  return {
    uuid: pickString(params.uuid) ?? entry.id,
    email: pickString(params.username) ?? entry.name,
    secret: pickString(params.password) ?? ''
  };
}

/**
 * 解密并解析上游条目参数。上游条目与线路共用同一套应用层 AES-GCM 密钥保护，
 * 因此直接复用 `revealInboundSecrets`，不引入第二套加解密实现。
 */
export function revealEntryParams(paramsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(paramsJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return revealEntryParamsObject(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

/** 就地解密已解析的对象；供 `revealEntryParams` 与单元测试复用。 */
export function revealEntryParamsObject(params: Record<string, unknown>): Record<string, unknown> {
  const revealed = revealInboundSecrets(params);
  for (const field of CREDENTIAL_FIELDS) {
    const value = revealed[field];
    if (typeof value === 'string' && isEncryptedSecret(value)) {
      revealed[field] = decryptSecret(value);
    }
  }
  return revealed;
}

/**
 * 上游凭据落库前加密。
 *
 * `protectInboundSecrets` 只覆盖 Reality 私钥（因为它服务的是"我方入站"），
 * 而上游条目的 uuid / password / username 是纯粹的客户端凭据、没有任何服务端对偶字段，
 * 因此必须在这里显式加密，避免机场账号以明文形式留在数据库中。
 */
export function protectEntryParams(params: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
  for (const field of CREDENTIAL_FIELDS) {
    const value = clone[field];
    // 已加密值原样保留：绝不能在"保护"路径上解密再加密，
    // 否则每次写入都会生成新密文，既破坏幂等也让密文比对失去意义。
    if (typeof value === 'string' && value.length > 0 && !isEncryptedSecret(value)) {
      clone[field] = encryptSecret(value);
    }
  }
  // Reality 私钥与线路参数共用同一保护语义，保持一致。
  return protectInboundSecrets(clone);
}

/** 上游条目中属于凭据的字段名（与 Sing-box client outbound 的字段名一致）。 */
const CREDENTIAL_FIELDS = ['uuid', 'password', 'username'] as const;

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
