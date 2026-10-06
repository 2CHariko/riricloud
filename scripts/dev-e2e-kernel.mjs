import net from 'node:net';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const field = (line, key) => line.match(new RegExp(`(?:^|\\s)${key}=(?:"([^"]*)"|([^\\s]+))`))?.slice(1).find(value => value !== undefined);

// 仅评估最近收到的配置及最近内核实例；历史 started 或其他实例 API 不构成就绪证据。
export function evaluateKernelLog(contents, { now = Date.now(), alive: processAlive = alive, stableMs = 3000 } = {}) {
  const lines = contents.split(/\r?\n/);
  const receiptIndex = lines.findLastIndex(line => field(line, 'event') === 'config_receipt');
  const receipt = lines[receiptIndex];
  const index = lines.findLastIndex(line => field(line, 'event') === 'kernel_start');
  if (lines.slice(Math.max(receiptIndex, index) + 1).some(line => field(line, 'event') === 'config_check' && field(line, 'success') === 'false'
    || field(line, 'event') === 'kernel_start_failed')) return { state: 'FAILED' };
  if (index < 0) return { state: 'WAIT' };
  const start = lines[index];
  const version = field(start, 'configVersion');
  if (!receipt || field(receipt, 'configVersion') !== version) return { state: 'WAIT' };
  const instance = field(start, 'kernelInstanceId');
  const later = lines.slice(index + 1).filter(line => !field(line, 'kernelInstanceId') || field(line, 'kernelInstanceId') === instance);
  const failure = later.findLast(line => /\bFATAL\b/.test(line));
  if (failure) {
    const bind = failure.match(/listen (?:tcp[46]?|udp[46]?) (?:\[[^\]]+\]|[^\s:]+):(\d+): bind:/);
    if (bind && /forbidden by its access permissions|address already in use|permission denied|Only one usage|access is denied/i.test(failure)) return { state: 'BIND_CONFLICT', port: Number(bind[1]) };
    return { state: 'FAILED' };
  }
  if (later.some(line => ['kernel_exit', 'kernel_stop'].includes(field(line, 'event')))) return { state: 'WAIT' };
  const pid = Number(field(start, 'pid'));
  const startedAt = Date.parse(field(start, 'time'));
  // 当前日志时间戳精度为秒，额外一秒余量避免舍入后不足稳定窗口。
  if (!instance || !Number.isInteger(pid) || pid < 1 || !processAlive(pid) || !Number.isFinite(startedAt) || now - startedAt < stableMs + 1000) return { state: 'WAIT' };
  return { state: 'PROBE', pid, instance, version };
}

function probeTcp({ host, port }) {
  return new Promise(resolvePromise => {
    const socket = net.connect({ host, port });
    const finish = result => { socket.destroy(); resolvePromise(result); };
    socket.setTimeout(500, () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('connect', () => finish(true));
  });
}

function probeApi(address, secret) {
  return new Promise(resolvePromise => {
    let url;
    try { url = new URL(`http://${address}/version`); } catch { resolvePromise(false); return; }
    if (!['127.0.0.1', '[::1]'].includes(url.hostname)) { resolvePromise(false); return; }
    const request = http.get(url, { headers: secret ? { Authorization: `Bearer ${secret}` } : {}, timeout: 500 }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 4096) response.destroy(); });
      response.once('error', () => resolvePromise(false));
      response.once('close', () => resolvePromise(false));
      response.once('end', () => {
        try { resolvePromise(response.statusCode === 200 && typeof JSON.parse(body).version === 'string'); } catch { resolvePromise(false); }
      });
    });
    request.once('timeout', () => request.destroy());
    request.once('error', () => resolvePromise(false));
  });
}

export async function inspectKernel(logPath, configPath, dependencies = {}) {
  const read = dependencies.read ?? (path => readFile(path, 'utf8'));
  const before = evaluateKernelLog(await read(logPath), dependencies);
  if (before.state !== 'PROBE') return before;
  let config;
  try { config = JSON.parse(await read(configPath)); } catch { return { state: 'WAIT' }; }
  const api = config.experimental?.clash_api;
  if (!api?.external_controller || !await (dependencies.probeApi ?? probeApi)(api.external_controller, api.secret)) return { state: 'WAIT' };
  for (const inbound of config.inbounds ?? []) {
    if (!inbound.listen_port || ['hysteria2', 'tuic', 'tun'].includes(inbound.type) || inbound.network === 'udp') continue;
    const host = inbound.listen === '0.0.0.0' ? '127.0.0.1' : inbound.listen === '::' ? '::1' : inbound.listen;
    if (!net.isIP(host) || !await (dependencies.probeTcp ?? probeTcp)({ host, port: inbound.listen_port })) return { state: 'WAIT' };
  }
  const after = evaluateKernelLog(await read(logPath), dependencies);
  return after.state === 'PROBE' && after.instance === before.instance && after.version === before.version
    ? { state: 'READY' } : after.state === 'PROBE' ? { state: 'WAIT' } : after;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  inspectKernel(process.argv[2], process.argv[3]).then(result => console.log(`${result.state}${result.port ? ` ${result.port}` : ''}`))
    .catch(() => { console.log('WAIT'); });
}
