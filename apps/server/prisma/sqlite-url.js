'use strict';
const path = require('node:path');

// Prisma SQLite 相对路径以 schema 目录为基准；调用方先固定为绝对 URL，
// 避免生成客户端的位置与迁移 CLI 使用不同的解析基准。
function normalizeSqliteUrl(url, schemaDir = __dirname) {
  if (typeof url !== 'string' || !url.startsWith('file:')) throw new Error('Database URL must use SQLite file');
  const queryIndex = url.indexOf('?');
  const file = url.slice(5, queryIndex < 0 ? undefined : queryIndex);
  if (!file) throw new Error('SQLite file path must not be empty');
  const absolute = path.resolve(schemaDir, file).split(path.sep).join('/');
  return `file:${absolute}${queryIndex < 0 ? '' : url.slice(queryIndex)}`;
}

module.exports = { normalizeSqliteUrl };
if (require.main === module) {
  try {
    process.stdout.write(normalizeSqliteUrl(process.argv[2], process.argv[3] || __dirname));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
