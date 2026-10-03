import { ClientKernelsService } from '../client-kernels/client-kernels.service';
import { MihomoExecutor } from './executors/mihomo.executor';
import { SingboxExecutor } from './executors/singbox.executor';
import { ProbeService } from './probe.service';
import type { ProbeConnectionRequest } from './probe.types';

const request: ProbeConnectionRequest = { subjectType: 'UPSTREAM_NODE', subjectId: 'node', configHash: 'hash', routeKind: 'UPSTREAM_DIRECT', connection: { protocolType: 'HTTP', serverHost: '1.1.1.1', serverPort: 443, params: { username: 'secret-user', password: 'secret-password' } } };
const target = { id: 'target', url: 'https://1.1.1.1/204', expectedStatus: 204 };
const socks = { ...request, connection: { ...request.connection, protocolType: 'SOCKS', params: { version: '4a' } } };
describe('ordinary latency and internal strict measurement', () => {
  afterEach(() => jest.restoreAllMocks());
  it('never falls back on missing Mihomo and never publishes credentials', async () => {
    const kernels = new ClientKernelsService();
    const resolve = jest.spyOn(kernels, 'resolve').mockResolvedValue(null);
    const result = await new ProbeService(kernels).executeBatch([request], target, 500, 'MIHOMO_PREFERRED');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('MIHOMO');
    expect(result[0]).toMatchObject({ schemaVersion: 2, measurement: 'MIHOMO_URL_TEST', status: 'ENVIRONMENT_UNAVAILABLE', errorCode: 'KERNEL_UNAVAILABLE', latencyMs: null });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('ordinary success uses URLTest only while strict execution remains internal', async () => {
    const kernels = new ClientKernelsService();
    jest.spyOn(kernels, 'resolve').mockResolvedValue({ path: 'unused', version: '1.19.30' });
    const latency = jest.spyOn(MihomoExecutor.prototype, 'executeLatency').mockResolvedValue([{ errorCode: null, latencyMs: 12, stage: 'DIAL_HTTP', durationMs: 1 }]);
    const strict = jest.spyOn(MihomoExecutor.prototype, 'execute').mockResolvedValue([{ errorCode: null, latencyMs: 25, stage: 'DIAL_HTTP', durationMs: 1 }]);
    const fallback = jest.spyOn(SingboxExecutor.prototype, 'execute');
    const service = new ProbeService(kernels);
    expect((await service.executeBatch([request], target, 500))[0]).toMatchObject({ schemaVersion: 2, measurement: 'MIHOMO_URL_TEST', status: 'SUCCESS', latencyMs: 12, fallbackReason: null });
    expect(latency).toHaveBeenCalledTimes(1); expect(strict).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
    expect((await service.executeStrictBatch([request], target, 500))[0]).toMatchObject({ schemaVersion: 1, measurement: 'PROXY_HTTP_DELAY', status: 'SUCCESS', latencyMs: 25 });
    expect(strict).toHaveBeenCalledTimes(1);
  });
  it('ordinary unsupported combinations never use the legacy capability fallback', async () => {
    const kernels = new ClientKernelsService();
    const resolve = jest.spyOn(kernels, 'resolve');
    const fallback = jest.spyOn(SingboxExecutor.prototype, 'execute');
    expect((await new ProbeService(kernels).executeBatch([socks], target, 500, 'MIHOMO_PREFERRED'))[0]).toMatchObject({ status: 'UNSUPPORTED', engine: null, fallbackReason: null, latencyMs: null });
    expect(resolve).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
  });
  it.each(['DIAL_FAILED', 'KERNEL_CONFIG_INVALID', 'NETWORK_TIMEOUT', 'URLTEST_FAILED'])('ordinary %s never falls back to strict or Sing-box', async (errorCode) => {
    const kernels = new ClientKernelsService();
    jest.spyOn(kernels, 'resolve').mockResolvedValue({ path: 'unused', version: '1.19.30' });
    jest.spyOn(MihomoExecutor.prototype, 'executeLatency').mockResolvedValue([{ errorCode, latencyMs: null, stage: 'DIAL_HTTP', durationMs: 1 }]);
    const strict = jest.spyOn(MihomoExecutor.prototype, 'execute');
    const fallback = jest.spyOn(SingboxExecutor.prototype, 'execute');
    const result = await new ProbeService(kernels).executeBatch([request], target, 500, 'MIHOMO_PREFERRED');
    expect(result[0]).toMatchObject({ engine: 'MIHOMO', errorCode, latencyMs: null });
    expect(strict).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
  });
  it('internal strict capability fallback still records the actual engine', async () => {
    const kernels = new ClientKernelsService();
    jest.spyOn(kernels, 'resolve').mockResolvedValue({ path: 'unused', version: '1.14.0' });
    jest.spyOn(SingboxExecutor.prototype, 'execute').mockResolvedValue({ errorCode: null, latencyMs: 7, stage: 'DIAL_HTTP', durationMs: 10 });
    const result = await new ProbeService(kernels).executeStrictBatch([socks], target, 500, 'MIHOMO_PREFERRED');
    expect(result[0]).toMatchObject({ schemaVersion: 1, measurement: 'PROXY_HTTP_DELAY', status: 'SUCCESS', engine: 'SINGBOX', mihomoCompatibility: 'UNSUPPORTED', fallbackReason: 'MIHOMO_SOCKS_VERSION_UNSUPPORTED', latencyMs: 7 });
    expect((await new ProbeService(kernels).executeStrictBatch([socks], target, 500, 'MIHOMO_ONLY'))[0].status).toBe('UNSUPPORTED');
  });
  it('pre-aborted batches are canceled; private upstream flags and private targets remain rejected', async () => {
    const kernels = new ClientKernelsService();
    const controller = new AbortController(); controller.abort();
    const service = new ProbeService(kernels);
    expect((await service.executeBatch([request], target, 500, 'MIHOMO_ONLY', controller.signal))[0].status).toBe('CANCELED');
    const privateRequest = { ...request, allowPrivateEndpoint: true, connection: { ...request.connection, serverHost: '127.0.0.1' } };
    expect((await service.executeBatch([privateRequest], target, 500))[0].errorCode).toBe('ADDRESS_POLICY_REJECTED');
    expect((await service.executeBatch([request], { ...target, url: 'http://127.0.0.1/204' }, 500))[0].errorCode).toBe('ADDRESS_POLICY_REJECTED');
  });
  it('refuses oversized batches and invalid timeout budgets', async () => {
    const service = new ProbeService(new ClientKernelsService());
    await expect(service.executeBatch(Array.from({ length: 33 }, () => request), target, 500)).rejects.toThrow('BATCH_TOO_LARGE');
    await expect(service.executeBatch([request], target, 499)).rejects.toThrow('INVALID_TIMEOUT');
  });
});
