import { MIRROR_STREAM_BUFFER_BYTES } from './mirror-capacity';
import type { Response } from 'express';
import type { MirrorStreamHandlers } from '../agent-gateway/agent.service';

export const MAX_MIRROR_RESPONSE_BYTES = 256 * 1024 * 1024;
const MAX_PENDING_BYTES = MIRROR_STREAM_BUFFER_BYTES;
const MAX_PENDING_CHUNKS = 1024;
const RESPONSE_HEADERS = new Set(['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control', 'expires', 'vary', 'content-encoding']);

export type MirrorOutcome = { success: boolean; statusCode?: number; code?: string; message?: string };

// 所有终态共用一次结算；启动仍在 await 时先取消已注册会话，再收回迟到的停止句柄。
export class MirrorTask {
  settled = false;
  private stop?: () => void;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(timeoutMs: number, private readonly cancelEarly: () => void, private readonly onFinish: (outcome: MirrorOutcome) => void, timeoutCode = 'TIMEOUT') {
    this.timer = setTimeout(() => this.finish({ success: false, statusCode: timeoutCode === 'TOKEN_EXPIRED' ? 403 : 504, code: timeoutCode, message: '镜像请求已超时或过期' }), timeoutMs);
  }

  attachStop(stop: () => void) {
    if (this.settled) stop();
    else this.stop = stop;
  }

  finish(outcome: MirrorOutcome) {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    try { (this.stop ?? this.cancelEarly)(); }
    finally { this.stop = undefined; this.onFinish(outcome); }
  }
}

// 只暂停当前 HTTP 流的写入；WS 消费保持同步、短时执行，避免阻塞其它任务及心跳。
export class MirrorResponseStream {
  bytesSent = 0;
  finalHost = 'unknown';
  readonly handlers: MirrorStreamHandlers;
  private closed = false;
  private headersReceived = false;
  private upstreamEnded = false;
  private blocked = false;
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(private readonly response: Response, private readonly method: string, private readonly settle: (outcome: MirrorOutcome) => void) {
    this.handlers = {
      onHeaders: (headers) => this.onHeaders(headers),
      onChunk: (chunk) => this.onChunk(chunk),
      onEnd: (end) => {
        if (this.closed || this.upstreamEnded) return;
        if (!end.success || !this.headersReceived) { this.fail('UPSTREAM_ERROR'); return; }
        this.upstreamEnded = true;
        this.flush();
      },
      onError: (error) => { if (!this.closed) this.fail(/^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'UPSTREAM_ERROR'); }
    };
    response.on('drain', this.onDrain);
    response.on('finish', this.onFinish);
    response.on('close', this.onClose);
    response.on('error', this.onError);
  }

  close(outcome: MirrorOutcome) {
    if (this.closed) return;
    this.closed = true;
    this.pending = [];
    this.pendingBytes = 0;
    const response = this.response;
    response.off('drain', this.onDrain);
    response.off('finish', this.onFinish);
    response.off('close', this.onClose);
    response.off('error', this.onError);
    if (outcome.success || response.destroyed || response.writableFinished) return;
    if (response.headersSent) { response.destroy(); return; }
    // 头部元数据到达不等于已发到浏览器；JSON 错误不能沿用上游 Content-Length/Encoding。
    for (const key of response.getHeaderNames()) if (RESPONSE_HEADERS.has(key.toLowerCase())) response.removeHeader(key);
    response.setHeader('Cache-Control', 'no-store');
    try { response.status(outcome.statusCode ?? 502).json({ message: outcome.message ?? '镜像请求未完成', code: outcome.code ?? 'UPSTREAM_ERROR' }); }
    catch { response.destroy(); }
  }

  private readonly onDrain = () => { this.blocked = false; this.flush(); };
  private readonly onFinish = () => {
    if (!this.closed && this.upstreamEnded) this.settle({ success: true, statusCode: this.response.statusCode });
  };
  private readonly onClose = () => {
    if (!this.closed) this.settle({ success: false, statusCode: this.response.statusCode, code: 'CLIENT_DISCONNECTED' });
  };
  private readonly onError = () => { if (!this.closed) this.fail('CLIENT_ERROR'); };

  private fail(code: string) { this.settle({ success: false, statusCode: 502, code }); }

  private onHeaders(headers: Parameters<MirrorStreamHandlers['onHeaders']>[0]) {
    if (this.closed || this.upstreamEnded) return;
    if (this.headersReceived || !Number.isInteger(headers.statusCode) || headers.statusCode < 200 || headers.statusCode > 599) { this.fail('INVALID_RESPONSE'); return; }
    if (this.method !== 'HEAD' && (headers.contentLength ?? 0) > MAX_MIRROR_RESPONSE_BYTES) { this.fail('RESPONSE_TOO_LARGE'); return; }
    this.headersReceived = true;
    this.finalHost = /^[a-zA-Z0-9.:[\]-]{1,253}$/.test(headers.finalHost) ? headers.finalHost : 'unknown';
    this.response.statusCode = headers.statusCode;
    const entries = Object.entries(headers.headers).map(([key, value]) => [key.toLowerCase(), value] as const);
    const nominated = new Set(entries.filter(([key]) => key === 'connection').flatMap(([, value]) => value.toLowerCase().split(',').map((part) => part.trim())));
    try {
      for (const [key, value] of entries) if (RESPONSE_HEADERS.has(key) && !nominated.has(key)) this.response.setHeader(key, value);
    } catch { this.fail('INVALID_RESPONSE'); }
  }

  private onChunk(chunk: Buffer) {
    if (this.closed || this.upstreamEnded) return;
    if (this.response.destroyed) { this.onClose(); return; }
    if (!this.headersReceived) { this.fail('INVALID_RESPONSE'); return; }
    if (this.method === 'HEAD' || [204, 304].includes(this.response.statusCode) || !chunk.length) return;
    if (this.bytesSent + this.pendingBytes + chunk.length > MAX_MIRROR_RESPONSE_BYTES) { this.fail('RESPONSE_TOO_LARGE'); return; }
    if (this.response.writableLength + this.pendingBytes + chunk.length > MAX_PENDING_BYTES || this.pending.length >= MAX_PENDING_CHUNKS) { this.fail('SLOW_CONSUMER'); return; }
    // Gateway 分片是原 WS 帧的视图；独立分配可避免小分片长期保留大帧或共享内存池。
    const owned = Buffer.allocUnsafeSlow(chunk.length);
    chunk.copy(owned);
    chunk = owned;
    if (this.blocked) { this.pending.push(chunk); this.pendingBytes += chunk.length; }
    else this.write(chunk);
  }

  private write(chunk: Buffer) {
    try {
      this.blocked = !this.response.write(chunk);
      this.bytesSent += chunk.length;
      if (this.response.writableLength + this.pendingBytes > MAX_PENDING_BYTES) this.fail('SLOW_CONSUMER');
    }
    catch { this.fail('CLIENT_ERROR'); }
  }

  private flush() {
    if (this.closed) return;
    while (!this.closed && !this.blocked && this.pending.length) {
      const chunk = this.pending.shift()!;
      this.pendingBytes -= chunk.length;
      this.write(chunk);
    }
    if (!this.closed && this.upstreamEnded && !this.pending.length && !this.blocked) {
      try { this.response.end(); } catch { this.fail('CLIENT_ERROR'); }
    }
  }
}
