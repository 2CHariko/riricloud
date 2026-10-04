import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AgentPollDto } from './agent-poll.dto';

describe('AgentPollDto', () => {
  const createDto = (uploadTotal: string, downloadTotal = '0') => plainToInstance(AgentPollDto, {
    protocolVersion: 2,
    cpuUsage: 1,
    memoryUsage: 2,
    bandwidthRate: 3,
    trafficSnapshots: [{ userUuid: 'user@example.com', uploadTotal, downloadTotal }]
  });

  it('接受最大 uint64 累计值', async () => {
    const errors = await validate(createDto('18446744073709551615'));
    expect(errors).toHaveLength(0);
  });

  it.each([
    '18446744073709551616',
    '01',
    'not-a-number'
  ])('拒绝非法累计值 %s', async (uploadTotal) => {
    const errors = await validate(createDto(uploadTotal));
    expect(errors.some((error) => error.property === 'trafficSnapshots')).toBe(true);
  });
  it('兼容旧日志与新时间字段，HTTP批次复用WS元数据和预算限制', async () => {
    const dto = createDto('0');
    dto.logs = [{ level: 'WARN', module: 'Singbox', message: 'old agent' },
      { level: 'ERROR', module: 'Singbox', message: 'timeout', occurredAt: '2026-10-04T00:00:00.123456789Z', sequence: 7, agentInstanceId: 'a1', metadata: { event: 'kernel_exit', detail: null } }];
    expect(await validate(plainToInstance(AgentPollDto, dto))).toHaveLength(0);
    dto.logs[1].metadata = { nested: { a: { b: { c: { d: { e: 'too deep' } } } } } };
    expect((await validate(plainToInstance(AgentPollDto, dto))).some((error) => error.property === 'logs')).toBe(true);
    dto.logs = Array.from({ length: 50 }, () => ({ level: 'INFO', module: 'HTTP', message: 'x'.repeat(2000) }));
    expect((await validate(plainToInstance(AgentPollDto, dto))).some((error) => error.property === 'logs')).toBe(true);
    dto.logs = Array.from({ length: 100 }, () => ({ level: 'INFO', module: 'HTTP', message: 'ok' }));
    expect(await validate(plainToInstance(AgentPollDto, dto))).toHaveLength(0);
  });
});
