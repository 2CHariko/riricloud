import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { URL, URLSearchParams } from 'node:url';
import { setImmediate, setTimeout } from 'node:timers';
import ts from 'typescript';
import * as zod from 'zod';
import * as jsxRuntime from 'react/jsx-runtime';
import * as axiosModule from 'axios';

const { AbortController, queueMicrotask } = globalThis;
const source = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
function load(file, modules = {}) {
  const exports = {};
  runInNewContext(ts.transpileModule(source(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText, { exports, AbortController, Error, require: (name) => {
    if (!(name in modules)) throw new Error('Unexpected test import: ' + name);
    return modules[name];
  } });
  return exports;
}
const contractPath = '../pages/admin/lines/line-credentials-contract.ts';
const contract = load(contractPath, { zod });
const lineId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const line = { id: lineId, name: 'Relay A', type: 'RELAY', relayMode: 'PROTOCOL_PROXY', status: 'ACTIVE' };
const status = (extra = {}) => ({
  lineId, operationId, state: 'CONFIRMED', activeVersion: 1, targetVersion: 1,
  errorCode: null, entryStopConfirmed: false, accepted: false,
  confirmedAt: '2026-11-17T04:00:00.000Z', ...extra
});

test('credential maintenance is limited to protocol/target relays, including disabled read-only lines', () => {
  for (const relayMode of ['PROTOCOL_PROXY', 'TARGET_LINE']) {
    assert.equal(contract.isCredentialLine({ ...line, relayMode }), true);
    assert.equal(contract.isCredentialLine({ ...line, relayMode, status: 'DISABLED' }), true);
  }
  for (const item of [{ ...line, type: 'DIRECT' }, { ...line, type: 'EXTERNAL' }, { ...line, relayMode: 'BLIND_FORWARD' }, { ...line, relayMode: 'UPSTREAM_NODE' }]) {
    assert.equal(contract.isCredentialLine(item), false);
    assert.equal(contract.canMaintainLineCredentials(item, status()), false);
  }
});

test('inactive, unavailable and running lines cannot rotate; FAILED retries the existing operation', () => {
  assert.equal(contract.canMaintainLineCredentials(line, status()), true);
  assert.equal(contract.canMaintainLineCredentials(line, status({ state: 'FAILED', errorCode: 'STAGE_TIMEOUT' })), true);
  assert.equal(contract.canMaintainLineCredentials({ ...line, status: 'DISABLED' }, status()), false);
  assert.equal(contract.canMaintainLineCredentials(line, status({ lineId: otherId })), false);
  assert.equal(contract.canMaintainLineCredentials(line, undefined), false);
  for (const state of ['UNAVAILABLE', 'STOPPING_PREVIOUS_ENTRY', 'STOPPING_ENTRY', 'APPLYING_LANDING', 'RESTORING_ENTRY', 'RETIRING_PREVIOUS_LANDING']) {
    assert.equal(contract.canMaintainLineCredentials(line, status({ state })), false);
  }
});

test('only known metadata reaches the query cache; unexpected credentials and diagnostics are stripped', () => {
  const result = contract.parseLineCredentialStatus({ ...status(), credential: 'secret-value', encryptedPayload: 'encrypted-secret', message: 'password=secret-value', unknown: { token: 'token-value' } }, lineId);
  assert.deepEqual(Object.keys(result).sort(), Object.keys(status()).sort());
  assert.doesNotMatch(JSON.stringify(result), /secret-value|encrypted-secret|password|token-value/);
  assert.equal(contract.parseLineCredentialStatus(status({ errorCode: 'password=secret-value' }), lineId).errorCode, 'UNKNOWN');
});

test('malformed status, mismatched line, and unconfirmed success fail closed without leaking response data', () => {
  for (const payload of [null, { message: 'secret-value' }, status({ lineId: otherId }), status({ state: 'unexpected-secret' }), status({ confirmedAt: null }), status({ activeVersion: 2 }), status({ targetVersion: -1 })]) {
    assert.throws(() => contract.parseLineCredentialStatus(payload, lineId), { message: 'LINE_CREDENTIAL_INVALID_RESPONSE' });
  }
});

test('only allowlisted backend codes or HTTP status produce localized error keys', () => {
  assert.equal(contract.credentialErrorKey({ response: { status: 401, data: { message: 'token=secret' } } }), 'unauthorized');
  assert.equal(contract.credentialErrorKey({ response: { status: 403, data: { message: 'password=secret' } } }), 'forbidden');
  assert.equal(contract.credentialErrorKey({ response: { status: 409, data: { message: 'LINE_CREDENTIAL_PUBLIC_TLS_REQUIRED' } } }), 'publicTlsRequired');
  assert.equal(contract.credentialErrorKey({ response: { status: 500, data: { message: 'password=secret' } } }), 'requestFailed');
  assert.equal(contract.credentialErrorKey(new Error('LINE_CREDENTIAL_INVALID_RESPONSE')), 'invalidResponse');
});


const atoms = (names) => Object.fromEntries(names.split(' ').map(name => [name, name]));
const commonUi = {
  'react/jsx-runtime': jsxRuntime,
  'lucide-react': atoms('Activity ArrowDown ArrowUp Copy MoreHorizontal Pencil ShieldCheck Trash2 Zap RefreshCw HelpCircle Search Plus GitBranch'),
  '@/components/ui/button': atoms('Button'),
  '@/components/ui/icon-button': atoms('IconButton'),
  '@/components/ui/badge': atoms('Badge'),
  '@/components/ui/card': atoms('Card CardContent'),
  '@/components/ui/checkbox': atoms('Checkbox'),
  '@/components/ui/table': atoms('Table TableBody TableCell TableHead TableHeader TableRow'),
  '@/components/ui/tooltip': atoms('Tooltip TooltipContent TooltipTrigger'),
  '@/components/ui/skeleton': atoms('Skeleton'),
  '@/components/ui/dialog': atoms('DialogDescription DialogFooter DialogHeader DialogTitle'),
  '@/components/shared/responsive-dialog': atoms('ResponsiveDialog ResponsiveDialogContent'),
  '@/components/ui/alert-dialog': atoms('AlertDialog AlertDialogAction AlertDialogCancel AlertDialogContent AlertDialogDescription AlertDialogFooter AlertDialogHeader AlertDialogTitle'),
  '@/components/ui/dropdown-menu': atoms('DropdownMenu DropdownMenuContent DropdownMenuItem DropdownMenuSeparator DropdownMenuTrigger')
};
const locale = load('../locales/zh-CN/admin.ts').default;
function translate(key, variables = {}) {
  const localKey = key.replace(/^admin:/, '');
  const value = localKey.split('.').reduce((object, name) => object?.[name], locale);
  if (typeof value !== 'string') return key;
  return value.replace(/{{(\w+)}}/g, (_, name) => variables[name] ?? '{{' + name + '}}');
}
commonUi['react-i18next'] = { useTranslation: () => ({ t: translate }) };
function nodes(element) {
  if (!element || typeof element !== 'object') return [];
  if (Array.isArray(element)) return element.flatMap(nodes);
  if (['AlertDialog', 'ResponsiveDialog'].includes(element.type) && !element.props.open) return [element];
  if (typeof element.type === 'function') return nodes(element.type(element.props));
  return [element, ...nodes(element.props?.children)];
}
function text(element) {
  if (element == null || typeof element === 'boolean') return '';
  if (typeof element !== 'object') return String(element);
  if (Array.isArray(element)) return element.map(text).join(' ');
  if (['AlertDialog', 'ResponsiveDialog'].includes(element.type) && !element.props.open) return '';
  if (typeof element.type === 'function') return text(element.type(element.props));
  return text(element.props?.children);
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await tick(); }
  assert.ok(predicate(), 'condition did not settle');
}
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// 使用真实 QueryObserver/MutationObserver；仅替换 React 挂载层与原子控件，不模拟轮询调度。
globalThis.window = {};
const { QueryClient, QueryObserver, MutationObserver } = await import('@tanstack/react-query');
delete globalThis.window;

function harness(initial = status(), initialLine = line, initiallyOpen = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false, gcTime: 0 } } });
  const calls = [], notifications = [], logs = [], slots = [];
  let cursor = 0, scheduled = false, disposed = false;
  let serverState = initial, getError = null, postError = null, postReply = null, getBlock = null, postBlock = null;
  let props = { line: initialLine, open: initiallyOpen, onOpenChange: open => { props.open = open; render(); } };
  let tree, hookResult;
  const schedule = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; if (!disposed) render(); });
  };
  const toast = Object.fromEntries(['error', 'success', 'info'].map(level => [level, message => notifications.push({ level, message })]));
  const i18n = { t: translate };
  const failure = load('./api-failure.ts');
  const errorMapping = load('../i18n/error-mapping.ts', { axios: axiosModule, './config': { default: i18n } });
  const baseApi = load('./api.ts', {
    axios: axiosModule, sonner: { toast }, '@/i18n': { default: i18n },
    '@/stores/auth': { useAuthStore: { getState: () => ({ user: null }) } },
    '@/lib/logger': { frontendLogger: { setTransport() {}, warn: (...values) => logs.push(values), error: (...values) => logs.push(values) } },
    '@/i18n/error-mapping': errorMapping, '@/lib/api-failure': failure
  });
  baseApi.api.defaults.adapter = async config => {
    const method = config.method.toUpperCase();
    calls.push({ method, url: config.url, data: config.data, signal: config.signal });
    const block = method === 'GET' ? getBlock : postBlock;
    if (block) await Promise.race([block.promise, new Promise((_, reject) => config.signal?.addEventListener('abort', () => reject(new axiosModule.CanceledError()), { once: true }))]);
    const failure = method === 'GET' ? getError : postError;
    if (failure) {
      const response = { config, status: failure.status, data: JSON.stringify(failure.data), headers: {}, statusText: 'Error' };
      throw new axiosModule.AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, undefined, response);
    }
    if (method === 'POST') serverState = postReply ?? status({ state: 'STOPPING_ENTRY', targetVersion: 2, confirmedAt: null, accepted: false });
    return { config, status: method === 'POST' ? 202 : 200, data: JSON.stringify(serverState), headers: {}, statusText: 'OK' };
  };
  const api = load('../pages/admin/lines/line-credentials-api.ts', { '@/lib/api': baseApi, '@/i18n/config': { default: i18n }, './line-credentials-contract': contract });
  const react = {
    useRef: value => { const index = cursor++; slots[index] ??= { ref: { current: value } }; return slots[index].ref; },
    useState: initial => { const index = cursor++; slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; schedule(); }]; }
  };
  let mutationCount = 0;
  const mutationStop = client.getMutationCache().subscribe(() => {
    const count = client.isMutating();
    if (count !== mutationCount) { mutationCount = count; schedule(); }
  });
  const queryHooks = {
    useIsMutating: filters => client.isMutating(filters),
    useQueryClient: () => client,
    useQuery: options => {
      const index = cursor++;
      if (!slots[index]) {
        const observer = new QueryObserver(client, options);
        slots[index] = { observer, stop: observer.subscribe(schedule) };
      } else slots[index].observer.setOptions(options);
      return slots[index].observer.getCurrentResult();
    },
    useMutation: options => {
      const index = cursor++;
      if (!slots[index]) {
        const observer = new MutationObserver(client, options);
        slots[index] = { observer, stop: observer.subscribe(schedule) };
      } else slots[index].observer.setOptions(options);
      const observer = slots[index].observer;
      return { ...observer.getCurrentResult(), mutate: (...args) => { void observer.mutate(...args).catch(() => {}); } };
    }
  };
  const hooks = load('../pages/admin/lines/use-line-credentials.ts', {
    react, '@tanstack/react-query': queryHooks, sonner: { toast }, '@/i18n/config': { default: i18n },
    './line-credentials-api': api, './line-credentials-contract': contract
  });
  const details = load('../pages/admin/lines/components/line-credential-status.tsx', {
    ...commonUi, '@/lib/utils': { formatDateTime: value => value }, '../line-credentials-contract': contract
  });
  const { LineCredentialsDialog } = load('../pages/admin/lines/components/line-credentials-dialog.tsx', {
    ...commonUi, react, '../line-credentials-contract': contract, './line-credential-status': details,
    '../use-line-credentials': { useLineCredentials: (...args) => { hookResult = hooks.useLineCredentials(...args); return hookResult; } }
  });
  function render() { cursor = 0; tree = LineCredentialsDialog(props); return tree; }
  render();
  return {
    client, calls, notifications, logs, api, hooks,
    get tree() { return tree; }, get hook() { return hookResult; },
    get nodes() { return nodes(tree); }, get text() { return text(tree); },
    control(label, type = 'Button') { const result = nodes(tree).find(node => node.type === type && text(node).trim() === label); assert.ok(result, 'control not found: ' + label); return result; },
    click(label, type) { const control = this.control(label, type); assert.equal(Boolean(control.props.disabled), false, label + ' is disabled'); control.props.onClick?.({ preventDefault() {} }); },
    updateLine(next) { props.line = next; render(); },
    remount() { for (const item of slots) item.stop?.(); slots.length = 0; props.open = true; render(); },
    setStatus(next) { serverState = next; }, setGetError(error) { getError = error; }, setPostError(error) { postError = error; },
    setPostReply(next) { postReply = next; }, blockGet(value) { getBlock = value; }, blockPost(value) { postBlock = value; },
    dispose() { disposed = true; getBlock?.resolve(); postBlock?.resolve(); mutationStop(); for (const item of slots) item.stop?.(); client.clear(); }
  };
}

