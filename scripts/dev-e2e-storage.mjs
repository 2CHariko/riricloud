import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import sqliteUrl from '../apps/server/prisma/sqlite-url.js';

export function resolveE2eStorage({ root, databaseUrl, telemetryDatabaseUrl, dataRoot }) {
  const workspace = resolve(root);
  const canonical = (url, schema) => {
    if (typeof url !== 'string' || /[?\0\r\n]/.test(url)) throw new Error('Ambiguous E2E SQLite URL');
    const value = sqliteUrl.normalizeSqliteUrl(url, schema);
    return process.platform === 'win32' ? value.toLowerCase() : value;
  };
  const main = canonical(databaseUrl, join(workspace, 'apps/server/prisma'));
  const telemetry = canonical(telemetryDatabaseUrl, join(workspace, 'apps/server/prisma/telemetry'));
  if (main === telemetry) throw new Error('E2E databases must use distinct files');
  // 按双库身份固定目录；端口自动顺延、编译目录和重复启动均不改变资源归属。
  const identity = createHash('sha256').update(JSON.stringify([main, telemetry])).digest('hex');
  const instanceDir = resolve(workspace, dataRoot || '.cache/dev-e2e-instances', identity);
  const portable = (value) => value.split(sep).join('/');
  return { identity, instanceDir: portable(instanceDir), dataDir: portable(join(instanceDir, 'data')) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [root, databaseUrl, telemetryDatabaseUrl, dataRoot] = process.argv.slice(2);
    process.stdout.write(resolveE2eStorage({ root, databaseUrl, telemetryDatabaseUrl, dataRoot }).instanceDir);
  } catch {
    console.error('Cannot resolve isolated E2E storage; check the workspace and SQLite URLs.');
    process.exitCode = 1;
  }
}
