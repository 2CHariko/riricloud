import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = await fs.readFile(new URL('./doc-governance.mjs', import.meta.url), 'utf8');
const gates = ['version', 'docs', 'i18n', 'server', 'web', 'agent'].map(name => 'gate:' + name);
const gateList = gates.map(name => '`pnpm ' + name + '`').join(' + ');
// 小型语义夹具只描述受保护的契约，不复制整篇规范或当前发行版本。
const policyFiles = {
  'AGENTS.md': '# 代理规范\nMaster 与 Agent 双轨，日常 PR 保持版本，维护 [Unreleased]，Release PR 固化。\n## 常用命令\n' + gateList + '\n',
  'README.md': '# 项目\n## 质量门禁与工程规范\n' + gateList + '\n',
  'docs/PROJECT_CONSTRAINTS.md': '# 约束\n## 10. 双轨版本管理\nMaster 与 Agent 独立维护 [Unreleased]，Release PR 执行对应 bump。\n',
  'docs/GIT_WORKFLOW.md': '# Git 规范\n允许短生命周期 release 分支，经 PR 合并。\n| 合并前门禁 | ' + gateList + ' |\n',
  'docs/CODE_REVIEW.md': '# 审查\n## 2. 质量门禁 (Quality Gates)\n' + gateList + '\n| `apps/web` | `pnpm gate:web`（`node --test` · ESLint · 类型检查 · 构建） |\n',
  'docs/VERSIONING.md': '# 版本规范\n## 3. 双轨解耦版本号策略\n\n| 事项 | Master 约定 | Agent 约定 |\n| :--- | :--- | :--- |\n| **版本源** | 根 `package.json` (`version`) | `apps/agent/VERSION` |\n| **日志缓冲** | 根 `CHANGELOG.md` 的 `[Unreleased]` | `apps/agent/CHANGELOG.md` 的 `[Unreleased]` |\n| **自增命令** | `pnpm bump` (patch/minor/major) | `pnpm bump:agent` (patch/minor/major) |\n| **发布 Tag** | `vX.Y.Z` | `agent-vA.B.C` |\n',
  'docs/plans/README.md': '# 规划索引\n',
};

async function createFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'riri-doc-governance-'));
  t.after(async () => {
    // 仅删除本测试在系统临时目录中创建的目录，避免影响工作区。
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('riri-doc-governance-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const write = async (file, text) => {
    const destination = path.join(directory, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, text, 'utf8');
  };
  const pkg = { scripts: Object.fromEntries(gates.map(name => [name, 'node check.mjs'])) };
  pkg.scripts.gate = gates.map(name => 'pnpm ' + name).join(' && ');
  pkg.scripts['gate:web'] = 'pnpm --filter @riricloud/web test && pnpm --filter @riricloud/web lint && pnpm --filter @riricloud/web build';
  await write('package.json', JSON.stringify(pkg));
  await write('scripts/doc-governance.mjs', script);
  for (const [file, text] of Object.entries(policyFiles)) await write(file, text);
  const run = (...args) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_') || key === 'SKIP_DOC_SYNC') delete env[key];
    // 不让临时夹具继承父测试内部标记，也不向上发现宿主仓库。
    delete env.NODE_TEST_CONTEXT;
    env.GIT_CEILING_DIRECTORIES = path.dirname(directory);
    const result = spawnSync(process.execPath, [path.join(directory, 'scripts/doc-governance.mjs'), ...args], {
      cwd: directory, env, encoding: 'utf8', timeout: 15_000,
    });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  };
  return { directory, pkg, write, run };
}

function assertRejected(result, diagnostic) {
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, diagnostic);
}

test('允许双轨、Unreleased 与完整六门禁契约', async t => {
  const { run } = await createFixture(t);
  const result = run('check');
  assert.equal(result.status, 0, result.output);
});

