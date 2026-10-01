import * as http from 'node:http';
import * as https from 'node:https';
import * as tls from 'node:tls';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { KernelExecutionError, type ManagedKernelProcess } from '../../client-kernels/kernel-process';
import type { PinnedProbeTarget } from '../probe-target-policy';

export async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new KernelExecutionError('PORT_UNAVAILABLE')); return; }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}
export async function controllerRequest(port: number, secret: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/version', headers: { Authorization: `Bearer ${secret}` }, signal, timeout: 250, agent: false }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.once('error', () => resolve(false));
    req.once('timeout', () => req.destroy());
    req.end();
  });
}
export async function waitForKernel(child: ManagedKernelProcess, ready: () => Promise<boolean>, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 5_000;
  let exited = false;
  void child.exited.then(() => { exited = true; });
  while (Date.now() < deadline && !exited) {
    if (signal?.aborted) throw new KernelExecutionError('CANCELED');
    if (await ready()) return;
    try { await sleep(40, undefined, { signal }); } catch { throw new KernelExecutionError('CANCELED'); }
  }
  throw new KernelExecutionError(signal?.aborted ? 'CANCELED' : exited ? 'KERNEL_START_FAILED' : 'KERNEL_START_TIMEOUT');
}
function endpoint(address: string, port: number): string { return `${address.includes(':') ? `[${address}]` : address}:${port}`; }

// 用 Node 标准 HTTP CONNECT 与 TLS/HTTP 客户端，不维护手写响应解析器。
// 固定目标 IP，Host/SNI 保留原始域名，禁重定向、不读取系统代理、默认验证证书。
export async function proxyHttpDelay(port: number, target: PinnedProbeTarget, timeoutMs: number, signal?: AbortSignal): Promise<number> {
  const controller = new AbortController();
  const externalAbort = () => controller.abort();
  signal?.addEventListener('abort', externalAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  let tunnel: import('node:net').Socket | undefined;
  let agent: http.Agent | undefined;
  try {
    const targetPort = Number(target.url.port || (target.url.protocol === 'https:' ? 443 : 80));
    const socket = await new Promise<import('node:net').Socket>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, method: 'CONNECT', path: endpoint(target.address, targetPort), signal: controller.signal, agent: false });
      req.once('connect', (res, socket, head) => {
        if (res.statusCode !== 200 || head.length) { socket.destroy(); reject(new KernelExecutionError('DIAL_FAILED')); } else resolve(socket);
      });
      req.once('error', reject);
      req.end();
    });
    tunnel = socket;
    controller.signal.addEventListener('abort', () => tunnel?.destroy(), { once: true });
    if (target.url.protocol === 'https:') {
      const secure = tls.connect({ socket, servername: target.url.hostname.replace(/^\[|\]$/g, ''), rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
      tunnel = secure;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { secure.removeListener('secureConnect', ready); secure.removeListener('error', failed); secure.removeListener('close', closed); controller.signal.removeEventListener('abort', aborted); };
        const ready = () => { cleanup(); resolve(); };
        const failed = (error: Error) => { cleanup(); reject(error); };
        const closed = () => failed(new KernelExecutionError('DIAL_FAILED'));
        const aborted = () => failed(new KernelExecutionError('NETWORK_TIMEOUT'));
        secure.once('secureConnect', ready); secure.once('error', failed); secure.once('close', closed);
        controller.signal.addEventListener('abort', aborted, { once: true });
        if (controller.signal.aborted) aborted();
      });
      agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
    } else agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = () => tunnel!;
    await new Promise<void>((resolve, reject) => {
      const options: http.RequestOptions = { hostname: target.url.hostname.replace(/^\[|\]$/g, ''), port: targetPort, path: `${target.url.pathname}${target.url.search}`, agent };
      const req = (target.url.protocol === 'https:' ? https : http).request({ ...options, method: 'GET', signal: controller.signal, headers: { Host: target.url.host, Connection: 'close', 'User-Agent': 'RiriCloud-Probe' }, maxHeaderSize: 16_384 }, (res) => {
        const status = res.statusCode;
        res.destroy();
        if (status === target.expectedStatus) resolve(); else reject(new KernelExecutionError('UNEXPECTED_HTTP_STATUS'));
      });
      req.once('error', reject);
      req.end();
    });
    return Math.max(1, Math.round(performance.now() - started));
  } catch (error) {
    if (signal?.aborted) throw new KernelExecutionError('CANCELED');
    if (controller.signal.aborted) throw new KernelExecutionError('NETWORK_TIMEOUT');
    throw error instanceof KernelExecutionError ? error : new KernelExecutionError('DIAL_FAILED');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', externalAbort); agent?.destroy(); tunnel?.destroy();
  }
}
