'use strict';
const fs = require('node:fs');
const { normalizeSqliteUrl } = require('./sqlite-url');
const UPSTREAM_MIGRATION = '20260930190000_upstream_breaking_refactor';

// 仅通过原始只读 SQL 检查旧模型，不读取秘密、不执行数据转换。
async function assertUpstreamUpgradeSafe(client) {
  const tables = await client.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type = 'table'");
  const names = new Set(tables.map((row) => row.name));
  if (names.has('_prisma_migrations')) {
    const applied = await client.$queryRawUnsafe(
      `SELECT migration_name FROM "_prisma_migrations" WHERE migration_name = '${UPSTREAM_MIGRATION}' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`
    );
    if (applied.length) return;
  }
  let legacy = false;
  for (const table of ['UpstreamSubscription', 'UpstreamNode']) {
    if (!names.has(table)) continue;
    const rows = await client.$queryRawUnsafe(`SELECT COUNT(*) AS count FROM "${table}"`);
    legacy ||= BigInt(rows[0].count) > 0n;
  }
  if (names.has('Line')) {
    const columns = await client.$queryRawUnsafe('PRAGMA table_info("Line")');
    const columnNames = new Set(columns.map((row) => row.name));
    const clauses = [];
    if (columnNames.has('upstreamNodeId')) clauses.push('"upstreamNodeId" IS NOT NULL');
    if (columnNames.has('relayMode')) clauses.push('"relayMode" = \'UPSTREAM_NODE\'');
    if (clauses.length) {
      const rows = await client.$queryRawUnsafe(`SELECT COUNT(*) AS count FROM "Line" WHERE ${clauses.join(' OR ')}`);
      legacy ||= BigInt(rows[0].count) > 0n;
    }
  }
  if (legacy) {
    throw new Error('Backup the main database and explicitly remove legacy upstream sources, nodes and their linked lines before upgrading. Automatic upstream conversion or cleanup is not supported. See docs/DEPLOYMENT_GUIDE.md.');
  }
}

async function runUpstreamUpgradePreflight(url = process.env.DATABASE_URL || 'file:./dev.db', options = {}) {
  const absoluteUrl = normalizeSqliteUrl(url, options.schemaDir || __dirname);
  const dbPath = absoluteUrl.slice(5).split('?')[0];
  if (!fs.existsSync(dbPath)) return;
  const createClient = options.createClient || ((resolvedUrl) => {
    const { PrismaClient } = require('@prisma/client');
    return new PrismaClient({ datasources: { db: { url: resolvedUrl } } });
  });
  const client = createClient(absoluteUrl);
  try {
    await assertUpstreamUpgradeSafe(client);
  } finally {
    await client.$disconnect();
  }
}

module.exports = { assertUpstreamUpgradeSafe, runUpstreamUpgradePreflight, UPSTREAM_MIGRATION };
if (require.main === module) {
  runUpstreamUpgradePreflight().catch((err) => {
    console.error(`[upstream-upgrade-preflight] ${err.message}`);
    process.exitCode = 1;
  });
}
