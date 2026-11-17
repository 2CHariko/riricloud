/* 镜像生命周期隔离夹具：只绑定回环，无生产数据、鉴权凭据或上游公网访问。 */
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { createServer } = require('node:http');
const { createHook } = require('node:async_hooks');
const serverRequire = createRequire(resolve(__dirname, '../apps/server/package.json'));
serverRequire('ts-node').register({ transpileOnly: true, project: resolve(__dirname, '../apps/server/tsconfig.json') });
serverRequire('reflect-metadata');
const express = serverRequire('express');
const { WebSocketServer } = serverRequire('ws');
const { Logger } = serverRequire('@nestjs/common');
Logger.overrideLogger(false);
const { MirrorService } = require('../apps/server/src/mirrors/mirror.service.ts');
const { AgentService } = require('../apps/server/src/agent-gateway/agent.service.ts');
const { RateLimitService } = require('../apps/server/src/common/rate-limit.service.ts');

const mirrorTimers = new Map();
const timerHook = createHook({
  init(id, type, _trigger, resource) {
    if (type === 'Timeout' && /mirrors[\\/]/.test(new Error().stack || '')) mirrorTimers.set(id, resource);
  },
  destroy(id) { mirrorTimers.delete(id); }
});
timerHook.enable();
const node = { id: 'fixture-node', name: 'Fixture', status: 'ONLINE', communicationMode: 'WS', capabilitiesJson: '["mirror_proxy"]', serverHost: 'fixture.invalid' };
const site = { id: 'fixture-site', name: 'Fixture', slug: 'fixture', enabled: true, upstreamBaseUrl: 'https://fixture.invalid', allowedOriginsJson: '["fixture.invalid"]', nodeId: node.id, accessMode: 'PUBLIC', shareTokenHash: null, shareExpiresAt: null, node };
let logWrites = 0;
const prisma = {
  mirrorSite: { findUnique: async () => site, update: async () => { logWrites++; return site; } },
  node: { findUnique: async () => node, update: async () => node }
};
const gateway = new AgentService(prisma);
const rate = new RateLimitService();
const mirrors = new MirrorService(prisma, gateway, rate);
const app = express();
app.get('/mirror', (req, res, next) => { void mirrors.proxy('fixture', undefined, req, res).catch(next); });
app.use((error, _req, res, _next) => { res.status(error.getStatus?.() ?? 500).json(error.getResponse?.() ?? { code: 'FIXTURE_ERROR' }); });
const server = createServer(app);
const ws = new WebSocketServer({ server, path: '/agent' });
let shuttingDown = false;
function snapshot() {
  return { pid: process.pid, activeTasks: [...mirrors.activeTaskIds.values()].reduce((sum, tasks) => sum + tasks.size, 0), gatewaySessions: gateway.mirrorSessions.size, capacity: mirrors.capacity.snapshot, rateCounters: rate.size, mirrorTimers: [...mirrorTimers.values()].filter(timer => !timer._destroyed).length, logWrites };
}
function send(value) { if (process.connected) process.send(value); }
ws.on('connection', socket => {
  // 仅替换已认证节点的承载 socket；镜像方法仍使用真实 Gateway 实现与会话表。
  gateway.sockets.set(node.id, socket);
  socket.on('message', (data, binary) => {
    if (binary) gateway.handleMirrorBinary(node.id, Buffer.from(data));
    else {
      const frame = JSON.parse(data.toString());
      gateway.handleMirrorText(node.id, frame.type, frame.data);
    }
  });
  socket.on('close', () => {
    if (shuttingDown) return;
    void gateway.unregister(node.id, socket).then(() => send({ type: 'agent-disconnected', snapshot: snapshot() }));
  });
  send({ type: 'agent-connected' });
});
process.on('message', async message => {
  if (message.type === 'snapshot') send({ type: 'snapshot', snapshot: snapshot() });
  if (message.type === 'shutdown') {
    shuttingDown = true;
    mirrors.onModuleDestroy();
    for (const socket of ws.clients) socket.close(1001, 'fixture shutdown');
    gateway.sockets.clear();
    await new Promise(resolveClose => ws.close(resolveClose));
    await new Promise(resolveClose => server.close(resolveClose));
    await new Promise(resolveTurn => setImmediate(resolveTurn));
    const final = snapshot();
    timerHook.disable();
    send({ type: 'stopped', snapshot: final });
    process.disconnect();
    // 不调用 process.exit；残留的镜像定时器/句柄会阻止自然退出并导致父测试失败。
  }
});
server.listen(0, '127.0.0.1', () => send({ type: 'ready', port: server.address().port, snapshot: snapshot() }));
