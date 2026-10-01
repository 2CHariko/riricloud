#!/usr/bin/env node
// 主控容器入口：迁移数据库、初始化管理员与系统节点，并管理 Master 的生命周期。
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let validateJwtSecret;
try {
  ({ validateJwtSecret } = require('/app/prisma/admin-bootstrap'));
} catch (_) {
  try {
    ({ validateJwtSecret } = require(path.resolve(__dirname, '../apps/server/prisma/admin-bootstrap')));
  } catch (err) {
    validateJwtSecret = (secret) => {
      if (!secret || typeof secret !== 'string' || secret.trim().length < 16) {
        throw new Error('JWT_SECRET 未配置或未满足强随机安全要求');
      }
    };
  }
}

const prismaCli = '/app/node_modules/prisma/build/index.js';
let serverChild = null;
let shutdownRequested = false;

function fail(message) {
  console.error(message);
  throw new Error(message);
}

function runPrisma(...args) {
  const result = spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: '/app',
    env: process.env,
    stdio: 'inherit'
  });
  if (result.error) fail(`prisma ${args.join(' ')} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`prisma ${args.join(' ')} failed with exit code ${result.status ?? 1}`);
}

function runNodeScript(scriptPath) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: '/app',
    env: process.env,
    stdio: 'inherit'
  });
  if (result.error) fail(`${scriptPath} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${scriptPath} failed with exit code ${result.status ?? 1}`);
}

function isEnabled(value) {
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

function isProduction() {
  return String(process.env.NODE_ENV ?? '').toLowerCase() === 'production' ||
    String(process.env.RIRICLOUD_ENV ?? '').toLowerCase() === 'production';
}

function isBooleanValue(value) {
  return ['true', '1', 'yes', 'on', 'false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}

function printPermissionFailure({ currentUid, currentGid, dirStat, fileStat, filename, summary, stage }) {
  const dirInfo = dirStat
    ? `UID=${dirStat.uid}, GID=${dirStat.gid}, Mode=0${(dirStat.mode & 0o777).toString(8)}`
    : '无法获取 (目录未就绪)';
  const fileInfo = fileStat
    ? `\n  - 异常文件属性:     [${filename}] UID=${fileStat.uid}, GID=${fileStat.gid}, Mode=0${(fileStat.mode & 0o777).toString(8)}`
    : '';

  console.error(`
================================================================================
🚨 RiriCloud Master 容器启动诊断失败 (Startup Diagnostics Error)
================================================================================
【诊断结论】
  ${summary}

【环境现场取证】
  - 容器进程运行身份: UID=${currentUid}, GID=${currentGid}
  - 挂载目录实际状态: ${dirInfo}${fileInfo}
  - 触发异常具体环节: ${stage}

【宿主机一键修复建议 (任选其一)】
  👉 方案 1 (最推荐，放宽宿主机挂载目录写权限):
     chmod -R 777 ./data ./data/agent

  👉 方案 2 (保持非 Root 安全用户，将挂载目录属主修改为容器 UID 65532):
     sudo chown -R 65532:65532 ./data ./data/agent
     (注: 若项目位于 /root 目录下，请确认 /root 本身具备 +x 穿透权限)

  👉 方案 3 (在 .env 或 .env.image 中以宿主机当前身份运行，免改目录权限):
     DOCKER_USER=0:0   # 以 root 运行 (适合 VPS 管理员)
     或设置 DOCKER_USER=$(id -u):$(id -g)
================================================================================
`);
}

function printDiagnosticFailure({ title, summary, details, remedies }) {
  console.error(`
================================================================================
🚨 RiriCloud Master 容器配置诊断失败: ${title}
================================================================================
【诊断结论】
  ${summary}

【现场取证】
${details.map((d) => `  - ${d}`).join('\n')}

【修复建议】
${remedies
  .map(
    (r) =>
      `  👉 ${r.title}:\n${r.commands.map((c) => `     ${c}`).join('\n')}${r.note ? `\n     (注: ${r.note})` : ''}`
  )
  .join('\n\n')}
================================================================================
`);
}

function runStartupDiagnostics() {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
  const currentGid = typeof process.getgid === 'function' ? process.getgid() : 'unknown';
  const dataDir = process.env.MASTER_DATA_DIR || '/app/data';
  const tmpDir = process.env.MASTER_TMP_DIR || '/tmp';

  // 1. 核心安全配置预检
  try {
    validateJwtSecret(process.env.JWT_SECRET);
  } catch (error) {
    printDiagnosticFailure({
      title: '核心密钥 JWT_SECRET 校验失败',
      summary: error.message || 'JWT_SECRET 未配置或未满足强随机安全要求',
      details: [
        `当前配置状态: JWT_SECRET=${process.env.JWT_SECRET ? '(已设置但未满足复杂度或存在默认占位符)' : '(未提供)'}`
      ],
      remedies: [
        {
          title: '生成并配置强随机 JWT 密钥',
          commands: ['openssl rand -hex 32', '在 .env 或 .env.image 中设置 JWT_SECRET=<生成的64字符密钥>']
        }
      ]
    });
    process.exit(1);
  }

  const autoSeed = String(process.env.AUTO_SEED ?? 'false').toLowerCase();
  if (!isBooleanValue(autoSeed)) {
    printDiagnosticFailure({
      title: 'AUTO_SEED 取值非法',
      summary: 'AUTO_SEED 必须是布尔值 (true 或 false)',
      details: [`当前配置: AUTO_SEED=${process.env.AUTO_SEED}`],
      remedies: [{ title: '修正 AUTO_SEED 取值', commands: ['AUTO_SEED=false'] }]
    });
    process.exit(1);
  }

  if (isEnabled(autoSeed) && isProduction()) {
    printDiagnosticFailure({
      title: '生产环境安全红线阻断',
      summary: '生产环境 (NODE_ENV=production) 禁止开启 AUTO_SEED=true 演示数据播种',
      details: ['生产模式要求使用显式管理员凭证进行安全引导，禁止播种公开演示套餐和用户。'],
      remedies: [
        {
          title: '关闭自动演示播种',
          commands: ['AUTO_SEED=false', '配置 ADMIN_EMAIL 与 ADMIN_PASSWORD 启动']
        }
      ]
    });
    process.exit(1);
  }

  // 2. 数据目录创建与访问探测
  let dirStat = null;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    dirStat = fs.statSync(dataDir);
  } catch (err) {
    printPermissionFailure({
      currentUid,
      currentGid,
      dirStat,
      summary: `挂载数据目录 [${dataDir}] 无法创建或无访问权限！`,
      stage: `创建数据目录失败: ${err.message}`
    });
    process.exit(1);
  }

  // 3. SQLite 临时锁与预写日志探测文件创建/读写/销毁测试
  const probeFile = `${dataDir}/.startup-probe-${Date.now()}-${process.pid}.tmp`;
  try {
    fs.writeFileSync(probeFile, 'riricloud-storage-probe\n', { mode: 0o666 });
    const probeContent = fs.readFileSync(probeFile, 'utf8');
    if (!probeContent.startsWith('riricloud')) throw new Error('探测文件写入校验不匹配');
    fs.unlinkSync(probeFile);
  } catch (err) {
    try {
      if (fs.existsSync(probeFile)) fs.unlinkSync(probeFile);
    } catch (_) {}
    printPermissionFailure({
      currentUid,
      currentGid,
      dirStat,
      summary: `挂载数据目录 [${dataDir}] 写入权限不足，无法创建 SQLite 数据库或 WAL/SHM 锁文件！`,
      stage: `测试锁文件创建/读写失败: ${err.message}`
    });
    process.exit(1);
  }

  // 4. 存量 SQLite 数据库及 WAL/SHM 文件读写锁能力探测
  const checkFiles = [
    'riri.db', 'riri.db-wal', 'riri.db-shm',
    'telemetry.db', 'telemetry.db-wal', 'telemetry.db-shm'
  ];
  for (const filename of checkFiles) {
    const fullPath = `${dataDir}/${filename}`;
    if (!fs.existsSync(fullPath)) continue;
    try {
      fs.accessSync(fullPath, fs.constants.R_OK | fs.constants.W_OK);
      const fd = fs.openSync(fullPath, 'r+');
      fs.closeSync(fd);
    } catch (err) {
      let fileStat = null;
      try {
        fileStat = fs.statSync(fullPath);
      } catch (_) {}
      printPermissionFailure({
        currentUid,
        currentGid,
        dirStat,
        fileStat,
        filename,
        summary: `存量数据库文件 [${filename}] 读写权限不足，SQLite 无法打开或加锁！`,
        stage: `打开存量数据库文件失败 (${filename}): ${err.message}`
      });
      process.exit(1);
    }
  }

  // 5. 临时目录 /tmp 可用性检测
  const tmpProbe = `${tmpDir}/.riri-tmp-probe-${Date.now()}-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpProbe, 'tmp-probe');
    fs.unlinkSync(tmpProbe);
  } catch (err) {
    try {
      if (fs.existsSync(tmpProbe)) fs.unlinkSync(tmpProbe);
    } catch (_) {}
    printPermissionFailure({
      currentUid,
      currentGid,
      dirStat: null,
      summary: `临时目录 [${tmpDir}] 无写入权限，可能被挂载为只读 (read-only)！`,
      stage: `临时目录写入失败: ${err.message}`
    });
    process.exit(1);
  }
}

