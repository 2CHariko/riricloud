import { Injectable } from '@nestjs/common';
import { ClientKernelsService } from '../client-kernels/client-kernels.service';
import { KernelExecutionError } from '../client-kernels/kernel-process';
import { getProxyCapabilities } from '../common/proxy-capabilities';
import type { ProxyConnection } from '../common/proxy-connection';
import { MihomoExecutor, type ProbeExecution } from './executors/mihomo.executor';
import { SingboxExecutor } from './executors/singbox.executor';
import { ProbeTargetPolicy, type PinnedProbeTarget } from './probe-target-policy';
import type { ProbeConnectionRequest, ProbeEngine, ProbePolicy, ProbeResult, ProbeTarget } from './probe.types';

@Injectable()
export class ProbeService {
  private readonly mihomo: MihomoExecutor;
  private readonly singbox: SingboxExecutor;
  // 测试可显式注入策略实例；生产 DI 不提供绕过 URL 公网验证的环境开关。
  readonly targetPolicy = new ProbeTargetPolicy();
  constructor(private readonly kernels: ClientKernelsService) {
    this.mihomo = new MihomoExecutor(kernels);
    this.singbox = new SingboxExecutor(kernels);
  }
  async executeBatch(requests: ProbeConnectionRequest[], target: ProbeTarget, timeoutMs: number, policy: ProbePolicy, signal?: AbortSignal, onResult?: (result: ProbeResult) => Promise<void> | void): Promise<ProbeResult[]> {
    if (requests.length > 32) throw new KernelExecutionError('BATCH_TOO_LARGE');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30_000) throw new KernelExecutionError('INVALID_TIMEOUT');
    if (!['MIHOMO_PREFERRED', 'MIHOMO_ONLY'].includes(policy)) throw new KernelExecutionError('INVALID_POLICY');
    if (!requests.length) return [];
    const started = Date.now();
    const results: ProbeResult[] = requests.map((request) => this.result(request, target, started));
    if (signal?.aborted) {
      for (const result of results) this.failure(result, 'CANCELED', 'CANCELED');
      return this.publish(results, onResult);
    }
    const primary: Array<{ index: number; connection: ProxyConnection }> = [];
    const fallback: Array<{ index: number; connection: ProxyConnection }> = [];
    let pinned: PinnedProbeTarget;
    try { pinned = await this.targetPolicy.target(target, signal); }
    catch (error) {
      const code = error instanceof KernelExecutionError ? error.code : 'TARGET_DNS_FAILED';
      for (const result of results) this.failure(result, signal?.aborted ? 'CANCELED' : code);
      return this.publish(results, onResult);
    }
    await Promise.all(requests.map(async (request, index) => {
      const caps = getProxyCapabilities(request.connection);
      results[index].mihomoCompatibility = caps.mihomo.supported ? 'SUPPORTED' : 'UNSUPPORTED';
      if (signal?.aborted) { this.failure(results[index], 'CANCELED'); return; }
      if (caps.mihomo.reason === 'INVALID_CONNECTION') { this.failure(results[index], 'INVALID_CONNECTION'); return; }
      if (!caps.mihomo.supported && (policy === 'MIHOMO_ONLY' || !caps.fallbackAllowed)) { this.failure(results[index], caps.mihomo.reason!, 'UNSUPPORTED'); return; }
      try {
        const controlledManaged = request.subjectType === 'LINE' && request.routeKind !== 'UPSTREAM_DIRECT' && request.allowPrivateEndpoint === true;
        const connection = await this.targetPolicy.connection(request.connection, controlledManaged, signal);
        if (caps.mihomo.supported) primary.push({ index, connection });
        else { results[index].fallbackReason = caps.mihomo.reason; fallback.push({ index, connection }); }
      } catch (error) { this.failure(results[index], error instanceof KernelExecutionError ? error.code : 'ENDPOINT_DNS_FAILED'); }
    }));
    primary.sort((a, b) => a.index - b.index);
    fallback.sort((a, b) => a.index - b.index);
    if (primary.length) {
      const kernel = signal?.aborted ? null : await this.kernels.resolve('MIHOMO');
      if (!kernel) for (const item of primary) this.failure(results[item.index], signal?.aborted ? 'CANCELED' : 'KERNEL_UNAVAILABLE', signal?.aborted ? 'CANCELED' : 'ENVIRONMENT_UNAVAILABLE');
      else {
        const executed = await this.mihomo.execute(primary.map((item) => item.connection), pinned, timeoutMs, kernel, signal);
        primary.forEach((item, index) => this.measurement(results[item.index], executed[index], 'MIHOMO', kernel.version));
      }
    }
    // 主批次彻底退出后才进入显式兼容分支；所有运行错误都不会产生新的回退候选。
    if (fallback.length) {
      const kernel = signal?.aborted ? null : await this.kernels.resolve('SINGBOX');
      for (const item of fallback) {
        if (!kernel || signal?.aborted) { this.failure(results[item.index], signal?.aborted ? 'CANCELED' : 'KERNEL_UNAVAILABLE', signal?.aborted ? 'CANCELED' : 'ENVIRONMENT_UNAVAILABLE'); continue; }
        const executed = await this.singbox.execute(item.connection, pinned, timeoutMs, kernel, signal);
        this.measurement(results[item.index], executed, 'SINGBOX', kernel.version);
      }
    }
    if (signal?.aborted) for (const result of results) this.failure(result, 'CANCELED', 'CANCELED');
    for (const result of results) result.durationMs = Date.now() - started;
    return this.publish(results, onResult);
  }
  private result(request: ProbeConnectionRequest, target: ProbeTarget, started: number): ProbeResult {
    let targetHost = '';
    try { targetHost = new URL(target.url).hostname; } catch { /* 不返回原始 URL 或错误文本 */ }
    return { schemaVersion: 1, subjectType: request.subjectType, subjectId: request.subjectId, status: 'ERROR', errorCode: null, message: '', engine: null, engineVersion: null, fallbackReason: null, mihomoCompatibility: 'UNSUPPORTED', measurement: 'PROXY_HTTP_DELAY', perspective: 'MASTER', routeKind: request.routeKind, targetId: target.id, targetHost, testedAt: new Date(started).toISOString(), durationMs: 0, latencyMs: null, stage: 'VALIDATE', configHash: request.configHash, applied: false };
  }
  private failure(result: ProbeResult, code: string, status?: ProbeResult['status']): void {
    result.status = status ?? (code === 'CANCELED' ? 'CANCELED' : code.endsWith('TIMEOUT') ? 'TIMEOUT' : ['KERNEL_UNAVAILABLE', 'NAIVE_ENVIRONMENT_UNAVAILABLE', 'KERNEL_START_FAILED'].includes(code) ? 'ENVIRONMENT_UNAVAILABLE' : 'ERROR');
    result.errorCode = code; result.message = code; result.latencyMs = null;
  }
  private measurement(result: ProbeResult, executed: ProbeExecution, engine: ProbeEngine, version: string): void {
    result.engine = engine; result.engineVersion = version; result.stage = executed.stage; result.durationMs = executed.durationMs;
    if (executed.errorCode) this.failure(result, executed.errorCode);
    else { result.status = 'SUCCESS'; result.latencyMs = executed.latencyMs; result.message = 'PROXY_HTTP_OK'; result.errorCode = null; }
  }
  private async publish(results: ProbeResult[], onResult?: (result: ProbeResult) => Promise<void> | void): Promise<ProbeResult[]> {
    if (onResult) for (const result of results) await onResult(result);
    return results;
  }
}
