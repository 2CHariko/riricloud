import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { URL } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
function load(path, modules) {
  const exports = {};
  runInNewContext(ts.transpileModule(source(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, AbortController: globalThis.AbortController, require: (name) => modules[name] ?? require(name) });
  return exports;
}

function loadForm(file) {
  return load(`../pages/admin/lines/components/${file}.ts`, new Proxy({ '@/i18n/config': { default: { t: (key) => key } } }, {
    get: (modules, name) => modules[name] ?? (name.startsWith('./') ? loadForm(name.slice(2)) : undefined)
  }));
}

function harness() {
  const requests = [], errors = [], changes = [], listeners = new Set();
  const values = { protocolType: 'VLESS', tlsMode: 'reality', type: 'DIRECT', realityShortIds: 'aaaa,bbbb', realityPublicKey: 'old-public', realityPrivateKey: 'old-private', realityDest: 'target.example:443', realityServerNames: 'target.example' };
  let pending = false, cleanup, deps, callback;
  const ref = { current: null };
  const form = {
    watch: (name) => {
      if (typeof name === 'string') return values[name];
      listeners.add(name);
      return { unsubscribe: () => listeners.delete(name) };
    },
    setValue: (name, value, options) => {
      values[name] = value;
      changes.push({ name, value, options });
      for (const listener of listeners) listener(values, { name });
    }
  };
  const mutation = { get isPending() { return pending; }, mutate: (signal, handlers) => {
    pending = true;
    mutation.options.mutationFn(signal).then(handlers.onSuccess, handlers.onError).finally(() => { pending = false; handlers.onSettled(); });
  } };
  const lines = load('../pages/admin/lines/use-lines.ts', {
    '@tanstack/react-query': { useMutation: (options) => { mutation.options = options; return mutation; } },
    sonner: {}, '@/i18n/config': {}, '@/lib/api': { api: { post: (url, body, { signal }) => new Promise((resolve, reject) => { requests.push({ url, body, signal, resolve: (data) => resolve({ data }), reject }); }) } }
  });
  const { useGenerateRealityParameters } = load('../pages/admin/lines/components/use-reality-parameters.ts', {
    react: { useRef: () => ref, useCallback: (fn) => callback ??= fn, useEffect: (fn, next) => {
      if (!deps || next.some((value, i) => value !== deps[i])) { cleanup?.(); cleanup = fn(); deps = next; }
    } },
    'react-i18next': { useTranslation: () => ({ t: (key) => key }) },
    sonner: { toast: { error: (message) => errors.push(message) } }, '../use-lines': lines
  });
  return { form, values, requests, errors, changes, mutation,
    render: (open = true, key = 'line-a') => useGenerateRealityParameters(form, open, key),
    reset: () => { for (const listener of listeners) listener(values, {}); },
    unmount: () => cleanup?.()
  };
}
const parameters = (id) => ({ shortIds: [id.repeat(16)], publicKey: `public-${id}`, privateKey: `private-${id}` });

test('one request replaces all three fields, marks them dirty and preserves handshake settings; subsequent click regenerates', async () => {
  const h = harness();
  h.render().generate();
  h.render().generate();
  assert.equal(h.render().isPending, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/admin/nodes/reality-keypair');
  assert.equal(h.mutation.options.retry, false);
  assert.equal(h.mutation.options.gcTime, 0);
  h.requests[0].resolve(parameters('a'));
  await setImmediate();
  assert.equal(h.values.realityShortIds, 'a'.repeat(16));
  assert.equal(h.values.realityPublicKey, 'public-a');
  assert.equal(h.values.realityPrivateKey, 'private-a');
  assert.ok(h.changes.every(({ options }) => options.shouldDirty));
  assert.equal(h.values.realityDest, 'target.example:443');
  assert.equal(h.values.realityServerNames, 'target.example');
  h.render().generate();
  h.requests[1].resolve(parameters('b'));
  await setImmediate();
  assert.equal(h.values.realityShortIds, 'b'.repeat(16));
  assert.equal(h.values.realityPublicKey, 'public-b');
  assert.equal(h.values.realityPrivateKey, 'private-b');
});

test('failure preserves the original draft and reports a safe error, then permits retry', async () => {
  const h = harness();
  const original = { ...h.values };
  h.render().generate();
  h.requests[0].reject(new Error('failure with secret data'));
  await setImmediate();
  assert.deepEqual(h.values, original);
  assert.deepEqual(h.errors, ['admin:lineForm.generateParametersFailed']);
  assert.equal(h.render().isPending, false);
  h.render().generate();
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve(parameters('b'));
  await setImmediate();
});

test('closing/reopening, switching lines, resetting or unmounting aborts and ignores even successful late responses', async () => {
  for (const action of [(h) => h.render(false), (h) => { h.render(false); h.render(); }, (h) => h.render(true, 'line-b'), (h) => h.reset(), (h) => h.unmount(), (h) => h.render().cancel()]) {
    const h = harness();
    h.render().generate();
    action(h);
    assert.equal(h.requests[0].signal.aborted, true);
    h.requests[0].resolve(parameters('a'));
    await setImmediate();
    assert.equal(h.changes.length, 0);
    assert.deepEqual(h.errors, []);
  }
});

test('manual parameter edits or protocol/security/topology changes cancel generation without overwriting the new input', async () => {
  for (const field of ['protocolType', 'tlsMode', 'type', 'realityShortIds', 'realityPublicKey', 'realityPrivateKey']) {
    const h = harness();
    h.render().generate();
    h.form.setValue(field, 'manual-value');
    h.requests[0].resolve(parameters('a'));
    await setImmediate();
    assert.equal(h.requests[0].signal.aborted, true);
    assert.equal(h.values[field], 'manual-value');
    assert.equal(h.changes.length, 1);
  }
});

test('canceled failures are silent and generation requires an open VLESS Reality managed draft', async () => {
  const h = harness();
  h.render().generate();
  h.render().cancel();
  h.requests[0].reject(new Error('canceled'));
  await setImmediate();
  assert.deepEqual(h.errors, []);
  for (const [field, value] of [['protocolType', 'VMESS'], ['tlsMode', 'tls'], ['type', 'EXTERNAL']]) {
    const draft = harness();
    draft.values[field] = value;
    draft.render().generate();
    assert.equal(draft.requests.length, 0);
  }
  const closed = harness();
  closed.render(false).generate();
  assert.equal(closed.requests.length, 0);
});

test('save is disabled and guarded during generation; the form uses the new button and impact hint', () => {
  const dialog = source('../pages/admin/lines/components/line-form-dialog.tsx');
  const fields = source('../pages/admin/lines/components/line-security-fields.tsx');
  assert.match(dialog, /if \(realityParameters.isPending\) return/);
  assert.match(dialog, /disabled=\{pending \|\| !ready \|\| realityParameters.isPending\}/);
  assert.match(fields, /lineForm.generateParameters'/);
  assert.match(fields, /lineForm.generateParametersHint/);
});

test('generated draft serializes all three values for saving; untouched edits omit the hidden private key', () => {
  const schema = loadForm('line-form-schema');
  const draft = { ...schema.defaultLineFormValues('VLESS'), name: 'Line', entryNodeId: 'entry', realityShortIds: 'a'.repeat(16), realityPublicKey: 'new-public', realityPrivateKey: 'new-private' };
  const result = schema.toLinePayload(draft).params.tls.reality;
  assert.equal(result.publicKey, 'new-public');
  assert.equal(result.privateKey, 'new-private');
  assert.deepEqual(Array.from(result.shortIds), ['a'.repeat(16)]);
  const untouched = schema.toLinePayload({ ...draft, realityPrivateKey: '' }).params.tls.reality;
  assert.equal(Object.hasOwn(untouched, 'privateKey'), false);
});