test('opening queries only status, rotation requires AlertDialog confirmation and disables repeat submission', async () => {
  const h = harness();
  try {
    await until(() => h.hook.canRotate);
    assert.deepEqual(h.calls.map(call => [call.method, call.url]), [['GET', '/admin/lines/' + lineId + '/credentials/status']]);
    h.click(translate('lineCredentials.rotate')); await tick();
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
    assert.ok(h.nodes.some(node => node.type === 'AlertDialog' && node.props.open));
    assert.match(h.text, /短暂停线/); assert.match(h.text, /重载内核/);
    h.nodes.find(node => node.type === 'AlertDialog').props.onOpenChange(false); await tick();
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
    h.click(translate('lineCredentials.rotate')); await tick();
    const pending = defer(); h.blockPost(pending);
    const confirm = h.control(translate('lineCredentials.confirmRotate'), 'AlertDialogAction');
    confirm.props.onClick(); confirm.props.onClick();
    await until(() => h.calls.some(call => call.method === 'POST'));
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(h.control(translate('lineCredentials.submitting')).props.disabled, true);
    assert.doesNotMatch(h.text, /维护已确认完成|已确认新版本运行/);
    pending.resolve();
    await until(() => h.hook.query.data?.state === 'STOPPING_ENTRY' && !h.hook.rotation.isPending);
    assert.equal(h.control(translate('lineCredentials.inProgress')).props.disabled, true);
    assert.equal(h.notifications.some(item => item.level === 'success'), false);
    assert.match(h.text, /尚未确认新版本运行/);
  } finally { h.dispose(); }
});

