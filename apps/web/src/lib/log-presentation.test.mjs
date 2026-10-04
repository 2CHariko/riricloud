import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as icons from 'lucide-react';
import { URL } from 'node:url';

const require = createRequire(import.meta.url);
const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
function load(path, modules = {}) {
  const exports = {};
  runInNewContext(ts.transpileModule(source(path), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX
  } }).outputText, { exports, require: (name) => modules[name] ?? require(name) });
  return exports;
}
const utils = load('./utils.ts', { '@/i18n/config': { default: { t: (key) => key } } });
const presentation = () => load('../pages/admin/logs/log-presentation.ts', { '@/lib/utils': utils });

test('compact log time preserves milliseconds and the configured system timezone', () => {
  const { formatLogTime } = presentation();
  utils.setDefaultSystemTimezone('Asia/Shanghai');
  assert.equal(formatLogTime('2026-10-04T15:48:33.007Z'), '10-04 23:48:33.007');
  utils.setDefaultSystemTimezone('America/New_York');
  assert.equal(formatLogTime('2026-10-04T15:48:33.636Z'), '10-04 11:48:33.636');
  assert.equal(formatLogTime('invalid'), '—');
});

test('advanced filter drafts round-trip local time and preserve presets for module-only changes', () => {
  const { toLocalDateTimeInput, advancedFilterPatch } = presentation();
  const iso = '2026-10-04T15:48:33.636Z';
  const local = toLocalDateTimeInput(iso);
  assert.equal(new Date(local).toISOString(), iso);
  assert.equal(toLocalDateTimeInput('invalid'), '');
  const moduleOnly = advancedFilterPatch({ module: ' HTTP ', startTime: '', endTime: '' });
  assert.equal(moduleOnly.module, 'HTTP');
  assert.equal(moduleOnly.timeRange, undefined);
  const bounded = advancedFilterPatch({ module: '', startTime: local, endTime: '' });
  assert.equal(bounded.startTime, iso);
  assert.equal(bounded.timeRange, 'all');
});

test('log table restores compact fixed columns, selectable summaries and colored levels', () => {
  const table = source('../pages/admin/logs/components/log-table.tsx');
  assert.match(table, /table-fixed/);
  assert.match(table, /w-40/);
  assert.match(table, /w-20/);
  assert.match(table, /w-\[90px\]/);
  assert.match(table, /w-\[140px\]/);
  assert.match(table, /py-2/);
  assert.match(table, /formatLogTime\(log.createdAt\)/);
  assert.doesNotMatch(table, /LogCorrelation/);
  assert.match(table, /select-text/);
  assert.match(table, /INFO:.*bg-blue-500\/15/);
  assert.match(table, /ERROR:.*bg-destructive\/10/);
  assert.match(table, /onFilterByNodeId/);
  assert.match(table, /onFilterByTraceId/);
});

