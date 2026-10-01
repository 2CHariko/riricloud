import { AgentService } from './agent-gateway.service';
import type { ConfigSyncData } from './agent-message';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
describe('配置变更同步竞态', () => {
  afterEach(() => jest.useRealTimers());
  it('旧批次完成不能提前结算新变更的等待者', async () => {
    jest.useFakeTimers();
    const service = new AgentService({} as never, { getSettings: async () => ({ configSyncDebounceMs: 1 }), onSettingsChange: () => {} } as never);
    const first = deferred<number>(), second = deferred<number>();
    const flush = jest.spyOn(service as unknown as { flushConfigToAll: () => Promise<number> }, 'flushConfigToAll').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const p1 = service.pushConfigToAll(); await Promise.resolve(); await jest.advanceTimersByTimeAsync(1);
    let secondDone = false;
    const p2 = service.pushConfigToAll().then(() => { secondDone = true; }); await Promise.resolve();
    first.resolve(1); await p1; await Promise.resolve();
    expect(secondDone).toBe(false);
    await jest.advanceTimersByTimeAsync(1); second.resolve(1); await p2;
    expect(flush).toHaveBeenCalledTimes(2);
  });
  it('缓存失效后，进行中的旧构建不能重写最新缓存', async () => {
    jest.useFakeTimers();
    const service = new AgentService({} as never, { getSettings: async () => ({ configSyncDebounceMs: 1 }), onSettingsChange: () => {} } as never);
    const old = deferred<ConfigSyncData>();
    const current = { version: 2, singboxConfig: { outbounds: [{ tag: 'new-egress' }] } } as ConfigSyncData;
    const build = jest.spyOn(service, 'buildConfigSync').mockReturnValueOnce(old.promise).mockResolvedValue(current);
    const internal = service as unknown as { getDesiredConfigSync: (nodeId: string) => Promise<ConfigSyncData> };
    const read = internal.getDesiredConfigSync('node');
    const refresh = service.pushConfigToAll(); await Promise.resolve(); await jest.advanceTimersByTimeAsync(1); await refresh;
    old.resolve({ version: 1, singboxConfig: {} } as ConfigSyncData);
    expect(await read).toEqual(current);
    expect(await internal.getDesiredConfigSync('node')).toEqual(current);
    expect(build).toHaveBeenCalledTimes(2);
  });
});
