import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import locks from '../apps/server/prisma/maintenance-lock.js';

const root = fileURLToPath(new URL('../', import.meta.url));
function bash() {
  if (process.platform !== 'win32') return 'bash';
  const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).stdout?.trim();
  const candidate = git && resolve(git, '../../../bin/bash.exe');
  if (candidate && existsSync(candidate)) return candidate;
  throw new Error('找不到 Git Bash，请从 Git Bash 运行本地验收或安装 Git for Windows。');
}

async function run() {
  const shell = bash();
  const scratch = mkdtempSync(join(tmpdir(), 'riricloud-e2e-'));
  // 仅继承主机工具链和显式测试资源，不把当前 shell 的服务配置传给隔离联调。
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR|SYSTEMDRIVE|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES(\(X86\))?|TEMP|TMP|TMPDIR|TERM|LANG|LC_.*|CI|GOTOOLCHAIN|GOROOT|GOPATH|GOCACHE|GOMODCACHE|PNPM_HOME|COREPACK_HOME|MIHOMO_BINARY_PATH|SINGBOX_BINARY_PATH|CLIENT_VALIDATION_RESOURCES_DIR)$/i.test(key)
  ));
  if (process.platform === 'win32') {
    const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'Path';
    env[pathKey] = resolve(shell, '..') + ';' + (env[pathKey] ?? '');
  }
  const portable = scratch.replaceAll('\\', '/');
  const config = { main: join(scratch, 'main.db'), telemetry: join(scratch, 'telemetry.db'), dataDir: join(scratch, 'data') };
  Object.assign(env, {
    E2E_SMOKE_DIR: portable,
    NODE_OPTIONS: '--require="' + join(root, 'scripts/dev-e2e-no-dotenv.cjs').replaceAll('\\', '/') + '"',
    RIRICLOUD_E2E_LOOPBACK: '1',
    RIRICLOUD_CONFIG_PATH: portable + '/agent.yaml',
    JWT_SECRET: randomBytes(32).toString('hex'),
    RIRICLOUD_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    MASTER_LOCAL_HOST: '127.0.0.1',
    ADMIN_EMAIL: 'e2e-admin@riricloud.local',
    ADMIN_PASSWORD: 'E2e!' + randomBytes(20).toString('hex'),
    SEED_USER_EMAIL: 'e2e-user@riricloud.local',
    SEED_USER_PASSWORD: 'E2e!' + randomBytes(20).toString('hex')
  });
  const child = spawn(shell, ['scripts/dev-e2e.sh', '--smoke'], { cwd: root, env, stdio: 'inherit' });
  let interrupted = false;
  const stop = () => { interrupted = true; writeFileSync(join(scratch, 'cancel'), '', { mode: 0o600 }); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const code = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('close', code => done(code ?? 1));
    });
    process.exitCode = interrupted ? 130 : code;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (existsSync(join(scratch, 'cleanup-pending')) || locks.lockPaths(config).some(existsSync)) {
      console.error('[dev-e2e] 未确认隔离环境已清理，已保留现场：%s', scratch);
      if (!process.exitCode) process.exitCode = 1;
    } else rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}

run().catch(error => {
  console.error('[dev-e2e] 本地验收运行器失败：%s', error.code ?? error.message);
  process.exitCode = 1;
});
