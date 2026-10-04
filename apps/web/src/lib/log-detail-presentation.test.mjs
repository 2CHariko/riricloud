import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { URL } from 'node:url';
import ts from 'typescript';
import * as icons from 'lucide-react';
import { setImmediate } from 'node:timers';

const require = createRequire(import.meta.url);
const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
function load(path, modules = {}, context = {}) {
  const exports = {};
  runInNewContext(ts.transpileModule(source(path), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX
  } }).outputText, { exports, require: (name) => {
    if (name in modules) return modules[name];
    return require(name);
  }, ...context });
  return exports;
}
const utils = load('./utils.ts', { '@/i18n/config': { default: { t: (key) => key } } });
const helpers = () => load('./log-detail-presentation.ts', { '@/lib/utils': utils });

test('detail metadata distinguishes absent, empty object and invalid JSON without losing evidence', () => {
  const { detailMetadata } = helpers();
  assert.equal(detailMetadata('').state, 'empty');
  assert.equal(detailMetadata('  { } ').state, 'empty');
  for (const value of ['broken', 'null', '[]', '42']) {
    const result = detailMetadata(value);
    assert.equal(result.state, 'invalid');
    assert.equal(result.text, value);
  }
  const result = detailMetadata('{"extra":{"unknown":"retained"},"sequence":0}');
  assert.equal(result.state, 'valid');
  assert.equal(result.data.sequence, 0);
  assert.match(result.text, /retained/);
});

test('detail times use system timezone with milliseconds and neutral quality mappings', () => {
  const { formatDetailTime, timeQualityKey, showReportedTime } = helpers();
  utils.setDefaultSystemTimezone('Asia/Shanghai');
  assert.equal(formatDetailTime('2026-10-04T09:21:33.007Z'), '2026-10-04 17:21:33.007');
  utils.setDefaultSystemTimezone('America/New_York');
  assert.equal(formatDetailTime('2026-10-04T09:21:33.692Z'), '2026-10-04 05:21:33.692');
  assert.equal(formatDetailTime('broken'), '—');
  assert.equal(timeQualityKey('agent-clock'), 'agent');
  assert.equal(timeQualityKey('legacy-received-time'), 'legacy');
  assert.equal(timeQualityKey('invalid-clock-fallback'), 'fallback');
  assert.equal(timeQualityKey(undefined), 'missing');
  assert.equal(timeQualityKey('new-code'), 'unknown');
  assert.equal(showReportedTime({ occurredAt: '2026-10-04T09:21:33.692588Z', timeQuality: 'agent-clock' }, '2026-10-04T09:21:33.692Z'), false);
  assert.equal(showReportedTime({ occurredAt: 'bad-clock', timeQuality: 'invalid-clock-fallback' }, '2026-10-04T09:21:33.692Z'), true);
});

test('collector metrics preserve zero, reject invalid counts and flag only actual loss', () => {
  const { collectorMetrics, correlationFields } = helpers();
  assert.equal(collectorMetrics(null).length, 0);
  assert.equal(collectorMetrics([]).length, 0);
  const metrics = collectorMetrics({ filtered: 0, coalesced: 7, requeued: -1, dropped: 2, truncated: '3' });
  assert.equal(metrics.find((item) => item.key === 'filtered').value, 0);
  assert.equal(metrics.find((item) => item.key === 'filtered').warning, false);
  assert.equal(metrics.find((item) => item.key === 'dropped').warning, true);
  assert.equal(metrics.find((item) => item.key === 'requeued').value, null);
  assert.equal(metrics.find((item) => item.key === 'truncated').value, null);
  assert.equal(collectorMetrics({}).every((item) => item.value === null), true);
  const fields = correlationFields({ sequence: 0, agentInstanceId: 'id', event: '', taskId: {}, operationId: Infinity });
  assert.equal(fields.length, 2);
  assert.equal(fields.find((field) => field.key === 'sequence').value, '0');
});

test('detail UI is message first with full-width trace, clean context and direct dark metadata', () => {
  const drawer = source('../pages/admin/logs/components/log-detail-drawer.tsx');
  assert.doesNotMatch(drawer, /clipboard.writeText|setTimeout/);
  assert.match(drawer, /generatedAt/);
  assert.match(drawer, /formatDetailTime/);
  assert.match(drawer, /traceIdTitle/);
  for (const name of ['LogContextCards', 'LogCollectorStats', 'LogMetadataSection', 'LogCopyButton']) assert.match(drawer, new RegExp(name));
  const correlation = source('../components/shared/log-correlation.tsx');
  assert.match(correlation, /LogInfoCard/);
  assert.match(correlation, /qualityLabels/);
  assert.match(correlation, /IconButton/);
  const metadata = source('../pages/admin/logs/components/log-metadata-section.tsx');
  assert.match(metadata, /bg-zinc-950/);
  assert.match(metadata, /metadata.text/);
  assert.match(drawer, /key=\{log.id\}/);
});

