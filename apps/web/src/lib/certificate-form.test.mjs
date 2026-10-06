import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { URL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import ts from 'typescript';

function load(path, modules) {
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }
  }).outputText, { exports, window: { setTimeout: () => 1, clearTimeout: () => {} }, require: (name) => modules[name] ?? {} });
  return exports;
}

function harness() {
  const refs = [], effectDeps = [], effects = [], submissions = [];
  let cursor = 0, values, dirty = false, tree, sessionKey;
  const detail = { data: undefined, dataUpdatedAt: 0, isLoading: true, isError: false, refetch: () => { detail.retries = (detail.retries ?? 0) + 1; } };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useMemo: (fn) => fn(),
    useState: initial => { const index = cursor++; refs[index] ??= { current: initial }; return [refs[index].current, value => { refs[index].current = value; }]; },
    useRef: (initial) => refs[cursor++] ??= { current: initial },
    useEffect: (fn, deps) => {
      const index = cursor++;
      if (!deps || !effectDeps[index] || deps.some((value, i) => value !== effectDeps[index][i])) effects.push(fn);
      effectDeps[index] = deps;
    }
  };
  const form = {
    control: {}, formState: { get isDirty() { return dirty; } },
    reset: (next) => { values = { ...next }; dirty = false; },
    watch: (name) => values[name],
    handleSubmit: (fn) => () => fn(values), setError: () => {},
    setValue: (name, value) => { values[name] = value; dirty = true; }
  };
  const { useFormResetOnKey } = load('../hooks/use-form-reset.ts', { react });
  const components = new Proxy({}, { get: (_, name) => name });
  const z = { string: () => new Proxy({}, { get: (_, name) => name === 'optional' ? () => ({}) : () => z.string() }), object: () => ({}) };
  const modules = {
    react, '@/hooks/use-form-reset': { useFormResetOnKey },
    '@hookform/resolvers/zod': { zodResolver: () => {} }, zod: { z },
    'react-hook-form': { useForm: ({ defaultValues }) => { values ??= { ...defaultValues }; return form; } },
    'react-i18next': { useTranslation: () => ({ t: (key) => key }) },
    './use-certificates': { useCertificateDetail: () => detail, useCertificateMutations: () => ({ parse: { mutate: () => {}, reset: () => {} }, preview: { mutate: (payload, options) => options.onSuccess({ contentChanged: false }) } }) }
  };
  const { CertificateFormDialog } = load('../pages/admin/certificates/certificate-form-dialog.tsx', new Proxy(modules, {
    get: (items, name) => items[name] ?? components
  }));
  function nodes(element) {
    if (!element || typeof element !== 'object') return [];
    if (Array.isArray(element)) return element.flatMap(nodes);
    return [element, ...nodes(element.props?.children)];
  }
  function render(props = {}) {
    cursor = 0;
    const options = { open: true, certificateId: 'certificate-a', pending: false, onOpenChange: () => {}, onSubmit: (payload) => submissions.push(payload), ...props };
    tree = CertificateFormDialog(options);
    const session = nodes(tree).find((node) => typeof node.type === 'function');
    if (!session || session.props.key !== sessionKey) {
      refs.length = 0;
      effectDeps.length = 0;
      values = undefined;
      dirty = false;
      sessionKey = session?.props.key;
    }
    if (session) tree = session.type(session.props);
    while (effects.length) effects.shift()();
    return nodes(tree);
  }
  return { detail, form, render, submissions, get values() { return values; }, submit: () => nodes(tree).find((node) => node.type === 'form')?.props.onSubmit() };
}

const certificate = { currentRevision: 1, name: 'Certificate A', certificatePem: 'certificate-a-pem', privateKeyPem: 'private-a-pem' };

