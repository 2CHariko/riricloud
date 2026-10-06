import net from 'node:net';
import dgram from 'node:dgram';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createResourceRequest, parseCookieJar } from './dev-e2e-sync-resource.mjs';

function portNumber(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('监听端口必须为 1–65535 的整数');
  return port;
}

// 双协议检测期间同时持有 TCP/UDP，退出时全部释放；不以进程列表代替实际绑定。
export async function probePort({ host, port, protocols }) {
  portNumber(port);
  if (!net.isIP(host)) throw new Error('端口探测仅支持明确的本机监听 IP');
  const listeners = [];
  try {
    for (const protocol of protocols) {
      const listener = protocol === 'tcp' ? net.createServer() : dgram.createSocket({ type: net.isIP(host) === 6 ? 'udp6' : 'udp4', reuseAddr: false });
      listeners.push(listener);
      await new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('bind timeout'), { code: 'ETIMEDOUT' })), 1000);
        listener.once('error', error => { clearTimeout(timer); reject(error); });
        const ready = () => { clearTimeout(timer); resolvePromise(); };
        if (protocol === 'tcp') listener.listen({ host, port, exclusive: true }, ready);
        else listener.bind({ address: host, port, exclusive: true }, ready);
      });
    }
    return true;
  } catch (error) {
    if (['EADDRINUSE', 'EACCES', 'EPERM'].includes(error.code)) return false;
    throw new Error(`监听地址 ${host}:${port} 探测失败 [${error.code ?? 'BIND_ERROR'}]`);
  } finally {
    await Promise.all(listeners.map(listener => new Promise(resolvePromise => {
      try { listener.close(resolvePromise); } catch { resolvePromise(); }
    })));
  }
}

export async function pickPort({ port, host = '0.0.0.0', protocols = ['tcp'], fixed = false, reserved = new Set(), start = 30000, limit = 1000, probe = probePort }) {
  portNumber(port);
  portNumber(start);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('端口扫描次数必须为 1–10000 的整数');
  if (await probe({ host, port, protocols })) return port;
  if (fixed) throw new Error(`固定监听端口 ${port} 无法绑定，请调整 NODE_PORT`);
  for (let candidate = start; candidate <= 65535 && candidate < start + limit; candidate += 1) {
    if (!reserved.has(candidate) && await probe({ host, port: candidate, protocols })) return candidate;
  }
  throw new Error(`未找到可用监听端口（起始 ${start}，最多 ${limit} 次）`);
}

function managedLine(line, lineId) {
  return line.tag === 'master-direct' && line.name === 'Master 本机直连' && line.type === 'DIRECT' && line.protocolType === 'VLESS'
    || line.tag === 'master-blind' && line.name === 'Master 本机盲转示例' && line.type === 'RELAY' && line.relayMode === 'BLIND_FORWARD' && line.protocolType === 'VLESS'
    || line.id === lineId && line.tags?.includes('e2e') && line.type === 'DIRECT' && line.protocolType === 'VLESS';
}

export async function planLinePorts(lines, { nodeId, lineId, fixedPort, rejectedPort, start = 30000, limit = 1000, probe = probePort }) {
  const reserved = new Set();
  for (const line of lines) {
    if (line.entryNodeId === nodeId && line.entryPort) reserved.add(line.entryPort);
    if (line.landingNodeId === nodeId && line.landingPort) reserved.add(line.landingPort);
  }
  const updates = [];
  let rejectedMatched = !rejectedPort;
  for (const line of lines.filter(line => line.status === 'ACTIVE' && line.entryNodeId === nodeId
    && (line.type !== 'RELAY' || line.landingNodeId === nodeId) && managedLine(line, lineId))) {
    const patch = {};
    for (const role of ['entry', 'landing']) {
      if (line[`${role}NodeId`] !== nodeId || !line[`${role}Port`]) continue;
      const oldPort = line[`${role}Port`];
      const fixed = Boolean(fixedPort && role === 'entry' && line.id === lineId);
      const port = fixed ? portNumber(fixedPort) : oldPort;
      if (fixed && port !== oldPort && reserved.has(port)) throw new Error(`固定监听端口 ${port} 已被其他线路使用`);
      const protocols = role === 'entry' && line.relayMode === 'BLIND_FORWARD' ? ['tcp', 'udp'] : ['tcp'];
      const host = line.listen || '0.0.0.0';
      const rejected = port === rejectedPort;
      if (oldPort === rejectedPort) rejectedMatched = true;
      const next = await pickPort({ port, host, protocols, fixed, reserved, start, limit,
        probe: endpoint => endpoint.port === rejectedPort ? false : probe(endpoint) });
      if (next !== oldPort || rejected) {
        if (line.endpointOverrideEnabled || line.landingEndpointOverrideEnabled) throw new Error(`线路 ${line.id} 存在端点覆盖，请手动调整端口`);
        // 保留旧端口到本轮结束，避免更新顺序产生数据库冲突；订阅与中继目标由服务端重建。
        patch[`${role}Port`] = next;
        reserved.add(next);
      }
    }
    if (Object.keys(patch).length) updates.push({ id: line.id, patch });
  }
  if (!rejectedMatched) throw new Error(`绑定失败端口 ${rejectedPort} 不属于可自动调整的本机 E2E 线路`);
  return updates;
}

