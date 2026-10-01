import { ProbeResourceService } from './probe-resource.service';
import { PrismaService } from '../prisma/prisma.service';
import { encryptSecret } from '../common/secret-crypto';
import { INTERNAL_SPEEDTEST_UUID } from '../common/constants';
import { safeProbeResult, readLastProbe } from './probe-result';
import type { ProbeResult } from './probe.types';

function setup() {
  const source = { id: 'source', status: 'ACTIVE', updatedAt: new Date(1), userInfoUsedBytes: null, userInfoTotalBytes: null, userInfoExpireAt: null };
  const node = { id: 'node', subscriptionId: 'source', status: 'ACTIVE', presenceStatus: 'PRESENT', configHash: 'cfg', connectionHash: 'conn', protocolType: 'HYSTERIA2', serverHost: 'example.com', serverPort: 443, paramsJson: encryptSecret('{"password":"real-upstream-secret"}'), subscription: source, updatedAt: new Date(2) };
  const prisma = { upstreamNode: { findUnique: jest.fn(async () => node), findMany: jest.fn(), updateMany: jest.fn(async () => ({ count: 1 })) }, line: { findUnique: jest.fn(), findMany: jest.fn(), updateMany: jest.fn(async () => ({ count: 1 })) }, $transaction: jest.fn() };
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
  const service = new ProbeResourceService(prisma as unknown as PrismaService);
  return { service, prisma, source, node };
}
function result(subjectId = 'node'): ProbeResult {
  return { schemaVersion: 1, subjectType: 'UPSTREAM_NODE', subjectId, status: 'SUCCESS', errorCode: null, message: 'PROXY_HTTP_OK', engine: 'MIHOMO', engineVersion: '1.19.30', fallbackReason: null, mihomoCompatibility: 'SUPPORTED', measurement: 'PROXY_HTTP_DELAY', perspective: 'MASTER', routeKind: 'UPSTREAM_DIRECT', targetId: 'target', targetHost: 'example.com', testedAt: new Date().toISOString(), durationMs: 20, latencyMs: 10, stage: 'DIAL_HTTP', configHash: 'hash', applied: false };
}
describe('资源快照与条件写入', () => {
  it('UDP 协议使用真实凭据；源变更阻断旧结果写入', async () => {
    const { service, prisma, source } = setup();
    const seq = service.reserve('UPSTREAM_NODE', ['node']);
    const snapshot = (await service.snapshot('UPSTREAM_NODE', 'node', seq))!;
    expect(snapshot.request.connection.params.password).toBe('real-upstream-secret');
    source.status = 'DISABLED';
    expect(await service.persist(snapshot, { ...result(), configHash: snapshot.request.configHash }, new AbortController().signal)).toBe(false);
    expect(prisma.upstreamNode.updateMany).not.toHaveBeenCalled();
  });
  it('新发起任务禁止旧任务晚到覆盖；同版本 updateMany 包含 updatedAt 条件', async () => {
    const { service, prisma } = setup();
    const seq = service.reserve('UPSTREAM_NODE', ['node']);
    const snapshot = (await service.snapshot('UPSTREAM_NODE', 'node', seq))!;
    expect(await service.persist(snapshot, { ...result(), configHash: snapshot.request.configHash }, new AbortController().signal)).toBe(true);
    expect(prisma.upstreamNode.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'node', updatedAt: new Date(2) }), data: expect.objectContaining({ latencyMs: 10 }) }));
    service.reserve('UPSTREAM_NODE', ['node']);
    expect(await service.persist(snapshot, { ...result(), configHash: snapshot.request.configHash }, new AbortController().signal)).toBe(false);
  });
  it('托管线路绑定内部探针 UUID，不泄露服务端私钥', async () => {
    const { service, prisma } = setup();
    prisma.line.findUnique.mockResolvedValue({ id: 'line', status: 'ACTIVE', type: 'DIRECT', protocolType: 'VLESS', paramsJson: JSON.stringify({ tls: { mode: 'reality', reality: { publicKey: 'public', privateKey: 'secret', shortIds: ['1234'] } } }), entryNode: { id: 'entry', serverHost: 'example.com', status: 'OFFLINE' }, entryPort: 443, updatedAt: new Date(2) });
    const snapshot = (await service.snapshot('LINE', 'line', service.reserve('LINE', ['line'])))!;
    expect(snapshot.request.connection.params.uuid).toBe(INTERNAL_SPEEDTEST_UUID);
    expect(JSON.stringify(snapshot.request.connection)).not.toContain('secret');
  });
  it('最终出站更新使线路与桥接拨测失效，旧结果不写回', async () => {
    const { service, prisma } = setup();
    const line = { id: 'line', status: 'ACTIVE', type: 'DIRECT', protocolType: 'VLESS', paramsJson: '{"tls":{"mode":"none"}}', entryNode: { id: 'entry', serverHost: 'example.com', status: 'ONLINE' }, entryPort: 443, updatedAt: new Date(2), egressProxyJson: 'old' };
    prisma.line.findUnique.mockResolvedValue(line);
    const snapshot = (await service.snapshot('LINE', 'line', service.reserve('LINE', ['line'])))!;
    line.egressProxyJson = 'new';
    expect(await service.persist(snapshot, { ...result('line'), subjectType: 'LINE', configHash: snapshot.version }, new AbortController().signal)).toBe(false);
    const targetLine = { ...line, id: 'target' };
    prisma.line.findUnique.mockResolvedValue({ ...line, type: 'RELAY', relayMode: 'TARGET_LINE', targetLine });
    const bridge = (await service.snapshot('LINE', 'line', snapshot.sequence))!;
    targetLine.updatedAt = new Date(4);
    targetLine.egressProxyJson = 'changed';
    expect((await service.snapshot('LINE', 'line', snapshot.sequence))!.version).not.toBe(bridge.version);
  });
  it('同 ID 证书原地更新及目标线路证书更新阻断旧结果并失效展示', async () => {
    const { service, prisma } = setup();
    const certificate = { id: 'cert', updatedAt: new Date(1) };
    const line = { id: 'line', status: 'ACTIVE', type: 'DIRECT', protocolType: 'VLESS', paramsJson: '{"tls":{"mode":"tls"}}', entryNode: { id: 'entry', serverHost: 'example.com', status: 'ONLINE' }, entryPort: 443, certificateId: 'cert', certificate, updatedAt: new Date(2) };
    prisma.line.findUnique.mockResolvedValue(line);
    const snapshot = (await service.snapshot('LINE', 'line', service.reserve('LINE', ['line'])))!;
    const measured: ProbeResult = { ...result('line'), subjectType: 'LINE', routeKind: 'MANAGED_DIRECT', configHash: snapshot.version };
    certificate.updatedAt = new Date(3);
    expect(await service.persist(snapshot, measured, new AbortController().signal)).toBe(false);
    expect(prisma.line.updateMany).not.toHaveBeenCalled();
    const current = (await service.snapshot('LINE', 'line', snapshot.sequence))!;
    expect(readLastProbe(JSON.stringify(measured), true, current.version)).toMatchObject({ status: 'STALE', latencyMs: null });
    const targetLine = { ...line, id: 'target', certificate: { id: 'target-cert', updatedAt: new Date(1) } };
    prisma.line.findUnique.mockResolvedValue({ ...line, type: 'RELAY', relayMode: 'TARGET_LINE', targetLine });
    const relay = (await service.snapshot('LINE', 'line', snapshot.sequence))!;
    targetLine.certificate.updatedAt = new Date(4);
    expect((await service.snapshot('LINE', 'line', snapshot.sequence))!.version).not.toBe(relay.version);
  });
  it('游标分页覆盖第 201 个节点，超过上限不静默截断', async () => {
    const { service, prisma } = setup();
    prisma.upstreamNode.findMany.mockResolvedValueOnce(Array.from({ length: 200 }, (_, i) => ({ id: String(i) }))).mockResolvedValueOnce([{ id: '200' }]);
    expect(await service.listIds('UPSTREAM_NODE', {})).toHaveLength(201);
    expect(prisma.upstreamNode.findMany.mock.calls[1][0]).toMatchObject({ cursor: { id: '199' }, skip: 1 });
  });
  it('结果采用字段白名单，旧 TCP 与嵌套秘密不可见', () => {
    expect(safeProbeResult({ status: 'SUCCESS', latencyMs: 10 })).toBeNull();
    const safe = safeProbeResult({ ...result(), connection: { password: 'secret' }, params: { uuid: 'secret' } });
    expect(JSON.stringify(safe)).not.toContain('secret');
    expect(readLastProbe(JSON.stringify(result()), false)).toMatchObject({ status: 'STALE', latencyMs: null });
  });
});
