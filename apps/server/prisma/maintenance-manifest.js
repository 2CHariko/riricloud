'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { encryptSecret, decryptSecret } = require('./secret-crypto');
const { applicationVersion } = require('./maintenance-config');
const { expectedMigrations } = require('./maintenance-database');
const { safeRelative, assertNoLinks } = require('./maintenance-paths');
const { EXIT, fail } = require('./maintenance-errors');
const FORMAT_VERSION = 1;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function requireKey() {
  if (!(process.env.RIRICLOUD_ENCRYPTION_KEY || process.env.JWT_SECRET || '').trim()) fail('KEY_REQUIRED', 'Supply the existing encryption key through the process environment.', EXIT.KEY_MISMATCH);
}
function signManifest(metadata) {
  requireKey();
  return { ...metadata, keyVerification: encryptSecret(`riricloud-backup-v1:${digest(metadata)}`) };
}
function forbiddenResource(relative) {
  return relative.split('/').some((name) => /^\.env(?:\.|$)/i.test(name) || /(?:^|[._-])(tmp|temp|cache|staging|lock|locks)(?:$|[._-])/i.test(name) || /\.(?:part|partial|tmp|lock|key|pem|pfx|p12)$/i.test(name));
}
function readManifest(backup) {
  const file = path.join(backup, 'manifest.json');
  assertNoLinks(file);
  if (fs.statSync(file).size > MAX_MANIFEST_BYTES) fail('INVALID_MANIFEST', 'Backup manifest exceeds its size limit.', EXIT.INVALID_BACKUP);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('INVALID_MANIFEST', 'Backup manifest is missing or invalid.', EXIT.INVALID_BACKUP); }
  if (!manifest || manifest.formatVersion !== FORMAT_VERSION || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100000 ||
      typeof manifest.keyVerification !== 'string' || !manifest.keyVerification.startsWith('enc:v1:')) {
    fail('INVALID_MANIFEST', 'Backup format is unsupported or incomplete.', EXIT.INVALID_BACKUP);
  }
  const seen = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object') fail('INVALID_MANIFEST', 'Backup file metadata is invalid.', EXIT.INVALID_BACKUP);
    safeRelative(file.path);
    if (!/^(databases\/(main|telemetry)\.db(?:-wal|-shm)?|binaries\/.+)$/.test(file.path) ||
        forbiddenResource(file.path) || seen.has(file.path.toLowerCase()) || !Number.isSafeInteger(file.size) || file.size < 0 ||
        !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.executable !== 'boolean') fail('INVALID_MANIFEST', 'Backup file metadata is invalid or duplicated.', EXIT.INVALID_BACKUP);
    seen.add(file.path.toLowerCase());
  }
  if (!seen.has('databases/main.db') || !seen.has('databases/telemetry.db')) fail('INVALID_MANIFEST', 'Both SQLite databases are required.', EXIT.INVALID_BACKUP);
  const { keyVerification, ...metadata } = manifest;
  requireKey();
  let proof;
  try { proof = decryptSecret(keyVerification); } catch { fail('KEY_MISMATCH', 'The encryption key does not match this backup.', EXIT.KEY_MISMATCH); }
  if (proof !== `riricloud-backup-v1:${digest(metadata)}`) fail('MANIFEST_AUTH_FAILED', 'Backup metadata authentication failed.', EXIT.INVALID_BACKUP);
  if (manifest.applicationVersion !== applicationVersion() || canonical(manifest.migrations) !== canonical(expectedMigrations())) {
    fail('BACKUP_VERSION_MISMATCH', 'Use the application version and migrations that created this backup, then upgrade normally.', EXIT.INCOMPATIBLE);
  }
  return manifest;
}
module.exports = { FORMAT_VERSION, MAX_MANIFEST_BYTES, signManifest, readManifest, forbiddenResource, digest, requireKey };
