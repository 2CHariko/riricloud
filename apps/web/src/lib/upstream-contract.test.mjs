import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { URL } from 'node:url';

const require = createRequire(import.meta.url);
function load(relative) {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  runInNewContext(output, { exports, require: (name) => name === '@/i18n/config' ? { default: { t: (key) => key } } : require(name), crypto: { randomUUID: () => '00000000-0000-0000-0000-000000000000' } });
  return exports;
}
const schema = load('../pages/admin/lines/components/line-form-schema.ts');
const usage = load('./upstream-usage.ts');

test('external line requires an upstream, but no managed entry or TLS fields', () => {
  const values = { ...schema.defaultLineFormValues('TROJAN'), type: 'EXTERNAL', name: 'External', upstreamNodeId: 'resource', trafficRate: 0, isPublic: false, status: 'DISABLED' };
  assert.equal(schema.lineFormSchema.safeParse(values).success, true);
  assert.equal(schema.lineFormSchema.safeParse({ ...values, upstreamNodeId: '' }).success, false);
  const payload = schema.toLinePayload(values);
  assert.deepEqual(Object.keys(payload).sort(), ['type', 'name', 'tag', 'upstreamNodeId', 'tags', 'level', 'sortOrder', 'isPublic', 'status'].sort());
  assert.equal(payload.isPublic, false);
  assert.equal(payload.status, 'DISABLED');
});

test('managed lines still require entry and positive billing rate', () => {
  const values = { ...schema.defaultLineFormValues(), name: 'Managed' };
  assert.equal(schema.lineFormSchema.safeParse(values).success, false);
  assert.equal(schema.lineFormSchema.safeParse({ ...values, entryNodeId: 'entry', trafficRate: 0 }).success, false);
  assert.equal(schema.lineFormSchema.safeParse({ ...values, entryNodeId: 'entry' }).success, true);
});

test('relay payload keeps upstream binding without copying upstream secrets', () => {
  const values = { ...schema.defaultLineFormValues(), name: 'Relay', type: 'RELAY', relayMode: 'UPSTREAM_NODE', entryNodeId: 'entry', upstreamNodeId: 'resource' };
  assert.equal(schema.lineFormSchema.safeParse(values).success, true);
  const payload = schema.toLinePayload(values);
  assert.equal(payload.upstreamNodeId, 'resource');
  assert.equal(payload.entryNodeId, 'entry');
});

test('external edit accepts nullable entry and no local parameters', () => {
  const values = schema.lineToFormValues({ type: 'EXTERNAL', name: 'External', protocolType: 'TUIC', tag: null, upstreamNodeId: 'resource', tags: [], level: 0, sortOrder: 10, isPublic: false, status: 'DISABLED' });
  assert.equal(schema.lineFormSchema.safeParse(values).success, true);
  assert.equal(values.trafficRate, 0);
});

test('decimal byte formatting handles unknown, zero and values above safe integer precisely', () => {
  assert.equal(usage.formatUpstreamBytes(null, 'unknown'), 'unknown');
  assert.equal(usage.formatUpstreamBytes('0', 'unknown'), '0.00 B');
  assert.equal(usage.formatUpstreamBytes('9007199254740993', 'unknown'), '8.00 PiB');
  assert.equal(usage.formatUpstreamBytes('18446744073709551615', 'unknown'), '15.99 EiB');
});
