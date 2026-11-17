#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadEnvironment, resolveConfig, configureDatabaseEnvironment, serverRoot } = require('./maintenance-config');
const { acquireLock, assertStartAllowed } = require('./maintenance-lock');
const { publicError, fail, EXIT } = require('./maintenance-errors');
const { assertNoLinks } = require('./maintenance-paths');

function prepareDatabaseFiles(config) {
  // 部分 Windows Prisma 引擎无法创建不存在的 SQLite 文件；持锁后只用 wx 初始化空文件。
  for (const file of [config.main, config.telemetry]) {
    assertNoLinks(file, true);
    try { const descriptor = fs.openSync(file, 'wx', 0o600); fs.closeSync(descriptor); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1) fail('UNSAFE_DATABASE_FILE', 'Database path is not an ordinary unlinked file.', EXIT.DATABASE);
    }
  }
}
function parseStartArguments(args = []) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--seed-if-missing' && !options.seedIfMissing) options.seedIfMissing = true;
    else if (args[i] === '--stop-file' && args[i + 1] && !options.stopFile) options.stopFile = path.resolve(args[++i]);
    else if (args[i] === '--build-dir' && args[i + 1] && !options.buildDir) options.buildDir = path.resolve(args[++i]);
    else fail('INVALID_ARGUMENTS', 'Unsupported startup option.', EXIT.USAGE);
  }
  return options;
}
async function start(options = {}) {
  loadEnvironment();
  process.chdir(serverRoot);
  const config = resolveConfig();
  configureDatabaseEnvironment(config);
  const lock = acquireLock(config, { role: 'startup' });
  let child;
  let safeToRelease = true;
  let currentSession;
  let stopTimer;
  let stopping = false;
  const stop = (signal) => { stopping = true; if (child && child.exitCode === null && !currentSession?.requestShutdown()) child.kill(signal); };
  const terminate = () => stop('SIGTERM');
  const interrupt = () => stop('SIGINT');
  process.on('SIGTERM', terminate);
  process.on('SIGINT', interrupt);
  async function run(file, args = [], application = false) {
    if (stopping) fail('START_CANCELLED', 'Master startup was cancelled.', 130);
    const result = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [file, ...args], { cwd: serverRoot, env: lock.childEnvironment, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
      const session = lock.bindChild(child);
      currentSession = session;
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        session.detach();
        if (signal || code !== 0 || (application && !session.closed)) safeToRelease = false;
        resolve(signal || (application && !session.closed) ? 1 : code ?? 1);
      });
    });
    if (result !== 0) fail('START_FAILED', 'A protected startup step failed; inspect retained storage locks.', EXIT.IO);
  }
  try {
    if (options.stopFile) {
      assertNoLinks(options.stopFile, true);
      if (fs.existsSync(options.stopFile)) fail('START_CANCELLED', 'Stop request already exists.', 130);
      stopTimer = setInterval(() => { if (fs.existsSync(options.stopFile)) stop('SIGTERM'); }, 200);
      stopTimer.unref();
    }
    assertStartAllowed(config);
    require('./admin-bootstrap').validateJwtSecret(process.env.JWT_SECRET);
    const autoSeed = /^(true|1|yes|on)$/i.test(process.env.AUTO_SEED || 'false') || (options.seedIfMissing && !fs.existsSync(config.main));
    if (autoSeed && (process.env.NODE_ENV === 'production' || process.env.RIRICLOUD_ENV === 'production')) fail('UNSAFE_SEED', 'Demo seeding is disabled in production.', EXIT.USAGE);
    const buildDir = options.buildDir || path.join(serverRoot, 'dist');
    const entry = ['main.js', 'src/main.js'].map(name => path.join(buildDir, name)).find(file => fs.existsSync(file));
    if (!entry) fail('MASTER_BUILD_MISSING', 'Build the Master application before starting it.', EXIT.IO);
    assertNoLinks(entry);
    prepareDatabaseFiles(config);
    await run(path.join(__dirname, 'deploy-databases.js'));
    await run(path.join(__dirname, 'bootstrap-admin.js'));
    if (autoSeed) await run(path.join(__dirname, 'seed.js'));
    await run(entry, [], true);
  } finally {
    // 只有最后一个子进程退出后才解锁，迁移/引导/运行共享一个连续生命周期。
    clearInterval(stopTimer);
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', interrupt);
    if (safeToRelease) lock.release();
  }
}
module.exports = { start, prepareDatabaseFiles, parseStartArguments };
if (require.main === module) Promise.resolve().then(() => start(parseStartArguments(process.argv.slice(2)))).catch((error) => { const result = publicError(error); console.error(JSON.stringify(result)); process.exitCode = result.exitCode; });
