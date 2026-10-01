import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { URL, URLSearchParams } from 'node:url';
import ts from 'typescript';
const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const load = (path) => {
  const exports = {};
  runInNewContext(ts.transpileModule(source(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { exports, URL, URLSearchParams });
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
  assert.match(source('./components/proxy-endpoint-selection.tsx'), /disabled=\{endpoint.status !== 'AVAILABLE'\}/);
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
