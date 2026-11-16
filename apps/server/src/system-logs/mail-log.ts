import { maskCredentialsOnly } from './masking.util';

export interface MailLogMetadata {
  event: 'MAIL_SEND_ACCEPTED' | 'MAIL_SEND_FAILED' | 'MAIL_SWEEP_FAILED';
  operationId: string;
  mailType: 'VERIFICATION' | 'TRAFFIC_WARNING' | 'SUBSCRIPTION_EXPIRY' | 'CERTIFICATE_EXPIRY' | 'SMTP_TEST' | 'SUBSCRIPTION_SWEEP' | 'CERTIFICATE_SWEEP';
  action?: string;
  to?: string;
  from?: string;
  subject?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  durationMs?: number;
  messageId?: string;
  smtpResponse?: string;
  accepted?: string[];
  rejected?: string[];
  stage?: 'CONFIG' | 'VERIFY' | 'SEND' | 'SWEEP';
  error?: { name?: string; message?: string; code?: string; responseCode?: number; command?: string; response?: string };
  subscriptionId?: string;
  deliveryId?: string;
  certificateIds?: string[];
  certificateRevisions?: Array<{ certificateId: string; revision: number }>;
  certificateCount?: number;
}

export interface MailLogInput {
  level: 'INFO' | 'ERROR';
  userId?: string | null;
  metadata: MailLogMetadata;
}

export const MAIL_LOG_MESSAGES: Record<MailLogMetadata['event'], string> = {
  MAIL_SEND_ACCEPTED: 'Mail submission accepted by SMTP server',
  MAIL_SEND_FAILED: 'Mail send failed',
  MAIL_SWEEP_FAILED: 'Mail sweep failed'
};
const MAIL_TYPES: MailLogMetadata['mailType'][] = ['VERIFICATION', 'TRAFFIC_WARNING', 'SUBSCRIPTION_EXPIRY', 'CERTIFICATE_EXPIRY', 'SMTP_TEST', 'SUBSCRIPTION_SWEEP', 'CERTIFICATE_SWEEP'];
const STAGES: NonNullable<MailLogMetadata['stage']>[] = ['CONFIG', 'VERIFY', 'SEND', 'SWEEP'];
const METADATA_BYTES = 16 * 1024;
const STRING_LIMIT = 8192;
const ARRAY_LIMIT = 100;

function secretVariants(secret: string): string[] {
  const bytes = Buffer.from(secret, 'utf8');
  const chars = secret.split('');
  const hex = bytes.toString('hex');
  const uri = encodeURIComponent(secret);
  const html = secret.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  const encoded = [secret, uri, encodeURI(secret), encodeURIComponent(uri), JSON.stringify(secret).slice(1, -1), html,
    bytes.toString('base64'), bytes.toString('base64url'), hex, hex.toUpperCase(),
    Array.from(bytes, (byte) => '%' + byte.toString(16).padStart(2, '0')).join(''),
    chars.map((char) => '&#' + char.charCodeAt(0) + ';').join(''),
    chars.map((char) => '&#x' + char.charCodeAt(0).toString(16) + ';').join(''),
    chars.map((char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('')];
  return [...new Set(encoded.flatMap((value) => [value, value.replace(/%[a-f0-9]{2}/gi, (part) => part.toUpperCase())]))];
}

/** 成功/失败诊断均复用此入口；不接受正文，保留业务目标，仅剔除凭据与已知秘密。 */
export function sanitizeMailDiagnostic(value: string, secrets: string[] = []): string {
  const variants = [...new Set(secrets.filter((secret) => typeof secret === 'string' && secret.length > 0)
    .flatMap(secretVariants))].sort((a, b) => b.length - a.length);
  let result = value;
  for (const secret of variants) result = result.split(secret).join('***');
  result = maskCredentialsOnly(result);
  // SMTP AUTH 的载荷可能同时编码账号和密码，不能只靠单个秘密的 base64 匹配。
  result = result.replace(/\bAUTH[ \t]+(PLAIN|LOGIN|XOAUTH2|OAUTHBEARER|CRAM-MD5)(?:[ \t]+[^\r\n]*)?(?:\r?\n[ \t]*(?:334[ \t]+)?[A-Za-z0-9+/_=-]+[ \t]*(?=\r?\n|$))*/gi, 'AUTH $1 ***');
  result = result.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/<>"']*@/gi, '$1***@');
  result = result.replace(/((?:smtp[-_]?user(?:name)?|smtp[-_]?pass(?:word)?|username|verification[-_]?code|otp|pass|auth)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}]+)/gi, '$1***');
  return result;
}

