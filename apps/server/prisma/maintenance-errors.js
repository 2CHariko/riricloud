'use strict';

const EXIT = Object.freeze({ USAGE: 2, LOCKED: 3, INVALID_BACKUP: 4, INCOMPATIBLE: 5, KEY_MISMATCH: 6, IO: 7, DATABASE: 8, ISOLATED: 9 });
class MaintenanceError extends Error {
  constructor(code, message, exitCode = EXIT.IO) {
    super(message);
    this.name = 'MaintenanceError';
    this.code = code;
    this.exitCode = exitCode;
  }
}
function fail(code, message, exitCode) { throw new MaintenanceError(code, message, exitCode); }
function publicError(error) {
  if (error instanceof MaintenanceError) return { ok: false, code: error.code, message: error.message, exitCode: error.exitCode };
  // 文件系统、Prisma 与密码学异常可能带路径、SQL、密钥；只返回稳定分类。
  return { ok: false, code: 'IO_FAILED', message: 'Maintenance operation failed; no ready result was published.', exitCode: EXIT.IO };
}
module.exports = { EXIT, MaintenanceError, fail, publicError };
