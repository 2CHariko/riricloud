import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateKernelLog, inspectKernel } from './dev-e2e-kernel.mjs';

const receipt = 'time="2026-10-07T00:03:47+08:00" event=config_receipt configVersion=42\n';
const start = 'time="2026-10-07T00:03:47+08:00" event=kernel_start configVersion=42 kernelInstanceId=abc pid=123 msg="sing-box started; process only, network health unverified"\n';
const fatal = 'time="2026-10-07T00:03:47+08:00" kernelInstanceId=abc msg="FATAL start service: start inbound/direct[master-blind-entry]: listen udp4 0.0.0.0:62470: bind: An attempt was made to access a socket in a way forbidden by its access permissions."\n';
const now = Date.parse('2026-10-07T00:03:52+08:00');

test('日志已启动后立即退出不能通过就绪，识别 Windows UDP 绑定失败', () => {
  assert.deepEqual(evaluateKernelLog(receipt + start + fatal, { now, alive: () => false }), { state: 'BIND_CONFLICT', port: 62470 });
  assert.equal(evaluateKernelLog(receipt + start + 'event=kernel_exit kernelInstanceId=abc expected=false\n', { now, alive: () => true }).state, 'WAIT');
});

test('配置接受、新进程不足稳定窗口、旧配置及旧 API 不代表就绪', () => {
  assert.equal(evaluateKernelLog(receipt, { now, alive: () => true }).state, 'WAIT');
  assert.equal(evaluateKernelLog(receipt + start, { now: now - 4000, alive: () => true }).state, 'WAIT');
  assert.equal(evaluateKernelLog(receipt + start + 'event=config_receipt configVersion=43\n', { now, alive: () => true }).state, 'WAIT');
  assert.equal(evaluateKernelLog(receipt + start, { now, alive: () => false }).state, 'WAIT');
  assert.equal(evaluateKernelLog(receipt + start, { now, alive: () => true }).state, 'PROBE');
});

test('新实例恢复不被旧错误否决，非绑定 FATAL 不触发端口调整', () => {
  const next = start.replaceAll('abc', 'def');
  assert.equal(evaluateKernelLog(receipt + start + fatal + next, { now, alive: () => true }).state, 'PROBE');
  assert.equal(evaluateKernelLog(receipt + start + 'kernelInstanceId=abc msg="FATAL invalid certificate"\n', { now, alive: () => true }).state, 'FAILED');
  assert.equal(evaluateKernelLog(receipt + 'event=config_check success=false\n', { now }).state, 'FAILED');
});

test('真实就绪读取 Agent 生效配置中的管理地址，检查 API 和 TCP 入站', async () => {
  const config = { experimental: { clash_api: { external_controller: '127.0.0.1:20086', secret: 'private' } }, inbounds: [{ type: 'vless', listen: '0.0.0.0', listen_port: 25000 }, { type: 'direct', listen: '0.0.0.0', listen_port: 25001 }] };
  const seen = [];
  const dependencies = { now, alive: () => true, read: async path => path === 'log' ? receipt + start : JSON.stringify(config), probeApi: async (address, secret) => { seen.push([address, secret]); return true; }, probeTcp: async endpoint => { seen.push(endpoint); return true; } };
  assert.equal((await inspectKernel('log', 'config', dependencies)).state, 'READY');
  assert.deepEqual(seen, [['127.0.0.1:20086', 'private'], { host: '127.0.0.1', port: 25000 }, { host: '127.0.0.1', port: 25001 }]);
  assert.equal((await inspectKernel('log', 'config', { ...dependencies, probeApi: async () => false })).state, 'WAIT');
  assert.equal((await inspectKernel('log', 'config', { ...dependencies, probeTcp: async () => false })).state, 'WAIT');
  assert.equal((await inspectKernel('log', 'config', { ...dependencies, read: async path => path === 'log' ? receipt + start : '{' })).state, 'WAIT');
});
