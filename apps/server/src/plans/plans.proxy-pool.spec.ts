import { PlansService } from './plans.service';
import { AgentService } from '../agent-gateway/agent.service';

describe('套餐代理池授权配置通知', () => {
  it('修改线路匹配规则提交后通知Agent，不因仅改名称通知', async () => {
    const plan = { id: 'plan', name: 'Plan', description: null, price: 0, durationDays: 30, trafficLimitBytes: 1000n, lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]', templateId: null, isPublic: true, sortOrder: 0 };
    const prisma = { plan: { findUnique: jest.fn(async () => plan), update: jest.fn(async () => plan) } };
    const agent = { pushConfigToAll: jest.fn(async () => 1) };
    const service = new PlansService(prisma as never, undefined, agent as unknown as AgentService);
    await service.update(plan.id, { lineMatchMode: 'EXPLICIT', lineIds: [] });
    expect(agent.pushConfigToAll).toHaveBeenCalledTimes(1);
    agent.pushConfigToAll.mockClear();
    await service.update(plan.id, { name: 'Renamed' });
    expect(agent.pushConfigToAll).not.toHaveBeenCalled();
  });
});