test('FAILED confirms a retry of the same operation and candidate, never posts secret material', async () => {
  const failed = status({ state: 'FAILED', targetVersion: 2, confirmedAt: null, failedStage: 'APPLYING_LANDING', errorCode: 'STAGE_TIMEOUT' });
  const h = harness(failed);
  try {
    await until(() => h.hook.canRotate);
    assert.match(h.text, /本阶段未在规定时间内获得运行确认/);
    assert.match(h.text, /入口仍被要求停用/);
    h.click(translate('lineCredentials.retry')); await tick();
    assert.match(h.text, /沿用原维护任务与候选凭据版本/);
    h.setPostReply({ ...failed, state: 'STOPPING_ENTRY', failedStage: null, errorCode: null });
    h.click(translate('lineCredentials.confirmRetry'), 'AlertDialogAction');
    await until(() => h.hook.query.data?.state === 'STOPPING_ENTRY' && !h.hook.rotation.isPending);
    assert.equal(h.hook.query.data.operationId, operationId);
    assert.equal(h.hook.query.data.targetVersion, 2);
    const post = h.calls.find(call => call.method === 'POST');
    assert.equal(post.url, '/admin/lines/' + lineId + '/credentials/rotate');
    assert.equal(post.data, undefined);
  } finally { h.dispose(); }
});