function stopChild(child, signal = 'SIGTERM') {
  if (child && child.exitCode === null && !child.killed) child.kill(signal);
}

function handleSignal(signal) {
  shutdownRequested = true;
  if (serverChild) stopChild(serverChild, signal);
}

process.on('SIGTERM', () => handleSignal('SIGTERM'));
process.on('SIGINT', () => handleSignal('SIGINT'));

async function main() {
  runStartupDiagnostics();

  process.env.TELEMETRY_DATABASE_URL = process.env.TELEMETRY_DATABASE_URL || 'file:/app/data/telemetry.db';

  runNodeScript('/app/prisma/upstream-upgrade-preflight.js');
  runPrisma('migrate', 'deploy', '--schema=/app/prisma/telemetry/schema.prisma');
  runNodeScript('/app/prisma/migrate-telemetry-data.js');
  runPrisma('migrate', 'deploy');
  runNodeScript('/app/prisma/bootstrap-admin.js');

  const autoSeed = String(process.env.AUTO_SEED ?? 'false').toLowerCase();
  if (isEnabled(autoSeed)) {
    console.log('seeding demo data (AUTO_SEED=true) ...');
    runNodeScript('/app/prisma/seed.js');
  }

  const mainEntry = fs.existsSync('/app/dist/main.js')
    ? 'dist/main.js'
    : fs.existsSync('/app/dist/src/main.js')
      ? 'dist/src/main.js'
      : 'dist/main.js';

  serverChild = spawn(process.execPath, [mainEntry], {
    cwd: '/app',
    env: process.env,
    stdio: 'inherit'
  });

  const exitCode = await new Promise((resolve) => {
    serverChild.once('error', (error) => {
      console.error(`Master 启动失败：${error.message}`);
      resolve(1);
    });
    serverChild.once('exit', (code, signal) => {
      if (shutdownRequested || signal) resolve(0);
      else resolve(code ?? 1);
    });
  });

  process.exitCode = exitCode;
}

main().catch((error) => {
  if (serverChild) stopChild(serverChild);
  console.error(`master entrypoint failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = shutdownRequested ? 0 : 1;
});
