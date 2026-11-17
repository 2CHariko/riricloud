'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { EXIT, fail } = require('./maintenance-errors');
const { applicationVersion } = require('./maintenance-config');
const { acquireLock, RESTORE_MARKER } = require('./maintenance-lock');
const { expectedMigrations, inspectDatabase } = require('./maintenance-database');
const { FORMAT_VERSION, signManifest, readManifest, forbiddenResource, requireKey } = require('./maintenance-manifest');
const { assertNoLinks, safeRelative, within, overlaps, copyAndHash, writeJson, removeOwned } = require('./maintenance-paths');

async function resourceFiles(root, prefix = '') {
  assertNoLinks(root, true);
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const source = path.join(root, entry.name);
    assertNoLinks(source);
    if (forbiddenResource(relative)) continue;
    safeRelative(relative);
    if (entry.isDirectory()) result.push(...await resourceFiles(source, relative));
    else if (entry.isFile()) result.push({ path: `binaries/${relative}`, source });
    else fail('UNSAFE_FILE', 'Unsupported binary resource file type.', EXIT.INVALID_BACKUP);
    if (result.length > 100000) fail('TOO_MANY_FILES', 'Runtime binary file limit exceeded.', EXIT.INVALID_BACKUP);
  }
  return result;
}
async function sourceFiles(config) {
  const files = [];
  for (const role of ['main', 'telemetry']) {
    assertNoLinks(config[role]);
    if (fs.existsSync(`${config[role]}-journal`)) fail('ROLLBACK_JOURNAL_PRESENT', 'SQLite rollback journal exists; recover with the matching application before cold backup.', EXIT.DATABASE);
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${config[role]}${suffix}`;
      if (suffix && !fs.existsSync(source)) continue;
      assertNoLinks(source);
      files.push({ path: `databases/${role}.db${suffix}`, source });
    }
  }
  files.push(...await resourceFiles(config.binaries));
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
async function fingerprint(files) {
  return JSON.stringify(await Promise.all(files.map(async (file) => {
    const stat = await fsp.lstat(file.source);
    return [file.path, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino];
  })));
}
async function checkInventory(backup, manifest) {
  const allowed = new Set(['manifest.json', ...manifest.files.map((file) => file.path)]);
  async function visit(directory, prefix = '') {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = within(backup, relative);
      const stat = await fsp.lstat(file);
      if (stat.isDirectory()) {
        if (![...allowed].some((name) => name.startsWith(`${relative}/`))) fail('UNLISTED_FILE', 'Backup contains an unlisted directory.', EXIT.INVALID_BACKUP);
        await visit(file, relative);
      } else if (!stat.isFile() || stat.nlink !== 1 || !allowed.delete(relative)) {
        fail('UNLISTED_FILE', 'Backup contains an unlisted or linked file.', EXIT.INVALID_BACKUP);
      }
    }
  }
  await visit(backup);
  if (allowed.size) fail('MISSING_FILE', 'Backup is missing a listed file.', EXIT.INVALID_BACKUP);
}
async function verifyBackup(backup) {
  backup = assertNoLinks(backup);
  const manifest = readManifest(backup);
  await checkInventory(backup, manifest);
  // 所有文件经哈希边复制边校验；SQLite 只接触该私有副本，WAL 回放不污染原备份。
  const scratchParent = assertNoLinks(os.tmpdir());
  const scratch = await fsp.mkdtemp(path.join(scratchParent, 'riricloud-maintenance-'));
  try {
    await fsp.chmod(scratch, 0o700);
    for (const file of manifest.files) await copyAndHash(within(backup, file.path), within(scratch, file.path), file);
    for (const role of ['main', 'telemetry']) await inspectDatabase(path.join(scratch, 'databases', `${role}.db`), manifest.migrations[role], role === 'main');
    return manifest;
  } finally { await removeOwned(scratch, scratchParent); }
}
async function createBackup(config, destination) {
  requireKey();
  destination = assertNoLinks(destination, true);
  for (const storage of [path.dirname(config.main), path.dirname(config.telemetry), config.dataDir]) {
    if (overlaps(storage, destination) || overlaps(destination, storage)) fail('OVERLAPPING_PATHS', 'Backup destination must be outside live storage.', EXIT.USAGE);
  }
  const lock = acquireLock(config);
  let created = false;
  try {
    const files = await sourceFiles(config);
    const before = await fingerprint(files);
    try { await fsp.mkdir(destination, { mode: 0o700 }); created = true; } catch (error) {
      if (error.code === 'EEXIST') fail('DESTINATION_EXISTS', 'Backup destination must be a new directory.', EXIT.USAGE);
      throw error;
    }
    const metadata = { formatVersion: FORMAT_VERSION, backupId: randomUUID(), createdAt: new Date().toISOString(), applicationVersion: applicationVersion(), migrations: expectedMigrations(), files: [] };
    for (const file of files) metadata.files.push({ path: file.path, ...await copyAndHash(file.source, within(destination, file.path)) });
    if (before !== await fingerprint(await sourceFiles(config))) fail('SOURCE_CHANGED', 'Storage changed during cold backup.', EXIT.INVALID_BACKUP);
    await writeJson(path.join(destination, 'manifest.json'), signManifest(metadata));
    await verifyBackup(destination);
    return { ok: true, code: 'BACKUP_CREATED', backupId: metadata.backupId, files: metadata.files.length, applicationVersion: metadata.applicationVersion };
  } catch (error) {
    if (created) await removeOwned(destination, path.dirname(destination));
    throw error;
  } finally { lock.release(); }
}
module.exports = { createBackup, verifyBackup, checkInventory, sourceFiles };