test('all running stages disable rotation and acceptance never renders runtime confirmation', async () => {
  for (const state of ['STOPPING_PREVIOUS_ENTRY', 'STOPPING_ENTRY', 'APPLYING_LANDING', 'RESTORING_ENTRY', 'RETIRING_PREVIOUS_LANDING']) {
    const h = harness(status({ state, targetVersion: 2, confirmedAt: null, accepted: true, entryStopConfirmed: false }));
    try {
      await until(() => h.hook.query.isSuccess);
      assert.equal(h.control(translate('lineCredentials.inProgress')).props.disabled, true);
      h.hook.requestRotation(); await tick();
      assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
      assert.match(h.text, /配置已受理，仍需运行确认/);
      assert.match(h.text, state === 'RESTORING_ENTRY' ? /本阶段不要求入口停用/ : /尚未确认入口已停止接入/);
      assert.match(h.text, /尚未确认新版本运行/);
      assert.doesNotMatch(h.text, /已确认新版本运行/);
    } finally { h.dispose(); }
  }
});

test('inactive lines and lines disabled while confirming remain read-only', async () => {
  const h = harness(status(), { ...line, status: 'DISABLED' });
  try {
    await until(() => h.hook.query.isSuccess);
    assert.equal(h.control(translate('lineCredentials.rotate')).props.disabled, true);
    assert.match(h.text, /此线路已停用/);
    h.updateLine(line);
    h.click(translate('lineCredentials.rotate')); await tick();
    h.updateLine({ ...line, status: 'DISABLED' });
    const confirm = h.control(translate('lineCredentials.confirmRotate'), 'AlertDialogAction');
    assert.equal(confirm.props.disabled, true);
    confirm.props.onClick(); await tick();
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
  } finally { h.dispose(); }
});

test('real React Query polls only while open and running; closing stops subsequent requests', async () => {
  const h = harness(status({ state: 'STOPPING_ENTRY', targetVersion: 2, confirmedAt: null }));
  try {
    await until(() => h.hook.query.isSuccess);
    await wait(2150);
    assert.ok(h.calls.length >= 2, 'an open running dialog must poll');
    h.click('common:actions.close'); await tick();
    const countAtClose = h.calls.length;
    await wait(2150);
    assert.equal(h.calls.length, countAtClose);
    assert.equal(h.nodes.some(node => node.type === 'Button'), false);
  } finally { h.dispose(); }
});

