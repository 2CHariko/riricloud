import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { discoverNativeSuites, assertJestResults, assertNativeTap } from './run-native-client-tests.mjs';
import { repository } from './prepare-native-kernels.mjs';

const source = path.join(repository, 'apps/server/src');
const linuxOnlySuites = [
  'line-credentials/relay-credentials.naive.native.spec.ts',
  'probe/executors/naive.native.spec.ts'
];
const relativeSuites = (files, root = source) => files.map(file => path.relative(root, file).split(path.sep).join('/')).sort();
test('发现全部原生套件，仅按精确 Linux allowlist 排除 Naive，不固定套件总数', async () => {
  const linux = await discoverNativeSuites(source, 'linux-arm64');
  const baseline = relativeSuites(linux.selected);
  assert.deepEqual(linux.excluded, []);
  for (const file of linuxOnlySuites) assert.ok(baseline.includes(file), file);
  assert.ok(baseline.includes('line-credentials/relay-credentials.native.spec.ts'));
  for (const target of ['linux-amd64', 'windows-amd64', 'darwin-amd64', 'darwin-arm64']) {
    const result = await discoverNativeSuites(source, target);
    const excluded = target.startsWith('linux-') ? [] : linuxOnlySuites;
    assert.deepEqual(result.excluded.map(item => item.file).sort(), excluded);
    assert.deepEqual(relativeSuites(result.selected), baseline.filter(file => !excluded.includes(file)));
    assert.ok(result.excluded.every(item => item.reason === 'Naive/Cronet real TLS HTTP/2 acceptance is Linux-only'));
  }
  for (const name of ['client-kernels.service.spec.ts', 'validation-native.spec.ts', 'native-client.spec.ts', 'mihomo.executor.spec.ts', 'protocols.native.spec.ts', 'fallback.native.spec.ts', 'mihomo-urltest.native.spec.ts', 'mihomo-latency.native.spec.ts']) assert.ok(linux.selected.some(file => file.endsWith(name)));
});
test('新目录、同名 Naive 或未登记 skip 都不能被平台过滤隐藏', async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'riri-native-discovery-'));
  try {
    const required = ['future/naive.native.spec.ts', 'future/relay-credentials.naive.native.spec.ts', 'other/naive-only.spec.ts', 'other/handshake.native.spec.ts'];
    for (const file of [...linuxOnlySuites, ...required, 'other/ordinary.spec.ts']) {
      const absolute = path.join(directory, file);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, file.endsWith('ordinary.spec.ts') ? 'describe.skip("ordinary unit suite", () => {});' : 'const native = process.env.RUN_NATIVE_CLIENT_TESTS === "1" ? describe : describe.skip; native("fixture", () => {});');
    }
    const result = await discoverNativeSuites(directory, 'windows-amd64');
    assert.deepEqual(result.excluded.map(item => item.file).sort(), linuxOnlySuites);
    assert.deepEqual(relativeSuites(result.selected, directory), required.sort());
    const executed = {
      success: true, numFailedTests: 0, numFailedTestSuites: 0, numPendingTests: 0, numPendingTestSuites: 0,
      numTodoTests: 0, numTotalTests: required.length,
      testResults: result.selected.map(name => ({ name, status: 'passed', assertionResults: [{ status: 'passed' }] }))
    };
    assert.doesNotThrow(() => assertJestResults(executed, result.selected));
    // 即使报告的汇总计数谎称无 skip，逐套件/逐断言检查仍拒绝未运行测试。
    for (const index of executed.testResults.keys()) {
      const skipped = structuredClone(executed);
      skipped.testResults[index].assertionResults[0].status = 'pending';
      assert.throws(() => assertJestResults(skipped, result.selected), /did not all execute/);
      skipped.testResults[index].status = 'pending';
      assert.throws(() => assertJestResults(skipped, result.selected), /did not all execute/);
      const missing = structuredClone(executed);
      missing.testResults.splice(index, 1);
      assert.throws(() => assertJestResults(missing, result.selected), /inventory/);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
const suites = [path.join(source, 'example.spec.ts')];
const success = () => ({ success: true, numFailedTests: 0, numFailedTestSuites: 0, numPendingTests: 0, numTodoTests: 0, numPendingTestSuites: 0, numTotalTests: 1, testResults: [{ name: suites[0], status: 'passed', assertionResults: [{ status: 'passed' }] }] });
test('非零测试数、全部套件和每条断言真实执行才通过', () => {
  assert.deepEqual(assertJestResults(success(), suites), { suites: 1, tests: 1 });
  for (const change of [{ success: false }, { numPendingTests: 1 }, { numTodoTests: 1 }, { numFailedTestSuites: 1 }, { numTotalTests: 0 }]) assert.throws(() => assertJestResults({ ...success(), ...change }, suites), /failed|skipped|no tests/);
  assert.throws(() => assertJestResults({ ...success(), testResults: [] }, suites), /inventory/);
  const pending = success(); pending.testResults[0].assertionResults[0].status = 'pending';
  assert.throws(() => assertJestResults(pending, suites), /did not all execute/);
});
test('原生脚本 TAP 不能用 skip/todo/空结果伪装成功', () => {
  const tap = '# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.deepEqual(assertNativeTap(tap), { tests: 2 });
  assert.throws(() => assertNativeTap(tap.replace('# skipped 0', '# skipped 1')), /skipped/);
  assert.throws(() => assertNativeTap(''), /no complete TAP/);
});
test('CI 接入 i18n、全部脚本及五个原生 runner，无交叉编译替代', async () => {
  const require = createRequire(path.join(repository, 'apps/server/package.json'));
  const workflow = require('yaml').parse(await fs.readFile(path.join(repository, '.github/workflows/ci.yml'), 'utf8'));
  assert.ok(workflow.jobs.governance.steps.some(step => step.run === 'pnpm gate:i18n'));
  assert.ok(workflow.jobs.scripts.steps.some(step => step.run === 'node scripts/run-script-tests.mjs'));
  const native = workflow.jobs['native-kernels'];
  assert.deepEqual(native.strategy.matrix.include, [
    { target: 'linux-amd64', runner: 'ubuntu-24.04' }, { target: 'linux-arm64', runner: 'ubuntu-24.04-arm' },
    { target: 'windows-amd64', runner: 'windows-2022' }, { target: 'darwin-amd64', runner: 'macos-15-intel' }, { target: 'darwin-arm64', runner: 'macos-15' },
  ]);
  assert.equal(native.env.RUN_NATIVE_CLIENT_TESTS, '1');
  assert.equal(native.defaults.run.shell, 'bash');
  assert.ok(native.steps.some(step => step.with?.['node-version'] === 22));
  assert.ok(native.steps.some(step => step.with?.['go-version-file'] === 'apps/agent/go.mod'));
});
