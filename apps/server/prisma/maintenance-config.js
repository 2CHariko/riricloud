'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { normalizeSqliteUrl } = require('./sqlite-url');
const { EXIT, fail } = require('./maintenance-errors');
const serverRoot = path.resolve(__dirname, '..');

function loadEnvironment() {
  const file = path.join(serverRoot, '.env');
  if (!fs.existsSync(file)) return;
  // 与 Nest ConfigModule 使用同一解析器，不执行 shell，不覆盖显式环境变量。
  const { parse } = createRequire(require.resolve('@nestjs/config'))('dotenv');
  const parsed = parse(fs.readFileSync(file));
  for (const [key, value] of Object.entries(parsed)) if (process.env[key] === undefined) process.env[key] = value;
}
function sqlitePath(value, schemaDir) {
  try {
    if (typeof value !== 'string' || /[\0\r\n?#]/.test(value)) throw new Error();
    return path.resolve(normalizeSqliteUrl(value, schemaDir).slice(5));
  } catch { fail('INVALID_DATABASE_PATH', 'Use an unambiguous SQLite file URL without query parameters.', EXIT.USAGE); }
}
function resolveConfig(options = {}, env = process.env) {
  const mainUrl = options.database || env.DATABASE_URL || 'file:./dev.db';
  const telemetryUrl = options.telemetryDatabase || env.TELEMETRY_DATABASE_URL ||
    (mainUrl.includes('/riri.db') ? mainUrl.replace('/riri.db', '/telemetry.db') :
      mainUrl.endsWith('dev.db') ? mainUrl.replace('dev.db', 'dev-telemetry.db') : 'file:./dev-telemetry.db');
  const main = sqlitePath(mainUrl, __dirname);
  const telemetry = sqlitePath(telemetryUrl, path.join(__dirname, 'telemetry'));
  if (main === telemetry) fail('DATABASE_PATH_COLLISION', 'Business and telemetry databases must be distinct.', EXIT.USAGE);
  const dataDir = path.resolve(options.dataDir || env.RIRICLOUD_DATA_DIR || env.MASTER_DATA_DIR || path.join(serverRoot, 'data'));
  return { main, telemetry, dataDir, binaries: path.join(dataDir, 'binaries'), serverRoot };
}
function configureDatabaseEnvironment(config) {
  process.env.DATABASE_URL = `file:${config.main.split(path.sep).join('/')}`;
  process.env.TELEMETRY_DATABASE_URL = `file:${config.telemetry.split(path.sep).join('/')}`;
  process.env.RIRICLOUD_DATA_DIR = config.dataDir;
}
function applicationVersion() {
  for (const candidate of [path.join(serverRoot, 'package.json'), path.resolve(serverRoot, '../../package.json')]) {
    const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    if (typeof pkg.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(pkg.version)) return pkg.version;
  }
  fail('VERSION_UNAVAILABLE', 'Application version metadata is missing.', EXIT.INCOMPATIBLE);
}
module.exports = { loadEnvironment, resolveConfig, configureDatabaseEnvironment, applicationVersion, serverRoot };
