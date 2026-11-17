import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { discoverScriptTests, runScriptTests } from './run-script-tests.mjs';
import { runCommand } from './native-test-process.mjs';

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'riri-script-runner-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
test('递归发现 mjs/cjs 并稳定排序，忽略 fixture、依赖和符号链接', async t => {
  const directory = await temporary(t);
  for (const sub of ['nested', 'fixtures', 'node_modules', '.cache']) await fs.mkdir(path.join(directory, sub));
  for (const name of ['z.test.mjs', 'a.test.cjs', 'not-a-test.mjs', 'nested/b.test.mjs', 'fixtures/f.test.mjs', 'node_modules/x.test.cjs', '.cache/x.test.mjs']) await fs.writeFile(path.join(directory, name), '');
  assert.deepEqual((await discoverScriptTests(directory)).map(file => path.relative(directory, file).split(path.sep).join('/')), ['a.test.cjs', 'nested/b.test.mjs', 'z.test.mjs']);
});
test('空测试清单必须失败', async t => {
  const root = await temporary(t); await fs.mkdir(path.join(root, 'scripts'));
  await assert.rejects(runScriptTests({ root }), /No script tests/);
});
test('测试脚本的非零退出必须传给调用方', async t => {
  const root = await temporary(t); await fs.mkdir(path.join(root, 'scripts'));
  await fs.writeFile(path.join(root, 'scripts/fail.test.mjs'), "import test from 'node:test'; test('expected fixture failure', () => { throw new Error('fixture failed'); });");
  await assert.rejects(runScriptTests({ root }), /Command failed/);
});
test('串行执行文件，工作目录与调用方无关', async t => {
  const root = await temporary(t); await fs.mkdir(path.join(root, 'scripts'));
  await fs.writeFile(path.join(root, 'scripts/1.test.mjs'), "import fs from 'node:fs'; import test from 'node:test'; test('first', () => fs.writeFileSync('ordered', 'first'));");
  await fs.writeFile(path.join(root, 'scripts/2.test.cjs'), "const fs = require('node:fs'); const test = require('node:test'); const assert = require('node:assert/strict'); test('second', () => assert.equal(fs.readFileSync('ordered', 'utf8'), 'first'));");
  await runScriptTests({ root });
  assert.equal(await fs.readFile(path.join(root, 'ordered'), 'utf8'), 'first');
});
test('不存在的命令和失败的启动不能视为跳过', async () => {
  await assert.rejects(runCommand('riri-command-that-does-not-exist', [], { capture: true }), /ENOENT/);
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.exit(7)'], { capture: true }), /Command failed \(7\)/);
});
test('超时回收子进程及其孙进程', { timeout: 15_000 }, async t => {
  const root = await temporary(t); const pidFile = path.join(root, 'pid');
  const code = "const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {stdio:'ignore'}); fs.writeFileSync(process.argv[1], String(child.pid)); setInterval(()=>{}, 1000);";
  await assert.rejects(runCommand(process.execPath, ['-e', code, pidFile], { timeoutMs: 2500, capture: true }), /timed out/);
  const pid = Number(await fs.readFile(pidFile, 'utf8'));
  // POSIX 进程组同时退出后，给 init 回收已终止孙进程的时间，避免调度顺序影响断言。
  for (let attempt = 0; attempt < 40; attempt++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('Native command left a descendant process alive');
});
