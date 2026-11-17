import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCommand } from './native-test-process.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function discoverScriptTests(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'fixtures', 'artifacts'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await discoverScriptTests(file));
    else if (entry.isFile() && /\.test\.(?:mjs|cjs)$/.test(entry.name)) files.push(file);
  }
  return files.sort();
}
export async function runScriptTests({ root = repository, list = false } = {}) {
  const files = await discoverScriptTests(path.join(root, 'scripts'));
  if (files.length === 0) throw new Error('No script tests discovered');
  if (list) { console.log(files.map(file => path.relative(root, file).split(path.sep).join('/')).join('\n')); return; }
  console.log(`Running ${files.length} script test files serially. Optional native fixtures run in the native-kernels CI job.`);
  // 显式文件列表避免不同 shell 的 glob 展开差异；数据库/进程类测试按文件串行。
  const env = { ...process.env };
  // Node 测试内自测调度器时不能继承父测试的内部标记，否则子进程会静默不运行。
  delete env.NODE_TEST_CONTEXT;
  await runCommand(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: root, env, capture: process.env.NODE_TEST_CONTEXT !== undefined, timeoutMs: 10 * 60_000 });
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--list')) throw new Error('Usage: node scripts/run-script-tests.mjs [--list]');
    await runScriptTests({ list: args.includes('--list') });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
