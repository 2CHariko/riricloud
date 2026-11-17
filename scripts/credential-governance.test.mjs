import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
async function productionFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...await productionFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !/[.](spec|test)[.]ts$/.test(entry.name) && !entry.name.includes('.native-fixture')) files.push(path);
  }
  return files;
}
test('公开代理认证不得恢复全局固定测速或中继身份', async () => {
  const forbiddenNames = /INTERNAL_(?:SPEEDTEST|RELAY_TRANSIT)_(?:UUID|SECRET|EMAIL)/;
  const forbiddenValues = [/__riricloud_(?:speedtest_probe|relay_transit)__/, /riricloud-internal-(?:speedtest|relay-transit)-secret/, /00000000-0000-4000-8000-00000000000[23]/];
  const violations = [];
  for (const path of await productionFiles(join(root, 'apps/server/src'))) {
    const text = await readFile(path, 'utf8');
    if (forbiddenNames.test(text) || forbiddenValues.some(pattern => pattern.test(text))) violations.push(relative(root, path));
  }
  assert.deepEqual(violations, [], '生产代码不能包含全局固定代理认证身份；负向测试夹具不参与扫描');
});
