import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

// 匿名引用只在本进程有效，密钥不持久化、不使用可枚举的普通哈希。
const correlationKey = randomBytes(32);
// eslint-disable-next-line no-control-regex
const ANSI_CONTROL_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const SENSITIVE_KEY_PATTERN = /(password|passwd|pwd|token|secret|authorization|credential|cookie|privatekey|private.key|publickey|api[-_]?key|jwt|hash|uuid)/i;
const TARGET_KEY_PATTERN = /^(?:target|host|hostname|serverHost|clientIp|ip|address|addresses|remoteAddress|destination|email)$/i;
const CORRELATION_KEY_PATTERN = /^(?:agentInstanceId|kernelInstanceId|operationId|taskId|traceId|instanceId|nodeId|userId)$/;
const DOMAIN_PATTERN = /(?<![@\w-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?![\w-])/gi;
const LOG_IDENTITY_KEYS = new Set(['receivedAt', 'occurredAt', 'timeQuality', 'sequence', 'agentInstanceId', 'kernelInstanceId', 'operationId', 'taskId', 'event', 'configVersion', 'status', 'trigger']);

/** 超限时仍保留有界、已脱敏的时间与任务关联，不携带原始凭据。 */
export function retainLogIdentity(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return Object.fromEntries(Object.entries(data).filter(([key, value]) => LOG_IDENTITY_KEYS.has(key) &&
    (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))))
    .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 256) : value]));
}

function anonymousTarget(value: string, type: 'host' | 'ip' = isIP(value) ? 'ip' : 'host'): string {
  if (/^\[redacted-(?:host|ip):[a-f0-9]{16}\]$/.test(value)) return value;
  const ref = createHmac('sha256', correlationKey).update(value.toLowerCase()).digest('hex').slice(0, 16);
  return `[redacted-${type}:${ref}]`;
}

/** 完整遮蔽凭据，目标保留匿名关联，避免时间/代码/版本误伤。 */
export function maskSensitiveString(input: string): string {
  if (!input || typeof input !== 'string') return input;
  let result = input.replace(ANSI_CONTROL_PATTERN, '');
  result = result.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, '***PRIVATE_KEY***');
  result = result.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '***');
  result = result.replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, '***');
  result = result.replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, (value) => `${value.split(/\s/)[0]} ***`);
  result = result.replace(/([?&](?:token|password|secret|key|ticket|uuid)=)[^&\s]+/gi, '$1***');
  // Cookie header 的分号后同样可能有凭据，未加引号时保守遮蔽整行。
  result = result.replace(/(\b(?:set-cookie|cookie)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]*)/gi, '$1***');
  result = result.replace(/((?:password|passwd|pwd|token|secret|authorization|cookie|credential|uuid|hash|jwt|api[-_]?key|access[-_]?key|private[-_]?key|public[-_]?key|signing[-_]?key)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}]+)/gi, '$1***');
  result = result.replace(/(\/sub\/)[A-Za-z0-9_-]+/g, '$1***');
  // 绝对 URL 不保留浏览路径或用户信息；端口可供运维判断。
  result = result.replace(/\b(?:https?|socks5?|tcp|udp):\/\/[^\s"'<>]+/gi, (raw) => {
    try {
      const url = new URL(raw);
      return `${url.protocol}//${anonymousTarget(url.hostname.replace(/^\[|\]$/g, ''))}${url.port ? `:${url.port}` : ''}/[redacted-path]`;
    } catch { return '[redacted-url]'; }
  });
  result = result.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}/gi, (value) => anonymousTarget(value));
  // 显式连接目标优先于代码/文件名例外，已匿名的引用不再次处理。
  result = result.replace(/(\b(?:dial|connect(?:ing)?(?: to)?|from|destination|target|host)\s+["']?)([a-z][\w.-]*)(?=:\d{1,5}\b)/gi, (_raw, prefix: string, target: string) => `${prefix}${anonymousTarget(target)}`);
  result = result.replace(/(?<![\w.:])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g, (value, offset: number, text: string) => {
    const prefix = text.slice(Math.max(0, offset - 32), offset);
    if (/(?:Chrome|Chromium|Firefox|Safari|Edg|Version)\/$/i.test(prefix) || /(?:version|revision)\s*[=:]\s*$/i.test(prefix)) return value;
    return isIP(value) === 4 ? anonymousTarget(value, 'ip') : value;
  });
  result = result.replace(/(?<![\w:])(?:[a-f0-9]*:){2,}[a-f0-9:.]*(?:%[\w-]+)?(?![\w:])/gi, (value) => isIP(value) === 6 ? anonymousTarget(value, 'ip') : value);
  result = result.replace(DOMAIN_PATTERN, (value) => {
    // Stack/文件名与典型 Type.method 不是连接目标；显式目标字段仍强制匿名。
    if (/\.(?:js|ts|tsx|jsx|go|json|yaml|yml|map)$/i.test(value) || /^[A-Z][\w]*\.[A-Za-z]+$/.test(value)) return value;
    return anonymousTarget(value);
  });
  return result;
}

/** 有界递归脱敏，敏感字段不保留凭据前后缀。 */
export function sanitizeLogMetadata<T = unknown>(data: T, depth = 0): T {
  if (depth > 8) return '[truncated]' as T;
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') return maskSensitiveString(data) as T;
  if (Array.isArray(data)) return data.slice(0, 100).map((item) => sanitizeLogMetadata(item, depth + 1)) as T;
  if (typeof data !== 'object') return data;
  const sanitized: Record<string, unknown> = {};
  const entries = Object.entries(data).sort(([a], [b]) => Number(LOG_IDENTITY_KEYS.has(b)) - Number(LOG_IDENTITY_KEYS.has(a))).slice(0, 100);
  for (const [key, value] of entries) {
    if (SENSITIVE_KEY_PATTERN.test(key)) sanitized[key] = '***';
    else if (CORRELATION_KEY_PATTERN.test(key) && typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)) sanitized[key] = value;
    else if (TARGET_KEY_PATTERN.test(key) && typeof value === 'string') sanitized[key] = anonymousTarget(value);
    else if (TARGET_KEY_PATTERN.test(key) && Array.isArray(value)) sanitized[key] = value.slice(0, 100).map((item) => typeof item === 'string' ? anonymousTarget(item) : '[redacted]');
    else sanitized[key] = sanitizeLogMetadata(value, depth + 1);
  }
  return sanitized as T;
}
