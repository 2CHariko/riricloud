import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import * as http from 'node:http';
import * as https from 'node:https';

export const UPSTREAM_FETCH_LIMITS = { timeoutMs: 20_000, maxBytes: 5 * 1024 * 1024, maxRedirects: 5 } as const;
const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16]] as const) blocked.addSubnet(address, prefix, 'ipv6');

export function isPublicUpstreamAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export function validateUpstreamUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('上游 URL 必须为绝对 HTTP(S) 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('上游 URL 协议或内嵌凭据无效');
  if ((process.env.NODE_ENV === 'production' || process.env.RIRICLOUD_ENV === 'production') && url.protocol !== 'https:') throw new Error('生产上游 URL 必须使用 HTTPS');
  if (url.hash || raw.length > 8192) throw new Error('上游 URL 长度或片段无效');
  return url;
}

export function validateUpstreamHeaders(headers: Record<string, string>): void {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.keys(headers).length > 32) throw new Error('自定义 Header 无效');
  let size = 0;
  for (const [key, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || typeof value !== 'string' || /[\r\n\0]/.test(value) || /^(host|connection|content-length|transfer-encoding|upgrade|proxy-authorization|accept-encoding)$/i.test(key)) throw new Error('自定义 Header 名称或值无效');
    size += Buffer.byteLength(key) + Buffer.byteLength(value);
  }
  if (size > 16 * 1024) throw new Error('自定义 Header 超限');
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('上游拉取取消或超时'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function requestPinned(url: URL, headers: Record<string, string>, signal: AbortSignal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await abortable(isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : lookup(hostname, { all: true, verbatim: true }), signal);
  if (!addresses.length || addresses.some(({ address }) => !isPublicUpstreamAddress(address))) throw new Error('上游地址不是公共网络地址');
  const pinned = addresses[0];
  return new Promise<{ status: number; location?: string; userInfo?: string; content: string }>((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request({
      protocol: url.protocol, hostname: pinned.address, family: pinned.family,
      port: url.port || (url.protocol === 'https:' ? 443 : 80), path: `${url.pathname}${url.search}`,
      method: 'GET', agent: false, servername: isIP(hostname) ? undefined : hostname,
      headers: { ...headers, Host: url.host, 'Accept-Encoding': 'identity' }, signal
    }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.destroy();
        resolve({ status, location, content: '' });
        return;
      }
      const fail = (message: string) => { response.destroy(); reject(new Error(message)); };
      if (status < 200 || status >= 300) return fail(`上游 HTTP 状态 ${status}`);
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') return fail('上游不支持的响应编码');
      if (Number(response.headers['content-length']) > UPSTREAM_FETCH_LIMITS.maxBytes) return fail('上游响应超限');
      let bytes = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > UPSTREAM_FETCH_LIMITS.maxBytes) return fail('上游响应超限');
        chunks.push(chunk);
      });
      response.once('aborted', () => reject(new Error('上游响应截断')));
      response.once('error', () => reject(new Error('上游响应中断')));
      response.once('end', () => {
        if (!response.complete || (response.headers['content-length'] && bytes !== Number(response.headers['content-length']))) return fail('上游响应截断');
        const userInfo = response.headers['subscription-userinfo'];
        resolve({ status, content: Buffer.concat(chunks).toString('utf8'), userInfo: typeof userInfo === 'string' ? userInfo : undefined });
      });
    });
    request.once('error', () => reject(new Error('上游连接失败、取消或超时')));
    request.end();
  });
}

export async function fetchUpstream(rawUrl: string, customHeaders: Record<string, string>, externalSignal?: AbortSignal): Promise<{ content: string; userInfo?: string }> {
  validateUpstreamHeaders(customHeaders);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  externalSignal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, UPSTREAM_FETCH_LIMITS.timeoutMs);
  try {
    let url = validateUpstreamUrl(rawUrl);
    let headers = { 'User-Agent': 'RiriCloud-Master', Accept: '*/*', ...customHeaders };
    for (let redirects = 0; redirects <= UPSTREAM_FETCH_LIMITS.maxRedirects; redirects++) {
      const response = await requestPinned(url, headers, controller.signal);
      if (![301, 302, 303, 307, 308].includes(response.status)) return { content: response.content, userInfo: response.userInfo };
      if (!response.location || redirects === UPSTREAM_FETCH_LIMITS.maxRedirects) throw new Error('上游重定向无效或超限');
      let next: URL;
      try { next = validateUpstreamUrl(new URL(response.location, url).toString()); } catch { throw new Error('上游重定向地址无效'); }
      // 跨来源只保留固定公开请求头，避免自定义凭据以未知 Header 名泄露。
      if (next.origin !== url.origin) headers = { 'User-Agent': 'RiriCloud-Master', Accept: '*/*' };
      url = next;
    }
    throw new Error('上游重定向超限');
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', cancel);
  }
}