test('unmounting aborts in-flight status requests without failure toast or log', async () => {
  const h = harness();
  await until(() => h.hook.query.isSuccess);
  const blocked = defer(); h.blockGet(blocked);
  void h.hook.refresh();
  await until(() => h.calls.length === 2);
  const signal = h.calls[1].signal;
  h.dispose(); blocked.resolve(); await tick();
  assert.equal(signal.aborted, true);
  assert.deepEqual(h.notifications, []);
  assert.deepEqual(h.logs, []);
});

test('401/403 and unsafe server errors never yield success, leak diagnostics, or silently retry mutations', async () => {
  for (const httpStatus of [401, 403, 500]) {
    const h = harness();
    try {
      await until(() => h.hook.canRotate);
      h.setPostError({ status: httpStatus, data: { message: 'password=secret-value', token: 'token-value', details: { credential: 'credential-value' } } });
      h.click(translate('lineCredentials.rotate')); await tick();
      h.click(translate('lineCredentials.confirmRotate'), 'AlertDialogAction');
      await until(() => h.hook.rotation.isError);
      assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
      assert.equal(h.control(translate('lineCredentials.rotate')).props.disabled, true);
      assert.equal(h.notifications.some(item => item.level === 'success'), false);
      assert.match(h.text, /本次请求结果尚无法确认/);
      assert.doesNotMatch(h.text + JSON.stringify(h.notifications) + JSON.stringify(h.logs), /secret-value|token-value|credential-value/);
      if (httpStatus === 401) assert.match(h.text, /登录状态已失效/);
      if (httpStatus === 403) assert.match(h.text, /没有管理员维护权限/);
      h.setPostError(null);
      h.click(translate('lineCredentials.refresh'));
      await until(() => h.hook.canRotate);
    } finally { h.dispose(); }
  }
});

test('status read failures hide stale success, stop polling and show a safe manual refresh', async () => {
  const h = harness(status({ state: 'STOPPING_ENTRY', targetVersion: 2, confirmedAt: null }));
  try {
    await until(() => h.hook.query.isSuccess);
    h.setGetError({ status: 403, data: { message: 'private-key=secret-value' } });
    await h.hook.refresh(); await tick();
    assert.equal(h.hook.query.isError, true);
    assert.equal(h.hook.canRotate, false);
    assert.match(h.text, /没有管理员维护权限/);
    assert.doesNotMatch(h.text, /secret-value|已确认新版本运行/);
    const query = h.client.getQueryCache().getAll()[0];
    assert.equal(query.options.refetchInterval(query), false);
  } finally { h.dispose(); }
});

test('response fields are sanitized before real Axios interceptors, cache, and UI consume them', async () => {
  const h = harness({ ...status(), encryptedPayload: 'encrypted-value', credential: 'secret-value', password: 'password-value' });
  try {
    await until(() => h.hook.query.isSuccess);
    assert.doesNotMatch(JSON.stringify(h.hook.query.data) + h.text, /encrypted-value|secret-value|password-value/);
    assert.equal(h.hook.query.data.accepted, false);
    assert.match(h.text, /已确认新版本运行/);
    assert.match(h.text, /已完成全部阶段对账/);
  } finally { h.dispose(); }
});


test('a confirmation opened for an older operation cannot rotate a newly changed version', async () => {
  const h = harness();
  try {
    await until(() => h.hook.canRotate);
    h.click(translate('lineCredentials.rotate')); await tick();
    h.setStatus(status({ operationId: otherId, activeVersion: 2, targetVersion: 2 }));
    await h.hook.refresh(); await tick();
    const confirm = h.control(translate('lineCredentials.confirmRotate'), 'AlertDialogAction');
    assert.equal(confirm.props.disabled, true);
    confirm.props.onClick(); await tick();
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
    assert.match(h.text, /维护状态已变化/);
  } finally { h.dispose(); }
});


test('closed and unsupported dialogs never issue credential requests', async () => {
  for (const [item, open] of [[line, false], [{ ...line, type: 'DIRECT' }, true], [{ ...line, relayMode: 'BLIND_FORWARD' }, true]]) {
    const h = harness(status(), item, open);
    try { await tick(); assert.equal(h.calls.length, 0); assert.equal(h.hook.canRotate, false); }
    finally { h.dispose(); }
  }
});

test('UNAVAILABLE blocks actions, uninitialized active relays may initialize after confirmation', async () => {
  for (const state of ['UNAVAILABLE', 'NOT_INITIALIZED']) {
    const h = harness(status({ state, operationId: null, activeVersion: null, targetVersion: null, confirmedAt: null, errorCode: state === 'UNAVAILABLE' ? 'LINE_CREDENTIAL_LINE_INACTIVE' : null }));
    try {
      await until(() => h.hook.query.isSuccess);
      assert.equal(h.control(translate('lineCredentials.rotate')).props.disabled, state === 'UNAVAILABLE');
      assert.match(h.text, /尚未生成/);
      assert.doesNotMatch(h.text, /已确认新版本运行/);
      if (state === 'UNAVAILABLE') assert.match(h.text, /已禁用线路不能发起轮换/);
    } finally { h.dispose(); }
  }
});

