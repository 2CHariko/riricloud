'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { EXIT, fail } = require('./maintenance-errors');
const { acquireLock, RESTORE_MARKER } = require('./maintenance-lock');
const { verifyBackup } = require('./maintenance-backup');
const { inspectDatabase } = require('./maintenance-database');
const { digest } = require('./maintenance-manifest');
const { assertNoLinks, within, overlaps, copyAndHash, writeJson } = require('./maintenance-paths');

function restoredPath(relative) {
  return relative.replace(/^databases\/main\.db/, 'riri.db').replace(/^databases\/telemetry\.db/, 'telemetry.db');
}
async function restoreBackup(backup, destination) {
  backup = assertNoLinks(backup);
  destination = assertNoLinks(destination, true);
  if (overlaps(backup, destination) || overlaps(destination, backup)) fail('OVERLAPPING_PATHS', 'Restore destination and backup must not overlap.', EXIT.USAGE);
  const manifest = await verifyBackup(backup);
  try { await fsp.mkdir(destination, { mode: 0o700 }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!(await fsp.stat(destination)).isDirectory() || (await fsp.readdir(destination)).length) fail('DESTINATION_NOT_EMPTY', 'Restore requires a new or empty directory; existing storage is never overwritten.', EXIT.USAGE);
  }
  const marker = path.join(destination, RESTORE_MARKER);
  // 占有空目录并先标记为不可启动，任何中途退出都不能留下可启动的半恢复目录。
  await writeJson(marker, { formatVersion: 1, status: 'incomplete', isolated: true, backupId: manifest.backupId });
  if ((await fsp.readdir(destination)).some((name) => name !== RESTORE_MARKER)) fail('DESTINATION_CHANGED', 'Restore destination changed while being reserved.', EXIT.INVALID_BACKUP);
  const config = { main: path.join(destination, 'riri.db'), telemetry: path.join(destination, 'telemetry.db'), dataDir: destination };
  const lock = acquireLock(config);
  try {
    for (const file of manifest.files) {
      const target = within(destination, restoredPath(file.path));
      await copyAndHash(within(backup, file.path), target, file);
      await fsp.chmod(target, file.executable ? 0o700 : 0o600);
    }
    for (const role of ['main', 'telemetry']) await inspectDatabase(config[role], manifest.migrations[role], role === 'main');
    const ready = { formatVersion: 1, status: 'ready', isolated: true, backupId: manifest.backupId, applicationVersion: manifest.applicationVersion, manifestSha256: digest(manifest), verifiedAt: new Date().toISOString() };
    const pending = `${marker}.tmp`;
    await writeJson(pending, ready);
    await fsp.rename(pending, marker);
    return { ok: true, code: 'RESTORE_READY', backupId: manifest.backupId, isolated: true, layout: { database: 'riri.db', telemetryDatabase: 'telemetry.db', dataDir: '.' } };
  } finally { lock.release(); }
}
module.exports = { restoreBackup, restoredPath };
