import { HTTP_CODE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ProbeController } from './probe.controller';
import { LinesController } from '../lines/lines.controller';
import { UpstreamController } from '../upstream/upstream.controller';
import { LinesService } from '../lines/lines.service';
import { UpstreamService } from '../upstream/upstream.service';
import { ProbeTaskService } from './probe-task.service';
import { ClientKernelsService } from '../client-kernels/client-kernels.service';
import { StartProbeDto, ProbeResultsQueryDto } from './probe-task.dto';

describe('管理员异步探针 HTTP 契约', () => {
  it('四个启动路由为 HTTP202 且直接提交任务，不调用旧测速服务', async () => {
    const receipt = { taskId: 'task', state: 'QUEUED', total: 1 };
    const tasks = { start: jest.fn().mockResolvedValue(receipt) };
    const lines = new LinesController({} as LinesService, tasks as unknown as ProbeTaskService);
    const nodes = new UpstreamController({} as UpstreamService, tasks as unknown as ProbeTaskService);
    const dto = new StartProbeDto(), user = { id: 'admin' };
    expect(await lines.speedtest('line', dto, user)).toEqual(receipt);
    expect(await lines.speedtestAll(dto, user)).toEqual(receipt);
    expect(await nodes.probeNode('node', dto, user)).toEqual(receipt);
    expect(await nodes.probeAll({ subscriptionId: 'source' }, dto, user)).toEqual(receipt);
    expect(tasks.start.mock.calls).toEqual([
      ['admin', 'LINE', { id: 'line' }, 'MIHOMO_ONLY'],
      ['admin', 'LINE', {}, 'MIHOMO_ONLY'],
      ['admin', 'UPSTREAM_NODE', { id: 'node' }, 'MIHOMO_ONLY'],
      ['admin', 'UPSTREAM_NODE', { subscriptionId: 'source' }, 'MIHOMO_ONLY']
    ]);
    for (const method of [LinesController.prototype.speedtest, LinesController.prototype.speedtestAll, UpstreamController.prototype.probeNode, UpstreamController.prototype.probeAll]) expect(Reflect.getMetadata(HTTP_CODE_METADATA, method)).toBe(202);
  });
  it('任务汇总、分页、幂等取消与内核状态端点受管理员角色保护', () => {
    const tasks = { summary: jest.fn(), results: jest.fn(), cancel: jest.fn() }, kernels = { status: jest.fn() };
    const controller = new ProbeController(tasks as unknown as ProbeTaskService, kernels as unknown as ClientKernelsService);
    controller.summary('task'); controller.results('task', new ProbeResultsQueryDto()); controller.cancel('task'); controller.status();
    expect(tasks.results).toHaveBeenCalledWith('task', 1, 20);
    expect(Reflect.getMetadata('roles', ProbeController)).toEqual(['ADMIN']);
    expect(Reflect.getMetadata(PATH_METADATA, ProbeController.prototype.results)).toBe('probe-tasks/:id/results');
    expect(Reflect.getMetadata(PATH_METADATA, ProbeController.prototype.status)).toBe('client-kernels/status');
  });
});