test('a 202 FAILED result is rendered as failure with retry rather than a successful rotation', async () => {
  const h = harness();
  try {
    await until(() => h.hook.canRotate);
    h.setPostReply(status({ state: 'FAILED', targetVersion: 2, confirmedAt: null, errorCode: 'AGENT_REJECTED', failedStage: 'STOPPING_ENTRY' }));
    h.click(translate('lineCredentials.rotate')); await tick();
    h.click(translate('lineCredentials.confirmRotate'), 'AlertDialogAction');
    await until(() => h.hook.query.data?.state === 'FAILED' && h.hook.canRotate);
    assert.equal(h.control(translate('lineCredentials.retry')).props.disabled, false);
    assert.match(h.text, /节点拒绝了本阶段配置/);
    assert.equal(h.notifications.some(item => item.level === 'success'), false);
    assert.doesNotMatch(h.text, /已确认新版本运行/);
  } finally { h.dispose(); }
});

function pageHarness(items) {
  const slots = [], effects = [], mutations = [], queries = [];
  let cursor = 0, tree, scheduled = false;
  const schedule = () => { if (!scheduled) { scheduled = true; queueMicrotask(() => { scheduled = false; render(); }); } };
  const react = {
    useState: initial => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; schedule(); }]; },
    useMemo: fn => fn(),
    useEffect: (effect, deps) => { const index = cursor++; if (!slots[index] || deps.some((dep, i) => !Object.is(dep, slots[index][i]))) effects.push(effect); slots[index] = deps; }
  };
  const rowActions = load('../pages/admin/lines/components/line-row-actions.tsx', { ...commonUi, '../line-credentials-contract': contract });
  const table = load('../pages/admin/lines/components/lines-table.tsx', {
    ...commonUi, '@/components/shared/empty-state': atoms('EmptyState'), '@/components/shared/flag-text': atoms('FlagText'),
    '@/components/shared/probe-result': atoms('ProbeMeasurementChip'), '@/lib/utils': { cn: (...values) => values.filter(Boolean).join(' ') },
    '@/lib/speed-tier': { formatSpeedLimit: String, getSpeedTierBadgeClass: () => '' }, './line-topology': atoms('LineTopology'), './line-row-actions': rowActions
  });
  const toolbar = load('../pages/admin/lines/components/lines-toolbar.tsx', {
    ...commonUi, '@/components/ui/input': atoms('Input'), '@/components/ui/select': atoms('Select SelectContent SelectItem SelectTrigger SelectValue'), './proxy-pool-drawer': atoms('ProxyPoolDrawer')
  });
  const mutators = Object.fromEntries(['create', 'update', 'remove', 'duplicate', 'testResolve', 'batchStatus', 'reorder'].map(name => [name, { isPending: false, mutate: (value, options) => { mutations.push({ name, value }); options?.onSuccess?.(); } }]));
  const { default: Page } = load('../pages/admin/lines/index.tsx', {
    ...commonUi, react,
    'react-router-dom': { useLocation: () => ({ key: 'lines-page', state: null }), useSearchParams: () => [new URLSearchParams(), () => {}] },
    '@/lib/certificate-navigation': { certificateReturnPath: () => null },
    '@/lib/public-settings': { usePublicSettings: () => ({ data: {} }) },
    '@/components/shared/certificate-return-link': atoms('CertificateReturnLink'),
    '@/components/shared/server-pagination': atoms('ServerPagination'), '@/components/shared/page-container': atoms('PageContainer PageHeader'),
    '@/components/shared/probe-task-dialog': atoms('ProbeTaskDialog'),
    '../nodes/use-nodes': { useAdminNodes: () => ({ data: [] }) },
    '../certificates/use-certificates': { useAdminCertificates: () => ({ data: { data: [] } }) },
    './use-lines': { useAdminLines: query => { queries.push(query); return { data: { data: items, total: items.length } }; }, useLineMutations: () => mutators },
    './components/linked-line-dialog': atoms('LinkedLineDialog'), './components/line-form-dialog': atoms('LineFormDialog'),
    './components/line-speedtest-dialog': atoms('LineSpeedtestDialog'), './components/line-credentials-dialog': atoms('LineCredentialsDialog'),
    './components/lines-table': table, './components/lines-toolbar': toolbar, './line-credentials-contract': contract
  });
  function render() { cursor = 0; tree = Page(); effects.splice(0).forEach(effect => effect()); }
  render();
  return { get tree() { return tree; }, get nodes() { return nodes(tree); }, mutations, queries, updateItems(next) { items = next; render(); } };
}
const tableLine = (overrides = {}) => ({ ...line, tags: [], sortOrder: 10, level: 0, isPublic: true, serverHost: 'node.example', serverPort: 443, trafficRate: 1, ...overrides });

