import { Injectable } from '@nestjs/common';
import { fetchSafeRemoteBuffer } from '../common/safe-remote-fetch';

/**
 * 上游订阅抓取（v0.9.10）。
 *
 * 全部外发请求统一走 `fetchSafeRemoteBuffer`，复用既有的 SSRF 防护能力：
 * 内网与元数据地址拦截、重定向次数上限、响应体字节上限、总超时与流中断检测。
 *
 * 订阅 URL 内嵌机场鉴权 Token，**属于密钥**：本服务是唯一接触原始 URL 的位置，
 * 对外只提供脱敏后的摘要。
 */

/** 单次抓取允许的最大响应体：2 MiB，足以覆盖超大机场订阅。 */
export const UPSTREAM_MAX_BYTES = 2 * 1024 * 1024;

/** 抓取总超时：20 秒，避免慢机场拖住同步任务。 */
export const UPSTREAM_FETCH_TIMEOUT_MS = 20_000;

/**
 * 默认 User-Agent 伪装成 Clash Verge，使机场返回 mihomo/Clash 配置。
 * 这是上游订阅生态的实际约定，使用其它 UA 往往只能拿到 Base64 通用列表。
 */
export const DEFAULT_UPSTREAM_USER_AGENT = 'clash-verge/v2.0.0';

export type UpstreamFetchResult = {
  content: string;
  bytes: number;
  latencyMs: number;
  finalUserAgent: string;
};

@Injectable()
export class UpstreamFetchService {
  /**
   * 抓取订阅内容。失败时抛出脱敏后的错误，绝不把原始 URL 写进消息或日志。
   */
  async fetch(url: string, userAgent?: string | null): Promise<UpstreamFetchResult> {
    const finalUserAgent = userAgent?.trim() || DEFAULT_UPSTREAM_USER_AGENT;
    const startedAt = Date.now();
    try {
      const buffer = await fetchSafeRemoteBuffer(url, {
        maxBytes: UPSTREAM_MAX_BYTES,
        timeoutMs: UPSTREAM_FETCH_TIMEOUT_MS
      });
      const content = buffer.toString('utf8');
      return {
        content,
        bytes: buffer.length,
        latencyMs: Date.now() - startedAt,
        finalUserAgent
      };
    } catch (error) {
      // 只保留 host 与错误原因；订阅 Token 绝不出现在任何输出中
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`抓取上游订阅失败 (${maskUpstreamUrl(url)}): ${detail}`);
    }
  }
}

/**
 * URL 脱敏：只保留协议与 host，丢弃 path、query 与 userinfo。
 * query 中通常携带机场鉴权 Token，是最需要保护的部分。
 */
export function maskUpstreamUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '(无效地址)';
  }
}

/**
 * 生成用于审计日志的订阅摘要。`SystemLog.metadata` 同样不允许出现完整 URL。
 */
export function upstreamLogMetadata(subscription: { id: string; name: string; url: string }): {
  subscriptionId: string;
  name: string;
  host: string;
} {
  return {
    subscriptionId: subscription.id,
    name: subscription.name,
    host: maskUpstreamUrl(subscription.url)
  };
}
