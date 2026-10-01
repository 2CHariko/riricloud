import { AgentService } from './agent-gateway.service';
import { encryptSecret } from '../common/secret-crypto';
import { formatProxyLineUsername } from '../proxy-pool/proxy-key.util';
import { parseTrafficCredential } from '../common/inbound';
import type { ProxyPoolAccessService } from '../proxy-pool-access/proxy-pool-access.service';

const directId = '11111111-1111-4111-8111-111111111111';
const relayId = '22222222-2222-4222-8222-222222222222';
const rawKey = 'pk_0123456789abcdef01234567';
const directLogin = formatProxyLineUsername(rawKey, directId);
const relayLogin = formatProxyLineUsername(rawKey, relayId);
function setup() {
  const cursors = new Map<string, { credential: string; uploadTotal: bigint; downloadTotal: bigint }>();
  const tx = { user: { findMany: jest.fn(async () => [{ id: 'user', uuid: 'uuid', email: 'user@example.com', trafficLimitBytes: 100000n, trafficUsedBytes: 0n }]), update: jest.fn() }, proxyKey: { findMany: jest.fn(async () => [{ id: 'key', userId: 'user', username: rawKey }]), update: jest.fn() }, subscription: { findMany: jest.fn(async () => [{ id: 'sub', userId: 'user', trafficLimitBytes: 100000n, trafficUsedBytes: 0n }]), update: jest.fn() }, line: { findMany: jest.fn(async () => [{ id: directId, trafficRate: 1, entryNodeId: 'node' }, { id: relayId, trafficRate: 2, entryNodeId: 'node' }]) }, trafficCursor: { findMany: jest.fn(async () => [...cursors.values()]), upsert: jest.fn(async (args) => { cursors.set(args.create.credential, args.create); }) } };
  const prisma = { $transaction: jest.fn(async (fn) => fn(tx)), node: { findUnique: jest.fn() }, user: { findMany: jest.fn(async () => []), findUnique: jest.fn() } };
  const access = { getNodeBindings: jest.fn(async () => [{ lineId: directId, keyId: 'key', userId: 'user', username: directLogin, password: 'fixture', whitelistIps: ['192.0.2.1'] }, { lineId: relayId, keyId: 'key', userId: 'user', username: relayLogin, password: 'fixture', whitelistIps: ['192.0.2.1'] }]) };
  const service = new AgentService(prisma as never, undefined, undefined, undefined, access as unknown as ProxyPoolAccessService);
  const persist = (records: Array<{ userUuid: string; uploadTotal: string; downloadTotal: string }>) => (service as unknown as { persistTrafficSnapshots: (node: string, snapshots: Array<{ userUuid: string; uploadTotal: string; downloadTotal: string }>, fallback: { id: string; trafficRate: number }) => Promise<unknown> }).persistTrafficSnapshots('node', records, { id: 'first-vless', trafficRate: 99 });
  return { service, prisma, access, tx, cursors, persist };
}
describe('代理池线路绑定与精确账务', () => {
  it('派生身份可还原Key及线路，两个倍率独立计费且重复快照不重复扣', async () => {
    const { service, tx, persist } = setup();
    expect(parseTrafficCredential(directLogin)).toEqual({ rawCredential: rawKey, lineId: directId });
    const records = [{ userUuid: directLogin, uploadTotal: '10', downloadTotal: '20' }, { userUuid: relayLogin, uploadTotal: '10', downloadTotal: '20' }];
    await persist(records);
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'user' }, data: { trafficUsedBytes: { increment: 90n } } });
    expect(tx.proxyKey.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ trafficUsedBytes: { increment: 90n } }) }));
    expect(service.getBufferedTrafficHourlyMetrics()).toEqual(expect.arrayContaining([expect.objectContaining({ lineId: directId, billedBytes: 30n, proxyKeyId: 'key' }), expect.objectContaining({ lineId: relayId, billedBytes: 60n, proxyKeyId: 'key' })]));
    tx.user.update.mockClear(); tx.proxyKey.update.mockClear(); await persist(records);
    expect(tx.user.update).not.toHaveBeenCalled(); expect(tx.proxyKey.update).not.toHaveBeenCalled();
    await persist([{ userUuid: relayLogin, uploadTotal: '2', downloadTotal: '3' }]);
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'user' }, data: { trafficUsedBytes: { increment: 10n } } });
  });
  it('malformed、未知和跨节点新身份推进游标但不得退回节点首线路计费', async () => {
    const { tx, persist } = setup();
    tx.line.findMany.mockResolvedValue([{ id: directId, trafficRate: 1, entryNodeId: 'other-node' }]);
    await persist([directLogin, relayLogin, 'pk_line_invalid'].map(userUuid => ({ userUuid, uploadTotal: '10', downloadTotal: '20' })));
    expect(tx.user.update).not.toHaveBeenCalled(); expect(tx.proxyKey.update).not.toHaveBeenCalled();
    expect(tx.trafficCursor.upsert).toHaveBeenCalledTimes(3);
  });
  it('Key停用后的合法迟到快照仍精确结算，删除后不误匹配订阅用户', async () => {
    const { tx, persist } = setup();
    await persist([{ userUuid: relayLogin, uploadTotal: '1', downloadTotal: '2' }]);
    expect(tx.proxyKey.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { username: { in: [rawKey] } } }));
    tx.proxyKey.findMany.mockResolvedValue([]); tx.user.update.mockClear();
    await persist([{ userUuid: relayLogin, uploadTotal: '2', downloadTotal: '3' }]);
    expect(tx.user.update).not.toHaveBeenCalled();
  });
  it('中继白名单拒绝先于转发，只显式支持线路注入绑定且不下发裸Key', async () => {
    const { service, prisma } = setup();
    const base = { name: 'pool', listen: '127.0.0.1', status: 'ACTIVE', isPublic: true, tagsJson: '[]', protocolType: 'MIXED', proxyPoolEnabled: true, entryNodeId: 'node', paramsJson: '{"usersEnabled":true}', certificate: null };
    const upstream = { id: 'up', status: 'ACTIVE', presenceStatus: 'PRESENT', protocolType: 'HTTP', serverHost: 'example.com', serverPort: 8080, paramsJson: encryptSecret('{"username":"up","password":"secret"}'), subscription: { status: 'ACTIVE', userInfoUsedBytes: null, userInfoTotalBytes: null, userInfoExpireAt: null } };
    prisma.node.findUnique.mockResolvedValue({ id: 'node', serverHost: 'example.com', status: 'ONLINE', entryLines: [{ ...base, id: directId, type: 'DIRECT', entryPort: 10001 }, { ...base, id: relayId, type: 'RELAY', relayMode: 'UPSTREAM_NODE', upstreamNode: upstream, entryPort: 10002 }, { ...base, id: 'hidden-http', protocolType: 'HTTP', proxyPoolEnabled: false, type: 'DIRECT', entryPort: 10003 }], landingLines: [] });
    const config = (await service.buildConfigSync('node')).singboxConfig;
    const inbounds = config.inbounds as Array<{ type: string; listen_port: number; users: Array<{ username: string }> }>;
    expect(inbounds.find(i => i.listen_port === 10001)?.users).toEqual(expect.arrayContaining([expect.objectContaining({ username: directLogin })]));
    expect(inbounds.find(i => i.listen_port === 10002)?.users).toEqual(expect.arrayContaining([expect.objectContaining({ username: relayLogin })]));
    expect(inbounds.find(i => i.listen_port === 10003)?.users.some(u => u.username.startsWith('pk_'))).toBe(false);
    expect(inbounds.flatMap(i => i.users).some(u => u.username === rawKey)).toBe(false);
    const rules = (config.route as { rules: Array<Record<string, unknown>> }).rules;
    expect(rules.slice(0, 2).every(r => r.action === 'reject')).toBe(true);
    expect(rules[2]).toMatchObject({ outbound: `relay-out-${relayId}` });
  });
});
