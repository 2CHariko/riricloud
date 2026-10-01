import { ClientKernelsService, type ResolvedClientKernel } from '../../client-kernels/client-kernels.service';
import { KernelExecutionError, ManagedKernelProcess, probeConnectionSlots } from '../../client-kernels/kernel-process';
import { compileSingboxClient } from '../../subscription/compilers/singbox-client';
import type { ProxyConnection } from '../../common/proxy-connection';
import type { PinnedProbeTarget } from '../probe-target-policy';
import { executionFailure, portReady, type ProbeExecution } from './mihomo.executor';
import { proxyHttpDelay, reserveLoopbackPort, waitForKernel } from './proxy-http';

export class SingboxExecutor {
  constructor(private readonly kernels: ClientKernelsService) {}
  async execute(connection: ProxyConnection, target: PinnedProbeTarget, timeoutMs: number, kernel: ResolvedClientKernel, signal?: AbortSignal): Promise<ProbeExecution> {
    const started = Date.now();
    let child: ManagedKernelProcess | undefined;
    let release: (() => void) | undefined;
    let stage: ProbeExecution['stage'] = 'START_KERNEL';
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    let crashed = false;
    let startupExpired = false;
    const startupTimer = setTimeout(() => { startupExpired = true; controller.abort(); }, 5_000);
    try {
      if (connection.protocolType === 'NAIVE' && !await this.kernels.supportsNaive(kernel)) throw new KernelExecutionError('NAIVE_ENVIRONMENT_UNAVAILABLE');
      const port = await reserveLoopbackPort();
      const content = JSON.stringify({
        log: { disabled: true },
        inbounds: [{ type: 'mixed', tag: 'probe-in', listen: '127.0.0.1', listen_port: port }],
        outbounds: [compileSingboxClient(connection, 'probe-out')],
        route: { final: 'probe-out' }
      });
      const check = await this.kernels.validate('SINGBOX', content, 'FULL', controller.signal);
      if (signal?.aborted) throw new KernelExecutionError('CANCELED');
      if (check.status !== 'PASSED') throw new KernelExecutionError(connection.protocolType === 'NAIVE' ? 'NAIVE_ENVIRONMENT_UNAVAILABLE' : check.status === 'UNAVAILABLE' ? 'KERNEL_UNAVAILABLE' : 'KERNEL_CONFIG_INVALID');
      child = await ManagedKernelProcess.start(kernel.path, (file, directory) => ['run', '-D', directory, '-c', file], content, controller.signal, 5_000 + timeoutMs + 2_000);
      await waitForKernel(child, () => portReady(port, controller.signal), controller.signal);
      clearTimeout(startupTimer);
      void child.exited.then(() => { crashed = true; controller.abort(); });
      stage = 'DIAL_HTTP';
      release = await probeConnectionSlots.acquire(controller.signal);
      const latencyMs = await proxyHttpDelay(port, target, timeoutMs, controller.signal);
      return { latencyMs, errorCode: null, stage, durationMs: Date.now() - started };
    } catch (error) { return executionFailure(startupExpired ? new KernelExecutionError('KERNEL_START_TIMEOUT') : crashed ? new KernelExecutionError('KERNEL_EXITED') : error, stage, started, signal); }
    finally { clearTimeout(startupTimer); signal?.removeEventListener('abort', abort); controller.abort(); release?.(); await child?.stop(); }
  }
}
