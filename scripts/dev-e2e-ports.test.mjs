import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import dgram from 'node:dgram';
import { readFile } from 'node:fs/promises';
import { probePort, planLinePorts, prepareLinePorts } from './dev-e2e-ports.mjs';

const direct = { id: 'direct', name: 'Master 本机直连', tag: 'master-direct', type: 'DIRECT', protocolType: 'VLESS', status: 'ACTIVE', entryNodeId: 'local', entryPort: 24001, listen: '0.0.0.0', params: {} };
const relay = { ...direct, id: 'relay', name: 'Master 本机盲转示例', tag: 'master-blind', type: 'RELAY', relayMode: 'BLIND_FORWARD', entryPort: 62470, landingNodeId: 'local', landingPort: 24003 };
const options = { nodeId: 'local', lineId: 'direct', start: 30000, limit: 10 };

test('盲转入口 TCP 可用但 UDP 被保留时迁移端口，订阅由线路模型同步', async () => {
  const seen = [];
  const updates = await planLinePorts([direct, relay], { ...options, probe: async endpoint => {
    seen.push(endpoint);
    return endpoint.port !== 62470 || !endpoint.protocols.includes('udp');
  } });
  assert.deepEqual(updates, [{ id: 'relay', patch: { entryPort: 30000 } }]);
  assert.ok(seen.some(x => x.port === 62470 && x.host === '0.0.0.0' && x.protocols.join(',') === 'tcp,udp'));
});

test('旧库逐次检查，保持可用端口并跳过数据库与本轮已分配端口', async () => {
  const custom = { ...direct, id: 'custom', tag: 'custom', name: 'custom', entryPort: 30000 };
  const updates = await planLinePorts([direct, relay, custom], { ...options, probe: async ({ port }) => ![24001, 62470, 24003].includes(port) });
  assert.deepEqual(updates, [
    { id: 'direct', patch: { entryPort: 30001 } },
    { id: 'relay', patch: { entryPort: 30002, landingPort: 30003 } }
  ]);
  assert.deepEqual(await planLinePorts([direct, relay], { ...options, probe: async () => true }), []);
});

test('显式 NODE_PORT 固定且探测失败时不自动漂移；绑定竞态端口强制重新分配', async () => {
  await assert.rejects(planLinePorts([direct, relay], { ...options, fixedPort: 62470, probe: async ({ port }) => port !== 62470 }), /固定.*62470/);
  assert.deepEqual(await planLinePorts([direct], { ...options, fixedPort: 25000, probe: async () => true }), [{ id: 'direct', patch: { entryPort: 25000 } }]);
  await assert.rejects(planLinePorts([direct, relay], { ...options, fixedPort: relay.entryPort, probe: async () => true }), /其他线路/);
  assert.deepEqual(await planLinePorts([direct, relay], { ...options, rejectedPort: 62470, probe: async () => true }), [{ id: 'relay', patch: { entryPort: 30000 } }]);
  await assert.rejects(planLinePorts([direct], { ...options, rejectedPort: 9999, probe: async () => true }), /不属于/);
});

test('只管理默认 seed 和 e2e 标记线路，忽略其他节点、停用线路并拒绝覆盖端点', async () => {
  const custom = { ...direct, id: 'custom', tag: 'custom', name: 'custom', entryPort: 30005 };
  const remote = { ...relay, id: 'remote', entryNodeId: 'remote', landingNodeId: 'local' };
  assert.deepEqual(await planLinePorts([custom, remote, { ...relay, status: 'DISABLED' }], { ...options, lineId: 'custom', probe: async () => false }), []);
  await assert.rejects(planLinePorts([{ ...direct, endpointOverrideEnabled: true }], { ...options, probe: async ({ port }) => port !== direct.entryPort }), /端点覆盖/);
  await assert.rejects(planLinePorts([direct], { ...options, limit: 2, probe: async () => false }), /未找到/);
  await assert.rejects(planLinePorts([direct], { ...options, start: 65535, limit: 2, probe: async () => false }), /未找到/);
});

