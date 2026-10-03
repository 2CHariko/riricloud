import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function createServerBuild(serverDirectory) {
  const server = resolve(serverDirectory);
  // 输出必须仍位于 server 下，才能解析其 node_modules；每次启动独立，避免 watcher 互删 dist。
  const parent = join(server, '.cache');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'dev-e2e-server-'));
  const configPath = join(directory, 'tsconfig.json');
  const portable = (value) => value.replaceAll('\\', '/');
  await writeFile(configPath, JSON.stringify({
    extends: portable(join(server, 'tsconfig.build.json')),
    compilerOptions: { outDir: portable(join(directory, 'dist')), incremental: false },
    include: [portable(join(server, 'src', '**', '*.ts'))]
  }, null, 2) + '\n');
  return portable(configPath);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServerBuild(process.argv[2] || 'apps/server').then(console.log).catch(() => {
    console.error('无法创建 E2E 主控隔离编译配置');
    process.exitCode = 1;
  });
}
