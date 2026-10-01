import { LineSpeedtestService } from './line-speedtest.service';
import { ProbeTaskService } from '../probe/probe-task.service';
import { SettingsService } from '../system/settings.service';

describe('线路自动探针调度', () => {
  afterEach(() => jest.useRealTimers());
  it('只提交异步 Mihomo 任务，没有同步或 TCP 测速入口', async () => {
    jest.useFakeTimers();
    const tasks = { start: jest.fn().mockResolvedValue({ taskId: 'task', state: 'QUEUED', total: 1 }) };
    const settings = { getSettings: jest.fn().mockResolvedValue({ lineSpeedtestEnabled: true, lineSpeedtestIntervalMins: 1 }) };
    const service = new LineSpeedtestService(tasks as unknown as ProbeTaskService, settings as unknown as SettingsService);
    expect(service).not.toHaveProperty('testLine');
    expect(service).not.toHaveProperty('tcpPing');
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(60000);
    expect(tasks.start).toHaveBeenCalledWith('SYSTEM_LINE_SCHEDULER', 'LINE', {}, 'MIHOMO_PREFERRED');
    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(60000);
    expect(tasks.start).toHaveBeenCalledTimes(1);
  });
});
