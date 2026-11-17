import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { URL, URLSearchParams } from 'node:url';
import ts from 'typescript';
import * as jsxRuntime from 'react/jsx-runtime';
const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const load = (path, modules = {}) => {
  const exports = {};
  runInNewContext(ts.transpileModule(source(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, URL, URLSearchParams, require: (name) => {
    if (!(name in modules)) throw new Error(`Unexpected test import: ${name}`);
    return modules[name];
  } });
  return exports;
};
const contract = load('./proxy-pool-contract.ts');
const snippets = load('./proxy-snippets.ts');
const endpoint = (lineId, extra = {}) => ({ lineId, name: lineId, host: '2001:db8::1', port: 8080, tls: false, status: 'AVAILABLE', supportedProtocols: ['http', 'socks5'], ...extra });

test('more than 200 selected endpoints cannot exceed API or automation limits', () => {
  const endpoints = Array.from({ length: 201 }, (_, i) => endpoint(String(i)));
  assert.equal(contract.reconcileSelection(endpoints.map(e => e.lineId), endpoints).length, 200);
  assert.equal(contract.buildAutomationUrl('https://example.com', 'token', 'http', 'json', endpoints.map(e => e.lineId)), '');
});
test('capacity invalidation removes checked entries without selecting newly added entries; offline is separate', () => {
  const endpoints = [endpoint('old', { online: false }), endpoint('full', { status: 'CAPACITY_EXCLUDED' }), endpoint('new')];
  assert.deepEqual(Array.from(contract.reconcileSelection(['old', 'full', 'removed'], endpoints)), ['old']);
  assert.equal(contract.supportsProtocol(endpoint('tls', { tls: true }), 'socks5'), false);
  assert.equal(contract.supportsProtocol(endpoint('http', { supportedProtocols: ['http'] }), 'socks5'), false);
});
test('version 2 credentials come from each endpoint; legacy/raw key usernames are rejected', () => {
  const payload = { version: 2, key: { id: 'key', username: 'pk_raw' }, proxies: [endpoint('one', { username: 'derived_one', password: 'pass1' }), endpoint('two', { username: 'derived_two', password: 'pass2' })] };
  const parsed = contract.parseProxyPoolExport(payload, 'key');
  assert.equal(parsed.proxies[1].username, 'derived_two');
  assert.equal(contract.parseProxyPoolExport({ ...payload, version: 1 }, 'key'), null);
  assert.equal(contract.parseProxyPoolExport({ ...payload, key: { id: 'other' } }, 'key'), null);
  assert.equal(contract.parseProxyPoolExport({ ...payload, proxies: [endpoint('one', { username: 'pk_raw', password: 'pass' })] }, 'key'), null);
  const code = snippets.buildMultiProxyCodeSnippets({ protocol: 'http', endpoints: parsed.proxies }).map((item) => item.code).join('\n');
  assert.match(code, /derived_one/); assert.match(code, /derived_two/);
  assert.match(code, /pass1/); assert.match(code, /pass2/); assert.doesNotMatch(code, /pk_raw/);
});
test('TLS SOCKS fails closed and IPv6 URI authorities are bracketed', () => {
  assert.throws(() => snippets.buildProxyUri({ ...endpoint('tls', { tls: true }), protocol: 'socks5', username: 'derived', password: 'pass' }), /UNSUPPORTED/);
  assert.equal(snippets.buildProxyUri({ ...endpoint('ip'), protocol: 'http', username: 'user@', password: 'p:' }), 'http://user%40:p%3A@[2001:db8::1]:8080');
});
test('automation URLs retain explicit selection/protocol and cannot expand empty selections', () => {
  assert.equal(contract.buildAutomationUrl('https://panel', 'token', 'http', 'json', []), '');
  const url = new URL(contract.buildAutomationUrl('https://panel', 'token', 'http', 'json', ['one', 'two']));
  assert.equal(url.pathname, '/api/v1/user/proxy-pool/export');
  assert.equal(url.searchParams.get('lineIds'), 'one,two');
  assert.equal(url.searchParams.get('protocol'), 'http');
});
test('UI uses per-key queries, invalidation-safe checkboxes and no raw key snippet credentials/storage', () => {
  const hook = source('./use-proxy-export.ts');
  assert.doesNotMatch(hook, /currentKey\.(username|password)|localStorage|sessionStorage/);
  assert.match(hook, /reconcileSelection/);
  assert.match(source('./use-proxy-pool.ts'), /ENDPOINTS_QUERY_KEY, keyId/);
  const endpoints = [endpoint('online', { online: true }), endpoint('offline', { online: false }), endpoint('full', { status: 'CAPACITY_EXCLUDED' })];
  const h = endpointSelectionHarness(endpoints);
  for (const item of endpoints) {
    const checkbox = h.nodes.find((node) => node.type === 'Checkbox' && node.props.id === 'endpoint-' + item.lineId);
    assert.ok(checkbox);
    assert.equal(checkbox.props.disabled, item.status !== 'AVAILABLE');
    const card = h.nodes.find((node) => node.key === item.lineId);
    card.props.onClick();
  }
  assert.deepEqual(h.toggles, [['online', true], ['offline', true]]);
});

function endpointSelectionHarness(endpoints, selectedLineIds = [], pending = false) {
  const toggles = [], selections = [];
  const { ProxyEndpointSelection } = load('./components/proxy-endpoint-selection.tsx', {
    'react/jsx-runtime': jsxRuntime,
    'react-i18next': { useTranslation: () => ({ t: (key) => key }) },
    '@/components/ui/button': { Button: 'Button' },
    '@/components/ui/checkbox': { Checkbox: 'Checkbox' },
    '@/components/ui/badge': { Badge: 'Badge' },
    '@/components/ui/card': Object.fromEntries(['Card', 'CardContent', 'CardHeader', 'CardTitle'].map((name) => [name, name])),
    '@/components/shared/probe-result': { ProbeMeasurementChip: 'ProbeMeasurementChip' },
    '@/components/shared/flag-text': { FlagText: 'FlagText' },
    '@/lib/utils': { cn: (...values) => values.filter(Boolean).join(' ') },
    '../proxy-snippets': snippets
  });
  const tree = ProxyEndpointSelection({
    endpoints, pending, excludedCount: endpoints.filter((item) => item.status === 'CAPACITY_EXCLUDED').length,
    state: {
      selectedLineIds,
      toggleLine: (...args) => toggles.push(args),
      setSelection: (ids) => selections.push(Array.from(ids))
    }
  });
  function nodes(element) {
    if (!element || typeof element !== 'object') return [];
    if (Array.isArray(element)) return element.flatMap(nodes);
    return [element, ...nodes(element.props?.children)];
  }
  return { nodes: nodes(tree), toggles, selections };
}

test('available cards and checkboxes toggle the current selection without bubbling a second toggle', () => {
  for (const selected of [false, true]) {
    const h = endpointSelectionHarness([endpoint('one')], selected ? ['one'] : []);
    const checkbox = h.nodes.find((node) => node.type === 'Checkbox');
    assert.equal(checkbox.props.checked, selected);
    assert.equal(checkbox.props.disabled, false);
    const card = h.nodes.find((node) => node.key === 'one');
    card.props.onClick();
    assert.deepEqual(h.toggles, [['one', !selected]]);
    h.toggles.length = 0;
    let stopped = 0;
    checkbox.props.onClick({ stopPropagation: () => stopped++ });
    checkbox.props.onCheckedChange(!selected);
    assert.equal(stopped, 1);
    assert.deepEqual(h.toggles, [['one', !selected]]);
    checkbox.props.onCheckedChange('indeterminate');
    assert.deepEqual(h.toggles[1], ['one', false]);
  }
});

test('bulk selection excludes unavailable endpoints and empty or pending lists disable select-all', () => {
  const endpoints = [endpoint('one'), endpoint('offline', { online: false }), endpoint('full', { status: 'CAPACITY_EXCLUDED' })];
  const h = endpointSelectionHarness(endpoints, ['one']);
  const button = (harness, label) => harness.nodes.find((node) => node.type === 'Button' && node.props.children === 'user:proxyPool.' + label);
  assert.equal(button(h, 'selectAll').props.disabled, false);
  button(h, 'selectAll').props.onClick();
  assert.deepEqual(h.selections, [['one', 'offline']]);
  assert.equal(button(h, 'clearAll').props.disabled, false);
  button(h, 'clearAll').props.onClick();
  assert.deepEqual(h.selections[1], []);
  for (const pending of [false, true]) {
    const empty = endpointSelectionHarness([], [], pending);
    assert.equal(button(empty, 'selectAll').props.disabled, true);
    assert.equal(button(empty, 'clearAll').props.disabled, true);
  }
  const pending = endpointSelectionHarness(endpoints, [], true);
  assert.equal(button(pending, 'selectAll').props.disabled, true);
  assert.equal(pending.nodes.some((node) => node.type === 'Checkbox'), false);
});

test('structured errors are recognized for both JSON and raw export responses', () => {
  for (const data of [{ code: 'PROXY_POOL_SELECTION_UNAVAILABLE' }, '{"code":"PROXY_POOL_SELECTION_UNAVAILABLE","lineIds":["full"]}']) {
    assert.equal(contract.proxyPoolErrorCode({ response: { data } }), 'PROXY_POOL_SELECTION_UNAVAILABLE');
  }
  assert.equal(contract.proxyPoolErrorCode({ response: { data: 'invalid' } }), null);
  assert.match(source('./use-proxy-pool.ts'), /responseType: 'text'/);
  assert.doesNotMatch(source('./use-proxy-pool.ts'), /JSON.stringify\(raw/);
});

function selectionHarness() {
  const slots = [];
  let cursor = 0;
  const effects = [];
  const emptyQuery = { data: undefined, isError: false, isFetching: false, isPending: true };
  const modules = {
    react: {
      useState: (initial) => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
      useEffect: (effect) => effects.push(effect), useMemo: (fn) => fn()
    },
    'react-i18next': { useTranslation: () => ({ t: (key) => key }) },
    sonner: { toast: {} }, '@/lib/api': { extractErrorMessage: () => '' },
    '@/lib/public-settings': { usePublicSettings: () => ({ data: {} }) },
    './proxy-snippets': snippets, './proxy-pool-contract': contract,
    './use-proxy-pool': { useProxyPoolExport: () => emptyQuery, useProxyPoolExportCredentials: () => emptyQuery }
  };
  const exports = {};
  runInNewContext(ts.transpileModule(source('./use-proxy-export.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText,
    { exports, require: (name) => modules[name], window: { location: { origin: 'https://panel' } }, Error });
  return (keyId, endpoints, ready = true) => {
    cursor = 0; effects.length = 0;
    const result = exports.useProxyExport({ id: keyId, exportToken: 'token' }, endpoints, ready);
    effects.forEach((effect) => effect());
    return result;
  };
}
test('checkbox state survives refetch/key changes but cleans capacity/deletion and never reselects reappearing endpoints', () => {
  const render = selectionHarness();
  let state = render('a', [endpoint('one'), endpoint('two')]);
  assert.equal(state.selectedLineIds.length, 0);
  state.toggleLine('one', true);
  state = render('a', [endpoint('one'), endpoint('two'), endpoint('new')]);
  assert.deepEqual(Array.from(state.selectedLineIds), ['one']);
  assert.equal(render('b', [endpoint('one')]).selectedLineIds.length, 0);
  assert.deepEqual(Array.from(render('a', [endpoint('one')]).selectedLineIds), ['one']);
  assert.equal(render('a', [endpoint('one', { status: 'CAPACITY_EXCLUDED' })]).selectedLineIds.length, 0);
  assert.equal(render('a', [endpoint('one')]).selectedLineIds.length, 0);
  state = render('a', [endpoint('one')]); state.toggleLine('one', true);
  render('a', []);
  assert.equal(render('a', [endpoint('one')]).selectedLineIds.length, 0);
});
test('UI never issues incompatible TLS SOCKS/TXT export or unsafe empty automation', () => {
  const render = selectionHarness();
  let state = render('a', [endpoint('tls', { tls: true, supportedProtocols: ['http'] })]);
  state.toggleLine('tls', true);
  state = render('a', [endpoint('tls', { tls: true, supportedProtocols: ['http'] })]);
  assert.equal(state.canCopy, false); assert.equal(state.automationUrl, '');
  state.setProtocol('http');
  state = render('a', [endpoint('tls', { tls: true, supportedProtocols: ['http'] })]);
  assert.equal(state.content, 'user:proxyPool.tlsTextUnavailable');
  assert.equal(state.automationUrl, '');
  state.setFormat('uri');
  state = render('a', [endpoint('tls', { tls: true, supportedProtocols: ['http'] })]);
  assert.match(state.automationUrl, /lineIds=tls/);
  assert.match(state.automationUrl, /protocol=http/);
});
