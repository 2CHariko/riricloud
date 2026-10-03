import * as http from 'node:http';
import { KernelExecutionError } from '../../client-kernels/kernel-process';
import type { PinnedProbeTarget } from '../probe-target-policy';

// 只请求受管内核的回环控制端口；原始目标 URL 保留域名与 HTTPS 证书验证。
// 固定版本的 delay API 不提供严格 HTTP 状态契约，不能用其结果替代严格诊断。
export async function mihomoUrlTest(port: number, secret: string, name: string, target: PinnedProbeTarget, timeoutMs: number, signal?: AbortSignal): Promise<number> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs + 500);
  try {
    const query = new URLSearchParams({ url: target.url.href, timeout: String(timeoutMs), expected: String(target.expectedStatus) });
    return await new Promise<number>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, method: 'GET', path: `/proxies/${encodeURIComponent(name)}/delay?${query}`, headers: { Authorization: `Bearer ${secret}` }, signal: controller.signal, agent: false, maxHeaderSize: 16_384 }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const failed = () => reject(new KernelExecutionError('URLTEST_RESPONSE_INVALID'));
        res.once('error', failed);
        res.once('aborted', failed);
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16_384) { res.destroy(); failed(); return; }
          chunks.push(chunk);
        });
        res.once('end', () => {
          if (res.statusCode === 504 || res.statusCode === 408) { reject(new KernelExecutionError('NETWORK_TIMEOUT')); return; }
          if (res.statusCode !== 200) { reject(new KernelExecutionError('URLTEST_FAILED')); return; }
          try {
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
            const delay = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).delay : undefined;
            if (typeof delay !== 'number' || !Number.isInteger(delay) || delay <= 0 || delay > 65_535) throw new Error();
            resolve(delay);
          } catch { reject(new KernelExecutionError('URLTEST_RESPONSE_INVALID')); }
        });
      });
      req.once('error', reject);
      req.end();
    });
  } catch (error) {
    if (signal?.aborted) throw new KernelExecutionError('CANCELED');
    if (controller.signal.aborted) throw new KernelExecutionError('NETWORK_TIMEOUT');
    throw error instanceof KernelExecutionError ? error : new KernelExecutionError('URLTEST_FAILED');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
