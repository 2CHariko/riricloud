import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { URL, URLSearchParams } from 'node:url';
import ts from 'typescript';

const components = new Proxy({}, { get: (_, name) => name });
function load(path, modules = {}) {
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, URL, URLSearchParams, require: name => modules[name] ?? (name === 'react/jsx-runtime' ? { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) } : components) });
  return exports;
}
const navigation = load('./certificate-navigation.ts');
function flatten(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(flatten)];
}

test('返回地址只允许证书页，保留两级分页和搜索，禁止站外及其他管理页面跳转', () => {
  const path = navigation.certificateLinesPath('?page=3&search=example&status=VALID', 'cert', 4, { search: '线路 & 名称', relation: 'inherited', lineStatus: 'DISABLED' });
  const params = new URL(path, 'https://panel.invalid').searchParams;
  assert.equal(params.get('page'), '3');
  assert.equal(params.get('linePage'), '4');
  assert.equal(params.get('lineSearch'), '线路 & 名称');
  assert.equal(params.get('tab'), 'lines');
  assert.equal(navigation.certificateReturnPath({ certificateReturn: path }), path);
  for (const path of ['https://evil.invalid/admin/certificates', '//evil.invalid/admin/certificates', '/admin/logs', '/admin/certificates/../logs', 'javascript:alert(1)']) assert.equal(navigation.certificateReturnPath({ certificateReturn: path }), null);
  for (const page of ['-1', 'NaN', '1.5', null]) assert.equal(navigation.positivePage(page), 1);
});

test('关联明细的线路、编辑、桥接目标、承载节点入口携带完整返回上下文，筛选重置分页', () => {
  let params = new URLSearchParams('certificateId=cert&tab=lines&page=3&linePage=2');
  const row = { id: 'bridge', name: '桥接线路', type: 'RELAY', protocolType: 'VLESS', status: 'DISABLED', inherited: true, targetLine: { id: 'target', name: '目标线路' }, entryNode: { id: 'entry', name: '入口' }, landingNode: null, hostingNodes: [{ id: 'landing', name: '实际落地' }], serverNames: ['example.com'], matched: true };
  const { CertificateLines } = load('../pages/admin/certificates/certificate-records.tsx', {
    react: { useState: initial => [initial, () => {}] },
    'react-router-dom': { Link: 'Link', useLocation: () => ({ search: '?' + params }), useSearchParams: () => [params, next => { params = next; }] },
    'react-i18next': { useTranslation: () => ({ t: key => key }) },
    '@/lib/certificate-navigation': navigation,
    './use-certificates': { useCertificateRecords: () => ({ data: { data: [row], total: 21 } }) }
  });
  const tree = flatten(CertificateLines({ id: 'cert', preserveContext: true }));
  const links = tree.filter(node => node.type === 'Link');
  for (const to of ['/admin/lines?lineId=bridge', '/admin/lines?lineId=bridge&edit=1', '/admin/lines?lineId=target', '/admin/nodes/landing']) {
    const link = links.find(node => node.props.to === to);
    assert.ok(link, to);
    assert.equal(new URL(link.props.state.certificateReturn, 'https://panel.invalid').searchParams.get('linePage'), '2');
  }
  tree.find(node => node.type === 'Input').props.onChange({ target: { value: '查找' } });
  assert.equal(params.get('linePage'), '1');
  assert.equal(params.get('lineSearch'), '查找');
  assert.equal(params.get('page'), '3');
});

test('线路直达独立加载详情，编辑仅初始化一次，刷新不覆盖草稿，失败提供重试和返回', () => {
  const query = { data: { id: 'one', name: '线路', status: 'ACTIVE', entryNode: null, params: { tls: { serverName: 'tls.example.com' } }, serverHost: 'example.com' }, refetch: () => { query.retries++; }, retries: 0 };
  let ref;
  const { LinkedLineDialog } = load('../pages/admin/lines/components/linked-line-dialog.tsx', {
    react: { useRef: initial => ref ??= { current: initial }, useEffect: fn => fn() },
    '@tanstack/react-query': { useQuery: () => query },
    'react-i18next': { useTranslation: () => ({ t: key => key }) },
    'react-router-dom': { Link: 'Link' }
  });
  const edits = [];
  const props = { id: 'one', edit: true, returnTo: '/admin/certificates?certificateId=cert&tab=lines', onClose: () => {}, onEdit: row => edits.push(row) };
  const firstTree = flatten(LinkedLineDialog(props));
  assert.ok(firstTree.some(node => node.type === 'p' && node.props.children?.includes('tls.example.com')));
  query.data = { ...query.data, name: '后台刷新' };
  LinkedLineDialog(props);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].name, '线路');
  query.data = undefined;
  query.isError = true;
  const tree = flatten(LinkedLineDialog({ ...props, edit: false }));
  assert.ok(tree.some(node => node.type === 'Link' && node.props.to === props.returnTo));
  tree.find(node => node.type === 'Button' && node.props.children === 'common:actions.retry').props.onClick();
  assert.equal(query.retries, 1);
});

test('关联列表默认请求不提交空枚举，搜索和筛选进入独立缓存键', async () => {
  let requested;
  const { useCertificateRecords } = load('../pages/admin/certificates/use-certificates.ts', {
    '@tanstack/react-query': { useQuery: options => options },
    '@/lib/api': { api: { get: async (path, options) => { requested = { path, ...options }; return { data: {} }; } } }
  });
  const empty = useCertificateRecords('cert', 'lines', 1, true, { search: '', lineStatus: '', relation: '' });
  await empty.queryFn();
  assert.deepEqual({ ...requested.params }, { page: 1, pageSize: 20 });
  const filtered = useCertificateRecords('cert', 'lines', 2, true, { search: '查找', lineStatus: 'DISABLED', relation: 'inherited' });
  await filtered.queryFn();
  assert.equal(requested.params.relation, 'inherited');
  assert.notEqual(JSON.stringify(filtered.queryKey), JSON.stringify(empty.queryKey));
});