const react = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const translation = { useTranslation: () => ({ t: (key) => key }) };
const Button = load('../components/ui/button.tsx', { '@/lib/utils': utils }).Button;
const IconButton = (props) => react.createElement(Button, { ...props, tooltip: undefined });
const copyModule = load('../components/shared/log-copy-button.tsx', {
  'lucide-react': icons, 'react-i18next': translation, '@/components/ui/button': { Button }, '@/components/ui/icon-button': { IconButton }
});
const cardModule = load('../components/shared/log-info-card.tsx', {
  '@/lib/utils': utils, '@/components/ui/card': load('../components/ui/card.tsx', { '@/lib/utils': utils }), './log-copy-button': copyModule
});
const shared = { 'lucide-react': icons, 'react-i18next': translation, '@/lib/utils': utils,
  '@/lib/log-detail-presentation': helpers(), '@/components/ui/button': { Button }, '@/components/ui/icon-button': { IconButton }, '@/components/shared/log-info-card': cardModule };
const { LogCorrelation } = load('../components/shared/log-correlation.tsx', {
  ...shared, './log-info-card': cardModule, '@/components/ui/badge': load('../components/ui/badge.tsx', { '@/lib/utils': utils })
});
const { LogCollectorStats } = load('../pages/admin/logs/components/log-collector-stats.tsx', shared);
const { LogContextCards } = load('../pages/admin/logs/components/log-context-cards.tsx', shared);
const accordion = load('../components/ui/accordion.tsx', { '@/lib/utils': utils, 'lucide-react': icons });
const { LogMetadataSection } = load('../pages/admin/logs/components/log-metadata-section.tsx', {
  ...shared, '@/components/ui/accordion': accordion, '@/components/shared/log-copy-button': copyModule
});
const log = { id: 'log', source: 'AGENT', module: 'Collector', level: 'INFO', createdAt: '2026-10-04T09:21:33.692Z',
  message: 'Collector cumulative statistics', traceId: 'trace-123', node: { id: 'node', name: 'Master-Local', serverHost: '127.0.0.1' },
  metadata: JSON.stringify({ receivedAt: '2026-10-04T09:21:33.694Z', sequence: 0, timeQuality: 'agent-clock', agentInstanceId: 'full-id-'.repeat(20) }) };
const render = (component, props) => renderToStaticMarkup(react.createElement(component, props));

test('rendered evidence uses labeled cards, preserves long IDs and zero sequence without health claims', () => {
  utils.setDefaultSystemTimezone('Asia/Shanghai');
  const html = render(LogCorrelation, { log });
  assert.match(html, /2026-10-04 17:21:33.692/);
  assert.match(html, /2026-10-04 17:21:33.694/);
  assert.match(html, /qualityAgent/);
  assert.match(html, /full-id-full-id/);
  assert.match(html, /select-text/);
  assert.match(html, /sm:grid-cols-2/);
  assert.match(html, /Asia\/Shanghai/);
  assert.doesNotMatch(html, /text-success|bg-success/);
  const legacy = render(LogCorrelation, { log: { ...log, metadata: '{}' } });
  assert.match(legacy, /notProvided/);
  assert.doesNotMatch(legacy, /identityTitle/);
  const stats = render(LogCollectorStats, { stats: { filtered: 0, dropped: 4, truncated: 0 } });
  assert.match(stats, /text-amber-700/);
  assert.match(stats, /notProvided/);
  assert.match(stats, />0<\/div>/);
});

