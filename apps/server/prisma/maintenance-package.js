'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { serverRoot } = require('./maintenance-config');
const { assertNoLinks, overlaps } = require('./maintenance-paths');
const { fail, EXIT, publicError } = require('./maintenance-errors');
function sanitizePrismaPackage(outputDirectory) {
  const output = assertNoLinks(outputDirectory);
  // 只允许打包输出目录；绝不能清理当前源码数据库或其祖先目录。
  if (overlaps(output, serverRoot) || overlaps(serverRoot, output)) fail('UNSAFE_PACKAGE_TARGET', 'Package cleanup target overlaps the source server.', EXIT.USAGE);
  const prisma = assertNoLinks(path.join(output, 'prisma'));
  let removed = 0;
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = assertNoLinks(path.join(directory, entry.name));
      const relative = path.relative(prisma, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('UNSAFE_PACKAGE_TARGET', 'Package cleanup escaped the package.', EXIT.USAGE);
      if (/\.db(?:$|[-.])/i.test(entry.name) || /\.maintenance\.lock$/i.test(entry.name) || entry.name === '.riricloud-maintenance.lock' || entry.name === '.riricloud-restore.json' || /\.test\.[cm]?js$/.test(entry.name) || entry.name === 'maintenance-test-fixture.js' || /^\.env(?:\.|$)/i.test(entry.name) || /\.env$/i.test(entry.name)) {
        fs.rmSync(target, { recursive: true, force: true }); removed++;
      } else if (entry.isDirectory()) visit(target);
    }
  };
  visit(prisma);
  return { ok: true, removed };
}
module.exports = { sanitizePrismaPackage };
if (require.main === module) {
  try { if (!process.argv[2]) fail('INVALID_ARGUMENTS', 'Package output is required.', EXIT.USAGE); console.log(JSON.stringify(sanitizePrismaPackage(process.argv[2]))); }
  catch (error) { const result = publicError(error); console.error(JSON.stringify(result)); process.exitCode = result.exitCode; }
}
