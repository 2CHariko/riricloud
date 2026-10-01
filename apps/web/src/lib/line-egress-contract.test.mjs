import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { URL } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const base = '../pages/admin/lines/components/';
const source = (file) => readFileSync(new URL(base + file, import.meta.url), 'utf8');
function load(file) {
  const exports = {};
  const output = ts.transpileModule(source(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  runInNewContext(output, { exports, require: (name) => name === '@/i18n/config' ? { default: { t: (key) => key } } : name.startsWith('./') ? load(name.slice(2) + '.ts') : require(name) });
  return exports;
}
const schema = load('line-form-schema.ts');
const egress = load('line-egress-schema.ts');
const values = (extra = {}) => ({ ...schema.defaultLineFormValues('MIXED'), name: 'Line', entryNodeId: 'entry', egressEnabled: true, egressServerHost: '127.0.0.1', egressServerPort: 1080, ...extra });
const payload = (extra = {}) => schema.toLinePayload(values(extra)).egressProxy;

test('default UDP is off; HTTP cannot emit UDP even with stale draft', () => {
  assert.equal(values().egressUdpEnabled, false);
  assert.equal(payload({ egressUdpEnabled: true }).udpEnabled, false);
  assert.equal(payload({ egressProtocol: 'SOCKS5', egressUdpEnabled: true }).udpEnabled, true);
});
test('editing never copies password and blank password is omitted to preserve it', () => {
  const draft = egress.egressToFormValues({ protocol: 'SOCKS5', serverHost: 'localhost', serverPort: 1080, authEnabled: true, username: 'user', hasPassword: true, udpEnabled: false, password: 'not-returned' });
  assert.equal(draft.egressPassword, '');
  const edited = values(draft);
  assert.equal(schema.lineFormSchema.safeParse(edited).success, true);
  const result = schema.toLinePayload(edited).egressProxy;
  assert.equal(Object.hasOwn(result, 'password'), false);
  assert.equal(Object.hasOwn(result, 'hasPassword'), false);
  assert.equal(result.username, 'user');
});
test('new authentication requires password; replacement keeps exact non-empty value', () => {
  const auth = { egressAuthEnabled: true, egressUsername: ' user ' };
  assert.equal(schema.lineFormSchema.safeParse(values(auth)).success, false);
  assert.equal(schema.lineFormSchema.safeParse(values({ ...auth, egressPassword: ' p ' })).success, true);
  assert.equal(payload({ ...auth, egressPassword: ' p ' }).password, ' p ');
  assert.equal(payload({ ...auth, egressPassword: ' p ' }).username, ' user ');
});
test('editing unrelated fields preserves exact authenticated username and omits password', () => {
  const draft = egress.egressToFormValues({ protocol: 'SOCKS5', serverHost: 'localhost', serverPort: 1080, authEnabled: true, username: ' user ', hasPassword: true, udpEnabled: false });
  const edited = values({ ...draft, name: 'Renamed' });
  const result = schema.toLinePayload(edited).egressProxy;
  assert.equal(result.username, ' user ');
  assert.equal(Object.hasOwn(result, 'password'), false);
});
test('auth disabled removes credentials; disabled proxy clears explicitly', () => {
  const result = payload({ egressHasPassword: true, egressUsername: 'old', egressPassword: 'old' });
  assert.equal(result.authEnabled, false);
  assert.equal(Object.hasOwn(result, 'username'), false);
  assert.equal(Object.hasOwn(result, 'password'), false);
  assert.equal(payload({ egressEnabled: false }), null);
  assert.deepEqual(Object.keys(result).sort(), ['protocol', 'serverHost', 'serverPort', 'authEnabled', 'udpEnabled'].sort());
});
test('host/port validation rejects URLs, whitespace, blank and non-integer or out-of-range ports', () => {
  for (const host of ['', 'http://localhost', 'localhost/path', 'local host']) assert.equal(schema.lineFormSchema.safeParse(values({ egressServerHost: host })).success, false);
  for (const port of ['', 0, -1, 65536, 1.5]) assert.equal(schema.lineFormSchema.safeParse(values({ egressServerPort: port })).success, false);
  for (const host of ['proxy.example.com', '127.0.0.1', '::1']) assert.equal(schema.lineFormSchema.safeParse(values({ egressServerHost: host })).success, true);
});
test('DIRECT and owned relay configure; inherited/upstream/external never silently remove draft', () => {
  for (const relayMode of ['BLIND_FORWARD', 'PROTOCOL_PROXY']) assert.equal(schema.lineFormSchema.safeParse(values({ type: 'RELAY', relayMode, landingNodeId: 'landing' })).success, true);
  for (const relayMode of ['TARGET_LINE', 'UPSTREAM_NODE']) {
    const topology = { type: 'RELAY', relayMode, targetLineId: 'target', upstreamNodeId: 'upstream', localUsersEnabled: true };
    assert.equal(schema.lineFormSchema.safeParse(values(topology)).success, false);
    const cleared = values({ ...topology, ...egress.egressToFormValues(), egressClearConfirmed: true });
    assert.equal(schema.lineFormSchema.safeParse(cleared).success, true);
    assert.equal(schema.toLinePayload(cleared).egressProxy, null);
    assert.equal(Object.hasOwn(schema.toLinePayload({ ...cleared, egressClearConfirmed: false }), 'egressProxy'), false);
  }
  assert.equal(schema.lineFormSchema.safeParse(values({ type: 'EXTERNAL', upstreamNodeId: 'upstream', trafficRate: 0 })).success, false);
  const external = values({ type: 'EXTERNAL', upstreamNodeId: 'upstream', trafficRate: 0, ...egress.egressToFormValues(), egressClearConfirmed: true });
  assert.equal(schema.toLinePayload(external).egressProxy, null);
});
test('protocol changes preserve all egress fields; confirmation intercepts before topology mutation', () => {
  const dialog = source('line-form-dialog.tsx');
  const controls = source('line-form-controls.tsx');
  assert.match(dialog, /key\.startsWith\('egress'\)/);
  assert.match(dialog, /!supportsOwnEgress\(next\) && hasEgressDraft\(form.getValues\(\)\)/);
  assert.match(dialog, /setPendingTopologyChange\(\(\) => apply\)/);
  assert.match(dialog, /<AlertDialog open=\{!!pendingTopologyChange\}/);
  assert.match(controls, /onValueChange=\{onValueChange \?\? field.onChange\}/);
  assert.doesNotMatch(controls, /field.onChange\(value\); onValueChange/);
  const advanced = source('line-advanced-fields.tsx');
  assert.ok(advanced.indexOf('<LineEgressFields') > advanced.indexOf('name="targetLineId"'));
  assert.ok(advanced.indexOf('<LineEgressFields') < advanced.indexOf('sectionEndpointOverride'));
});