test('editing initializes the complete saved private key and submits its replacement; clearing it preserves the server key', () => {
  const h = harness();
  h.detail.data = certificate;
  h.detail.isLoading = false;
  h.render();
  assert.equal(h.values.privateKeyPem, certificate.privateKeyPem);
  h.form.setValue('privateKeyPem', 'replacement-pem');
  h.submit();
  assert.equal(h.submissions[0].privateKeyPem, 'replacement-pem');
  h.form.setValue('privateKeyPem', '  ');
  h.submit();
  assert.equal(Object.hasOwn(h.submissions[1], 'privateKeyPem'), false);
});

test('late detail initialization and background refetch never overwrite an initialized draft', () => {
  const h = harness();
  h.render();
  h.detail.data = certificate;
  h.detail.dataUpdatedAt = 1;
  h.detail.isLoading = false;
  h.render();
  assert.equal(h.values.privateKeyPem, certificate.privateKeyPem);
  h.detail.data = { ...certificate, privateKeyPem: 'refetched-key' };
  h.detail.dataUpdatedAt = 2;
  h.render();
  assert.equal(h.values.privateKeyPem, certificate.privateKeyPem);
  h.form.setValue('privateKeyPem', 'draft-key');
  h.detail.dataUpdatedAt = 3;
  h.render();
  assert.equal(h.values.privateKeyPem, 'draft-key');
});

test('loading or failed detail prevents saving and failure offers retry', () => {
  const h = harness();
  h.render();
  h.submit();
  assert.equal(h.submissions.length, 0);
  h.detail.isLoading = false;
  h.detail.isError = true;
  const nodes = h.render();
  assert.ok(nodes.some((node) => node.props?.children?.includes('admin:certificates.loadFailed')));
  const retry = nodes.find((node) => node.props?.children?.includes('common:actions.retry'));
  assert.ok(retry);
  retry.props.onClick();
  assert.equal(h.detail.retries, 1);
  h.submit();
  assert.equal(h.submissions.length, 0);
});

test('dialog scopes drafts to the open certificate session, discarding them on close or identity change', () => {
  const h = harness();
  h.detail.data = certificate;
  h.detail.isLoading = false;
  const open = h.render();
  assert.ok(open.some((node) => node.type === 'form'));
  h.form.setValue('privateKeyPem', 'unsaved-a-key');
  h.detail.data = { ...certificate, privateKeyPem: 'private-b-pem' };
  h.render({ certificateId: 'certificate-b' });
  assert.equal(h.values.privateKeyPem, 'private-b-pem');
  const closed = h.render({ open: false });
  assert.equal(closed.some((node) => node.type === 'form'), false);
  assert.equal(h.values, undefined);
  h.render();
  assert.equal(h.values.privateKeyPem, 'private-b-pem');
});

test('pending saves cannot submit another private-key update', () => {
  const h = harness();
  h.detail.data = certificate;
  h.detail.isLoading = false;
  h.render({ pending: true });
  h.submit();
  assert.equal(h.submissions.length, 0);
});

test('closing the last detail observer aborts its request and discards completed private-key cache', async () => {
  const requests = [];
  const { useCertificateDetail } = load('../pages/admin/certificates/use-certificates.ts', {
    '@tanstack/react-query': { useQuery: (options) => options },
    '@/lib/api': { api: { get: (url, options) => new Promise((resolve) => { requests.push({ url, ...options, resolve }); }) } }
  });
  const client = new QueryClient();
  try {
    const options = useCertificateDetail('certificate-a');
    const observer = new QueryObserver(client, options);
    const stop = observer.subscribe(() => {});
    assert.equal(requests[0].url, '/admin/certificates/certificate-a');
    stop();
    assert.equal(requests[0].signal.aborted, true);
    requests[0].resolve({ data: { certificate } });
    await setTimeout(5);
    assert.equal(client.getQueryData(options.queryKey), undefined);

    const next = new QueryObserver(client, options);
    const stopNext = next.subscribe(() => {});
    requests[1].resolve({ data: { certificate } });
    await setTimeout(5);
    assert.equal(client.getQueryData(options.queryKey).privateKeyPem, certificate.privateKeyPem);
    stopNext();
    await setTimeout(5);
    assert.equal(client.getQueryData(options.queryKey), undefined);
  } finally {
    client.clear();
  }
});