function field(data: object, key: string): unknown {
  try { return (data as Record<string, unknown>)[key]; } catch { return undefined; }
}

/** 兼容原生 Error 的非枚举字段；不序列化 stack/cause/transport 等未知对象。 */
export function mailErrorDetails(error: unknown, secrets: string[] = []): MailLogMetadata['error'] {
  if (typeof error === 'string') return { message: sanitizeMailDiagnostic(error, secrets) };
  if (!error || typeof error !== 'object') return undefined;
  const result: NonNullable<MailLogMetadata['error']> = {};
  for (const key of ['name', 'message', 'code', 'command', 'response'] as const) {
    const value = field(error, key);
    if (typeof value === 'string') result[key] = sanitizeMailDiagnostic(value, secrets);
  }
  const responseCode = field(error, 'responseCode');
  if (typeof responseCode === 'number' && Number.isFinite(responseCode)) result.responseCode = responseCode;
  return Object.keys(result).length ? result : undefined;
}

/** 独立白名单限定明文边界；通用 enqueue 无权通过模块名选择此策略。 */
export function sanitizeMailMetadata(input: MailLogMetadata): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || !Object.hasOwn(MAIL_LOG_MESSAGES, input.event) ||
      !MAIL_TYPES.includes(input.mailType) || typeof input.operationId !== 'string' || !input.operationId) return null;
  let truncated = false;
  const text = (value: string, limit = STRING_LIMIT): string => {
    const safe = sanitizeMailDiagnostic(value);
    if (safe.length > limit) truncated = true;
    return safe.slice(0, limit);
  };
  const result: Record<string, unknown> = { event: input.event, operationId: text(input.operationId, 128), mailType: input.mailType };
  for (const key of ['action', 'to', 'from', 'subject', 'smtpHost', 'messageId', 'smtpResponse', 'subscriptionId', 'deliveryId'] as const) {
    if (typeof input[key] === 'string') result[key] = text(input[key]);
  }
  for (const key of ['smtpPort', 'durationMs', 'certificateCount'] as const) {
    if (typeof input[key] === 'number' && Number.isFinite(input[key])) result[key] = input[key];
  }
  if (typeof input.smtpSecure === 'boolean') result.smtpSecure = input.smtpSecure;
  if (input.stage && STAGES.includes(input.stage)) result.stage = input.stage;
  for (const key of ['accepted', 'rejected', 'certificateIds'] as const) {
    const value = input[key];
    if (!Array.isArray(value)) continue;
    if (value.length > ARRAY_LIMIT) truncated = true;
    result[key] = value.slice(0, ARRAY_LIMIT).filter((item): item is string => typeof item === 'string').map((item) => text(item));
  }
  if (Array.isArray(input.certificateRevisions)) {
    if (input.certificateRevisions.length > ARRAY_LIMIT) truncated = true;
    result.certificateRevisions = input.certificateRevisions.slice(0, ARRAY_LIMIT)
      .filter((item) => item && typeof item.certificateId === 'string' && typeof item.revision === 'number' && Number.isFinite(item.revision))
      .map((item) => ({ certificateId: text(item.certificateId), revision: item.revision }));
  }
  const error = mailErrorDetails(input.error);
  if (error) result.error = Object.fromEntries(Object.entries(error).map(([key, value]) => [key, typeof value === 'string' ? text(value) : value]));
  if (truncated) result.truncated = true;
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= METADATA_BYTES) return result;
  // 失败摘要和交付关联优先，舍弃可能很大的主题、完整响应及批量证书列表。
  // 按每个 UTF-16 字符最坏 6 字节的 JSON 转义估算，连同字段名仍小于 16KiB。
  const retained: Record<string, unknown> = { event: result.event, operationId: result.operationId, mailType: result.mailType };
  for (const key of ['to', 'subscriptionId', 'deliveryId', 'stage']) {
    if (typeof result[key] === 'string') retained[key] = (result[key] as string).slice(0, key === 'to' ? 512 : 256);
  }
  if (error) retained.error = Object.fromEntries(Object.entries(error).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, key === 'message' ? 768 : 128) : value]));
  retained.truncated = true;
  return retained;
}