export async function waitForOfflineNode(request, { nodeId, offlineWaitMs = 45000, now = Date.now, sleep: pause = sleep, onWait = message => console.error(`[dev-e2e] ${message}`) }) {
  const readNode = async () => {
    const nodes = await request('/api/v1/admin/nodes');
    if (!Array.isArray(nodes)) throw new Error('节点列表响应格式无效');
    const node = nodes.find(node => node.id === nodeId);
    if (!node || !node.isLocal && node.serverHost !== '127.0.0.1') throw new Error('端口自动调整仅支持本机联调节点');
    return node;
  };
  let node = await readNode();
  if (node.status !== 'ONLINE') return node;
  const lastSeenAt = node.lastSeenAt;
  const deadline = now() + offlineWaitMs;
  if (offlineWaitMs > 0) onWait('节点记录仍为 ONLINE，等待 Master 心跳超时扫描确认离线（最多 45 秒）…');
  // Master 重启/Agent 被强制终止不会立即清掉持久化 ONLINE；只等待服务端收敛，不伪造状态。
  while (now() < deadline) {
    await pause(Math.min(1000, deadline - now()));
    node = await readNode();
    if (node.lastSeenAt !== lastSeenAt) throw new Error('联调节点收到新心跳，已有 Agent 正在运行，请先停止该 Agent');
    if (node.status !== 'ONLINE') return node;
  }
  throw new Error('联调节点已在线且等待离线超时，请检查已有 Agent 或 Master 心跳扫描；不会迁移其自身监听');
}

export async function prepareLinePorts(request, options) {
  const node = await waitForOfflineNode(request, options);
  if (node.configOverride) {
    let override;
    try { override = JSON.parse(node.configOverride); } catch { throw new Error('节点高级配置无效，请手动检查'); }
    if (override?.inbounds) throw new Error('节点高级配置覆写入站，请手动调整端口');
  }
  const lines = [];
  for (let page = 1; ; page += 1) {
    const payload = await request(`/api/v1/admin/lines?page=${page}&pageSize=100`);
    if (!Array.isArray(payload.data) || !Number.isInteger(payload.total)) throw new Error('线路列表响应格式无效');
    lines.push(...payload.data);
    if (lines.length >= payload.total) break;
    if (!payload.data.length || page >= 1000) throw new Error('线路分页未完整读取');
  }
  const selected = lines.find(line => line.id === options.lineId);
  if (!selected) throw new Error('未找到本次联调线路');
  const updates = await planLinePorts(lines, options);
  // 探测期间可能有另一个 Agent 接入；写操作前再读状态，避免迁移新上线实例的监听。
  const currentNodes = await request('/api/v1/admin/nodes');
  const currentNode = Array.isArray(currentNodes) && currentNodes.find(item => item.id === options.nodeId);
  if (!currentNode || currentNode.status === 'ONLINE' || currentNode.lastSeenAt !== node.lastSeenAt) throw new Error('联调节点状态已变化，请停止其他 Agent 后重试');
  for (const { id, patch } of updates) {
    await request(`/api/v1/admin/lines/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    console.error(`[dev-e2e] 线路 ${id} 已调整监听端口：${JSON.stringify(patch)}`);
  }
  return updates.find(update => update.id === selected.id)?.patch.entryPort ?? selected.entryPort;
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith('--') || argv[index + 1] === undefined) throw new Error('端口工具参数无效');
    args[argv[index].slice(2)] = argv[index + 1];
  }
  const common = { start: Number(args.start || 30000), limit: Number(args.limit || 1000) };
  if (command === 'pick') {
    console.log(await pickPort({ ...common, port: Number(args.port), fixed: Boolean(args.fixed) }));
  } else if (command === 'prepare') {
    const cookie = parseCookieJar(await readFile(process.env.RIRICLOUD_ADMIN_COOKIE_FILE, 'utf8'));
    if (!cookie) throw new Error('Cookie jar 中缺少管理员会话');
    const request = createResourceRequest(args.url, cookie);
    console.log(await prepareLinePorts(request, { ...common, nodeId: args.node, lineId: args.line,
      fixedPort: args.fixed ? Number(args.fixed) : undefined, rejectedPort: args.rejected ? Number(args.rejected) : undefined }));
  } else throw new Error('端口工具仅支持 pick / prepare');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
