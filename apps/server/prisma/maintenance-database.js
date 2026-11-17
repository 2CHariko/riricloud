'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EXIT, MaintenanceError, fail } = require('./maintenance-errors');
const { assertNoLinks } = require('./maintenance-paths');
const { verifyStoredSecrets } = require('./maintenance-secrets');

function migrationSet(directory) {
  assertNoLinks(directory);
  return fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const file = path.join(directory, entry.name, 'migration.sql');
    assertNoLinks(file);
    return { name: entry.name, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
function expectedMigrations() {
  return { main: migrationSet(path.join(__dirname, 'migrations')), telemetry: migrationSet(path.join(__dirname, 'telemetry/migrations')) };
}
async function inspectDatabase(file, migrations, checkSecrets = false) {
  // 只打开临时副本，绝不连接运行库或原备份；不加载 AppModule/巡检/Agent。
  assertNoLinks(file);
  const { PrismaClient } = require('@prisma/client');
  const client = new PrismaClient({ datasources: { db: { url: `file:${file.split(path.sep).join('/')}` } }, log: [] });
  try {
    await client.$executeRawUnsafe('PRAGMA query_only = ON');
    const integrity = await client.$queryRawUnsafe('PRAGMA integrity_check');
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') fail('SQLITE_INTEGRITY_FAILED', 'SQLite integrity validation failed.', EXIT.DATABASE);
    const foreignKeys = await client.$queryRawUnsafe('PRAGMA foreign_key_check');
    if (foreignKeys.length) fail('SQLITE_FOREIGN_KEY_FAILED', 'SQLite foreign-key validation failed.', EXIT.DATABASE);
    const applied = await client.$queryRawUnsafe('SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"');
    const active = applied.filter((row) => row.rolled_back_at === null);
    if (active.some((row) => !row.finished_at) || active.length !== migrations.length ||
        migrations.some((expected) => active.filter((row) => row.migration_name === expected.name && row.checksum === expected.sha256).length !== 1)) {
      fail('DATABASE_MIGRATIONS_MISMATCH', 'Database migrations do not match this application. Restore using the matching version first.', EXIT.INCOMPATIBLE);
    }
    if (checkSecrets) await verifyStoredSecrets(client);
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    fail('SQLITE_VALIDATION_FAILED', 'SQLite database or migration metadata could not be validated.', EXIT.DATABASE);
  } finally { await client.$disconnect(); }
}
module.exports = { migrationSet, expectedMigrations, inspectDatabase };
