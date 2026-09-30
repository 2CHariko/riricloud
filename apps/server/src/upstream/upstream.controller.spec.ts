import { validate } from 'class-validator';
import { PATH_METADATA } from '@nestjs/common/constants';
import { UpstreamController } from './upstream.controller';
import { SetNodeStatusDto } from './dto/set-node-status.dto';
import { ExportUpstreamNodesDto } from './dto/export-upstream-nodes.dto';
import { ProbeUpstreamDto } from './dto/probe-upstream.dto';
import { QueryUpstreamNodeDto } from './dto/query-upstream-node.dto';
import { CreateUpstreamDto } from './dto/create-upstream.dto';

async function invalid(object: object) { expect((await validate(object, { whitelist: true, forbidNonWhitelisted: true })).length).toBeGreaterThan(0); }
describe('上游新 DTO 和破坏性路由', () => {
  it('彻底删除直发开关路由和字段', async () => {
    const routes = Object.getOwnPropertyNames(UpstreamController.prototype).map((name) => Reflect.getMetadata(PATH_METADATA, Object.getOwnPropertyDescriptor(UpstreamController.prototype, name)?.value));
    expect(routes).not.toContain('nodes/:nodeId/direct-sub');
    await invalid(Object.assign(new QueryUpstreamNodeDto(), { isDirectSub: true }));
  });
  it('创建允许显式禁用状态，拒绝未知状态', async () => {
    expect(await validate(Object.assign(new CreateUpstreamDto(), { name: 'source', sourceType: 'TEXT', content: 'test', status: 'DISABLED' }), { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
    await invalid(Object.assign(new CreateUpstreamDto(), { name: 'source', status: 'MISSING' }));
  });
  it('节点启停只接受枚举且不能省略', async () => {
    await invalid(new SetNodeStatusDto());
    await invalid(Object.assign(new SetNodeStatusDto(), { status: 'PRESENT' }));
    expect(await validate(Object.assign(new SetNodeStatusDto(), { status: 'ACTIVE' }))).toHaveLength(0);
  });
  it('导出和批量测速校验 UUID，分页不允许无界请求', async () => {
    await invalid(Object.assign(new ExportUpstreamNodesDto(), { nodeIds: 'private-secret' }));
    await invalid(Object.assign(new ExportUpstreamNodesDto(), { subscriptionId: 'invalid' }));
    await invalid(Object.assign(new ProbeUpstreamDto(), { subscriptionId: 'invalid' }));
    await invalid(Object.assign(new QueryUpstreamNodeDto(), { pageSize: 201 }));
  });
  it('Header 的值必须为字符串、拒绝注入与超长名称', async () => {
    await invalid(Object.assign(new CreateUpstreamDto(), { name: 'source', customHeaders: { Authorization: 123 } }));
    await invalid(Object.assign(new CreateUpstreamDto(), { name: 'source', customHeaders: { Authorization: 'a\r\nX: secret' } }));
    await invalid(Object.assign(new CreateUpstreamDto(), { name: 'x'.repeat(129) }));
  });
});
