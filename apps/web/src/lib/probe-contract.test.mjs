import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { URL } from 'node:url';
import ts from 'typescript';
const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const exports = {};
runInNewContext(ts.transpileModule(source('./probe-types.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { exports });
const { parseLastProbe, probeTone, isProbePending, kernelCheckPassed } = exports;
const valid = { schemaVersion: 1, subjectType: 'UPSTREAM_NODE', subjectId: 'id', status: 'SUCCESS', errorCode: null, message: '', engine: 'MIHOMO', engineVersion: '1.19.30', fallbackReason: null, mihomoCompatibility: 'SUPPORTED', measurement: 'PROXY_HTTP_DELAY', perspective: 'MASTER', routeKind: 'UPSTREAM_DIRECT', targetId: 'target', targetHost: 'example.com', testedAt: '2026-01-01T00:00:00Z', durationMs: 12, latencyMs: 0, stage: 'DIAL_HTTP', configHash: 'hash', applied: true };

test('legacy TCP and malformed snapshots cannot become proxy success', () => {
  for (const value of [null, [], '{broken', JSON.stringify(valid), { latencyMs: 4, status: 'SUCCESS' }, { ...valid, measurement: 'TCP_HANDSHAKE' }, { ...valid, status: 'NOT_APPLICABLE' }, { ...valid, latencyMs: null }, { ...valid, latencyMs: -1 }, { ...valid, latencyMs: NaN }, { ...valid, durationMs: Infinity }, { ...valid, engine: null }, { ...valid, engine: 'unknown' }, { ...valid, testedAt: 'bad' }]) assert.equal(parseLastProbe(value), null);
  assert.equal(parseLastProbe(valid), valid);
});
test('all task result statuses remain distinct and fallback is never Mihomo verified', () => {
  for (const status of ['SUCCESS', 'TIMEOUT', 'ERROR', 'UNSUPPORTED', 'ENVIRONMENT_UNAVAILABLE', 'CANCELED', 'STALE', 'SKIPPED']) assert.equal(parseLastProbe({ ...valid, status }).status, status);
  assert.equal(probeTone(valid), 'success');
  assert.equal(probeTone({ ...valid, engine: 'SINGBOX' }), 'warning');
  for (const status of ['UNSUPPORTED', 'ENVIRONMENT_UNAVAILABLE']) assert.equal(probeTone({ ...valid, status }), 'warning');
  for (const status of ['CANCELED', 'STALE', 'SKIPPED']) assert.equal(probeTone({ ...valid, status }), 'muted');
});
test('polling ends for every terminal state', () => {
  for (const state of ['QUEUED', 'RUNNING']) assert.equal(isProbePending(state), true);
  for (const state of ['COMPLETED', 'CANCELED', 'FAILED', undefined]) assert.equal(isProbePending(state), false);
});
test('unexecuted or partial kernel checks cannot be shown as full pass', () => {
  const check = { engine: 'MIHOMO', engineVersion: null, status: 'PASSED', executed: true, scope: 'FULL', diagnostics: [] };
  assert.equal(kernelCheckPassed(check), true);
  assert.equal(kernelCheckPassed({ ...check, executed: false }), false);
  assert.equal(kernelCheckPassed({ ...check, scope: 'PARTIAL' }), false);
  for (const status of ['FAILED', 'UNAVAILABLE', 'UNSUPPORTED', 'EXTERNAL_RESOURCES_REQUIRED']) assert.equal(kernelCheckPassed({ ...check, status }), false);
});
test('task hook uses async receipts, bounded result pages, no close cancellation or synchronous aliases', () => {
  const hook = source('../hooks/use-probe-task.ts');
  assert.match(hook, /enabled: open && !!taskId/);
  assert.match(hook, /1000 : false/);
  assert.match(hook, /pageSize: 20/);
  assert.equal((hook.match(/api.delete/g) ?? []).length, 1);
  assert.doesNotMatch(hook, /120_000|45_000|targetUrl|\.probe\b|\.tested\b/);
  const preview = source('../pages/admin/templates/use-templates.ts');
  assert.match(preview, /kernelCheck: KernelCheckResult/);
  assert.doesNotMatch(preview, /singboxCheck|mihomoCheck|passed: boolean/);
});

function hookHarness() {
  let state;
  let summary;
  const queries = [], invalidations = [], posts = [], deletes = [], effects = [];
  const api = {
    get: async () => ({ data: summary }),
    post: async (...args) => { posts.push(args); return { data: { taskId: 'task-1', state: 'QUEUED', total: 2 } }; },
    delete: async (...args) => { deletes.push(args); }
  };
  const queryClient = { invalidateQueries: async (value) => invalidations.push(value.queryKey) };
  const modules = {
    react: { useEffect: (effect) => effects.push(effect), useRef: () => ({ current: null }), useState: (value) => [value, () => {}] },
    zustand: { create: (initialize) => {
      state = initialize((update) => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) }; });
      const useStore = () => state;
      useStore.getState = () => state;
      return useStore;
    } },
    '@tanstack/react-query': {
      useQueryClient: () => queryClient,
      useQuery: (options) => { queries.push(options); return { data: options.queryKey[1] === 'probe-tasks' ? summary : undefined, isError: false }; },
      useMutation: (options) => options
    },
    sonner: { toast: { error: () => {} } },
    '@/lib/api': { api, extractErrorMessage: String },
    '@/lib/probe-types': exports
  };
  const result = {};
  runInNewContext(ts.transpileModule(source('../hooks/use-probe-task.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText,
    { exports: result, require: (name) => modules[name] });
  return { run: result.useProbeTask, queries, invalidations, posts, deletes, effects, setSummary: (value) => { summary = value; } };
}
test('closing and reopening retain task identity without canceling; polling stops closed and terminal', async () => {
  const h = hookHarness(), request = { key: 'upstream:id', endpoint: '/admin/upstream/nodes/id/probe' };
  const initial = h.run(request, true);
  await initial.start.mutationFn('MIHOMO_PREFERRED');
  const closed = h.run(request, false);
  assert.equal(closed.taskId, 'task-1');
  assert.equal(h.queries.at(-2).enabled, false);
  assert.equal(h.queries.at(-2).refetchInterval({ state: {} }), false);
  assert.equal(h.deletes.length, 0);
  const reopened = h.run(request, true);
  assert.equal(reopened.taskId, 'task-1');
  assert.equal(h.queries.at(-2).refetchInterval({ state: { data: { state: 'RUNNING' } } }), 1000);
  assert.equal(h.queries.at(-2).refetchInterval({ state: { data: { state: 'COMPLETED' } } }), false);
  await assert.rejects(reopened.start.mutationFn('MIHOMO_ONLY'), /PROBE_TASK_ACTIVE/);
  assert.equal(h.posts.length, 1);
  assert.equal(h.invalidations.length, 0);
  await reopened.cancel.mutationFn();
  assert.equal(h.deletes[0][0], '/admin/probe-tasks/task-1');
});
test('all terminal states refresh resources because canceled/failed tasks may have applied earlier batches', () => {
  for (const state of ['QUEUED', 'RUNNING', 'CANCELED', 'FAILED', 'COMPLETED']) {
    const h = hookHarness();
    h.setSummary({ taskId: 'task-1', state });
    h.run({ key: 'line:id', endpoint: '/admin/lines/id/speedtest', taskId: 'task-1' }, true);
    h.effects.forEach((effect) => effect());
    assert.equal(h.invalidations.some((key) => key[0] === 'admin-upstream-nodes'), !['QUEUED', 'RUNNING'].includes(state));
    assert.equal(h.invalidations.some((key) => key[1] === 'probe-task-results'), !['QUEUED', 'RUNNING'].includes(state));
  }
});

test('kernel validation only marks full executed pass green and actual failures red', () => {
  const base = { status: 'PASSED', executed: true, scope: 'FULL', diagnostics: [] };
  assert.equal(exports.kernelCheckTone(base), 'success');
  for (const check of [{ ...base, executed: false }, { ...base, scope: 'PARTIAL' }, ...['UNAVAILABLE', 'UNSUPPORTED', 'EXTERNAL_RESOURCES_REQUIRED'].map((status) => ({ ...base, status }))]) {
    assert.equal(exports.kernelCheckTone(check), 'warning');
  }
  for (const executed of [true, false]) assert.equal(exports.kernelCheckTone({ ...base, status: 'FAILED', executed }), 'danger');
  assert.equal(exports.kernelCheckTone({ ...base, status: 'FUTURE' }), 'muted');
});

test('diagnostic localization uses exact allowlisted codes and never arbitrary raw logs', () => {
  for (const code of ['INVALID_CONFIG', 'KERNEL_UNAVAILABLE', 'NATIVE_CONFIG_CHECK_FAILED', 'KERNEL_EXECUTION_UNAVAILABLE', 'KERNEL_TIMEOUT', 'KERNEL_CANCELED', 'EXTERNAL_RESOURCES_REQUIRED', 'RESOURCE_PREPARATION_FAILED']) {
    assert.equal(exports.kernelDiagnosticCode(code), code);
  }
  for (const code of ['https://secret.example/token', 'INVALID_CONFIG: password=secret', 'FATAL secret', '__proto__', '', undefined]) {
    assert.equal(exports.kernelDiagnosticCode(code), 'UNKNOWN');
  }
});

test('preview delegates safe validation rendering and preserves configuration copy', () => {
  const preview = source('../pages/admin/templates/components/template-preview-drawer.tsx');
  const result = source('../pages/admin/templates/components/kernel-validation-result.tsx');
  assert.match(preview, /<KernelValidationResult check=\{check\}/);
  assert.match(preview, /clipboard.writeText\(result.content\)/);
  assert.doesNotMatch(preview, /diagnostics.join|KernelDiagnosticCard/);
  assert.match(result, /AccordionTrigger/);
  assert.match(result, /resourceRequirements \?\? \[\]/);
  assert.match(result, /resourceRequirementsTruncated/);
  assert.match(result, /kernelDiagnosticCode/);
  assert.doesNotMatch(result, /\{resource.reasonCode\}|\{diagnostic\}/);
});

test('resource reason codes are localized without exposing resource names or paths', () => {
  for (const code of ['RESOURCE_AVAILABLE', 'RESOURCE_MISSING', 'RESOURCE_UNREADABLE', 'RESOURCE_INVALID', 'RESOURCE_UNSUPPORTED', 'REMOTE_RESOURCE_DISABLED']) {
    assert.equal(exports.kernelDiagnosticCode(code), code);
  }
});

test('validation component handles old, empty, truncated and unknown responses safely', () => {
  const result = {};
  const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props };
  const passthrough = ({ children }) => children;
  const modules = {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-i18next': { useTranslation: () => ({ t: (key, options) => `${key} ${JSON.stringify(options ?? {})}` }) },
    'class-variance-authority': { cva: (_, config) => ({ tone }) => config.variants.tone[tone] },
    'lucide-react': { AlertTriangle: passthrough, CheckCircle2: passthrough, Info: passthrough },
    '@/components/ui/accordion': Object.fromEntries(['Accordion', 'AccordionContent', 'AccordionItem', 'AccordionTrigger'].map((name) => [name, passthrough])),
    '@/components/ui/badge': { Badge: passthrough },
    '@/components/ui/card': { Card: (props) => ({ card: props }), CardContent: passthrough },
    '@/lib/utils': { cn: (value) => value },
    '@/lib/probe-types': exports,
  };
  runInNewContext(ts.transpileModule(source('../pages/admin/templates/components/kernel-validation-result.tsx'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports: result, require: (name) => modules[name] });
  const base = { status: 'FAILED', executed: false, scope: 'PARTIAL', engine: 'MIHOMO', engineVersion: null, diagnostics: ['INVALID_CONFIG'] };
  const render = (check) => JSON.stringify(result.KernelValidationResult({ check }));
  assert.match(render(base), /parseFailed/);
  assert.match(render({ ...base, executed: true, diagnostics: ['NATIVE_CONFIG_CHECK_FAILED'] }), /nativeFailed/);
  assert.match(render({ ...base, diagnostics: [], resourceRequirements: [] }), /validation.empty/);
  const resource = { kind: 'RULE_PROVIDER', location: 'rule-providers[0]', state: 'REMOTE_DISABLED', reasonCode: 'REMOTE_RESOURCE_DISABLED', actionCode: 'CHECK_CLIENT', references: 3 };
  const html = render({ ...base, status: 'EXTERNAL_RESOURCES_REQUIRED', diagnostics: ['FATAL password=secret'], resourceRequirements: [resource, { ...resource, reasonCode: '/private/secret', kind: 'secret', actionCode: 'secret', state: 'secret' }], resourceRequirementsTruncated: 5 });
  assert.match(html, /text-amber/);
  assert.match(html, /validation.truncated/);
  assert.match(html, /REMOTE_RESOURCE_DISABLED/);
  assert.match(html, /validation.actions.CHECK_CLIENT/);
  assert.match(html, /UNKNOWN/);
  assert.doesNotMatch(html, /secret|FATAL|text-destructive/);
});
