import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { URL } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { discoverTestFiles } from '../../scripts/run-tests.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'riricloud web tests '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    write(path, content = '') {
      const file = join(root, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      return file;
    }
  };
}

function runFixture(f) {
  const script = f.write('scripts/run-tests.mjs');
  copyFileSync(new URL('../../scripts/run-tests.mjs', import.meta.url), script);
  const env = { ...process.env };
  // 子进程模拟独立 CLI，不能继承父测试进程的隔离标记。
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [script, '--test-reporter=tap'], {
    cwd: tmpdir(), env, encoding: 'utf8'
  });
}

test('discovery includes nested and newly added .test.mjs files and excludes dependencies and build output', (t) => {
  const f = fixture(t);
  const first = f.write('src/lib/first.test.mjs');
  const nested = f.write('src/pages/nested cases/second.test.mjs');
  const tooling = f.write('scripts/tooling.test.mjs');
  for (const path of ['src/helper.mjs', 'src/old.test.mjs.bak', 'node_modules/pkg/vendor.test.mjs', 'dist/bundle.test.mjs', 'coverage/report.test.mjs', '.git/internal.test.mjs']) f.write(path);
  assert.deepEqual(discoverTestFiles(f.root), [first, nested, tooling].sort());
  const added = f.write('src/new feature/added.test.mjs');
  assert.deepEqual(discoverTestFiles(f.root), [first, nested, tooling, added].sort());
});

test('CLI runs discovered files regardless of cwd and propagates newly discovered failures', (t) => {
  const f = fixture(t);
  f.write('src/nested cases/pass.test.mjs', "import { test } from 'node:test'; test('nested success', () => {});\n");
  const passed = runFixture(f);
  assert.ifError(passed.error);
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /ok \d+ - nested success/);

  f.write('src/new feature/fail.test.mjs', "import { test } from 'node:test'; test('new failure', () => { throw new Error('fixture failure'); });\n");
  const failed = runFixture(f);
  assert.ifError(failed.error);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /not ok \d+ - new failure/);
  assert.match(failed.stdout, /ok \d+ - nested success/);
});

test('CLI fails when no tests are discovered instead of reporting an empty success', (t) => {
  const result = runFixture(fixture(t));
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No \.test\.mjs files found/);
});
