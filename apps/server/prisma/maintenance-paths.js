'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline, finished } = require('node:stream/promises');
const { EXIT, fail } = require('./maintenance-errors');

function assertNoLinks(target, allowMissing = false) {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (allowMissing && error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) fail('UNSAFE_PATH', 'Symbolic links and junctions are not allowed.', EXIT.INVALID_BACKUP);
  }
  return absolute;
}
function safeRelative(value) {
  if (typeof value !== 'string' || value.length > 2048 || value.includes(String.fromCharCode(92)) || /[:\0-\x1f]/.test(value) ||
      value.startsWith('/') || value.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part))) {
    fail('UNSAFE_PATH', 'Backup contains an unsafe relative path.', EXIT.INVALID_BACKUP);
  }
  return value;
}
function within(root, relative) {
  safeRelative(relative);
  const target = path.resolve(root, ...relative.split('/'));
  const delta = path.relative(path.resolve(root), target);
  if (!delta || delta.startsWith(`..${path.sep}`) || path.isAbsolute(delta)) fail('UNSAFE_PATH', 'Path escapes the selected directory.', EXIT.INVALID_BACKUP);
  return assertNoLinks(target, true);
}
function overlaps(left, right) {
  const rel = path.relative(path.resolve(left), path.resolve(right));
  return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
async function copyAndHash(source, destination, expected) {
  assertNoLinks(source);
  assertNoLinks(destination, true);
  const before = await fsp.lstat(source);
  if (!before.isFile() || before.nlink !== 1) fail('UNSAFE_FILE', 'Only ordinary non-linked files can be backed up.', EXIT.INVALID_BACKUP);
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const hash = createHash('sha256');
  let size = 0;
  const counter = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; hash.update(chunk); callback(null, chunk); } });
  const input = fs.createReadStream(source, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) });
  const inputDone = finished(input, { cleanup: true }).catch(() => {});
  let output;
  try {
    output = fs.createWriteStream(destination, { flags: 'wx', mode: (before.mode & 0o111) ? 0o700 : 0o600 });
    await pipeline(input, counter, output);
  } finally {
    // 目标打开同步失败时也必须收回源流，不能遗留异步错误和句柄。
    input.destroy();
    output?.destroy();
    await inputDone;
  }
  const after = await fsp.lstat(source);
  const sha256 = hash.digest('hex');
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || size !== before.size) {
    fail('SOURCE_CHANGED', 'A source file changed during the cold copy.', EXIT.INVALID_BACKUP);
  }
  if (expected && (size !== expected.size || sha256 !== expected.sha256)) fail('HASH_MISMATCH', 'Backup file checksum or size does not match.', EXIT.INVALID_BACKUP);
  const handle = await fsp.open(destination, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
  return { size, sha256, executable: Boolean(before.mode & 0o111) };
}
async function fileHash(file) {
  assertNoLinks(file);
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function writeJson(file, value) {
  const handle = await fsp.open(file, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
}
// 仅删除本次独占创建的临时目录；所有调用方必须保留创建成功的所有权标志。
async function removeOwned(directory, parent) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(parent)) fail('UNSAFE_CLEANUP', 'Cleanup target is outside its parent.');
  assertNoLinks(resolved, true);
  await fsp.rm(resolved, { recursive: true, force: true });
}
module.exports = { assertNoLinks, safeRelative, within, overlaps, copyAndHash, fileHash, writeJson, removeOwned };
