import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { URL } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import ts from 'typescript';
const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
function load(path, context = {}) {
  const exports = {};
  runInNewContext(ts.transpileModule(source(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { exports, ...context });
  return exports;
}
test('cancellation, timeout and actual network failures are distinct', () => {
  const { classifyApiFailure } = load('./api-failure.ts');
  assert.equal(classifyApiFailure({ code: 'ERR_CANCELED' }), 'CANCELED');
  assert.equal(classifyApiFailure({ code: 'ECONNABORTED' }), 'TIMEOUT');
  assert.equal(classifyApiFailure({ code: 'ETIMEDOUT' }), 'TIMEOUT');
  assert.equal(classifyApiFailure({ code: 'ERR_NETWORK' }), 'NETWORK');
  assert.equal(classifyApiFailure({ response: { status: 409 } }), 'HTTP');
  assert.equal(classifyApiFailure({ code: 'ERR_BAD_OPTION' }), 'UNKNOWN');
});
test('all consumers share filters, metadata parsing and capability gates', () => {
  const { logFilterParams, supportsSnapshot, parseLogMetadata, matchesSnapshot } = load('./log-contract.ts');
  const params = logFilterParams({ level: 'ERROR', source: 'AGENT', nodeId: 'node', module: ' NodeDiagnostics ', traceId: ' trace ', keyword: ' task ', timeRange: 'all', startTime: 'start', endTime: 'end' });
  assert.deepEqual(JSON.parse(JSON.stringify(params)), { level: 'ERROR', source: 'AGENT', nodeId: 'node', module: 'NodeDiagnostics', traceId: 'trace', keyword: 'task', startTime: 'start', endTime: 'end' });
  assert.equal(supportsSnapshot({ status: 'ONLINE', capabilitiesJson: '["singbox_diagnostics_snapshot"]' }), true);
  assert.equal(supportsSnapshot({ status: 'OFFLINE', capabilities: ['singbox_diagnostics_snapshot'] }), false);
  assert.equal(supportsSnapshot({ status: 'ONLINE', capabilitiesJson: 'broken' }), false);
  for (const value of ['null', '[]', 'broken']) assert.equal(Object.keys(parseLogMetadata(value)).length, 0);
  const log = { nodeId: 'node', source: 'AGENT', module: 'NodeDiagnostics', metadata: JSON.stringify({ event: 'diagnostics_snapshot', taskId: 'task' }) };
  assert.equal(matchesSnapshot(log, 'node', 'task'), true);
  assert.equal(matchesSnapshot(log, 'node', 'other'), false);
  assert.equal(matchesSnapshot({ ...log, source: 'SERVER' }, 'node', 'task'), false);
});
test('SSE closes consumed tickets and retries with bounded fresh tickets and cleanup', () => {
  const hook = source('../pages/admin/logs/use-logs.ts');
  assert.match(hook, /eventSource\?\.close\(\)/);
  assert.match(hook, /attempts >= 5/);
  assert.match(hook, /signal: controller.signal/);
  assert.match(hook, /clearTimeout\(retryTimer\)/);
  assert.match(hook, /logFilterParams\(filter\)/);
  assert.match(hook, /queryKey: \['admin-logs-metrics',/);
});
test('snapshot polling has a wall-clock deadline and exact task matching independent of active filters', () => {
  const hook = source('../hooks/use-diagnostics-snapshot.ts');
  assert.match(hook, /30_000/);
  assert.match(hook, /controller.abort\(\)/);
  assert.match(hook, /matchesSnapshot/);
  assert.match(hook, /module: 'NodeDiagnostics'/);
  assert.doesNotMatch(hook, /reload|restart|log-diagnostics/);
});
test('bundle is JSON and warns about truncation and unpersisted queue', () => {
  const hook = source('../pages/admin/logs/use-logs.ts');
  assert.match(hook, /x-logs-truncated/);
  assert.match(hook, /manifest\.truncated/);
  assert.match(hook, /exportPending/);
  assert.match(hook, /format === 'csv' \? 'csv' : 'json'/);
});

function clock() {
  let id = 0;
  const timers = new Map();
  return {
    timers,
    setTimeout: (fn, delay) => { timers.set(++id, { fn, delay }); return id; },
    clearTimeout: (key) => timers.delete(key)
  };
}
function loggerHarness() {
  const timer = clock();
  const events = {};
  let beaconAccepted = false;
  const window = { ...timer, location: { href: 'https://panel/?token=secret' }, addEventListener: (name, fn) => { events[name] = fn; } };
  const { FrontendLogger } = load('./logger.ts', { window, Blob: globalThis.Blob, clearTimeout: timer.clearTimeout,
    navigator: { sendBeacon: () => beaconAccepted } });
  const logger = new FrontendLogger();
  logger.init();
  return { logger, timer, events, acceptBeacon: () => { beaconAccepted = true; } };
}
test('logger verifies HTTP status, caps retries and does not report its own failures', async () => {
  const { logger, timer } = loggerHarness();
  let calls = 0;
  logger.setTransport(async () => { calls++; return { status: 503 }; });
  logger.error('failure');
  for (let i = 0; i < 4; i++) await logger.flush();
  assert.equal(calls, 4);
  assert.equal(logger.getStats().retries, 3);
  assert.equal(logger.getStats().persistenceFailures, 4);
  assert.equal(logger.getStats().dropped, 1);
  assert.equal(logger.getStats().pendingEntries, 0);
  assert.equal(timer.timers.size, 0);
});
test('logger rejects invalid HTTP status instead of counting delivery', async () => {
  const { logger } = loggerHarness();
  logger.setTransport(async () => ({ status: NaN }));
  logger.error('invalid response');
  await logger.flush();
  assert.equal(logger.getStats().delivered, 0);
  assert.equal(logger.getStats().retries, 1);
  assert.equal(logger.getStats().pendingEntries, 1);
});
test('logger bounds queues and payloads, redacts credentials, handles cycles and Beacon rejection', async () => {
  const { logger, events, acceptBeacon } = loggerHarness();
  for (let i = 0; i < 105; i++) logger.info(`log ${i}`);
  assert.equal(logger.getStats().pendingEntries, 100);
  assert.equal(logger.getStats().dropped, 5);
  events.beforeunload();
  assert.equal(logger.getStats().pendingEntries, 100);
  acceptBeacon();
  events.beforeunload();
  assert.equal(logger.getStats().beaconQueued, 2);
  assert.equal(logger.getStats().delivered, 0);
  const clean = loggerHarness().logger;
  const metadata = { authorization: 'secret', nested: { token: 'secret' } };
  metadata.self = metadata;
  clean.error('Bearer abc+/= ?token=secret', 'Axios', metadata);
  clean.info('large', 'App', { text: '汉'.repeat(4000) });
  let sent;
  clean.setTransport(async (logs) => { sent = logs; return { status: 202 }; });
  await clean.flush();
  assert.doesNotMatch(JSON.stringify(sent), /secret|abc/);
  assert.equal(sent[0].metadata.nested.token, '***');
  assert.equal(sent[1].metadata.truncated, true);
  assert.equal(clean.getStats().delivered, 2);
});
test('logger serializes concurrent uploads and exposes in-flight count', async () => {
  const { logger } = loggerHarness();
  let finish;
  logger.setTransport(() => new Promise((resolve) => { finish = resolve; }));
  logger.error('one');
  const sending = logger.flush();
  logger.error('two');
  await logger.flush();
  assert.equal(logger.getStats().inFlightEntries, 1);
  assert.equal(logger.getStats().pendingEntries, 1);
  finish({ status: 200 });
  await sending;
  assert.equal(logger.getStats().inFlightEntries, 0);
});

function hookHarness(path, modules, context = {}) {
  let cursor = 0;
  let pendingEffects = [];
  const slots = [];
  const react = {
    useState: (initial) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef: (initial) => {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useEffect: (fn, deps) => {
      const index = cursor++;
      const old = slots[index];
      if (!old || deps.some((value, i) => value !== old.deps[i])) pendingEffects.push(() => {
        old?.cleanup?.();
        slots[index] = { deps, cleanup: fn() };
      });
    }
  };
  const exports = load(path, { ...context, require: (name) => name === 'react' ? react : modules[name] });
  return {
    render: (fn) => { cursor = 0; pendingEffects = []; const result = fn(exports); pendingEffects.forEach((effect) => effect()); return result; },
    unmount: () => slots.forEach((slot) => slot?.cleanup?.())
  };
}
test('snapshot empty polls keep observing, new tasks survive old cleanup, deadline and unmount abort', async () => {
  const timer = clock();
  let mutation;
  let query;
  const state = { data: undefined, error: null, isError: false };
  const signal = new globalThis.AbortController().signal;
  let receivedSignal;
  const harness = hookHarness('../hooks/use-diagnostics-snapshot.ts', {
    '@tanstack/react-query': { useQueryClient: () => ({ invalidateQueries: async () => {} }),
      useMutation: (options) => { mutation = options; return { isPending: false, isError: false }; },
      useQuery: (options) => { query = options; return state; } },
    '@/lib/api': { api: { get: async (_url, options) => { receivedSignal = options.signal; return { data: { items: [] } }; } } },
    '@/lib/log-contract': load('./log-contract.ts')
  }, { ...timer, AbortController: globalThis.AbortController });
  const render = () => harness.render(({ useDiagnosticsSnapshot }) => useDiagnosticsSnapshot('node'));
  render();
  mutation.onMutate();
  mutation.onSuccess({ nodeId: 'node', taskId: 'first', requested: true });
  assert.equal(render().status, 'waiting');
  state.data = await query.queryFn({ signal });
  render();
  assert.equal(receivedSignal.aborted, false);
  assert.equal(query.refetchInterval({ state: { data: null, error: null } }), 1500);
  mutation.onMutate();
  mutation.onSuccess({ nodeId: 'node', taskId: 'second', requested: true });
  render();
  await query.queryFn({ signal });
  assert.equal(receivedSignal.aborted, false);
  const deadline = [...timer.timers.values()][0];
  assert.ok(deadline.delay <= 30000);
  deadline.fn();
  assert.equal(render().status, 'timeout');
  assert.equal(query.enabled, false);
  mutation.onMutate();
  mutation.onSuccess({ nodeId: 'node', taskId: 'third', requested: true });
  render();
  await query.queryFn({ signal });
  harness.unmount();
  assert.equal(timer.timers.size, 0);
});
test('snapshot cards are isolated by selected node and reload remains independent', () => {
  assert.match(source('../pages/admin/logs/index.tsx'), /DiagnosticsSnapshotCard key=\{filter.nodeId\}/);
  const detail = source('../pages/admin/nodes/detail.tsx');
  assert.match(detail, /DiagnosticsSnapshotCard key=\{node.id\}/);
  assert.match(detail, /disabled=\{reloadNode.isPending\} onClick=\{\(\) => reloadNode.mutate\(node.id\)\}/);
  assert.match(source('../pages/admin/nodes/components/singbox-diagnostics-card.tsx'), /AlertDialogDescription.*diagConfirmDesc/);
});
test('SSE consumes fresh tickets on each bounded reconnect and clears resources', async () => {
  const timer = clock();
  const streams = [];
  let tickets = 0;
  let ticketSignal;
  class EventSource {
    constructor(url) { this.url = url; streams.push(this); }
    close() { this.closed = true; }
  }
  const harness = hookHarness('../pages/admin/logs/use-logs.ts', {
    '@/lib/api': { api: { post: async (_url, _body, options) => {
      ticketSignal = options.signal;
      return { data: { ticket: `ticket-${++tickets}` } };
    } } },
    '@/stores/auth': { useAuthStore: (selector) => selector({ user: { id: 'admin' } }) },
    '@/lib/log-contract': load('./log-contract.ts')
  }, { ...timer, AbortController: globalThis.AbortController, URLSearchParams: globalThis.URLSearchParams, EventSource });
  harness.render(({ useLiveTailStream }) => useLiveTailStream(true, { level: 'ERROR', source: 'AGENT', nodeId: 'node', module: 'NodeDiagnostics', timeRange: 'all' }, () => {}));
  await setImmediate();
  for (let i = 0; i < 5; i++) {
    streams.at(-1).onerror();
    assert.equal(streams.at(-1).closed, true);
    const [key, task] = [...timer.timers][0];
    timer.timers.delete(key); task.fn();
    await setImmediate();
  }
  streams.at(-1).onerror();
  assert.equal(tickets, 6);
  assert.equal(timer.timers.size, 0);
  assert.match(streams[1].url, /ticket=ticket-2/);
  assert.match(streams[1].url, /level=ERROR/);
  harness.unmount();
  assert.equal(ticketSignal.aborted, true);
});

test('API cancellation and logger transport failures bypass logging, toast and auth side effects', () => {
  const client = source('./api.ts');
  assert.match(client, /if \(category === 'CANCELED'\) return Promise.reject\(error\)/);
  assert.match(client, /if \(config\?\.url\?\.includes\('\/logs\/frontend'\)\) return Promise.reject\(error\)/);
  assert.match(client, /frontendLogger.setTransport\(\(logs\) => api.post/);
  assert.doesNotMatch(source('./logger.ts'), /import .*api/);
});