test('actual line-row menu opens one selected credential dialog, including inactive read-only relays, and closes it', async () => {
  const items = [
    tableLine(), tableLine({ id: otherId, status: 'DISABLED', relayMode: 'TARGET_LINE' }),
    tableLine({ id: 'direct', type: 'DIRECT' }), tableLine({ id: 'external', type: 'EXTERNAL' }),
    tableLine({ id: 'blind', relayMode: 'BLIND_FORWARD' }), tableLine({ id: 'upstream', relayMode: 'UPSTREAM_NODE' })
  ];
  const h = pageHarness(items);
  assert.equal(h.nodes.filter(node => node.type === 'LineCredentialsDialog').length, 0);
  let menu = h.nodes.filter(node => node.type === 'DropdownMenuItem' && text(node).trim() === translate('lineCredentials.manage'));
  assert.equal(menu.length, 2);
  menu[0].props.onSelect(); await tick();
  let dialog = h.nodes.find(node => node.type === 'LineCredentialsDialog');
  assert.equal(dialog.props.line.id, lineId);
  assert.equal(dialog.props.open, true);
  assert.equal(h.nodes.filter(node => node.type === 'LineCredentialsDialog').length, 1);
  dialog.props.onOpenChange(false); await tick();
  assert.equal(h.nodes.filter(node => node.type === 'LineCredentialsDialog').length, 0);
  menu = h.nodes.filter(node => node.type === 'DropdownMenuItem' && text(node).trim() === translate('lineCredentials.manage'));
  menu[1].props.onSelect(); await tick();
  dialog = h.nodes.find(node => node.type === 'LineCredentialsDialog');
  assert.equal(dialog.props.line.id, otherId);
  assert.equal(dialog.props.line.status, 'DISABLED');
  assert.deepEqual(h.mutations, []);
});

test('table extraction preserves checkbox selection, filter reset, and existing row callbacks', async () => {
  const h = pageHarness([tableLine(), tableLine({ id: otherId, name: 'Relay B' })]);
  h.nodes.find(node => node.type === 'Checkbox' && node.props['aria-label'] === 'common:actions.select Relay A').props.onCheckedChange(true);
  await tick();
  const batch = h.nodes.find(node => node.type === 'Button' && text(node).trim() === translate('lines.batchDisable'));
  batch.props.onClick(); await tick();
  assert.equal(h.mutations[0].name, 'batchStatus');
  assert.equal(JSON.stringify(h.mutations[0].value), JSON.stringify({ ids: [lineId], status: 'DISABLED' }));
  const duplicate = h.nodes.find(node => node.type === 'DropdownMenuItem' && text(node).trim() === translate('lines.duplicateLine'));
  duplicate.props.onClick();
  assert.equal(h.mutations[1].name, 'duplicate'); assert.equal(h.mutations[1].value, lineId);
  h.nodes.find(node => node.type === 'ServerPagination').props.onPageChange(2); await tick();
  h.nodes.find(node => node.type === 'Input' && node.props.placeholder === translate('nodes.searchPlaceholder')).props.onChange({ target: { value: 'filter' } });
  await tick();
  assert.equal(h.queries.at(-1).page, 1);
  assert.equal(h.queries.at(-1).search, 'filter');
});


test('a past confirmed version with invalid topology is not shown as currently successful', async () => {
  const h = harness(status({ errorCode: 'LINE_CREDENTIAL_CONFIGURATION_INVALID' }));
  try {
    await until(() => h.hook.query.isSuccess);
    assert.match(h.text, /当前不可维护/);
    assert.match(h.text, /尚未确认新版本运行/);
    assert.doesNotMatch(h.text, /维护已确认完成|已确认新版本运行/);
    assert.equal(h.control(translate('lineCredentials.rotate')).props.disabled, true);
  } finally { h.dispose(); }
});

test('closing and reopening while POST is in flight keeps the same mutation lock and hides old success', async () => {
  const h = harness();
  try {
    await until(() => h.hook.canRotate);
    const pending = defer(); h.blockPost(pending);
    h.click(translate('lineCredentials.rotate')); await tick();
    h.click(translate('lineCredentials.confirmRotate'), 'AlertDialogAction');
    await until(() => h.calls.some(call => call.method === 'POST'));
    h.click('common:actions.close'); await tick();
    h.remount(); await tick();
    assert.equal(h.hook.canRotate, false);
    assert.equal(h.control(translate('lineCredentials.submitting')).props.disabled, true);
    assert.doesNotMatch(h.text, /维护已确认完成|已确认新版本运行/);
    h.hook.requestRotation(); await tick();
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
    pending.resolve();
    await until(() => h.hook.query.data?.state === 'STOPPING_ENTRY' && !h.hook.mutationPending);
  } finally { h.dispose(); }
});

