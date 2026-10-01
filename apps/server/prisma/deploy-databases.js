'use strict';

/**
 * 自动双库部署脚本：
 * 保证在缺少 TELEMETRY_DATABASE_URL 时智能从 DATABASE_URL 自动推导，
 * 依次执行观测库迁移、存量数据无损搬移与主库迁移。
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// 简单加载 .env 文件中的环境变量（若未由父进程导出）
function loadDotenv() {
  const envFile = path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

loadDotenv();

const mainUrl = process.env.DATABASE_URL || 'file:./dev.db';
if (!process.env.TELEMETRY_DATABASE_URL) {
  if (mainUrl.includes('/riri.db')) {
    process.env.TELEMETRY_DATABASE_URL = mainUrl.replace('/riri.db', '/telemetry.db');
  } else if (mainUrl.includes('/dev.db') || mainUrl.endsWith('dev.db')) {
    process.env.TELEMETRY_DATABASE_URL = mainUrl.replace('dev.db', 'dev-telemetry.db');
  } else {
    process.env.TELEMETRY_DATABASE_URL = 'file:./dev-telemetry.db';
  }
}

const { normalizeSqliteUrl } = require('./sqlite-url');
process.env.DATABASE_URL = normalizeSqliteUrl(mainUrl, __dirname);
process.env.TELEMETRY_DATABASE_URL = normalizeSqliteUrl(process.env.TELEMETRY_DATABASE_URL, path.join(__dirname, 'telemetry'));

const prismaCli = path.resolve(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js');

function runPrisma(args) {
  const result = spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: path.resolve(__dirname, '..'),
    env: process.env,
    stdio: 'inherit'
  });
  if (result.error) {
    console.error(`prisma ${args.join(' ')} failed:`, result.error.message);
    process.exit(result.status ?? 1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function deploy() {
  // 必须在任何主库/观测库变更前拒绝旧上游数据，不自动清理或转换。
  const { runUpstreamUpgradePreflight } = require('./upstream-upgrade-preflight');
  await runUpstreamUpgradePreflight(process.env.DATABASE_URL);
  runPrisma(['migrate', 'deploy', '--schema=prisma/telemetry/schema.prisma']);
  const { migrateTelemetryData } = require('./migrate-telemetry-data');
  try {
    await migrateTelemetryData();
  } catch (err) {
    console.warn(`[telemetry-migration] Migration check error: ${err.message}`);
  }
  runPrisma(['migrate', 'deploy']);
}

deploy().catch((err) => {
  console.error(`[database-deploy] ${err.message}`);
  process.exitCode = 1;
});