test('阻断已知统一版本与每 PR bump 旧规范回流', async t => {
  const examples = [
    ['AGENTS.md', '三应用共用根 `package.json` 的统一版本号，不私设版本。'],
    ['docs/PROJECT_CONSTRAINTS.md', '根 `package.json` 的 `version` 字段为全局唯一真实源。'],
    ['docs/PROJECT_CONSTRAINTS.md', '核心代码变更强制递增：PR 合入 main 前必须执行 `pnpm bump`。'],
    ['docs/PROJECT_CONSTRAINTS.md', '`feat` / `fix` 等核心代码变更必须执行 `pnpm bump`。'],
    ['docs/VERSIONING.md', '统一版本号策略下的任一子应用发生破坏性变更。'],
    ['docs/GIT_WORKFLOW.md', '本项目不使用 Git Flow / release 分支。'],
    ['docs/CODE_REVIEW.md', '版本门禁校验单仓唯一版本源。'],
  ];
  for (const [file, oldPolicy] of examples) await t.test(oldPolicy, async t => {
    const { write, run } = await createFixture(t);
    await write(file, policyFiles[file] + '\n' + oldPolicy + '\n');
    assertRejected(run('check'), /版本模式漂移/);
  });
});

test('版本契约表分别约束版本源、日志、命令与 Tag', async t => {
  for (const [from, to] of [
    ['`apps/agent/VERSION`', '`package.json`'],
    ['`apps/agent/CHANGELOG.md`', '`CHANGELOG.md`'],
    ['`pnpm bump:agent`', '`pnpm bump`'],
    ['`agent-vA.B.C`', '`vA.B.C`'],
  ]) await t.test(from, async t => {
    const { write, run } = await createFixture(t);
    await write('docs/VERSIONING.md', policyFiles['docs/VERSIONING.md'].replace(from, to));
    assertRejected(run('check'), /双轨版本契约/);
  });
});

test('四份命令清单都必须保留 i18n，不接受其他章节提及代替', async t => {
  for (const file of ['AGENTS.md', 'README.md', 'docs/CODE_REVIEW.md', 'docs/GIT_WORKFLOW.md']) await t.test(file, async t => {
    const { write, run } = await createFixture(t);
    await write(file, policyFiles[file].replace(' + `pnpm gate:i18n`', '') + '\n## 其他说明\n`pnpm gate:i18n`\n');
    assertRejected(run('check'), /门禁集合漂移/);
  });
});

test('根命令遗漏必要门禁或文档记录不存在的门禁时阻断', async t => {
  const { pkg, write, run } = await createFixture(t);
  pkg.scripts.gate = pkg.scripts.gate.replace(' && pnpm gate:i18n', '');
  await write('package.json', JSON.stringify(pkg));
  assertRejected(run('check'), /门禁集合漂移/);
  pkg.scripts.gate += ' && pnpm gate:i18n';
  await write('package.json', JSON.stringify(pkg));
  await write('README.md', policyFiles['README.md'] + '`pnpm gate:obsolete`\n');
  assertRejected(run('check'), /门禁集合漂移/);
});

test('五门禁旧名称与漏写 Web 测试不能靠触及文档放行', async t => {
  const { write, run } = await createFixture(t);
  await write('README.md', policyFiles['README.md'] + '五合一质量门禁全绿。\n');
  assertRejected(run('check'), /门禁集合漂移/);
  await write('README.md', policyFiles['README.md']);
  await write('docs/CODE_REVIEW.md', policyFiles['docs/CODE_REVIEW.md'].replace('`node --test` · ', ''));
  assertRejected(run('check'), /Web 测试契约/);
});

test('新模板指向 Unreleased，作者通用，生成和归档均刷新索引', async t => {
  const { directory, run } = await createFixture(t);
  const created = run('new', 'new-feature');
  assert.equal(created.status, 0, created.output);
  const planFile = path.join(directory, 'docs/plans/new-feature.md');
  const plan = await fs.readFile(planFile, 'utf8');
  assert.match(plan, /^target_version: "Unreleased"$/m);
  assert.match(plan, /^author: "Contributors & Maintainers"$/m);
  assert.doesNotMatch(plan, /v0\.4\.0|Antigravity/);
  assert.match(await fs.readFile(path.join(directory, 'docs/plans/README.md'), 'utf8'), /new-feature\.md/);
  const active = run('check');
  assert.equal(active.status, 0, active.output);
  await fs.writeFile(planFile, plan.replaceAll('- [ ]', '- [x]'));
  assertRejected(run('check'), /强制归档/);
  const archived = run('archive', 'new-feature.md');
  assert.equal(archived.status, 0, archived.output);
  const checked = run('check');
  assert.equal(checked.status, 0, checked.output);
});