test('raw metadata displays directly in dark terminal and its copy action preserves formatted or invalid evidence', () => {
  const metadata = helpers().detailMetadata('{"unknown":"retained"}');
  const html = render(LogMetadataSection, { metadata });
  assert.match(html, /retained/);
  assert.match(html, /bg-zinc-950/);
  const raw = helpers().detailMetadata('invalid raw');
  const tree = LogMetadataSection({ metadata: raw });
  const copy = findElements(tree, (element) => element.type === copyModule.LogCopyButton)[0];
  assert.equal(copy.props.value, 'invalid raw');
  const empty = render(LogMetadataSection, { metadata: helpers().detailMetadata('{}') });
  assert.match(empty, /emptyMetadata/);
});
function findElements(tree, predicate, found = []) {
  if (!tree || typeof tree !== 'object') return found;
  if (predicate(tree)) found.push(tree);
  react.Children.forEach(tree.props?.children, (child) => findElements(child, predicate, found));
  return found;
}

test('context filter callbacks keep trace, node and module values and close the drawer', () => {
  const calls = [];
  const tree = LogContextCards({ log, onFilterByNodeId: (value) => calls.push(value), onFilterByModule: (value) => calls.push(value) });
  const buttons = findElements(tree, (element) => element.type === Button);
  buttons.forEach((btn) => btn.props.onClick());
  assert.deepEqual(calls, ['Collector', 'node']);
  const parts = new Proxy({}, { get: (_target, key) => key });
  const { LogDetailDrawer } = load('../pages/admin/logs/components/log-detail-drawer.tsx', { ...shared,
    '@/components/ui/sheet': parts, '@/components/ui/card': parts, '@/components/ui/badge': parts, '@/components/ui/accordion': parts,
    '@/components/shared/log-correlation': { LogCorrelation }, '@/components/shared/log-copy-button': copyModule,
    './log-context-cards': { LogContextCards }, './log-collector-stats': { LogCollectorStats }, './log-metadata-section': { LogMetadataSection }
  });
  const drawer = LogDetailDrawer({ log, open: true, onOpenChange: (value) => calls.push(value), onFilterByTraceId: (value) => calls.push(value) });
  const content = findElements(drawer, (element) => element.key === log.id)[0];
  const contentTree = content.type(content.props);
  const traceFilterBtn = findElements(contentTree, (element) => element.type === Button && element.props.variant === 'secondary')[0];
  traceFilterBtn.props.onClick();
  assert.deepEqual(calls.slice(-2), ['trace-123', false]);
});

function copyHarness(writeText) {
  let cursor = 0;
  const slots = [];
  const cleanups = [];
  const timers = new Map();
  const events = [];
  let timerId = 0;
  const hooks = {
    useState: (initial) => { const key = cursor++; if (!(key in slots)) slots[key] = initial; return [slots[key], (value) => { slots[key] = value; }]; },
    useRef: (initial) => { const key = cursor++; return slots[key] ??= { current: initial }; },
    useEffect: (fn) => { const key = cursor++; if (!(key in slots)) { slots[key] = true; cleanups.push(fn()); } }
  };
  const { LogCopyButton } = load('../components/shared/log-copy-button.tsx', {
    react: hooks, 'lucide-react': icons, 'react-i18next': translation,
    '@/components/ui/button': { Button }, '@/components/ui/icon-button': { IconButton },
    sonner: { toast: { success: (text) => events.push(['success', text]), error: (text) => events.push(['error', text]) } }
  }, { navigator: { clipboard: { writeText } }, setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id) => timers.delete(id) });
  const wrapper = LogCopyButton({ value: 'full evidence', label: 'evidence' });
  return { events, timers, render: () => { cursor = 0; return wrapper.type(wrapper.props); }, unmount: () => cleanups.forEach((fn) => fn?.()) };
}

test('copy waits for success, reports rejection and clears timer on unmount', async () => {
  let resolve;
  const success = copyHarness(() => new Promise((done) => { resolve = done; }));
  success.render().props.onClick();
  assert.equal(success.events.length, 0);
  resolve();
  await new Promise((done) => setImmediate(done));
  assert.equal(success.events[0][0], 'success');
  assert.equal(success.timers.size, 1);
  success.unmount();
  assert.equal(success.timers.size, 0);
  const failure = copyHarness(async () => { throw new Error('denied'); });
  failure.render().props.onClick();
  await new Promise((done) => setImmediate(done));
  assert.equal(failure.events[0][0], 'error');
  assert.equal(failure.timers.size, 0);
  failure.unmount();
});

test('late clipboard results after switching records do not produce stale feedback', async () => {
  let resolve;
  const harness = copyHarness(() => new Promise((done) => { resolve = done; }));
  harness.render().props.onClick();
  harness.unmount();
  resolve();
  await new Promise((done) => setImmediate(done));
  assert.equal(harness.events.length, 0);
  assert.equal(harness.timers.size, 0);
});
