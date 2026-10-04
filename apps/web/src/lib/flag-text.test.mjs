import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { URL } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const assetsDir = new URL('../assets/flags/', import.meta.url);
const assets = Object.fromEntries(readdirSync(assetsDir).filter((name) => name.endsWith('.svg')).map((name) => [name.slice(0, -4), `/assets/${name}`]));
function load(path, modules = {}) {
  const exports = {};
  runInNewContext(ts.transpileModule(source(path), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX
  } }).outputText, { exports, require: (name) => modules[name] ?? require(name) });
  return exports;
}
const helpers = load('./flag-text.ts');
const { splitFlagText } = helpers;
const { FlagText } = load('../components/shared/flag-text.tsx', {
  '@/lib/flag-text': helpers, '@/lib/flag-assets': { flagAssets: assets }
});
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const render = (text) => renderToStaticMarkup(createElement(FlagText, { text }));
const data = (value) => JSON.parse(JSON.stringify(value));

test('Windows-independent local flags replace supported regional indicator pairs', () => {
  const text = '🇭🇰 香港 01 · 🇺🇸 US · 🇯🇵 JP · 🇸🇬 SG · 🇹🇼 TW · 🇪🇺 EU · 🇽🇰 XK';
  const parts = splitFlagText(text, assets);
  assert.equal(parts.filter((part) => part.src).length, 7);
  assert.equal(parts.map((part) => part.text).join(''), text);
  assert.equal(parts[0].src, '/assets/1f1ed-1f1f0.svg');
  assert.equal((render(text).match(/<img /g) ?? []).length, 7);
});

test('empty/plain text, ordinary emoji, unsupported flags and lone indicators remain exact', () => {
  for (const text of ['', 'Hong Kong', '🙂 🚀 🏳️‍🌈', '🇿🇿 unknown', '🇦 lone', '🇦-🇧', '香港 🇿🇿 🙂']) {
    assert.equal(splitFlagText(text, assets).map((part) => part.text).join(''), text);
    assert.equal(splitFlagText(text, assets).some((part) => part.src), false);
    assert.doesNotMatch(render(text), /<img /);
  }
  assert.deepEqual(data(splitFlagText('🇭🇰 missing asset', {})), [{ text: '🇭🇰 missing asset' }]);
});

test('adjacent/repeated flags and CRLF/spacing round-trip without normalization', () => {
  for (const text of ['🇭🇰🇺🇸🇭🇰', '  🇯🇵\r\n\t 🇺🇸  ', 'prefix 🇭🇰 suffix', '🇦🇧🇨']) {
    assert.equal(splitFlagText(text, assets).map((part) => part.text).join(''), text);
  }
});

test('original Unicode remains selectable text; overlay is decorative and HTML stays escaped', () => {
  const html = render('🇭🇰 <script>alert(1)</script> & 🇺🇸');
  assert.match(html, /🇭🇰/);
  assert.match(html, /🇺🇸/);
  assert.match(html, /alt=""/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /draggable="false"/);
  assert.match(html, /pointer-events-none/);
  assert.match(html, /select-none/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|https?:\/\//);
});

test('image failure falls back to the original flag without discarding the rest of the name', () => {
  let failed = false;
  const { FlagText: WithFailure } = load('../components/shared/flag-text.tsx', {
    '@/lib/flag-text': helpers, '@/lib/flag-assets': { flagAssets: assets },
    react: { useState: () => [failed, (value) => { failed = value; }] }
  });
  const tree = WithFailure({ text: '🇭🇰 Hong Kong' });
  const flag = tree.props.children[0];
  const glyph = flag.type(flag.props);
  const image = glyph.props.children.find((child) => child?.type === 'img');
  image.props.onError();
  assert.equal(flag.type(flag.props), '🇭🇰');
  assert.equal(tree.props.children[1], ' Hong Kong');
});

test('vendored SVGs cover only flags, contain no executable/external content and retain attribution', () => {
  assert.ok(Object.keys(assets).length >= 250);
  for (const name of readdirSync(assetsDir).filter((name) => name.endsWith('.svg'))) {
    assert.match(name, /^1f1[e-f][0-9a-f]-1f1[e-f][0-9a-f]\.svg$/);
    const svg = readFileSync(new URL(name, assetsDir), 'utf8');
    assert.match(svg, /^<svg\b/);
    assert.doesNotMatch(svg, /<script|<foreignObject|\bon\w+\s*=|(?:xlink:)?href\s*=|<!DOCTYPE/i);
  }
  assert.match(source('../assets/flags/README.md'), /Twemoji.*14\.0\.2/);
  assert.match(source('../assets/flags/README.md'), /CC-BY 4\.0/);
  assert.equal(source('../assets/flags/LICENSE-GRAPHICS'), source('../../public/third-party/twemoji-LICENSE-GRAPHICS.txt'));
  assert.match(source('../assets/flags/LICENSE-GRAPHICS'), /Creative Commons/);
});

test('subscription/upstream/line display sites use the shared renderer', () => {
  for (const [path, text] of [
    ['../components/shared/line-card.tsx', 'line.name'],
    ['../pages/admin/upstream/components/upstream-nodes-sheet.tsx', 'node.name'],
    ['../pages/admin/lines/index.tsx', 'line.name'],
    ['../pages/user/proxy-pool/components/proxy-endpoint-selection.tsx', 'endpoint.name'],
    ['../components/shared/probe-task-dialog.tsx', "title ?? t('admin:latencyTest.title')"],
    ['../pages/admin/lines/components/line-form-controls.tsx', 'option.label']
  ]) assert.ok(source(path).includes(`<FlagText text={${text}}`), `${path} should render local flags`);
});
