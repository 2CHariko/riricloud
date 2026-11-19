'use strict';

// 仅隔离验收加载：Prisma 生成客户端会按生成时路径读 .env，Vite 也会独立查找。
// 在子进程内只隐藏仓库中的 dotenv 文件；不移动工作区文件，也不改变生产入口。
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');
const root = path.resolve(__dirname, '..');
const exists = fs.existsSync;
const read = fs.readFileSync;

function workspaceDotenv(file) {
  if (file instanceof URL) {
    if (file.protocol !== 'file:') return false;
    file = fileURLToPath(file);
  }
  if (Buffer.isBuffer(file)) file = file.toString();
  if (typeof file !== 'string') return false;
  const relative = path.relative(root, path.resolve(file));
  return !path.isAbsolute(relative) && !relative.startsWith('..' + path.sep)
    && /^\.env(?:\.|$)/i.test(path.basename(relative));
}

fs.existsSync = file => !workspaceDotenv(file) && exists(file);
fs.readFileSync = (file, ...args) => {
  if (workspaceDotenv(file)) throw Object.assign(new Error('Dotenv file excluded from isolated E2E'), { code: 'ENOENT' });
  return read(file, ...args);
};
syncBuiltinESMExports();