test('真实 UDP 独占监听使双协议探测失败，探测结束释放 TCP 与 UDP', async () => {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind({ port: 0, address: '127.0.0.1', exclusive: true }, resolve); });
  const port = socket.address().port;
  try {
    assert.equal(await probePort({ host: '127.0.0.1', port, protocols: ['tcp'] }), true);
    assert.equal(await probePort({ host: '127.0.0.1', port, protocols: ['tcp', 'udp'] }), false);
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    await new Promise(resolve => server.close(resolve));
  } finally { await new Promise(resolve => socket.close(resolve)); }
  assert.equal(await probePort({ host: '127.0.0.1', port, protocols: ['tcp', 'udp'] }), true);
});

test('管理 API 分页完整读取、存活节点不修改、写入失败不重试', async () => {
  const calls = [];
  const request = async (path, init = {}) => {
    calls.push([path, init]);
    if (path.endsWith('/nodes')) return [{ id: 'local', isLocal: true, status: 'OFFLINE', configOverride: null }];
    if (path.includes('page=1')) return { data: [direct], total: 2 };
    if (path.includes('page=2')) return { data: [relay], total: 2 };
    if (init.method === 'PATCH') throw new Error('write failed');
    throw Error('unexpected request');
  };
  await assert.rejects(prepareLinePorts(request, { ...options, probe: async ({ port }) => port !== 62470 }), /write failed/);
  assert.equal(calls.filter(([, init]) => init.method === 'PATCH').length, 1);
  await assert.rejects(prepareLinePorts(async () => [{ id: 'local', isLocal: true, status: 'ONLINE' }], { ...options, offlineWaitMs: 0 }), /已在线/);
});

test('Master 重启后旧 ONLINE 记录等待正常离线扫描，不把历史状态当作活跃 Agent', async () => {
  let reads = 0;
  const messages = [];
  const request = async path => path.endsWith('/nodes')
    ? [{ id: 'local', isLocal: true, status: ++reads < 3 ? 'ONLINE' : 'OFFLINE', lastSeenAt: '2026-10-06T00:00:00Z' }]
    : { data: [direct], total: 1 };
  assert.equal(await prepareLinePorts(request, { ...options, probe: async () => true, sleep: async () => {}, onWait: message => messages.push(message) }), direct.entryPort);
  assert.equal(reads, 4);
  assert.equal(messages.length, 1);
});

test('等待期间收到新心跳立即拒绝，状态未收敛超时不绕过且不写库', async () => {
  let reads = 0;
  await assert.rejects(prepareLinePorts(async path => {
    assert.ok(path.endsWith('/nodes'));
    return [{ id: 'local', isLocal: true, status: 'ONLINE', lastSeenAt: `2026-10-07T00:00:0${reads++}Z` }];
  }, { ...options, sleep: async () => {} }), /新心跳/);
  let clock = 0;
  await assert.rejects(prepareLinePorts(async () => [{ id: 'local', isLocal: true, status: 'ONLINE', lastSeenAt: null }], {
    ...options, offlineWaitMs: 2, now: () => clock, sleep: async () => { clock += 1; }
  }), /已在线/);
});

test('端口探测期间其他 Agent 上线时不提交线路变更', async () => {
  let reads = 0;
  let writes = 0;
  await assert.rejects(prepareLinePorts(async (path, init = {}) => {
    if (path.endsWith('/nodes')) return [{ id: 'local', isLocal: true, status: ++reads === 1 ? 'OFFLINE' : 'ONLINE' }];
    if (init.method === 'PATCH') { writes += 1; throw Error('unexpected write'); }
    return { data: [direct, relay], total: 2 };
  }, { ...options, probe: async ({ port }) => port !== 62470 }), /状态已变化/);
  assert.equal(writes, 0);
});

test('启动脚本仅为本机专用库开启自动调整，并在 Agent 退出后处理绑定竞态', async () => {
  const script = await readFile(new URL('./dev-e2e.sh', import.meta.url), 'utf8');
  assert.match(script, /E2E_MANAGED_PORTS/);
  assert.match(script, /NODE_PORT_OVERRIDE/);
  assert.match(script, /dev-e2e-ports\.mjs/);
  assert.match(script, /BIND_CONFLICT/);
  assert.doesNotMatch(script, /grep -q "sing-box started"/);
});