test('历史版本与原作者信息保留，旧计划仍按原契约归档', async t => {
  const { directory, write, run } = await createFixture(t);
  const historical = '---\ntitle: "旧计划"\ntype: plan\nstatus: active\ntarget_version: "v0.4.0"\ncreated_at: "2026-08-31"\nauthor: "Antigravity & Maintainers"\n---\n\n- [x] 历史任务\n';
  await write('docs/plans/legacy.md', historical);
  const result = run('archive', 'legacy.md');
  assert.equal(result.status, 0, result.output);
  const archiveDir = path.join(directory, 'docs/plans/archive');
  const [name] = await fs.readdir(archiveDir);
  assert.match(name, /^\d{4}-\d{2}-\d{2}-legacy\.md$/);
  const saved = await fs.readFile(path.join(archiveDir, name), 'utf8');
  assert.match(saved, /^target_version: v0\.4\.0$/m);
  assert.match(saved, /^author: "Antigravity & Maintainers"$/m);
  assert.match(saved, /^status: completed$/m);
  const checked = run('check');
  assert.equal(checked.status, 0, checked.output);
});

test('允许无关文案和 Markdown 排版调整，不要求翻译全覆盖或视觉 CI', async t => {
  const { write, run } = await createFixture(t);
  await write('docs/VERSIONING.md', policyFiles['docs/VERSIONING.md'].replaceAll('**', '').replaceAll(' | ', '  |  ') + '\n普通说明可以改写。\n');
  await write('AGENTS.md', policyFiles['AGENTS.md'] + '\n非中文可异步补齐，视觉验证仅按需人工执行。\n');
  const result = run('check');
  assert.equal(result.status, 0, result.output);
});


test('仅改 scripts 或 JSON 键排序不触发依赖文档联动', async () => {
  const { dependencyMetadataChanged } = await import('./doc-governance.mjs');
  const before = { scripts: { test: 'node --test one.test.mjs' }, dependencies: { beta: '2', alpha: '1' } };
  const after = { dependencies: { alpha: '1', beta: '2' }, scripts: { test: 'node scripts/run-tests.mjs' } };
  assert.equal(dependencyMetadataChanged(before, after), false);
  assert.equal(dependencyMetadataChanged({}, { scripts: { test: 'node --test' } }), false);
});

test('依赖增删升级和工具链字段变化仍要求技术栈文档', async () => {
  const { dependencyMetadataChanged } = await import('./doc-governance.mjs');
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'engines']) {
    const original = { [field]: { example: '1' } };
    assert.equal(dependencyMetadataChanged(original, { [field]: { example: '2' } }), true, field);
    assert.equal(dependencyMetadataChanged(original, {}), true, field);
    assert.equal(dependencyMetadataChanged({}, original), true, field);
  }
  assert.equal(dependencyMetadataChanged({ packageManager: 'pnpm@9.15.9' }, { packageManager: 'pnpm@10.0.0' }), true);
});


test('总入口追加脚本回归时清单同步，但不要求原生测试进入常规门禁', async t => {
  const { pkg, write, run } = await createFixture(t);
  pkg.scripts.gate += ' && pnpm test:scripts';
  pkg.scripts['test:scripts'] = 'node scripts/run-script-tests.mjs';
  pkg.scripts['test:native'] = 'node scripts/run-native-client-tests.mjs';
  await write('package.json', JSON.stringify(pkg));
  assertRejected(run('check'), /门禁集合漂移/);
  for (const file of ['AGENTS.md', 'README.md', 'docs/CODE_REVIEW.md', 'docs/GIT_WORKFLOW.md']) {
    await write(file, policyFiles[file].replace(gateList, gateList + ' + `pnpm test:scripts`'));
  }
  const result = run('check');
  assert.equal(result.status, 0, result.output);
});
