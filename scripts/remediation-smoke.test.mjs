import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { stripVTControlCharacters } from 'node:util';
import { createServerBuild } from './dev-e2e-server-build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(root, 'apps/server');
const load = createRequire(join(server, 'package.json'));
const portable = value => value.split(sep).join('/');
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const enabled = process.env.RUN_REMEDIATION_SMOKE === '1';
const guard = join(root, 'scripts/remediation-smoke-runtime.mjs');

// 真正启动完整 Master、部署双库并编译源码，显式运行，避免常规脚本门禁竞争构建资源。
// RUN_REMEDIATION_SMOKE=1 node --test scripts/remediation-smoke.test.mjs
// 使用真实应用模块、维护入口、HTTP/WS；仅 Agent 的内核执行由协议客户端模拟。
test('完整 Master 隔离启动、Cookie、WS/HTTP 配置维护冒烟', { skip: enabled ? false : 'Set RUN_REMEDIATION_SMOKE=1 for isolated full-Master integration', timeout: 240_000 }, async t => {
  const secrets = new Set();
  const secret = () => { const value = randomBytes(32).toString('hex'); secrets.add(value); return value; };
  const evidence = { status: 'RUNNING', startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, phases: [], boundaries: { realAppModule: true, realMigrations: true, simulatedAgents: true, nativeAuthenticationRepeated: false, loopbackPreload: true, productionDataTouched: false } };
  const outputDirectory = join(root, 'artifacts/verification');
  const scratch = await mkdtemp(join(tmpdir(), 'riricloud-remediation-smoke-'));
  const mainDatabase = join(scratch, 'storage/main.db');
  const telemetryDatabase = join(scratch, 'storage/telemetry.db');
  const dataDirectory = join(scratch, 'storage/data');
  const lockPaths = [mainDatabase + '.maintenance.lock', telemetryDatabase + '.maintenance.lock', join(dataDirectory, '.riricloud-maintenance.lock')];
  const log = []; const rawServerLogs = []; const children = new Set();
  let buildDirectory; let instance; let base; let cookie; let client; let telemetry;
  let ws; let wsFrames = []; let entry; let landing; let account; let line;
  const sanitize = value => {
    let text = stripVTControlCharacters(String(value));
    for (const value of secrets) if (value) text = text.split(value).join('[REDACTED]');
    return text.replace(/(riricloud_access=)[^;\s]+/g, '$1[REDACTED]').replace(/enc:v1:[A-Za-z0-9+/:=_-]+/g, '[ENCRYPTED]');
  };
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const env = { ...process.env, NODE_ENV: 'test', RIRICLOUD_ENV: 'test', AUTO_SEED: 'false', JWT_SECRET: secret(), RIRICLOUD_ENCRYPTION_KEY: secret(), ADMIN_EMAIL: 'smoke-admin@example.test', ADMIN_PASSWORD: 'a9!' + secret().slice(0, 40), DATABASE_URL: 'file:' + portable(mainDatabase), TELEMETRY_DATABASE_URL: 'file:' + portable(telemetryDatabase), RIRICLOUD_DATA_DIR: dataDirectory, MASTER_DATA_DIR: dataDirectory, RIRICLOUD_BINARY_DIR: join(scratch, 'empty-static-binaries'), MASTER_LOCAL_HOST: '127.0.0.1', MASTER_LOCAL_AGENT_TOKEN: secret(), PORT: '0', RIRICLOUD_PUBLIC_URL: 'http://127.0.0.1', CORS_ORIGINS: 'http://127.0.0.1', SWAGGER_ENABLED: 'false', NODE_OPTIONS: '--import ' + JSON.stringify(pathToFileURL(guard).href) };
  secrets.add(env.ADMIN_PASSWORD);
  delete env.NODE_TEST_CONTEXT; delete env.RIRICLOUD_MAINTENANCE_LEASE;
  const spawnNode = (args, { controlled = false, timeout = 90_000, useGuard = true } = {}) => {
    const commandEnv = { ...env };
    if (!useGuard) delete commandEnv.NODE_OPTIONS;
    const child = spawn(process.execPath, args, { cwd: server, env: commandEnv, windowsHide: true, stdio: controlled ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
    const state = { child, output: '', done: false, code: null };
    children.add(state);
    const capture = chunk => { state.output += String(chunk); if (state.output.length > 8 * 1024 * 1024) child.kill(); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    state.exited = new Promise(resolveExit => {
      child.once('error', () => { state.done = true; state.code = -1; resolveExit(-1); });
      child.once('exit', code => { state.done = true; state.code = code; resolveExit(code); });
    });
    const timer = setTimeout(() => { if (!state.done) child.kill(); }, timeout); timer.unref();
    state.exited.finally(() => { clearTimeout(timer); children.delete(state); });
    return state;
  };
  const waitFor = async (get, message, timeout = 15_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const result = await get(); if (result) return result; await delay(75); }
    throw new Error(message);
  };
  const step = async (name, action, { continueOnFailure = false } = {}) => {
    const started = Date.now();
    await t.test(name, async () => {
      try { await action(); evidence.phases.push({ name, status: 'PASSED', durationMs: Date.now() - started }); }
      catch (error) { evidence.phases.push({ name, status: 'FAILED', message: sanitize(error.message), durationMs: Date.now() - started }); throw new Error(sanitize(error.message)); }
    });
    if (evidence.phases.at(-1)?.status !== 'PASSED') { if (!continueOnFailure) throw new Error('Smoke phase failed: ' + name); }
    else log.push('PASS ' + name);
  };
  const request = async (route, { method = 'GET', body, auth = cookie, status = 200, headers = {}, raw = false } = {}) => {
    const response = await globalThis.fetch(base + '/api/v1' + route, { method, headers: { ...(auth ? { Cookie: auth } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: globalThis.AbortSignal.timeout(15_000) });
    const text = await response.text();
    if (response.status !== status) throw new Error(method + ' ' + route.replace(/[a-f0-9-]{36}/g, ':id') + ' expected ' + status + ', got ' + response.status + ': ' + sanitize(text).slice(0, 700));
    return { body: raw ? text : text ? JSON.parse(text) : null, headers: response.headers };
  };
  const startMaster = async () => {
    instance = spawnNode([join(server, 'prisma/maintenance-start.js'), '--build-dir', join(buildDirectory, 'dist')], { controlled: true, timeout: 200_000 });
    await waitFor(() => {
      if (instance.done) throw new Error('Real Master startup exited: ' + sanitize(instance.output.slice(-4000)));
      return instance.output.includes('HTTP listener ready');
    }, 'Real Master startup timed out: ' + sanitize(instance.output.slice(-2000)), 65_000);
    const listener = instance.output.split(/\r?\n/).filter(value => value.startsWith('__RIRI_SMOKE_LISTEN__')).map(value => JSON.parse(value.slice('__RIRI_SMOKE_LISTEN__'.length))).find(value => value.entry === 'main.js');
    check(listener?.address === '127.0.0.1' && listener.port > 0, 'Master must bind an ephemeral loopback port');
    base = 'http://127.0.0.1:' + listener.port;
    evidence.listeners ??= []; evidence.listeners.push({ address: listener.address, port: listener.port });
    await request('/system/version', { auth: null });
  };
  const stopMaster = async () => {
    if (ws) { const current = ws; ws = undefined; if (current.readyState < 2) current.close(); await waitFor(() => current.readyState === 3, 'Owned WebSocket did not close', 3000).catch(() => current.terminate()); }
    if (instance && !instance.done) {
      instance.child.send({ type: 'riricloud-smoke-shutdown' });
      await waitFor(() => instance.done, 'Real Master failed to shut down gracefully', 15_000);
      check(instance.code === 0, 'Maintenance start must acknowledge clean application shutdown');
    }
    if (instance) { rawServerLogs.push(instance.output); instance = undefined; }
  };
  const heartbeat = (version = 0, running = false, overrides = {}) => ({ protocolVersion: 2, cpuUsage: 1, memoryUsage: 1, bandwidthRate: 0, trafficSnapshots: [], kernelRunning: running, appliedConfigVersion: version, lastError: '', agentVersion: 'smoke-simulated', osArch: 'windows/amd64', kernelVersion: 'smoke-no-kernel', ...overrides });
  const poll = async (version = 0, running = false, overrides = {}) => (await request('/agent/poll', { method: 'POST', body: heartbeat(version, running, overrides), auth: null, headers: { 'X-Agent-Token': landing.agentToken }, status: 201 })).body;
  const connectEntry = async () => {
    const WebSocket = load('ws'); wsFrames = [];
    ws = new WebSocket(base.replace('http:', 'ws:') + '/ws/agent', { headers: { 'X-Agent-Token': entry.agentToken } });
    ws.on('message', raw => { const frame = JSON.parse(raw.toString()); wsFrames.push(frame); });
    ws.on('error', () => {});
    await waitFor(() => wsFrames.find(frame => frame.type === 'auth_result' && frame.data.success), 'Real WS authentication did not succeed');
  };
  const row = async () => (await client.$queryRawUnsafe('SELECT * FROM LineCredentialRotation WHERE lineId = ?', line.id))[0];
  const status = async () => (await request('/admin/lines/' + line.id + '/credentials/status')).body;
  const waitRow = async (stage, accepted) => {
    try { return await waitFor(async () => { const value = await row(); return value?.stage === stage && (accepted === undefined || Boolean(value.accepted) === accepted) ? value : null; }, 'Rotation did not reach ' + stage + (accepted === undefined ? '' : '/accepted=' + accepted)); }
    catch (error) {
      const current = await row();
      throw new Error(error.message + '; observed ' + JSON.stringify({ stage: current?.stage, accepted: current?.accepted, expectedConfigVersion: current?.expectedConfigVersion?.toString(), errorCode: current?.errorCode, wsConfigVersions: wsFrames.filter(frame => frame.type === 'config_sync').map(frame => frame.data.version) }));
    }
  };
  const entryConfig = async stage => {
    await waitRow(stage);
    return waitFor(async () => { const current = await row(); return wsFrames.find(frame => frame.type === 'config_sync' && frame.data.version === Number(current.expectedConfigVersion))?.data; }, 'WS did not deliver the persisted expected config for ' + stage);
  };
  const send = (type, data) => ws.send(JSON.stringify({ type, data }));
  const acceptEntry = async (config, stage) => {
    send('config_apply_result', { version: config.version, success: true, message: 'Accepted by smoke simulator' });
    await waitRow(stage, true);
    send('heartbeat', heartbeat(config.version, true));
  };
  const rememberConfigSecrets = config => {
    for (const object of [...(config?.inbounds || []), ...(config?.outbounds || [])]) {
      for (const key of ['password', 'uuid', 'private_key']) if (typeof object[key] === 'string') secrets.add(object[key]);
      for (const user of object.users || []) for (const key of ['uuid', 'password', 'username', 'name']) if (typeof user[key] === 'string') secrets.add(user[key]);
    }
  };
  const verifyNoSecrets = (value, label = 'value') => { const text = JSON.stringify(value); for (const value of secrets) if (value.length > 7 && text.includes(value)) throw new Error('Sensitive material appeared at ' + label + '; length=' + value.length + '; fingerprint=' + createHash('sha256').update(value).digest('hex').slice(0, 12)); };
  const finishLandingAndEntry = async () => {
    await waitRow('APPLYING_LANDING');
    const payload = await poll(); rememberConfigSecrets(payload.singboxConfig);
    const current = await row();
    check(payload.needUpdate && payload.version === Number(current.expectedConfigVersion), 'HTTP configuration must match captured landing version');
    const landingInbound = payload.singboxConfig.inbounds.find(item => item.tag === 'smoke-relay-landing');
    check(landingInbound?.users?.length === 1, 'Landing must contain exactly one scoped relay identity');
    const candidate = landingInbound.users[0].uuid; secrets.add(candidate);
    await poll(payload.version, false, { configApplyResults: [{ version: payload.version, success: true, message: 'Accepted' }] });
    await waitRow('APPLYING_LANDING', true);
    check((await status()).state === 'APPLYING_LANDING', 'Acceptance alone must not report running success');
    await poll(payload.version, true);
    const restored = await entryConfig('RESTORING_ENTRY'); rememberConfigSecrets(restored.singboxConfig);
    const publicInbound = restored.singboxConfig.inbounds.find(item => item.tag === 'smoke-relay-entry');
    const outbound = restored.singboxConfig.outbounds.find(item => item.tag === 'relay-out-' + line.id);
    check(publicInbound?.users?.length === 1 && publicInbound.users[0].uuid === account.uuid, 'Public entry must contain the real authorized subscription account only');
    check(outbound?.uuid === candidate && outbound.server_port === 23456, 'Actual entry outbound and landing inbound credentials must agree');
    check(publicInbound.users.every(user => user.uuid !== candidate), 'Internal relay credential must not authenticate at the public entry');
    check(restored.singboxConfig.route.rules.some(rule => rule.inbound?.includes('smoke-relay-entry') && rule.outbound === outbound.tag), 'Entry route must select the authenticated relay outbound');
    await acceptEntry(restored, 'RESTORING_ENTRY');
    await waitRow('CONFIRMED');
    const view = await status(); verifyNoSecrets(view);
    check(view.state === 'CONFIRMED' && view.activeVersion === view.targetVersion, 'Confirmed response must represent the active target version');
    return { candidate, restored, landingVersion: payload.version };
  };
  try {
    await step('最终迁移快照与独立 Master 编译', async () => {
      // 旧本机 Agent 引导会检查这些固定目录；发现目录即拒绝运行，不能污染现有 Token。
      for (const directory of [resolve(server, 'data/agent'), resolve(root, 'data/agent'), resolve('/app/data/agent')]) check(!existsSync(directory), 'Existing legacy agent token directory prevents safe isolated bootstrap');
      await mkdir(dataDirectory, { recursive: true });
      const schema = await readFile(join(server, 'prisma/schema.prisma'), 'utf8');
      const migration = await readFile(join(server, 'prisma/migrations/20261117040000_line_credentials/migration.sql'), 'utf8');
      check(schema.includes('landingCredentialVersion') && migration.includes('landingCredentialVersion'), 'Final rotation migration is not available yet');
      const sourceFiles = ['prisma/schema.prisma', 'prisma/migrations/20261117040000_line_credentials/migration.sql', 'src/line-credentials/line-credentials.service.ts', 'src/agent-gateway/agent-gateway.service.ts', 'src/nodes/nodes.service.ts', 'src/binaries/binaries.controller.ts', 'src/line-credentials/line-auth-rejections.ts', 'src/system-logs/masking.util.ts', 'src/probe/probe-resource.service.ts', 'src/probe/probe-task.service.ts', 'src/probe/probe-subscription.ts'];
      const fingerprint = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await readFile(join(server, file))).digest('hex')])));
      evidence.sourceBeforeBuild = await fingerprint();
      const config = await createServerBuild(server); buildDirectory = dirname(config);
      const build = spawnNode([load.resolve('typescript/lib/tsc.js'), '-p', config], { useGuard: false });
      await build.exited;
      log.push(sanitize(build.output));
      check(build.code === 0, 'Independent TypeScript build failed: ' + sanitize(build.output.slice(-2000)));
      evidence.sourceAfterBuild = await fingerprint();
      check(JSON.stringify(evidence.sourceBeforeBuild) === JSON.stringify(evidence.sourceAfterBuild), 'Source changed during build; rerun against a coherent snapshot');
      check(existsSync(join(buildDirectory, 'dist/main.js')), 'Isolated build entry is missing');
    });
    await step('真实维护启动、AppModule DI 与双库迁移', async () => {
      await startMaster();
      const { PrismaClient } = load('@prisma/client'); const { PrismaClient: TelemetryClient } = load('@prisma/telemetry-client');
      client = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
      telemetry = new TelemetryClient({ datasources: { db: { url: env.TELEMETRY_DATABASE_URL } } });
      check((await client.$queryRawUnsafe('PRAGMA table_info("LineCredentialRotation")')).some(column => column.name === 'landingCredentialVersion'), 'Final credential field was not migrated');
      const migrations = await client.$queryRawUnsafe('SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations');
      const telemetryMigrations = await telemetry.$queryRawUnsafe('SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations');
      check(migrations.length > 0 && telemetryMigrations.length > 0 && [...migrations, ...telemetryMigrations].every(item => item.finished_at && !item.rolled_back_at), 'A database migration did not complete');
      check(await client.user.count() === 1 && await client.subscription.count() === 0, 'Isolated bootstrap must not demo-seed users or subscriptions');
      check(await client.node.count() === 1, 'Only the real built-in bootstrap node should exist before fixture setup');
      evidence.migrations = { main: migrations.length, telemetry: telemetryMigrations.length, finalColumnPresent: true };
    });
    await step('运行中维护锁拒绝第二启动和冷备', async () => {
      check(lockPaths.every(existsSync), 'All three storage locks must be held by the running Master');
      for (const args of [[join(server, 'prisma/maintenance-start.js'), '--build-dir', join(buildDirectory, 'dist')], [join(server, 'prisma/maintenance-cli.js'), 'backup:create', '--destination', join(scratch, 'blocked-backup')]]) {
        const blocked = spawnNode(args); await blocked.exited;
        log.push(sanitize(blocked.output));
        check(blocked.code === 3, 'Concurrent maintenance must return LOCKED exit code; received ' + blocked.code + ': ' + sanitize(blocked.output).slice(-1500));
      }
      check(!existsSync(join(scratch, 'blocked-backup')), 'Rejected backup must not publish any output');
    });
    await step('Cookie 管理员鉴权和公开设置边界', async () => {
      await request('/admin/settings', { auth: null, status: 401 });
      const login = await request('/auth/login', { method: 'POST', body: { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }, auth: null });
      check(login.body.authenticated === true && !('accessToken' in login.body), 'Login must not expose the bearer token in JSON');
      const header = login.headers.get('set-cookie');
      check(header?.includes('HttpOnly') && header.includes('SameSite=Lax'), 'Authentication cookie security attributes are missing');
      cookie = header.split(';')[0]; secrets.add(cookie.split('=')[1]);
      check((await request('/auth/me')).body.role === 'ADMIN', 'Cookie authentication did not resolve an administrator');
      const publicInfo = (await request('/system/public-info', { auth: null })).body;
      check(!Object.hasOwn(publicInfo, 'lineSpeedtestUserId'), 'Probe account selection must not be public');
    });
    await step('真实订阅拨测账号创建、验证和设置持久化', async () => {
      const plan = (await request('/admin/plans', { method: 'POST', body: { name: 'smoke isolated plan', durationDays: 30, trafficLimitBytes: 1_073_741_824, lineMatchMode: 'ALL' }, status: 201 })).body;
      const userPassword = 'a9!' + secret().slice(0, 40); secrets.add(userPassword);
      account = (await request('/admin/users', { method: 'POST', body: { email: 'smoke-probe@example.test', password: userPassword, planId: plan.id }, status: 201 })).body;
      check(typeof account.id === 'string', 'Created account has no identity');
      const stored = await client.user.findUnique({ where: { id: account.id } }); account.uuid = stored.uuid; secrets.add(stored.uuid);
      await request('/admin/users/' + account.id, { method: 'PATCH', body: { emailVerified: true } });
      await request('/admin/settings', { method: 'PUT', body: { lineSpeedtestUserId: account.id } });
      check((await request('/admin/settings')).body.lineSpeedtestUserId === account.id, 'Probe account setting did not persist');
      const userLogin = await request('/auth/login', { method: 'POST', body: { email: 'smoke-probe@example.test', password: userPassword }, auth: null });
      account.cookie = userLogin.headers.get('set-cookie').split(';')[0]; secrets.add(account.cookie.split('=')[1]);
      await request('/admin/settings', { auth: account.cookie, status: 403 });
    });
    await step('两节点、真实 WS/HTTP 接入和协议中继创建', async () => {
      entry = (await request('/admin/nodes', { method: 'POST', body: { name: 'smoke WS entry', serverHost: '203.0.113.11', communicationMode: 'WS' }, status: 201 })).body;
      landing = (await request('/admin/nodes', { method: 'POST', body: { name: 'smoke HTTP landing', serverHost: '203.0.113.12', communicationMode: 'HTTP' }, status: 201 })).body;
      secrets.add(entry.agentToken); secrets.add(landing.agentToken);
      check(!/[?&]token=/.test(JSON.stringify([entry.installCommands, landing.installCommands])), 'Generated installers must not put credentials in URLs');
      await request('/downloads/agent-installer?token=' + encodeURIComponent(entry.agentToken), { auth: null, status: 401 });
      await request('/downloads/agent-installer?token=' + encodeURIComponent(entry.agentToken), { auth: null, headers: { 'X-Agent-Token': entry.agentToken }, status: 401 });
      const installer = await request('/downloads/agent-installer?platform=linux-amd64&format=sh', { auth: null, headers: { 'X-Agent-Token': entry.agentToken }, raw: true });
      check(installer.body.includes(entry.agentToken) && installer.headers.get('cache-control') === 'no-store', 'Header-authorized preset installer must remain functional and uncacheable');
      await connectEntry(); await poll();
      await request('/agent/poll', { method: 'POST', body: heartbeat(), auth: null, headers: { 'X-Agent-Token': secret() }, status: 401 });
      line = (await request('/admin/lines', { method: 'POST', body: { name: 'smoke protocol relay', tag: 'smoke-relay', type: 'RELAY', relayMode: 'PROTOCOL_PROXY', protocolType: 'VMESS', params: { tls: { enabled: false, mode: 'none' } }, entryNodeId: entry.node.id, entryPort: 23455, landingNodeId: landing.node.id, landingPort: 23456, isPublic: true }, status: 201 })).body.line;
      check(typeof line?.id === 'string', 'Relay creation did not return a line');
      await request('/admin/lines/' + line.id + '/credentials/status', { auth: null, status: 401 });
      await request('/admin/lines/' + line.id + '/credentials/status', { auth: account.cookie, status: 403 });
    });
    await step('入口停用确认不被单独回执、旧版本或内核未启动推进', async () => {
      await request('/admin/lines/' + line.id + '/credentials/rotate', { method: 'POST', status: 202 });
      // 线路创建会触发 250ms 防抖全量下发；先等待预期版本稳定，不能回执已被取代的配置。
      let stableVersion; let stableSince = Date.now();
      await waitFor(async () => { const current = await row(); const version = current?.expectedConfigVersion?.toString(); if (version !== stableVersion) { stableVersion = version; stableSince = Date.now(); } return version && Date.now() - stableSince >= 600; }, 'Initial configuration did not stabilize');
      const stopped = await entryConfig('STOPPING_ENTRY');
      check(!(stopped.singboxConfig.inbounds || []).some(item => item.tag === 'smoke-relay-entry'), 'Entry must be absent before landing activation');
      send('heartbeat', heartbeat(stopped.version, true)); await delay(200);
      check((await row()).stage === 'STOPPING_ENTRY', 'Heartbeat without acceptance advanced maintenance');
      send('config_apply_result', { version: stopped.version, success: true, message: 'Accepted' }); await waitRow('STOPPING_ENTRY', true);
      send('heartbeat', heartbeat(stopped.version - 1, true)); await delay(200);
      check((await row()).stage === 'STOPPING_ENTRY', 'Stale heartbeat advanced maintenance');
      send('heartbeat', heartbeat(stopped.version, false));
      await waitRow('FAILED');
      check((await status()).errorCode === 'KERNEL_NOT_RUNNING', 'A stopped kernel must fail closed');
      await request('/admin/lines/' + line.id + '/credentials/rotate', { method: 'POST', status: 202 });
      const retry = await entryConfig('STOPPING_ENTRY');
      await acceptEntry(retry, 'STOPPING_ENTRY'); await waitRow('APPLYING_LANDING');
    });
    let first;
    await step('HTTP 落地确认与 WS 入口恢复使用一致随机凭据', async () => { first = await finishLandingAndEntry(); });
    let operation; let candidateHash;
    await step('维护冲突、幂等轮换和中途重启持久化', async () => {
      operation = (await request('/admin/lines/' + line.id + '/credentials/rotate', { method: 'POST', status: 202 })).body;
      const duplicate = (await request('/admin/lines/' + line.id + '/credentials/rotate', { method: 'POST', status: 202 })).body;
      check(operation.operationId === duplicate.operationId && operation.targetVersion === duplicate.targetVersion, 'Duplicate rotate created another operation');
      await request('/admin/nodes/' + entry.node.id, { method: 'PATCH', body: { serverHost: '203.0.113.99' }, status: 409 });
      const stopped = await entryConfig('STOPPING_ENTRY'); await acceptEntry(stopped, 'STOPPING_ENTRY');
      await waitRow('APPLYING_LANDING');
      const desired = await poll(); rememberConfigSecrets(desired.singboxConfig);
      const uuid = desired.singboxConfig.inbounds.find(item => item.tag === 'smoke-relay-landing').users[0].uuid;
      check(uuid !== first.candidate, 'A real rotation reused the previous identity');
      candidateHash = createHash('sha256').update(uuid).digest('hex');
      await stopMaster(); check(lockPaths.every(file => !existsSync(file)), 'Clean shutdown did not release all locks');
      // 测试自己的只读 Prisma 连接也必须关闭，避免 Windows SQLite 迁移被外部观察连接阻塞。
      await client.$disconnect(); await telemetry.$disconnect();
      await startMaster(); await connectEntry();
      const resumed = await poll(); rememberConfigSecrets(resumed.singboxConfig);
      check(createHash('sha256').update(resumed.singboxConfig.inbounds.find(item => item.tag === 'smoke-relay-landing').users[0].uuid).digest('hex') === candidateHash, 'Restart replaced the pending candidate');
      const resumedStatus = await status();
      check(resumedStatus.operationId === operation.operationId && resumedStatus.targetVersion === operation.targetVersion, 'Restart lost the operation identity');
      await poll(first.landingVersion, true, { configApplyResults: [{ version: first.landingVersion, success: true, message: 'Stale acceptance' }] });
      check((await row()).stage === 'APPLYING_LANDING', 'Pre-restart stale acceptance advanced maintenance');
    });
    await step('失败消息脱敏、入口保持停用及同候选重试', async () => {
      const desired = await poll(); const inbound = desired.singboxConfig.inbounds.find(item => item.tag === 'smoke-relay-landing');
      const leaked = inbound.users[0].uuid; secrets.add(leaked);
      await poll(desired.version, false, { configApplyResults: [{ version: desired.version, success: false, message: 'runtime rejected password=' + leaked }] });
      await waitRow('FAILED');
      verifyNoSecrets(await status());
      const detail = (await request('/admin/nodes/' + landing.node.id)).body;
      // 节点详情整体脱敏单独验收，诊断字段仍不得回显被拒绝配置中的中继身份。
      verifyNoSecrets(detail.node.configError);
      const failedEntry = await entryConfig('FAILED');
      check(!(failedEntry.singboxConfig.inbounds || []).some(item => item.tag === 'smoke-relay-entry'), 'Failed rotation reopened the entry');
      const retry = (await request('/admin/lines/' + line.id + '/credentials/rotate', { method: 'POST', status: 202 })).body;
      check(retry.operationId === operation.operationId && retry.targetVersion === operation.targetVersion, 'Retry replaced the operation or candidate version');
      const stopped = await entryConfig('STOPPING_ENTRY'); await acceptEntry(stopped, 'STOPPING_ENTRY');
      const confirmed = await finishLandingAndEntry();
      check(createHash('sha256').update(confirmed.candidate).digest('hex') === candidateHash, 'Retry did not preserve the candidate credential');
      const records = await client.$queryRawUnsafe('SELECT version, status, encryptedPayload FROM LineCredential WHERE lineId = ? ORDER BY version', line.id);
      check(records.length === 2 && records[0].status === 'REVOKED' && records[0].encryptedPayload === null && records[1].status === 'ACTIVE', 'Old authentication material was not revoked after confirmation');
      check(records[1].encryptedPayload?.startsWith('enc:v1:') && !records[1].encryptedPayload.includes(confirmed.candidate), 'Active credential must remain encrypted at rest');
    });
    await step('落地拒绝通过真实 HTTP 日志通道按配置与线路计数，重试不重复', async () => {
      const config = await poll(); rememberConfigSecrets(config.singboxConfig);
      check(config.needUpdate && typeof config.version === 'number', 'Expected a captured landing configuration');
      const rejection = { source: 'SINGBOX', level: 'ERROR', module: 'Singbox', message: 'inbound/vmess[smoke-relay-landing]: process connection from 127.0.0.1:40000: bad request', metadata: { configVersion: config.version }, agentInstanceId: 'smoke-auth-rejection', sequence: 1 };
      await poll(config.version, true, { logs: [rejection, rejection, { ...rejection, sequence: 2 }] });
      evidence.authRejections = { lineId: line.id, configVersion: config.version, reported: 3, expectedUnique: 2 };
    });
    await step('共享 SS 拨测在真实 API 拨号前返回不可计量而非成功', async () => {
      const password = secret();
      const created = (await request('/admin/lines', { method: 'POST', status: 201, body: { name: 'unmetered shared SS', type: 'DIRECT', protocolType: 'SHADOWSOCKS', entryNodeId: entry.node.id, entryPort: 23457, isPublic: true, params: { mode: 'shared', method: 'aes-128-gcm', password } } })).body.line;
      const before = await client.subscription.findUniqueOrThrow({ where: { userId: account.id } });
      const task = (await request('/admin/lines/' + created.id + '/speedtest', { method: 'POST', body: {}, status: 202 })).body;
      const result = await waitFor(async () => (await request('/admin/probe-tasks/' + task.taskId + '/results')).body.data[0], 'Shared SS task did not produce a terminal result');
      check(result.status === 'UNSUPPORTED' && result.errorCode === 'SPEEDTEST_LINE_UNMETERED' && result.applied === false && result.latencyMs === null && result.engine === null, 'Unmetered shared SS was executed or recorded as successful');
      check((await client.subscription.findUniqueOrThrow({ where: { userId: account.id } })).trafficUsedBytes === before.trafficUsedBytes, 'Rejected unmetered request must not invent account billing');
      verifyNoSecrets(result);
      evidence.unmeteredSharedProbeRejected = true;
    });
    await step('节点详情 API 不在安装命令中重新暴露一次性 Agent Token', async () => {
      const detail = (await request('/admin/nodes/' + landing.node.id)).body;
      const exposedPaths = [];
      const visit = (value, location = '') => {
        if (typeof value === 'string' && value.includes(landing.agentToken)) exposedPaths.push(location);
        else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) visit(item, location ? location + '.' + key : key);
      };
      visit(detail);
      if (exposedPaths.length) evidence.findings = [...(evidence.findings || []), { code: 'NODE_DETAIL_AGENT_TOKEN_DISCLOSURE', endpoint: 'GET /api/v1/admin/nodes/:id', paths: exposedPaths, reproduction: 'Create node, retain one-time agentToken in memory, GET node detail and compare installation command strings. No token value is logged.' }];
      check(exposedPaths.length === 0, 'Agent token reappeared at: ' + exposedPaths.join(', '));
      verifyNoSecrets((await request('/admin/nodes')).body, 'node list before rotate');
      const previousToken = landing.agentToken;
      const rotated = (await request('/admin/nodes/' + landing.node.id + '/rotate-token', { method: 'POST', status: 201 })).body;
      check(typeof rotated.agentToken === 'string' && rotated.agentToken !== previousToken, 'Rotation must return a fresh one-time token');
      secrets.add(rotated.agentToken);
      verifyNoSecrets((await request('/admin/nodes/' + landing.node.id)).body, 'node detail after rotate');
      verifyNoSecrets((await request('/admin/nodes')).body, 'node list after rotate');
      await request('/agent/poll', { method: 'POST', body: heartbeat(), auth: null, headers: { 'X-Agent-Token': previousToken }, status: 401 });
      landing.agentToken = rotated.agentToken;
      await poll();
    }, { continueOnFailure: true });
    await step('撤销订阅用户后真实公开入站收敛，设置拒绝不可用账号', async () => {
      await request('/admin/users/' + account.id, { method: 'PATCH', body: { isActive: false } });
      await waitFor(() => wsFrames.filter(frame => frame.type === 'config_sync').at(-1)?.data.singboxConfig.inbounds.every(item => item.tag !== 'smoke-relay-entry'), 'Revoked subscription identity remained in the entry config');
      await request('/admin/settings', { method: 'PUT', body: { lineSpeedtestUserId: account.id }, status: 400 });
      verifyNoSecrets((await request('/admin/lines/' + line.id)).body);
    });
    await step('日志无秘密且进程优雅退出释放全部维护锁', async () => {
      await stopMaster();
      check(lockPaths.every(file => !existsSync(file)), 'Owned storage lock remained after graceful shutdown');
      for (const text of rawServerLogs) verifyNoSecrets(text);
      const logs = await telemetry.$queryRawUnsafe('SELECT module, message, metadata FROM SystemLog');
      const authCounters = logs.filter(item => item.module === 'LineCredentialAuth').map(item => JSON.parse(item.metadata));
      check(authCounters.reduce((total, item) => total + item.count, 0) === 2 && authCounters.every(item => item.lineId === line.id && item.port === 23456 && item.configVersion === evidence.authRejections.configVersion), 'Landing authentication counters lost scope or duplicated a retried event');
      evidence.authRejections.persistedUnique = authCounters.reduce((total, item) => total + item.count, 0);
      verifyNoSecrets(logs);
      evidence.logRecordsChecked = logs.length;
      evidence.cleanup = { gracefulShutdown: true, storageLocksReleased: true };
    });
    evidence.status = evidence.phases.every(phase => phase.status === 'PASSED') ? 'PASSED' : 'FAILED';
  } catch (error) {
    evidence.status = 'FAILED'; evidence.error = sanitize(error.message);
    throw new Error(evidence.error);
  } finally {
    try { await stopMaster(); } catch (error) { log.push('Shutdown: ' + sanitize(error.message)); }
    await client?.$disconnect(); await telemetry?.$disconnect();
    for (const state of children) { if (!state.done) { state.child.kill(); await Promise.race([state.exited, delay(3000)]); } }
    for (const output of rawServerLogs) log.push(sanitize(output));
    await mkdir(outputDirectory, { recursive: true });
    evidence.finishedAt = new Date().toISOString();
    evidence.files = { json: 'artifacts/verification/remediation-smoke.json', log: 'artifacts/verification/remediation-smoke.log' };
    // 仅删除本次 mkdtemp 创建且已证明位于指定父目录下的临时目录。
    const ownedRemove = async (directory, parent, prefix) => {
      if (!directory) return;
      const resolved = resolve(directory); const rel = relative(resolve(parent), resolved);
      check(rel && !rel.startsWith('..') && !rel.includes(sep) && rel.startsWith(prefix), 'Refused cleanup outside owned scratch directory');
      await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    };
    try { await ownedRemove(buildDirectory, join(server, '.cache'), 'dev-e2e-server-'); await ownedRemove(scratch, tmpdir(), 'riricloud-remediation-smoke-'); evidence.scratchRemoved = true; }
    catch (error) { evidence.scratchRemoved = false; log.push('Cleanup: ' + sanitize(error.message)); }
    await writeFile(join(outputDirectory, 'remediation-smoke.json'), JSON.stringify(evidence, null, 2) + '\n');
    await writeFile(join(outputDirectory, 'remediation-smoke.log'), log.join('\n') + '\n');
  }
});
