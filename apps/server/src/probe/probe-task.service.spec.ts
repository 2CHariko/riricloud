import { ProbeTaskService } from './probe-task.service';
import { ProbeResourceService } from './probe-resource.service';
import { ProbeService } from './probe.service';
import { SettingsService } from '../system/settings.service';
import type { ProbeResult } from './probe.types';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
describe('异步端到端探针任务', () => {
  function setup(ids = ['n1']) {
    const resources = {
      reserve: jest.fn().mockReturnValue(1), release: jest.fn(),
      listIds: jest.fn().mockResolvedValue(ids),
      snapshot: jest.fn(async (subjectType: string, subjectId: string) => ({ request: { subjectType, subjectId, configHash: 'hash', routeKind: 'UPSTREAM_DIRECT', connection: { protocolType: 'HTTP', serverHost: 'example.com', serverPort: 80, params: {} } }, version: 'v' })),
      persist: jest.fn().mockResolvedValue(true)
    };
    const engine = { executeBatch: jest.fn().mockImplementation(() => new Promise(() => undefined)) };
    const settings = { getSettings: jest.fn().mockResolvedValue({ lineSpeedtestTargetUrl: 'https://example.com/generate_204', lineSpeedtestTimeoutMs: 3000 }) };
    const service = new ProbeTaskService(resources as unknown as ProbeResourceService, engine as unknown as ProbeService, settings as unknown as SettingsService);
    return { service, resources, engine, settings };
  }
  it('返回任务而不是等待网络；相同目标与策略重复请求去重', async () => {
    const { service, engine } = setup();
    const first = await service.start('admin', 'UPSTREAM_NODE', { id: 'n1' });
    const second = await service.start('admin', 'UPSTREAM_NODE', { id: 'n1' });
    expect(first).toEqual({ taskId: expect.any(String), state: 'QUEUED', total: 1 });
    expect(second.taskId).toBe(first.taskId);
    await flush();
    expect(engine.executeBatch).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ expectedStatus: 204 }), 3000, 'MIHOMO_PREFERRED', expect.any(AbortSignal), expect.any(Function));
    service.onModuleDestroy();
  });
  it('取消幂等，不允许晚到成功覆盖结果', async () => {
    const { service, engine, resources } = setup();
    let finish!: (results: ProbeResult[]) => void;
    engine.executeBatch.mockImplementation(() => new Promise<ProbeResult[]>((resolve) => { finish = resolve; }));
    const { taskId } = await service.start('admin', 'UPSTREAM_NODE', { id: 'n1' });
    await flush();
    expect(service.cancel(taskId).state).toBe('CANCELED');
    expect(service.cancel(taskId).state).toBe('CANCELED');
    finish([{ subjectId: 'n1', status: 'SUCCESS' } as ProbeResult]);
    await flush();
    expect(resources.persist).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });
  it('超过一万资源明确拒绝，分页不能超 200', async () => {
    const { service } = setup(Array.from({ length: 10001 }, (_, i) => String(i)));
    await expect(service.start('admin', 'UPSTREAM_NODE', {})).rejects.toThrow();
    expect(() => service.results('unknown', 1, 201)).toThrow();
    service.onModuleDestroy();
  });
  it('每位管理员最多两个不同活动任务', async () => {
    const { service, resources } = setup();
    await service.start('admin', 'UPSTREAM_NODE', { id: 'n1' });
    resources.listIds.mockResolvedValue(['n2']);
    await service.start('admin', 'UPSTREAM_NODE', { id: 'n2' });
    resources.listIds.mockResolvedValue(['n3']);
    await expect(service.start('admin', 'UPSTREAM_NODE', { id: 'n3' })).rejects.toThrow();
    service.onModuleDestroy();
  });
  it('关闭兼容回退设置后执行 MIHOMO_ONLY；不可用单资源返回 SKIPPED', async () => {
    const { service, resources, settings, engine } = setup();
    settings.getSettings.mockResolvedValue({ lineSpeedtestTargetUrl: 'https://example.com/generate_204', lineSpeedtestTimeoutMs: 3000, probeSingboxFallbackEnabled: false } as never);
    resources.snapshot.mockResolvedValue(null as never);
    const { taskId } = await service.start('admin', 'UPSTREAM_NODE', { id: 'n1' });
    await flush();
    expect(service.summary(taskId)).toMatchObject({ state: 'COMPLETED', skipped: 1 });
    expect(service.results(taskId).data[0].status).toBe('SKIPPED');
    resources.snapshot.mockImplementation(async (subjectType: string, subjectId: string) => ({ request: { subjectType, subjectId, configHash: 'hash', routeKind: 'UPSTREAM_DIRECT', connection: { protocolType: 'HTTP', serverHost: 'example.com', serverPort: 80, params: {} } }, version: 'v' }));
    await service.start('admin', 'UPSTREAM_NODE', { id: 'n1' });
    await flush();
    expect(engine.executeBatch.mock.calls[0][3]).toBe('MIHOMO_ONLY');
    service.onModuleDestroy();
  });
  it('30 分钟任务截止，15 分钟后结果过期清理', async () => {
    jest.useFakeTimers();
    const { service } = setup();
    service.onModuleInit();
    const { taskId } = await service.start('admin', 'UPSTREAM_NODE', { id: 'n1' });
    await jest.advanceTimersByTimeAsync(30 * 60_000);
    expect(service.summary(taskId).state).toBe('FAILED');
    await jest.advanceTimersByTimeAsync(15 * 60_000);
    expect(() => service.summary(taskId)).toThrow();
    service.onModuleDestroy();
    jest.useRealTimers();
  });
  it('大任务按 32 个一批，完成结果仅写入一次并安全标记 STALE', async () => {
    const ids = Array.from({ length: 65 }, (_, i) => `n${i}`);
    const { service, resources, engine } = setup(ids);
    resources.persist.mockResolvedValue(false);
    engine.executeBatch.mockImplementation(async (requests, target, _timeout, _policy, _signal, publish) => {
      const results = requests.map((request: { subjectId: string; configHash: string }) => ({ schemaVersion: 1, subjectType: 'UPSTREAM_NODE', subjectId: request.subjectId, status: 'SUCCESS', engine: 'MIHOMO', routeKind: 'UPSTREAM_DIRECT', measurement: 'PROXY_HTTP_DELAY', perspective: 'MASTER', testedAt: new Date().toISOString(), configHash: request.configHash, stage: 'DIAL_HTTP', targetId: target.id, latencyMs: 10 }));
      for (const result of results) await publish(result);
      return results;
    });
    const { taskId } = await service.start('admin', 'UPSTREAM_NODE', {});
    for (let index = 0; index < 8; index++) await flush();
    expect(engine.executeBatch.mock.calls.map((call) => call[0].length)).toEqual([32, 32, 1]);
    expect(resources.persist).toHaveBeenCalledTimes(65);
    expect(service.summary(taskId)).toMatchObject({ state: 'COMPLETED', total: 65, completed: 65, success: 0, skipped: 65 });
    expect(service.results(taskId, 1, 20).data).toHaveLength(20);
    expect(service.results(taskId).data[0]).toMatchObject({ status: 'STALE', applied: false, latencyMs: null });
    service.onModuleDestroy();
  });
});