test('the selected dialog follows fresh line status and closes when the line disappears or changes topology', async () => {
  const h = pageHarness([tableLine()]);
  const select = async () => { h.nodes.find(node => node.type === 'DropdownMenuItem' && text(node).trim() === translate('lineCredentials.manage')).props.onSelect(); await tick(); };
  await select();
  h.updateItems([tableLine({ status: 'DISABLED' })]); await tick();
  assert.equal(h.nodes.find(node => node.type === 'LineCredentialsDialog').props.line.status, 'DISABLED');
  h.updateItems([]); await tick();
  assert.equal(h.nodes.filter(node => node.type === 'LineCredentialsDialog').length, 0);
  h.updateItems([tableLine()]); await tick();
  assert.equal(h.nodes.filter(node => node.type === 'LineCredentialsDialog').length, 0);
  await select();
  h.updateItems([tableLine({ type: 'DIRECT' })]); await tick();
  h.updateItems([tableLine()]); await tick();
  assert.equal(h.nodes.filter(node => node.type === 'LineCredentialsDialog').length, 0);
});


test('Chinese account and maintenance keys contain actual copy with exact account interpolation', () => {
  const expected = {
    user: '拨测订阅账号', userHelp: '自建线路使用此账号的订阅身份，流量正常计费；每次测试都会重新校验权益。',
    userNone: '未配置', userCurrent: '当前账号：{{id}}', userSearch: '查找拨测账号', userSearchPlaceholder: '搜索 UID、昵称或邮箱',
    userLoadFailed: '账号列表加载失败，请稍后重试。', userSearchHint: '仅显示当前搜索页中可用的账号；可缩小搜索范围查找其他账号。'
  };
  for (const [key, value] of Object.entries(expected)) assert.equal(locale.latencyTest.settings[key], value);
  assert.equal(locale.latencyTest.accountErrors.SPEEDTEST_USER_NOT_CONFIGURED, '请先在系统设置中指定拨测订阅账号。');
  assert.equal(locale.latencyTest.accountErrors.SPEEDTEST_USER_UNAVAILABLE, '拨测账号不可用，请检查账号状态、邮箱验证、订阅有效期和配额。');
  assert.equal(locale.latencyTest.accountErrors.SPEEDTEST_LINE_UNAUTHORIZED, '拨测账号无权访问此线路。');
  assert.equal(locale.latencyTest.accountErrors.SPEEDTEST_IDENTITY_CHANGED, '拨测账号或凭据已变更，请重新测试。');
  for (const key of Object.values(contract.credentialErrorKeys)) assert.match(locale.lineCredentials.errors[key], /[\u4e00-\u9fff]/);
  for (const state of contract.credentialStates) assert.match(locale.lineCredentials.states[state], /[\u4e00-\u9fff]/);
});


test('topology retirement phases poll, disable operations and expose only optional previous node identifiers', async () => {
  for (const state of ['STOPPING_PREVIOUS_ENTRY', 'RETIRING_PREVIOUS_LANDING']) {
    const h = harness(status({
      state, targetVersion: 2, confirmedAt: null, previousEntryNodeId: otherId, previousLandingNodeId: lineId,
      credential: 'previous-secret', previousLandingPassword: 'landing-secret'
    }));
    try {
      await until(() => h.hook.query.isSuccess);
      assert.equal(h.hook.query.data.previousEntryNodeId, otherId);
      assert.equal(h.hook.query.data.previousLandingNodeId, lineId);
      assert.equal(h.control(translate('lineCredentials.inProgress')).props.disabled, true);
      assert.match(h.text, state === 'STOPPING_PREVIOUS_ENTRY' ? /正在停止原入口/ : /正在撤销原落地/);
      assert.match(h.text, /原入口节点 ID/); assert.match(h.text, /原落地节点 ID/);
      assert.match(h.text, /尚未确认新版本运行/);
      assert.doesNotMatch(h.text + JSON.stringify(h.hook.query.data), /previous-secret|landing-secret/);
      const query = h.client.getQueryCache().getAll()[0];
      assert.equal(query.options.refetchInterval(query), 2000);
      h.setStatus(status({ state: 'STOPPING_ENTRY', targetVersion: 2, confirmedAt: null }));
      await wait(2150);
      await until(() => h.hook.query.data?.state === 'STOPPING_ENTRY');
      assert.ok(h.calls.length >= 2);
      h.click('common:actions.close'); await tick();
      assert.equal(query.options.enabled, false);
      assert.equal(query.options.refetchInterval(query), false);
    } finally { h.dispose(); }
    const failed = contract.parseLineCredentialStatus(status({ state: 'FAILED', confirmedAt: null, failedStage: state, errorCode: 'STAGE_TIMEOUT' }), lineId);
    assert.equal(failed.failedStage, state);
    assert.equal(contract.canMaintainLineCredentials(line, failed), true);
  }
});
