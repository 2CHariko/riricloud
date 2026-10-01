import { LinesService } from './lines.service';
import { readEgressProxy, saveEgressProxy } from '../common/line-egress';
import { ValidationPipe } from '@nestjs/common';
import { CreateLineDto } from './dto/create-line.dto';
import { UpdateLineDto } from './dto/update-line.dto';

const proxy = { protocol: 'SOCKS5' as const, serverHost: '127.0.0.1', serverPort: 1080, authEnabled: true, username: 'warp', password: 'egress-secret' };
function setup() {
  const entry = { id: 'entry', name: 'Entry', serverHost: '198.51.100.1', status: 'ONLINE', reachability: 'PUBLIC', configOverride: null as string | null };
  const exit = { ...entry, id: 'exit', serverHost: '198.51.100.2' };
  const row = { id: 'line', name: 'Line', tag: null, listen: '0.0.0.0', type: 'DIRECT', relayMode: null as string | null, protocolType: 'MIXED', paramsJson: '{"usersEnabled":true}', entryNodeId: entry.id, entryPort: 24443, landingNodeId: null as string | null, landingPort: null as number | null, targetLineId: null, targetLine: null as unknown, certificate: null, status: 'ACTIVE', isPublic: true, tagsJson: '[]', updatedAt: new Date(), entryNode: entry, landingNode: null as typeof exit | null, egressProxyJson: null as string | null };
  const prisma = { node: { findUnique: jest.fn(async ({ where }) => where.id === entry.id ? entry : exit) }, line: { findUnique: jest.fn(async () => row), findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null), create: jest.fn(async ({ data }) => ({ ...row, ...data })), update: jest.fn(async ({ data }) => ({ ...row, ...data })), updateMany: jest.fn(async () => ({ count: 1 })) } };
  const agent = { pushConfigToAll: jest.fn(async () => 1) };
  const service = new LinesService(prisma as never, agent as never);
  return { service, prisma, row, entry, exit, agent };
}
describe('线路最终出站 API 与业务', () => {
  it('创建加密且响应无秘密；编辑省略/替换/清除；复制副本禁用', async () => {
    const { service, prisma, row, agent } = setup();
    const created = await service.create({ name: 'Line', protocolType: 'MIXED', entryNodeId: 'entry', entryPort: 24443, egressProxy: proxy });
    const stored = prisma.line.create.mock.calls[0][0].data.egressProxyJson;
    expect(readEgressProxy(stored)?.password).toBe(proxy.password);
    expect(JSON.stringify(created)).not.toContain(proxy.password);
    expect(JSON.stringify(created)).not.toContain('enc:v1');
    expect(created.line.effectiveEgress).toMatchObject({ nodeId: 'entry', inherited: false, proxy: { hasPassword: true } });
    row.egressProxyJson = stored;
    await service.update('line', { name: 'Renamed' });
    expect(prisma.line.update.mock.calls[0][0].data.egressProxyJson).toBe(stored);
    const { password: _password, ...safe } = proxy;
    await service.update('line', { egressProxy: safe });
    expect(readEgressProxy(prisma.line.update.mock.calls[1][0].data.egressProxyJson)?.password).toBe(proxy.password);
    await service.duplicate('line');
    expect(prisma.line.create.mock.calls[1][0].data.status).toBe('DISABLED');
    expect(readEgressProxy(prisma.line.create.mock.calls[1][0].data.egressProxyJson)?.password).toBe(proxy.password);
    await service.update('line', { egressProxy: null });
    expect(prisma.line.update.mock.calls[2][0].data.egressProxyJson).toBeNull();
    expect(agent.pushConfigToAll).toHaveBeenCalled();
    expect(JSON.stringify(await service.getAvailableForPlan({ lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]' }))).not.toContain('egress');
  });
  it('中继只校验落地覆盖，覆盖冲突与业务监听回环拒绝', async () => {
    const { service, entry, exit } = setup();
    const input = { name: 'Relay', protocolType: 'MIXED' as const, type: 'RELAY' as const, relayMode: 'BLIND_FORWARD' as const, entryNodeId: 'entry', entryPort: 24443, landingNodeId: 'exit', landingPort: 24444, egressProxy: proxy };
    entry.configOverride = '{"route":{}}';
    await service.create(input);
    exit.configOverride = '{"dns":{}}';
    await expect(service.create(input)).rejects.toThrow(/高级覆盖/);
    exit.configOverride = null;
    await expect(service.create({ ...input, egressProxy: { ...proxy, serverPort: 24444 } })).rejects.toThrow(/业务监听/);
  });
  it('TARGET_LINE继承脱敏出站，源独立配置必须显式清除', async () => {
    const { service, row, exit } = setup();
    const target = { ...row, id: 'target', protocolType: 'VLESS', entryNodeId: 'exit', entryNode: exit, egressProxyJson: saveEgressProxy(proxy, null) };
    row.type = 'RELAY'; row.relayMode = 'TARGET_LINE'; row.targetLine = target;
    const view = await service.detail('line');
    expect(view.line.effectiveEgress).toMatchObject({ sourceLineId: 'target', nodeId: 'exit', inherited: true });
    expect(JSON.stringify(view)).not.toContain('enc:v1');
    expect(JSON.stringify(view)).not.toContain(proxy.password);
    row.egressProxyJson = target.egressProxyJson;
    await expect(service.batchStatus({ ids: ['line'], status: 'ACTIVE' })).rejects.toThrow(/显式清除/);
  });
  it('批量启用重新检查执行节点覆盖', async () => {
    const { service, row, entry } = setup();
    row.egressProxyJson = saveEgressProxy(proxy, null);
    entry.configOverride = '{"outbounds":[]}';
    await expect(service.batchStatus({ ids: ['line'], status: 'ACTIVE' })).rejects.toThrow(/高级覆盖/);
  });
  it('嵌套DTO拒绝未知/null/错误类型，PATCH null可清除', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
    for (const egressProxy of [{ ...proxy, tls: {} }, { ...proxy, authEnabled: null }, { ...proxy, password: null }, { ...proxy, serverPort: '1080' }, { ...proxy, protocol: 'HTTPS' }]) {
      await expect(pipe.transform({ name: 'Line', egressProxy }, { type: 'body', metatype: CreateLineDto })).rejects.toThrow();
    }
    expect(await pipe.transform({ egressProxy: null }, { type: 'body', metatype: UpdateLineDto })).toMatchObject({ egressProxy: null });
  });
});
