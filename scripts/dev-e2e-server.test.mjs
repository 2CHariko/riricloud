import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const scratch = process.env.PI_SCRATCH_DIR || tmpdir();
const shellHelper = resolve('scripts/dev-e2e-server.sh').replaceAll('\\', '/');

async function startState(log, { alive = true, reachable = true } = {}) {
  const dir = await mkdtemp(join(scratch, 'e2e-readiness-'));
  try {
    const file = join(dir, 'server.log');
    await writeFile(file, log);
    return execFileSync('bash', ['-c', [
      'source "$1" || exit 1',
      `kill() { return ${alive ? 0 : 1}; }`,
      `server_up() { return ${reachable ? 0 : 1}; }`,
      'e2e_server_start_state "$2" 123'
    ].join('\n'), '--', shellHelper, file.replaceAll('\\', '/')], { encoding: 'utf8' }).trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('旧 API 可达与 Nest 初始化成功不能让本次未监听实例通过就绪检查', async () => {
  assert.equal(await startState('Starting compilation in watch mode...\n'), 'WAIT');
  assert.equal(await startState('Nest application successfully started\n'), 'WAIT');
});

test('本次监听标记、存活进程和可达 API 缺一不可', async () => {
  const log = '[Bootstrap] HTTP listener ready\n';
  assert.equal(await startState(log), 'READY');
  assert.equal(await startState(log, { alive: false }), 'EXITED');
  assert.equal(await startState(log, { reachable: false }), 'WAIT');
});

test('端口冲突和启动错误优先于旧 HTTP 响应及监听标记', async () => {
  assert.equal(await startState('HTTP listener ready\nError: listen EADDRINUSE\n'), 'PORT_CONFLICT');
  assert.equal(await startState("Error: Cannot find module 'dist/main'\n"), 'FAILED');
  assert.equal(await startState('Found 2 errors. Watching for file changes.\n'), 'FAILED');
});

test('启动脚本调用隔离配置且不再删除其他 watcher 的编译状态', async () => {
  const script = await readFile(resolve('scripts/dev-e2e.sh'), 'utf8');
  execFileSync('bash', ['-n', resolve('scripts/dev-e2e.sh').replaceAll('\\', '/')]);
  assert.match(script, /dev-e2e-server-build\.mjs/);
  assert.match(script, /nest start --watch --path "\$SERVER_TSCONFIG_ARG"/);
  assert.match(script, /SERVER_TSCONFIG_ARG="\.cache\//);
  assert.match(script, /e2e_server_start_state/);
  assert.doesNotMatch(script, /rm -f apps\/server\/\*\.tsbuildinfo/);
  const main = await readFile(resolve('apps/server/src/main.ts'), 'utf8');
  assert.match(main, /await app\.listen\([^;]+;\s*Logger\.log\('HTTP listener ready', 'Bootstrap'\)/);
});

test('并行 E2E 构建使用不同输出，保留手动主控 dist 并继承正式配置', async () => {
  const { createServerBuild } = await import(pathToFileURL(resolve('scripts/dev-e2e-server-build.mjs')));
  const dir = await mkdtemp(join(scratch, 'e2e-build-'));
  try {
    await mkdir(join(dir, 'dist'));
    await writeFile(join(dir, 'dist', 'main.js'), 'manual-server-output');
    const first = await createServerBuild(dir);
    const second = await createServerBuild(dir);
    assert.notEqual(first, second);
    const a = JSON.parse(await readFile(first, 'utf8'));
    const b = JSON.parse(await readFile(second, 'utf8'));
    assert.notEqual(a.compilerOptions.outDir, b.compilerOptions.outDir);
    assert.equal(a.extends, join(dir, 'tsconfig.build.json').replaceAll('\\', '/'));
    assert.equal(a.compilerOptions.incremental, false);
    assert.deepEqual(a.include, [join(dir, 'src', '**', '*.ts').replaceAll('\\', '/')]);
    assert.equal(await readFile(join(dir, 'dist', 'main.js'), 'utf8'), 'manual-server-output');
    assert.equal(a.compilerOptions.outDir, join(first, '..', 'dist').replaceAll('\\', '/'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('真实 Nest CLI 并行构建相对配置且不删除默认 dist', { timeout: 30000 }, async () => {
  const { createServerBuild } = await import(pathToFileURL(resolve('scripts/dev-e2e-server-build.mjs')));
  const dir = await mkdtemp(join(scratch, 'e2e-nest-cli-'));
  try {
    await mkdir(join(dir, 'src'));
    await mkdir(join(dir, 'dist'));
    await writeFile(join(dir, 'dist', 'main.js'), 'manual-server-output');
    await writeFile(join(dir, 'src', 'main.ts'), 'export const value = 42;\n');
    await writeFile(join(dir, 'nest-cli.json'), JSON.stringify({ sourceRoot: 'src', compilerOptions: { deleteOutDir: true } }));
    await writeFile(join(dir, 'tsconfig.build.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', rootDir: 'src', outDir: 'dist', types: [] }, exclude: ['**/*spec.ts', 'dist', '.cache'] }));
    const configs = await Promise.all([createServerBuild(dir), createServerBuild(dir)]);
    const cli = resolve('apps/server/node_modules/@nestjs/cli/bin/nest.js');
    await Promise.all(configs.map((config) => promisify(execFile)(process.execPath, [cli, 'build', '--path', relative(dir, config).replaceAll('\\', '/')], { cwd: dir, timeout: 25000 })));
    for (const config of configs) assert.match(await readFile(join(dirname(config), 'dist', 'main.js'), 'utf8'), /42/);
    assert.equal(await readFile(join(dir, 'dist', 'main.js'), 'utf8'), 'manual-server-output');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
