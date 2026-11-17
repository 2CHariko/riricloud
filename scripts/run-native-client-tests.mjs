import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { assertNativeTarget, hostTarget, prepareNativeKernels, repository } from './prepare-native-kernels.mjs';
import { runCommand } from './native-test-process.mjs';

const linuxOnly = new Set(['probe/executors/naive.native.spec.ts', 'line-credentials/relay-credentials.naive.native.spec.ts']);
export async function discoverNativeSuites(sourceRoot, target) {
  const selected = []; const excluded = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name.endsWith('.spec.ts')) {
        const source = await fs.readFile(file, 'utf8');
        if (!source.includes('RUN_NATIVE_CLIENT_TESTS') && !entry.name.endsWith('.native.spec.ts')) continue;
        const relative = path.relative(sourceRoot, file).split(path.sep).join('/');
        if (linuxOnly.has(relative) && !target.startsWith('linux-')) excluded.push({ file: relative, reason: 'Naive/Cronet real TLS HTTP/2 acceptance is Linux-only' });
        else selected.push(file);
      }
    }
  }
  await walk(sourceRoot);
  if (selected.length === 0) throw new Error('No native client test suites discovered');
  return { selected: selected.sort(), excluded };
}
export function assertJestResults(result, suites) {
  if (result.success !== true || result.numFailedTests !== 0 || result.numFailedTestSuites !== 0 || result.numPendingTests !== 0 || result.numTodoTests !== 0 || result.numPendingTestSuites !== 0 || !(result.numTotalTests > 0)) throw new Error('Native Jest run failed, skipped tests, or ran no tests');
  const actual = (result.testResults ?? []).map(suite => path.resolve(suite.name)).sort();
  const expected = suites.map(file => path.resolve(file)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Native Jest suite inventory mismatch');
  for (const suite of result.testResults) {
    if (suite.status !== 'passed' || !suite.assertionResults?.length || suite.assertionResults.some(test => test.status !== 'passed')) throw new Error(`Native assertions did not all execute: ${suite.name}`);
  }
  return { suites: actual.length, tests: result.numTotalTests };
}
export function assertNativeTap(tap) {
  const metric = name => Number(tap.match(new RegExp(`^# ${name} (\\d+)\\r?$`, 'm'))?.[1] ?? NaN);
  const tests = metric('tests');
  if (!(tests > 0) || metric('pass') !== tests || ['fail', 'skipped', 'cancelled', 'todo'].some(name => metric(name) !== 0)) throw new Error('Native script run failed, skipped tests, or produced no complete TAP report');
  return { tests };
}
export async function runNativeTests({ target = hostTarget(), outputRoot = path.join(repository, 'artifacts/native', target), cacheRoot } = {}) {
  assertNativeTarget(target);
  if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('Native acceptance requires Node.js 22; use the same runtime as CI');
  const sourceRoot = path.join(repository, 'apps/server/src');
  const inventory = await discoverNativeSuites(sourceRoot, target);
  outputRoot = path.resolve(outputRoot);
  await fs.mkdir(outputRoot, { recursive: true });
  const lockPath = path.join(outputRoot, 'run.lock');
  const lock = await fs.open(lockPath, 'wx');
  const summaryFile = path.join(outputRoot, 'summary.json');
  const summary = { schemaVersion: 1, target, node: process.version, startedAt: new Date().toISOString(), status: 'RUNNING', excluded: inventory.excluded };
  const save = () => fs.writeFile(summaryFile, JSON.stringify(summary, null, 2) + '\n');
  try {
    await lock.writeFile(String(process.pid));
    for (const file of ['resources.json', 'jest-results.json', 'native-scripts.tap']) await fs.rm(path.join(outputRoot, file), { force: true });
    await save();
    for (const item of inventory.excluded) console.log(`Platform exclusion: ${item.file}: ${item.reason}`);
    summary.stage = 'prepare';
    const resources = await prepareNativeKernels({ target, outputRoot, cacheRoot });
    const env = {
      ...process.env, RUN_NATIVE_CLIENT_TESTS: '1',
      MIHOMO_BINARY_PATH: resources.mihomo.path, SINGBOX_BINARY_PATH: resources.singbox.path,
      CLIENT_VALIDATION_RESOURCES_DIR: resources.validation.path, VALIDATION_RESOURCE_FIXTURE_DIR: resources.validation.path,
      E2E_NATIVE_AGENT_BINARY: resources.agent.path, E2E_NATIVE_SINGBOX_BINARY: resources.singbox.path,
    };
    summary.stage = 'jest'; await save();
    const require = createRequire(path.join(repository, 'apps/server/package.json'));
    const report = path.join(outputRoot, 'jest-results.json');
    // 显式列表 + runInBand；不使用 forceExit 掩盖未退出的原生进程或监听。
    await runCommand(process.execPath, [require.resolve('jest/bin/jest'), '--runInBand', '--runTestsByPath', ...inventory.selected, '--json', '--outputFile', report], { cwd: path.join(repository, 'apps/server'), env, timeoutMs: 15 * 60_000 });
    summary.jest = assertJestResults(JSON.parse(await fs.readFile(report, 'utf8')), inventory.selected);
    summary.stage = 'scripts'; await save();
    const tapFile = path.join(outputRoot, 'native-scripts.tap');
    await runCommand(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=tap', `--test-reporter-destination=${tapFile}`, 'scripts/dev-e2e-native.test.mjs', 'scripts/prepare-validation-resources.test.mjs'], { cwd: repository, env, timeoutMs: 5 * 60_000 });
    summary.scripts = assertNativeTap(await fs.readFile(tapFile, 'utf8'));
    summary.status = 'PASSED'; summary.stage = 'complete';
  } catch (error) {
    summary.status = 'FAILED'; summary.error = error.message;
    throw error;
  } finally {
    summary.finishedAt = new Date().toISOString();
    try { await save(); } finally { await lock.close(); await fs.rm(lockPath, { force: true }); }
  }
  console.log(`Native acceptance passed: ${target}; ${summary.jest.tests} Jest tests and ${summary.scripts.tests} script tests`);
  return summary;
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const { values } = parseArgs({ options: { target: { type: 'string', default: hostTarget() }, 'output-dir': { type: 'string' }, 'download-cache': { type: 'string' }, list: { type: 'boolean' } } });
    assertNativeTarget(values.target);
    if (values.list) console.log(JSON.stringify(await discoverNativeSuites(path.join(repository, 'apps/server/src'), values.target), null, 2));
    else await runNativeTests({ target: values.target, outputRoot: values['output-dir'], cacheRoot: values['download-cache'] });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
