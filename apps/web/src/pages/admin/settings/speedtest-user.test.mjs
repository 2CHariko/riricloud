import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { URL } from 'node:url';
import ts from 'typescript';
import { z } from 'zod';

function load(file, modules = {}) {
  const exports = {};
  const output = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  runInNewContext(output, { exports, URL, __DEFAULT_GITHUB_REPO_URL__: 'https://example.com/repo', require: (name) => {
    if (!(name in modules)) throw new Error('Unexpected dependency: ' + name);
    return modules[name];
  } });
  return exports;
}
const shared = { zod: { z }, '@/i18n/config': { default: { t: (key) => key } } };
const preset = load('./components/probe-preset-schema.ts', shared);
const schema = load('./settings-schema.ts', { ...shared, './components/probe-preset-schema': preset });
const form = load('./settings-form.ts', {
  './settings-schema': schema, './components/probe-preset-schema': preset,
  '@/lib/speed-tier': load('../../../lib/speed-tier.ts'),
  '@/lib/announcements': { parseAnnouncements: () => [], derivePrimaryBannerText: () => '' }
});
const { isSpeedtestUserCandidate } = load('./speedtest-user-options.ts');
const now = Date.parse('2026-11-17T00:00:00Z');
function user() {
  return { id: '12345678-1234-4234-8234-123456789abc', isActive: true, role: 'USER', emailVerifiedAt: '2026-01-01', subscription: { status: 'ACTIVE', trafficLimitBytes: 1000, trafficUsedBytes: 1, expireAt: null, plan: { id: 'plan', name: 'Plan' } } };
}

test('account selection survives settings conversion and clearing submits null', () => {
  const defaults = form.defaultSettingsForm();
  assert.equal(defaults.lineSpeedtestUserId, 'none');
  assert.equal(form.toPayload(defaults).lineSpeedtestUserId, null);
  const selected = form.toForm({ ...form.toPayload(defaults), lineSpeedtestUserId: user().id });
  assert.equal(selected.lineSpeedtestUserId, user().id);
  assert.equal(form.toPayload(selected).lineSpeedtestUserId, user().id);
  selected.lineSpeedtestUserId = 'none';
  assert.equal(form.toPayload(selected).lineSpeedtestUserId, null);
});
test('account field is part of the actual settings schema and Agent tab validation', () => {
  const fields = load('./settings-field-map.ts');
  assert.equal(fields.FIELD_TAB_MAP.lineSpeedtestUserId, 'agent');
  const field = schema.createSettingsSchema().shape.lineSpeedtestUserId;
  assert.equal(field.parse('none'), 'none');
  assert.equal(field.parse(user().id), user().id);
  assert.equal(field.safeParse(1).success, false);
});
test('active and canceled subscriptions with remaining quota are selectable', () => {
  for (const status of ['ACTIVE', 'CANCELED']) {
    const item = user(); item.subscription.status = status;
    assert.equal(isSpeedtestUserCandidate(item, true, now), true);
  }
});
test('inactive, unverified, expired, revoked, exhausted and missing subscriptions are excluded', () => {
  for (const patch of [
    (item) => { item.isActive = false; },
    (item) => { item.emailVerifiedAt = null; },
    (item) => { item.subscription.expireAt = new Date(now).toISOString(); },
    (item) => { item.subscription.trafficUsedBytes = 1000; },
    (item) => { item.subscription.status = 'REVOKED'; },
    (item) => { item.subscription = null; },
    (item) => { item.subscription.plan = null; }
  ]) {
    const item = user(); patch(item);
    assert.equal(isSpeedtestUserCandidate(item, true, now), false);
  }
});
test('email requirements follow the current setting and existing admin exemption', () => {
  const item = user(); item.emailVerifiedAt = null;
  assert.equal(isSpeedtestUserCandidate(item, false, now), true);
  assert.equal(isSpeedtestUserCandidate(item, true, now), false);
  item.role = 'ADMIN'; assert.equal(isSpeedtestUserCandidate(item, true, now), true);
});
