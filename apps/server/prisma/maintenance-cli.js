#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { loadEnvironment, resolveConfig } = require('./maintenance-config');
const { createBackup, verifyBackup } = require('./maintenance-backup');
const { restoreBackup } = require('./maintenance-restore');
const { EXIT, fail, publicError } = require('./maintenance-errors');
const HELP = {
  commands: {
    'backup:create': '--destination <new-directory> [--database file:<path>] [--telemetry-database file:<path>] [--data-dir <path>]',
    'backup:verify': '--backup <backup-directory>',
    'backup:restore': '--backup <backup-directory> --destination <new-or-empty-directory>'
  },
  encryption: 'Use the existing RIRICLOUD_ENCRYPTION_KEY or JWT_SECRET from the environment; keys are never accepted in argv.',
  restore: 'Offline validation only. Restored storage stays isolated until a maintainer explicitly removes .riricloud-restore.json before a planned deployment.',
  exitCodes: { success: 0, usage: 2, locked: 3, invalidBackup: 4, incompatible: 5, encryptionKey: 6, io: 7, database: 8, isolation: 9 }
};
function parseArguments(args) {
  if (args.length === 0 || args[0] === '--help') return { help: true };
  const command = args[0];
  if (!Object.hasOwn(HELP.commands, command)) fail('INVALID_COMMAND', 'Expected backup:create, backup:verify or backup:restore.', EXIT.USAGE);
  const names = { '--destination': 'destination', '--backup': 'backup', '--database': 'database', '--telemetry-database': 'telemetryDatabase', '--data-dir': 'dataDir' };
  const options = {};
  for (let index = 1; index < args.length; index++) {
    if (args[index] === '--') continue;
    if (args[index] === '--json') continue;
    const name = names[args[index]];
    const value = args[++index];
    if (!name || !value || value.startsWith('--') || options[name] !== undefined) fail('INVALID_ARGUMENTS', 'Unknown, duplicate or incomplete maintenance option.', EXIT.USAGE);
    options[name] = value;
  }
  const required = command === 'backup:create' ? ['destination'] : command === 'backup:verify' ? ['backup'] : ['backup', 'destination'];
  if (required.some((name) => !options[name])) fail('MISSING_ARGUMENTS', 'Required maintenance path option is missing; use --help.', EXIT.USAGE);
  if (command !== 'backup:create' && ['database', 'telemetryDatabase', 'dataDir'].some((name) => options[name])) fail('INVALID_ARGUMENTS', 'Database options apply only to backup:create.', EXIT.USAGE);
  if (command === 'backup:create' && options.backup || command === 'backup:verify' && options.destination) fail('INVALID_ARGUMENTS', 'This option does not apply to the command.', EXIT.USAGE);
  return { command, options };
}
async function run(args = process.argv.slice(2)) {
  try {
    const parsed = parseArguments(args);
    if (parsed.help) return { ok: true, code: 'HELP', ...HELP };
    loadEnvironment();
    const { command, options } = parsed;
    if (command === 'backup:create') return await createBackup(resolveConfig(options), path.resolve(options.destination));
    if (command === 'backup:restore') return await restoreBackup(path.resolve(options.backup), path.resolve(options.destination));
    const manifest = await verifyBackup(path.resolve(options.backup));
    return { ok: true, code: 'BACKUP_VERIFIED', backupId: manifest.backupId, files: manifest.files.length, applicationVersion: manifest.applicationVersion };
  } catch (error) { return publicError(error); }
}
module.exports = { run, parseArguments };
if (require.main === module) run().then((result) => { process.stdout.write(`${JSON.stringify(result)}\n`); process.exitCode = result.exitCode || 0; });
