import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { URL } from 'node:url';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { cva } from 'class-variance-authority';
import ts from 'typescript';

const codes = ['SPEEDTEST_USER_NOT_CONFIGURED', 'SPEEDTEST_USER_UNAVAILABLE', 'SPEEDTEST_LINE_UNAUTHORIZED', 'SPEEDTEST_IDENTITY_CHANGED'];
const text = new Map(codes.map((code, i) => ['latencyTest.accountErrors.' + code, 'Localized account reason ' + i]));
const translations = [];
function load(file, modules = {}) {
  const exports = {};
  const output = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  runInNewContext(output, { exports, require: (name) => {
    if (!(name in modules)) throw new Error('Unexpected dependency: ' + name);
    return modules[name];
  } });
  return exports;
}
const primitive = (tag) => ({ children, asChild: _asChild, variant: _variant, ...props }) => React.createElement(tag, props, children);
const modules = {
  'react/jsx-runtime': jsxRuntime,
  'react-i18next': { useTranslation: () => ({ t: (key) => { translations.push(key); return text.get(key.replace(/^admin:/, '')) ?? 'Localized generic state'; } }) },
  'class-variance-authority': { cva },
  '@/components/ui/badge': { Badge: primitive('span') },
  '@/components/ui/button': { Button: primitive('button') },
  '@/components/ui/card': { Card: primitive('div'), CardContent: primitive('div') },
  '@/components/ui/tooltip': { Tooltip: primitive('div'), TooltipTrigger: primitive('span'), TooltipContent: primitive('div') },
  '@/lib/utils': { cn: (...values) => values.filter(Boolean).join(' '), formatDateTime: () => 'fixture time' },
  '@/lib/probe-types': load('../../lib/probe-types.ts')
};
let view;
function components() {
  if (!view) {
    modules['./probe-result-account-errors'] = load('./probe-result-account-errors.ts');
    view = load('./probe-result.tsx', modules);
  }
  return view;
}
function result(errorCode) {
  return { schemaVersion: 2, subjectType: 'LINE', subjectId: 'line', status: 'SKIPPED', errorCode, message: 'private-user@example.invalid:SECRET-RAW-MESSAGE', engine: null, engineVersion: null, fallbackReason: null, mihomoCompatibility: 'UNSUPPORTED', measurement: 'MIHOMO_URL_TEST', perspective: 'MASTER', routeKind: 'MANAGED_DIRECT', targetId: 'target', targetHost: 'example.invalid', testedAt: '2026-11-17T00:00:00Z', durationMs: 0, latencyMs: null, stage: 'VALIDATE', configHash: '', applied: false };
}
for (const code of codes) {
  test(code + ' renders its allowlisted localization in result and tooltip', () => {
    const { ProbeResultCard, ProbeMeasurementChip } = components(); translations.length = 0;
    for (const element of [React.createElement(ProbeResultCard, { result: result(code) }), React.createElement(ProbeMeasurementChip, { value: result(code) })]) {
      const html = renderToStaticMarkup(element);
      assert.ok(html.includes(text.get('latencyTest.accountErrors.' + code)));
      assert.ok(!html.includes('SECRET-RAW-MESSAGE'));
      assert.ok(!html.includes('private-user@example.invalid'));
      assert.ok(!html.includes(code));
    }
    assert.ok(translations.some((key) => key.replace(/^admin:/, '') === 'latencyTest.accountErrors.' + code));
  });
}
test('unknown, prototype and almost-matching codes never become arbitrary messages or translation keys', () => {
  const { ProbeResultCard, ProbeMeasurementChip } = components();
  for (const code of [null, undefined, 42, {}, ['SPEEDTEST_USER_UNAVAILABLE'], '__proto__', 'constructor', 'toString', '<script>SECRET</script>', 'SPEEDTEST_USER_UNAVAILABLE:SECRET', ' SPEEDTEST_USER_UNAVAILABLE']) {
    translations.length = 0;
    for (const element of [React.createElement(ProbeResultCard, { result: result(code) }), React.createElement(ProbeMeasurementChip, { value: result(code) })]) {
      const html = renderToStaticMarkup(element);
      assert.ok(!html.includes('SECRET'));
      assert.ok(!html.includes('Localized account reason'));
    }
    assert.ok(translations.every((key) => !key.includes('accountErrors')));
  }
});
test('successful cards never show a contradictory account error or raw diagnostics', () => {
  const { ProbeResultCard } = components();
  const html = renderToStaticMarkup(React.createElement(ProbeResultCard, { result: { ...result(codes[0]), status: 'SUCCESS', latencyMs: 23 } }));
  assert.ok(html.includes('23')); assert.ok(!html.includes('Localized account reason')); assert.ok(!html.includes('SECRET'));
});

test('allowlisted keys exist in the actual Chinese baseline and preserve safe user-facing text', () => {
  const actual = load('../../locales/zh-CN/admin.ts').default;
  for (const code of codes) {
    const value = actual.latencyTest.accountErrors[code];
    assert.equal(typeof value, 'string');
    assert.ok(value.trim().length > 0);
    assert.ok(!value.includes(code));
    assert.ok(!value.includes('SECRET'));
  }
});
