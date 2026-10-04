// Web 前端统一日志与异常上报 SDK（守卫安全红线，敏感数据强脱敏）

export type FrontendLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface FrontendLogPayload {
  level: FrontendLogLevel;
  message: string;
  module?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}

const SENSITIVE_KEY_PATTERN = /(password|token|secret|authorization|credential|cookie|jwt|hash|uuid)/i;

function maskValue(val: unknown, depth = 0, seen = new WeakSet<object>(), budget = { remaining: 200 }): unknown {
  if (--budget.remaining < 0) return '[Truncated]';
  if (typeof val === 'string') {
    return val.replace(/(Bearer\s+)[^\s,;"']+/gi, '$1***')
      .replace(/([?&](?:token|password|secret|key)=)([^&\s]+)/gi, '$1***').slice(0, 4000);
  }
  if (val && typeof val === 'object') {
    if (depth >= 6 || seen.has(val)) return '[Truncated]';
    seen.add(val);
    if (Array.isArray(val)) return val.slice(0, 50).map((item) => maskValue(item, depth + 1, seen, budget));
    const res: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(val).slice(0, 50)) {
      res[key.slice(0, 128)] = SENSITIVE_KEY_PATTERN.test(key) ? '***' : maskValue(value, depth + 1, seen, budget);
    }
    return res;
  }
  return typeof val === 'bigint' ? String(val) : val;
}

export class FrontendLogger {
  private buffer: Array<{ log: FrontendLogPayload; attempts: number }> = [];
  private timer: number | null = null;
  private isInitialized = false;
  private sending = false;
  private inFlightEntries = 0;
  private transport?: (logs: FrontendLogPayload[]) => Promise<{ status: number }>;
  private counters = { retries: 0, dropped: 0, persistenceFailures: 0, delivered: 0, beaconQueued: 0 };

  setTransport(transport: (logs: FrontendLogPayload[]) => Promise<{ status: number }>): void {
    this.transport = transport;
  }

  getStats() { return { ...this.counters, pendingEntries: this.buffer.length, inFlightEntries: this.inFlightEntries }; }

  private schedule(delay = 2000): void {
    if (!this.timer && this.buffer.length) this.timer = window.setTimeout(() => { this.timer = null; void this.flush(); }, delay);
  }
  init(): void {
    if (this.isInitialized || typeof window === 'undefined') {
      return;
    }
    this.isInitialized = true;

    // 1. 全局捕获未处理 JS 错误
    window.addEventListener('error', (event) => {
      this.error(
        event.message || 'Window Script Error',
        'GlobalError',
        {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          stack: event.error?.stack,
          url: window.location.href
        }
      );
    });

    // 2. 全局捕获未处理 Promise 拒绝
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      const msg = reason instanceof Error ? reason.message : String(reason || 'Unhandled Promise Rejection');
      const stack = reason instanceof Error ? reason.stack : undefined;
      this.error(
        msg,
        'UnhandledRejection',
        {
          stack,
          url: window.location.href
        }
      );
    });

    // 3. 页面卸载前尝试通过 sendBeacon 冲刷剩余日志
    window.addEventListener('beforeunload', () => {
      this.flushBeacon();
    });
  }

  log(level: FrontendLogLevel, message: string, module = 'App', metadata?: Record<string, unknown>, traceId?: string): void {
    let sanitizedMetadata: Record<string, unknown>;
    try {
      sanitizedMetadata = maskValue({ ...metadata, pageUrl: window.location.href }) as Record<string, unknown>;
      if (new Blob([JSON.stringify(sanitizedMetadata)]).size > 4000) sanitizedMetadata = { truncated: true };
    } catch { sanitizedMetadata = { unavailable: true }; }

    if (this.buffer.length >= 100) {
      this.buffer.shift();
      this.counters.dropped++;
    }
    this.buffer.push({ attempts: 0, log: {
      level,
      message: String(maskValue(message)).slice(0, 4000),
      module: module.slice(0, 128),
      traceId: traceId?.slice(0, 128),
      metadata: sanitizedMetadata
    } });
    if (this.buffer.length >= 10 && !this.sending && !this.timer) void this.flush();
    else if (!this.sending) this.schedule();
  }

  info(message: string, module?: string, metadata?: Record<string, unknown>, traceId?: string): void {
    this.log('INFO', message, module, metadata, traceId);
  }

  warn(message: string, module?: string, metadata?: Record<string, unknown>, traceId?: string): void {
    this.log('WARN', message, module, metadata, traceId);
  }

  error(message: string, module?: string, metadata?: Record<string, unknown>, traceId?: string): void {
    this.log('ERROR', message, module, metadata, traceId);
  }

  async flush(): Promise<void> {
    if (this.sending) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.buffer.length) return;
    if (!this.transport) { this.schedule(); return; }
    this.sending = true;
    const batch = this.buffer.splice(0, 10);
    this.inFlightEntries = batch.length;
    let delay = 2000;
    try {
      const response = await this.transport(batch.map((entry) => entry.log));
      if (!(response.status >= 200 && response.status < 300)) throw new Error('LOG_UPLOAD_HTTP_FAILURE');
      // HTTP 成功只表示接收，不宣称日志已持久化。
      this.counters.delivered += batch.length;
    } catch {
      this.counters.persistenceFailures++;
      const retry = batch.filter((entry) => {
        entry.attempts++;
        if (entry.attempts <= 3) { this.counters.retries++; return true; }
        this.counters.dropped++;
        return false;
      });
      this.buffer = [...retry, ...this.buffer];
      if (this.buffer.length > 100) {
        this.counters.dropped += this.buffer.length - 100;
        this.buffer = this.buffer.slice(0, 100);
      }
      delay = Math.min(8000, 1000 * 2 ** (batch[0]?.attempts ?? 1));
      // 失败只更新计数，禁止通过 logger 自我上报导致递归。
    } finally {
      this.sending = false;
      this.inFlightEntries = 0;
      this.schedule(delay);
    }
  }

  private flushBeacon(): void {
    if (!this.buffer.length || !navigator.sendBeacon) return;
    const batch = this.buffer.slice(0, 2);
    const blob = new Blob([JSON.stringify({ logs: batch.map((entry) => entry.log) })], { type: 'application/json' });
    if (blob.size > 60_000) return;
    if (navigator.sendBeacon('/api/v1/logs/frontend', blob)) {
      this.buffer.splice(0, batch.length);
      this.counters.beaconQueued += batch.length;
    }
  }
}

export const frontendLogger = new FrontendLogger();
frontendLogger.init();