test('default log layout keeps diagnostics and custom dates behind explicit entries', () => {
  const page = source('../pages/admin/logs/index.tsx');
  assert.doesNotMatch(page, /<LogIngestionCard|<DiagnosticsSnapshotCard/);
  assert.match(page, /<LogDiagnosticsDialog/);
  const bar = source('../pages/admin/logs/components/log-filter-bar.tsx');
  assert.doesNotMatch(bar, /type="datetime-local"/);
  assert.match(bar, /LogAdvancedFilterDialog/);
  assert.match(bar, /xl:col-span-2/);
  const advanced = source('../pages/admin/logs/components/log-advanced-filter-dialog.tsx');
  assert.match(advanced, /useFormResetOnKey/);
  assert.match(advanced, /advancedFilterPatch/);
  assert.match(advanced, /handleSubmit/);
  const dialog = source('../pages/admin/logs/components/log-diagnostics-dialog.tsx');
  assert.match(dialog, /useDiagnosticsSnapshot\(node\?\.id/);
  assert.match(dialog, /DiagnosticsSnapshotContent/);
  assert.match(dialog, /LogIngestionCard/);
  assert.doesNotMatch(dialog, /open &&|reload|restart/);
});

const react = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const translation = { useTranslation: () => ({ t: (key) => key }) };
const ui = (path) => load(path, { '@/lib/utils': utils });
const { LogTable } = load('../pages/admin/logs/components/log-table.tsx', {
  'react-i18next': translation,
  '@/lib/utils': utils,
  '@/lib/log-contract': load('./log-contract.ts'),
  'lucide-react': icons,
  '../log-presentation': presentation(),
  '@/components/ui/badge': ui('../components/ui/badge.tsx'),
  '@/components/ui/button': ui('../components/ui/button.tsx'),
  '@/components/ui/card': ui('../components/ui/card.tsx'),
  '@/components/ui/skeleton': ui('../components/ui/skeleton.tsx'),
  '@/components/ui/table': ui('../components/ui/table.tsx')
});
const log = {
  id: 'log', createdAt: '2026-10-04T15:48:33.636Z', level: 'INFO', source: 'AGENT', module: 'NodeDiagnostics',
  message: 'network failure '.repeat(120), traceId: 'trace-123456789', node: { id: 'node', name: 'Master-Local' },
  metadata: JSON.stringify({ receivedAt: '2026-10-04T15:49:00.000Z', agentInstanceId: 'hidden-instance', repeatCount: 3 })
};
const props = { logs: [log], isLoading: false, total: 100, page: 2, pageSize: 50, totalPages: 2, keyword: 'failure', onPageChange() {}, onSelectLog() {} };
function findElements(tree, predicate, found = []) {
  if (!tree || typeof tree !== 'object') return found;
  if (predicate(tree)) found.push(tree);
  react.Children.forEach(tree.props?.children, (child) => findElements(child, predicate, found));
  return found;
}

test('rendered rows remain single-line summaries and preserve node, repeat and trace markers', () => {
  utils.setDefaultSystemTimezone('Asia/Shanghai');
  const html = renderToStaticMarkup(react.createElement(LogTable, props));
  assert.equal((html.match(/<td\b/g) ?? []).length, 6);
  assert.match(html, /10-04 23:48:33.636/);
  assert.match(html, /bg-blue-500\/15/);
  assert.match(html, /<mark[^>]*>failure<\/mark>/);
  assert.match(html, /Master-Local/);
  assert.match(html, /x3/);
  assert.match(html, /trace-12/);
  assert.doesNotMatch(html, /hidden-instance|15:49:00/);
  assert.match(html, /overflow-x-auto/);
});

test('module, node and trace callbacks stop row selection while pagination and row details still work', () => {
  const calls = [];
  const tree = LogTable({ ...props, onSelectLog: (value) => calls.push(value.id), onPageChange: (value) => calls.push(value),
    onFilterByNodeId: (value) => calls.push(value), onFilterByModule: (value) => calls.push(value), onFilterByTraceId: (value) => calls.push(value) });
  const controls = findElements(tree, (element) => element.props?.title && element.props?.onClick);
  let stopped = 0;
  for (const control of controls) control.props.onClick({ stopPropagation: () => stopped++ });
  assert.equal(stopped, 3);
  assert.deepEqual(calls, ['NodeDiagnostics', 'node', 'trace-123456789']);
  const row = findElements(tree, (element) => element.key === 'log')[0];
  row.props.onClick();
  const previous = findElements(tree, (element) => element.props?.disabled === false && element.props?.onClick)[0];
  previous.props.onClick();
  assert.deepEqual(calls, ['NodeDiagnostics', 'node', 'trace-123456789', 'log', 1]);
});

test('loading and empty states remain accessible without a fake log row', () => {
  const empty = renderToStaticMarkup(react.createElement(LogTable, { ...props, logs: [] }));
  assert.match(empty, /admin:logs.emptySearchTitle/);
  assert.doesNotMatch(empty, /<td\b/);
  const loading = renderToStaticMarkup(react.createElement(LogTable, { ...props, logs: [], isLoading: true }));
  assert.match(loading, /animate-pulse/);
  assert.doesNotMatch(loading, /admin:logs.emptySearchTitle/);
});

test('advanced dialog applies validated drafts once and cancellation leaves active filters intact', async () => {
  let resetOptions;
  let formOptions;
  let draft;
  let submit;
  const calls = [];
  const form = {
    control: {}, reset: (value) => { draft = value; },
    handleSubmit: (callback) => { submit = callback; return () => callback(draft); }
  };
  const components = new Proxy({}, { get: (_target, key) => key });
  const { LogAdvancedFilterDialog } = load('../pages/admin/logs/components/log-advanced-filter-dialog.tsx', {
    'react-i18next': translation,
    'react-hook-form': { useForm: (options) => { formOptions = options; return form; } },
    '@/hooks/use-form-reset': { useFormResetOnKey: (options) => { resetOptions = options; options.reset(); } },
    '@/components/shared/responsive-dialog': components, '@/components/ui/dialog': components,
    '@/components/ui/button': components, '@/components/ui/form': components, '@/components/ui/input': components,
    '../log-presentation': presentation()
  });
  const filter = { module: 'HTTP', startTime: '2026-10-04T15:48:33.636Z' };
  const tree = LogAdvancedFilterDialog({ open: true, filter, onChange: (patch) => calls.push(patch), onOpenChange: (open) => calls.push(open) });
  assert.equal(resetOptions.open, true);
  assert.equal(draft.module, 'HTTP');
  assert.equal(new Date(draft.startTime).toISOString(), filter.startTime);
  const cancel = findElements(tree, (element) => element.props?.type === 'button')[0];
  cancel.props.onClick();
  assert.deepEqual(calls, [false]);
  calls.length = 0;
  submit({ module: ' Collector ', startTime: '', endTime: '' });
  assert.equal(calls[0].module, 'Collector');
  assert.equal(calls[0].startTime, undefined);
  assert.equal(calls[0].page, 1);
  assert.equal(calls[1], false);
  const invalid = await formOptions.resolver({ module: '', startTime: '2026-10-04T12:00', endTime: '2026-10-03T12:00' }, {}, {});
  assert.equal(invalid.errors.endTime.message, 'admin:logs.invalidTimeRange');
});

test('closing and reopening diagnostics keeps the observer outside the portal without requesting a new task', () => {
  const components = new Proxy({}, { get: (_target, key) => key });
  const observation = { receipt: { taskId: 'task' }, status: 'waiting' };
  const nodes = [];
  const { LogDiagnosticsDialog } = load('../pages/admin/logs/components/log-diagnostics-dialog.tsx', {
    'react-i18next': translation,
    '@/components/shared/responsive-dialog': components,
    '@/components/shared/diagnostics-snapshot-card': components,
    '@/components/ui/dialog': components, '@/components/ui/card': components,
    './log-ingestion-card': components,
    '@/hooks/use-diagnostics-snapshot': { useDiagnosticsSnapshot: (node) => { nodes.push(node); return observation; } }
  });
  for (const open of [true, false, true]) {
    const tree = LogDiagnosticsDialog({ open, node: { id: 'node', name: 'Master-Local' }, onOpenChange() {} });
    assert.equal(tree.props.open, open);
    const content = findElements(tree, (element) => element.type === 'DiagnosticsSnapshotContent')[0];
    assert.equal(content.props.snapshot, observation);
  }
  assert.deepEqual(nodes, ['node', 'node', 'node']);
});
