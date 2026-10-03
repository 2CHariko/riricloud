import { randomBytes, randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { ClientKernelsService, type ResolvedClientKernel } from '../../client-kernels/client-kernels.service';
import { KernelExecutionError, ManagedKernelProcess, probeConnectionSlots } from '../../client-kernels/kernel-process';
import { compileMihomoProxy } from '../../subscription/compilers/mihomo-proxy';
import type { ProxyConnection } from '../../common/proxy-connection';
import type { PinnedProbeTarget } from '../probe-target-policy';
import { controllerRequest, proxyHttpDelay, reserveLoopbackPort, waitForKernel } from './proxy-http';
import { KernelReadiness } from './kernel-readiness';
import { mihomoUrlTest } from './mihomo-urltest';

export interface ProbeExecution { latencyMs: number | null; errorCode: string | null; stage: 'START_KERNEL' | 'DIAL_HTTP'; durationMs: number }
export function executionFailure(error: unknown, stage: ProbeExecution['stage'], started: number, signal?: AbortSignal): ProbeExecution {
  return { latencyMs: null, errorCode: signal?.aborted ? 'CANCELED' : error instanceof KernelExecutionError ? error.code : stage === 'START_KERNEL' ? 'KERNEL_START_FAILED' : 'DIAL_FAILED', stage, durationMs: Date.now() - started };
}
export function portReady(port: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(false); return; }
    const socket = connect({ host: '127.0.0.1', port });
    const aborted = () => finish(false);
    const finish = (value: boolean) => { signal?.removeEventListener('abort', aborted); socket.destroy(); resolve(value); };
    signal?.addEventListener('abort', aborted, { once: true });
    socket.setTimeout(250);
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
  });
}
export class MihomoExecutor {
  constructor(private readonly kernels: ClientKernelsService) {}
  async execute(connections: ProxyConnection[], target: PinnedProbeTarget, timeoutMs: number, kernel: ResolvedClientKernel, signal?: AbortSignal): Promise<ProbeExecution[]> {
    return this.run(connections, target, timeoutMs, kernel, false, signal);
  }
  async executeLatency(connections: ProxyConnection[], target: PinnedProbeTarget, timeoutMs: number, kernel: ResolvedClientKernel, signal?: AbortSignal): Promise<ProbeExecution[]> {
    return this.run(connections, target, timeoutMs, kernel, true, signal);
  }
  private async run(connections: ProxyConnection[], target: PinnedProbeTarget, timeoutMs: number, kernel: ResolvedClientKernel, latency: boolean, signal?: AbortSignal): Promise<ProbeExecution[]> {
    if (connections.length > 32) throw new KernelExecutionError('BATCH_TOO_LARGE');
    const started = Date.now();
    let child: ManagedKernelProcess | undefined;
    let stage: ProbeExecution['stage'] = 'START_KERNEL';
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let startupExpired = false;
    const readiness = new KernelReadiness();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      await readiness.listen();
      const readinessPort = await reserveLoopbackPort();
      const controllerPort = await reserveLoopbackPort();
      const secret = randomBytes(32).toString('hex');
      const items = await Promise.all(connections.map(async (connection) => ({ name: randomUUID(), port: await reserveLoopbackPort(), connection })));
      // 业务 listener 固定绑定代理，无 selector/DIRECT 回退；独立回环自检只作启动屏障。
      const config = {
        'allow-lan': false, 'bind-address': '127.0.0.1', mode: 'rule', 'log-level': 'silent',
        'external-controller': `127.0.0.1:${controllerPort}`, secret,
        'geodata-mode': false, 'geo-auto-update': false, 'unified-delay': latency,
        tun: { enable: false }, dns: { enable: false },
        proxies: items.map((item) => compileMihomoProxy(item.connection, item.name)),
        listeners: [...items.map((item) => ({ name: item.name, type: 'mixed', listen: '127.0.0.1', port: item.port, udp: false, proxy: item.name })), { name: 'kernel-readiness', type: 'mixed', listen: '127.0.0.1', port: readinessPort, udp: false, proxy: 'DIRECT' }],
        rules: ['MATCH,REJECT']
      };
      const content = JSON.stringify(config);
      startupTimer = setTimeout(() => { startupExpired = true; controller.abort(); }, 5_000);
      const check = await this.kernels.validate('MIHOMO', content, 'FULL', controller.signal);
      if (controller.signal.aborted) throw new KernelExecutionError('CANCELED');
      if (check.status !== 'PASSED') throw new KernelExecutionError(check.status === 'UNAVAILABLE' ? 'KERNEL_UNAVAILABLE' : 'KERNEL_CONFIG_INVALID');
      child = await ManagedKernelProcess.start(kernel.path, (file, directory) => ['-d', directory, '-f', file], content, controller.signal, 5_000 + Math.ceil(connections.length / 4) * (timeoutMs + (latency ? 500 : 0)) + 2_000);
      await waitForKernel(child, async () => await controllerRequest(controllerPort, secret, controller.signal) && await readiness.ready(readinessPort, controller.signal) && (await Promise.all(items.map((item) => portReady(item.port, controller.signal)))).every(Boolean), controller.signal);
      clearTimeout(startupTimer);
      let crashed = false;
      void child.exited.then(() => { crashed = true; controller.abort(); });
      stage = 'DIAL_HTTP';
      const results = await Promise.all(items.map(async (item) => {
        let release: (() => void) | undefined;
        const itemStarted = Date.now();
        try {
          release = await probeConnectionSlots.acquire(controller.signal);
          const latencyMs = latency ? await mihomoUrlTest(controllerPort, secret, item.name, target, timeoutMs, controller.signal) : await proxyHttpDelay(item.port, target, timeoutMs, controller.signal);
          return { latencyMs, errorCode: null, stage, durationMs: Date.now() - itemStarted };
        } catch (error) { return executionFailure(crashed ? new KernelExecutionError('KERNEL_EXITED') : error, stage, itemStarted, crashed ? signal : controller.signal); }
        finally { release?.(); }
      }));
      if (signal?.aborted) return connections.map(() => executionFailure(new KernelExecutionError('CANCELED'), stage, started, signal));
      return results.map((result) => ({ ...result, durationMs: Date.now() - started }));
    } catch (error) { return connections.map(() => executionFailure(startupExpired ? new KernelExecutionError('KERNEL_START_TIMEOUT') : error, stage, started, signal)); }
    finally { clearTimeout(startupTimer); signal?.removeEventListener('abort', abort); controller.abort(); await child?.stop(); await readiness.close(); }
  }
}
