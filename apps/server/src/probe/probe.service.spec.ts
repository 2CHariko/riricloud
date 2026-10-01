import { ClientKernelsService } from '../client-kernels/client-kernels.service';
import { MihomoExecutor } from './executors/mihomo.executor';
import { SingboxExecutor } from './executors/singbox.executor';
import { ProbeService } from './probe.service';
import type { ProbeConnectionRequest } from './probe.types';

const request: ProbeConnectionRequest = { subjectType: 'UPSTREAM_NODE', subjectId: 'node', configHash: 'hash', routeKind: 'UPSTREAM_DIRECT', connection: { protocolType: 'HTTP', serverHost: '1.1.1.1', serverPort: 443, params: { username: 'secret-user', password: 'secret-password' } } };
const target = { id: 'target', url: 'https://1.1.1.1/204', expectedStatus: 204 };
describe('shared probe service selection and safe results', () => {
  afterEach(() => jest.restoreAllMocks());
  it('never falls back on missing Mihomo and never publishes credentials', async () => {
    const kernels = new ClientKernelsService();
    const resolve = jest.spyOn(kernels, 'resolve').mockResolvedValue(null);
    const result = await new ProbeService(kernels).executeBatch([request], target, 500, 'MIHOMO_PREFERRED');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('MIHOMO');
    expect(result[0]).toMatchObject({ status: 'ENVIRONMENT_UNAVAILABLE', errorCode: 'KERNEL_UNAVAILABLE', latencyMs: null });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('network, config and native errors do not become compatibility fallback candidates', async () => {
    const kernels = new ClientKernelsService();
    jest.spyOn(kernels, 'resolve').mockResolvedValue({ path: 'unused', version: '1.19.30' });
    jest.spyOn(MihomoExecutor.prototype, 'execute').mockResolvedValue([{ errorCode: 'DIAL_FAILED', latencyMs: null, stage: 'DIAL_HTTP', durationMs: 1 }]);
    const fallback = jest.spyOn(SingboxExecutor.prototype, 'execute');
    const result = await new ProbeService(kernels).executeBatch([request], target, 500, 'MIHOMO_PREFERRED');
    expect(result[0]).toMatchObject({ engine: 'MIHOMO', status: 'ERROR', errorCode: 'DIAL_FAILED' });
    expect(fallback).not.toHaveBeenCalled();
  });
  it('explicit whitelisted capability fallback records the actual engine and compatibility', async () => {
    const kernels = new ClientKernelsService();
    jest.spyOn(kernels, 'resolve').mockResolvedValue({ path: 'unused', version: '1.14.0' });
    jest.spyOn(SingboxExecutor.prototype, 'execute').mockResolvedValue({ errorCode: null, latencyMs: 7, stage: 'DIAL_HTTP', durationMs: 10 });
    const socks = { ...request, connection: { ...request.connection, protocolType: 'SOCKS', params: { version: '4a' } } };
    const result = await new ProbeService(kernels).executeBatch([socks], target, 500, 'MIHOMO_PREFERRED');
    expect(result[0]).toMatchObject({ status: 'SUCCESS', engine: 'SINGBOX', mihomoCompatibility: 'UNSUPPORTED', fallbackReason: 'MIHOMO_SOCKS_VERSION_UNSUPPORTED', latencyMs: 7 });
    expect((await new ProbeService(kernels).executeBatch([socks], target, 500, 'MIHOMO_ONLY'))[0].status).toBe('UNSUPPORTED');
  });
  it('pre-aborted batches are uniformly canceled and private upstream flags cannot bypass policy', async () => {
    const kernels = new ClientKernelsService();
    const controller = new AbortController(); controller.abort();
    const service = new ProbeService(kernels);
    expect((await service.executeBatch([request], target, 500, 'MIHOMO_ONLY', controller.signal))[0].status).toBe('CANCELED');
    const privateRequest = { ...request, allowPrivateEndpoint: true, connection: { ...request.connection, serverHost: '127.0.0.1' } };
    expect((await service.executeBatch([privateRequest], target, 500, 'MIHOMO_ONLY'))[0].errorCode).toBe('ADDRESS_POLICY_REJECTED');
  });
  it('refuses oversized batches and invalid timeout budgets', async () => {
    const service = new ProbeService(new ClientKernelsService());
    await expect(service.executeBatch(Array.from({ length: 33 }, () => request), target, 500, 'MIHOMO_ONLY')).rejects.toThrow('BATCH_TOO_LARGE');
    await expect(service.executeBatch([request], target, 499, 'MIHOMO_ONLY')).rejects.toThrow('INVALID_TIMEOUT');
  });
});
