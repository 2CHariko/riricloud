import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { URL } from 'node:url';
import ts from 'typescript';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const exports = {};
// announcements.ts 仅依赖 react / i18n / public-settings，纯函数测试用空桩即可
runInNewContext(
  ts.transpileModule(source('./announcements.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText,
  { exports, require: () => ({}) }
);
const { buildAnnouncementSummary, stripMarkdownPreview, normalizeAnnouncementItem } = exports;

test('summary keeps whole leading lines instead of hard cutting by char count', () => {
  const content = '## 维护窗口\n维护时间 20:00-22:00，期间节点不可用。\n请提前保存配置。';
  const summary = buildAnnouncementSummary(content, '维护窗口');
  assert.ok(summary.includes('维护时间 20:00-22:00'), '关键句不得被字符截断丢失');
  assert.ok(summary.includes('请提前保存配置'), '第 3 行仍在取值范围内');
  assert.ok(!summary.startsWith('维护窗口'), '与标题重复的首行应被跳过');
});

test('summary caps by max lines and max chars with ellipsis', () => {
  const content = ['标题', 'a'.repeat(200), 'b'.repeat(200), 'c'.repeat(200), 'd'.repeat(200)].join('\n');
  const summary = buildAnnouncementSummary(content, '标题');
  assert.ok(summary.length <= 161, `超出字符上限：${summary.length}`);
  assert.ok(summary.endsWith('…'), '超长摘要必须以省略号收尾');
  assert.ok(!summary.includes('d'.repeat(20)), '第 4 行起不应进入摘要');
});

test('markdown syntax is flattened to plain text for the banner', () => {
  const content = '> [!WARNING]\n> 今晚 **22:00** 重启，详见 [状态页](https://status.example.com)';
  const summary = buildAnnouncementSummary(content, '重启公告');
  assert.ok(!summary.includes('[!WARNING]'), 'callout 标记必须被剥离');
  assert.ok(!summary.includes('**'), '强调符号必须被剥离');
  assert.ok(!summary.includes('http'), '链接语法降级为纯文本');
  assert.ok(!summary.startsWith('>'), '引用块符号不得残留在摘要中');
  assert.ok(summary.includes('22:00') && summary.includes('状态页'));
});

test('fenced code keeps its text and pure-syntax content falls back to an empty summary', () => {
  assert.equal(buildAnnouncementSummary('![示意图](https://cdn.example.com/a.png)', '图示公告'), '');
  assert.equal(buildAnnouncementSummary('```\nclash config\n```', '配置片段'), 'clash config');
  assert.equal(buildAnnouncementSummary('仅标题一行', '仅标题一行'), '');
  assert.equal(buildAnnouncementSummary('', '空公告'), '');
});

test('legacy single announcement keeps title from its first line without duplicating it', () => {
  const item = normalizeAnnouncementItem({ content: '系统将于今晚维护，请错峰使用。\n第二行补充说明。' });
  assert.equal(item.title, stripMarkdownPreview('系统将于今晚维护，请错峰使用。'));
  assert.equal(buildAnnouncementSummary(item.content, item.title), '第二行补充说明。');
});
