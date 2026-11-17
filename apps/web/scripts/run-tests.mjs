import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { error, log } from 'node:console';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const ignoredDirectories = new Set(['node_modules', 'dist', 'coverage', '.git']);

// 显式枚举文件，避免依赖 shell glob 或 Node 特定版本的 glob 支持。
export function discoverTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) return discoverTestFiles(path);
    return entry.isFile() && entry.name.endsWith('.test.mjs') ? [path] : [];
  }).sort();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const files = discoverTestFiles(webRoot);
    if (files.length === 0) throw new Error('No .test.mjs files found.');
    log(`[web:test] Discovered ${files.length} test files.`);
    const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
      cwd: webRoot,
      stdio: 'inherit'
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (cause) {
    error(`[web:test] ${cause.message}`);
    process.exitCode = 1;
  }
}
