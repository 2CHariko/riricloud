import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import dgram from 'node:dgram';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { planLinePorts, prepareLinePorts, probePort } from './dev-e2e-ports.mjs';
import { inspectKernel } from './dev-e2e-kernel.mjs';

const binaries = { agent: process.env.E2E_NATIVE_AGENT_BINARY, singbox: process.env.E2E_NATIVE_SINGBOX_BINARY };
const native = Boolean(binaries.agent && binaries.singbox);
const freeTcp = async () => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolvePromise => server.close(resolvePromise));
  return port;
};

// 显式传入已有二进制才运行，不在普通门禁下载/安装内核或改写用户的联调数据库。
test('真实 Agent/Sing-box：UDP 冲突校正后稳定就绪且盲转发 HTTP 成功，退出后无监听残留', { skip: !native, timeout: 25000 }, async () => {
  const require = createRequire(resolve('apps/server/package.json'));
  const { WebSocketServer } = require('ws');
  const directory = await mkdtemp(join(tmpdir(), 'riri-e2e-native-'));
  const configPath = join(directory, 'config.json');
  const logPath = join(directory, 'agent-console.log');
  const target = http.createServer((_request, response) => response.end('blind-forward-ok'));
  const occupied = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  let master;
  let agent;
  let log = '';
  let ready = false;
  let entryPort;
  let kernelPid;
  let currentConfig;
  let relay;
  const startAgent = () => {
    log = '';
    agent = spawn(resolve(binaries.agent), ['run'], { windowsHide: true, env: {
      ...process.env, RIRICLOUD_NON_INTERACTIVE: '1', RIRICLOUD_CONFIG_DIR: directory, RIRICLOUD_DATA_DIR: directory,
      AGENT_TOKEN: 'local-test-only', MASTER_WS_URL: `ws://127.0.0.1:${master.address().port}/ws/agent`,
      SINGBOX_BINARY_PATH: resolve(binaries.singbox), SINGBOX_CONFIG_PATH: configPath
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    agent.stdout.on('data', data => { log += data; });
    agent.stderr.on('data', data => { log += data; });
  };
  const stopAgent = async () => {
    if (!agent) return;
    if (process.platform === 'win32') await promisify(execFile)('taskkill', ['/PID', String(agent.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    else agent.kill('SIGTERM');
    if (agent.exitCode === null) await Promise.race([once(agent, 'exit'), sleep(3000)]);
    agent = undefined;
  };
  try {
    target.listen(0, '127.0.0.1');
    await once(target, 'listening');
    occupied.bind(0, '127.0.0.1');
    await once(occupied, 'listening');
    const blockedPort = occupied.address().port;
    relay = { id: 'relay', tag: 'master-blind', name: 'Master 本机盲转示例', type: 'RELAY', relayMode: 'BLIND_FORWARD', protocolType: 'VLESS', status: 'ACTIVE', entryNodeId: 'local', entryPort: blockedPort, landingNodeId: 'local', landingPort: target.address().port, listen: '127.0.0.1' };
    // 夹具 HTTP 落地已运行，仅对待启动盲转入口检测；落地保持实际监听。
    const updates = await planLinePorts([relay], { nodeId: 'local', lineId: 'relay', start: 32000, probe: endpoint => endpoint.port === target.address().port ? true : probePort(endpoint) });
    entryPort = updates[0]?.patch.entryPort;
    assert.ok(entryPort && entryPort !== blockedPort);
    const apiPort = await freeTcp();
    const statsPort = await freeTcp();
    currentConfig = {
      log: { level: 'warn', timestamp: true },
      inbounds: [{ type: 'direct', tag: 'master-blind-entry', listen: '127.0.0.1', listen_port: blockedPort, override_address: '127.0.0.1', override_port: target.address().port }],
      outbounds: [{ type: 'direct', tag: 'direct' }],
      experimental: { clash_api: { external_controller: `127.0.0.1:${apiPort}`, secret: 'local-test-only' }, v2ray_api: { listen: `127.0.0.1:${statsPort}`, stats: { enabled: true } } }
    };
    master = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(master, 'listening');
    master.on('connection', socket => {
      socket.send(JSON.stringify({ type: 'auth_result', data: { success: true, nodeId: 'local-test', protocolVersion: 2 } }));
      socket.send(JSON.stringify({ type: 'config_sync', data: { version: 42, singboxConfig: currentConfig, userDeviceLimits: {} } }));
    });
    // 模拟预检通过后端口被抢占，实际 Agent 先收到冲突配置，必须明确失败而非 READY。
    startAgent();
    let conflict;
    for (let iteration = 0; iteration < 40; iteration += 1) {
      await writeFile(logPath, log);
      conflict = await inspectKernel(logPath, configPath);
      if (conflict.state === 'BIND_CONFLICT') break;
      assert.notEqual(conflict.state, 'READY');
      await sleep(100);
    }
    assert.deepEqual(conflict, { state: 'BIND_CONFLICT', port: blockedPort });
    await stopAgent();
    // 与主控 PATCH 相同的数据形状更新模型后重建配置，不修改 Agent 的落盘 JSON。
    const writes = [];
    entryPort = await prepareLinePorts(async (path, init = {}) => {
      if (path.endsWith('/nodes')) return [{ id: 'local', isLocal: true, status: 'OFFLINE' }];
      if (path.includes('/lines?')) return { data: [relay], total: 1 };
      if (init.method === 'PATCH') {
        writes.push(JSON.parse(init.body));
        Object.assign(relay, writes.at(-1));
        currentConfig.inbounds[0].listen_port = relay.entryPort;
        return { line: relay };
      }
      throw Error('unexpected request');
    }, { nodeId: 'local', lineId: 'relay', rejectedPort: blockedPort, start: 32000, probe: endpoint => endpoint.port === target.address().port ? true : probePort(endpoint) });
    assert.deepEqual(writes, [{ entryPort }]);
    startAgent();
    for (let iteration = 0; iteration < 60; iteration += 1) {
      await writeFile(logPath, log);
      const result = await inspectKernel(logPath, configPath);
      if (result.state === 'READY') { ready = true; break; }
      assert.notEqual(result.state, 'FAILED');
      assert.notEqual(result.state, 'BIND_CONFLICT');
      assert.equal(agent.exitCode, null);
      await sleep(100);
    }
    assert.equal(ready, true, `真实内核未就绪，诊断事件：${log.match(/event=\S+/g)?.join(',')}`);
    kernelPid = Number(log.match(/event=kernel_start[^\n]*\bpid=(\d+)/)?.[1]);
    assert.ok(kernelPid > 0);
    const response = await fetch(`http://127.0.0.1:${entryPort}/`, { signal: AbortSignal.timeout(2000) });
    assert.equal(await response.text(), 'blind-forward-ok');
    const applied = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(applied.inbounds[0].listen_port, entryPort);
  } finally {
    await stopAgent();
    if (kernelPid) { try { process.kill(kernelPid, 'SIGKILL'); } catch { /* 正常回收后的 PID 已不存在。 */ } }
    if (master) { for (const client of master.clients) client.terminate(); await new Promise(resolvePromise => master.close(resolvePromise)); }
    await new Promise(resolvePromise => target.close(resolvePromise));
    await new Promise(resolvePromise => occupied.close(resolvePromise));
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(await probePort({ host: '127.0.0.1', port: entryPort, protocols: ['tcp', 'udp'] }), true);
});
