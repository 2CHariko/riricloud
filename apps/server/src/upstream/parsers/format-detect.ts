import { parse as parseYaml } from 'yaml';
import { parseMihomoProxies } from './mihomo.parser';
import { looksLikeSingboxConfig, parseSingboxOutbounds } from './singbox.parser';
import { looksLikeUriList, parseUriList } from './uri-list.parser';
import type { SkippedUpstreamNode, UpstreamParseResult } from './types';

/**
 * 上游订阅格式识别与统一入口。
 *
 * 识别顺序：YAML（mihomo）→ JSON（sing-box）→ 明文 URI 列表 → 整体 Base64 的 URI 列表。
 * 识别失败抛出带有明确原因的 `Error`，由调用方转换为 400。
 */

export type UpstreamFormat = 'MIHOMO' | 'SINGBOX' | 'BASE64_URI';

export type UpstreamParseOutput = UpstreamParseResult & {
  format: UpstreamFormat;
};

export class UpstreamFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamFormatError';
  }
}

/** 单次解析允许的最大节点数，避免超大订阅导致同步阻塞。 */
export const MAX_PARSED_NODES = 2000;

export function parseUpstreamContent(raw: string): UpstreamParseOutput {
  const text = raw.trim();
  if (!text) throw new UpstreamFormatError('订阅内容为空');

  const mihomo = tryParseMihomo(text);
  if (mihomo) return capNodes({ ...mihomo, format: 'MIHOMO' });

  const singbox = tryParseSingbox(text);
  if (singbox) return capNodes({ ...singbox, format: 'SINGBOX' });

  if (looksLikeUriList(text)) {
    return capNodes({ ...parseUriList(text), format: 'BASE64_URI' });
  }

  const decoded = decodeBase64Payload(text);
  if (decoded && decoded !== text) {
    // 解码后可能是 sing-box JSON，也可能是 URI 列表
    const decodedSingbox = tryParseSingbox(decoded);
    if (decodedSingbox) return capNodes({ ...decodedSingbox, format: 'SINGBOX' });
    if (looksLikeUriList(decoded)) {
      return capNodes({ ...parseUriList(decoded), format: 'BASE64_URI' });
    }
  }

  throw new UpstreamFormatError('无法识别订阅格式：仅支持 mihomo(Clash Meta) YAML、sing-box JSON 与 Base64/明文 URI 列表');
}

function tryParseMihomo(text: string): UpstreamParseResult | null {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch {
    return null;
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
  const root = document as Record<string, unknown>;
  if (Array.isArray(root.proxies)) {
    return parseMihomoProxies(root.proxies);
  }
  // Mihomo 兼容：仅含 proxies 的片段也可能没有顶层键
  return null;
}

function tryParseSingbox(text: string): UpstreamParseResult | null {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  if (!looksLikeSingboxConfig(document)) return null;
  return parseSingboxOutbounds((document as Record<string, unknown>).outbounds);
}

/** 整体 Base64 编码的订阅负载；失败返回 null。 */
function decodeBase64Payload(text: string): string | null {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  if (!normalized || !/^[A-Za-z0-9+/=]+$/.test(normalized)) return null;
  const padding = normalized.length % 4;
  const padded = padding === 0 ? normalized : normalized + '='.repeat(4 - padding);
  try {
    const buffer = Buffer.from(padded, 'base64');
    if (!buffer.length) return null;
    const decoded = buffer.toString('utf8');
    return decoded.includes('\uFFFD') ? null : decoded;
  } catch {
    return null;
  }
}

/** 超出上限时截断并记录跳过原因，不静默丢弃。 */
function capNodes(output: UpstreamParseOutput): UpstreamParseOutput {
  if (output.nodes.length <= MAX_PARSED_NODES) return output;
  const dropped = output.nodes.length - MAX_PARSED_NODES;
  const skipped: SkippedUpstreamNode[] = [
    ...output.skipped,
    { name: `(超限截断 ${dropped} 个节点)`, reason: 'INVALID_PARAMS', detail: `单次最多解析 ${MAX_PARSED_NODES} 个节点` }
  ];
  return { ...output, nodes: output.nodes.slice(0, MAX_PARSED_NODES), skipped };
}

/**
 * 提取 mihomo `proxy-providers` 中的远程订阅地址，供调用方递归一层抓取。
 * 只返回 http/https 且带 `url` 的 provider。
 */
export function extractProxyProviderUrls(text: string): string[] {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch {
    return [];
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) return [];
  const providers = (document as Record<string, unknown>)['proxy-providers'];
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return [];

  const urls: string[] = [];
  for (const value of Object.values(providers as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const url = (value as Record<string, unknown>).url;
    if (typeof url !== 'string' || !url.trim()) continue;
    try {
      const parsed = new URL(url.trim());
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') urls.push(parsed.toString());
    } catch {
      // 忽略非法 URL
    }
  }
  return [...new Set(urls)];
}
