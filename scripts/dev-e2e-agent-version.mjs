import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveE2eAgentVersion({ agentVersion, resourceVersion, buildVersion, declaredVersion }) {
  const explicitAgent = agentVersion?.trim() ?? '';
  const explicitResource = resourceVersion?.trim() ?? '';
  if (explicitAgent && explicitResource && explicitAgent !== explicitResource) {
    throw new Error('E2E_AGENT_VERSION 与 E2E_RESOURCE_VERSION 不一致；联调构建和资源标签必须使用同一版本');
  }
  return explicitAgent || explicitResource || declaredVersion?.trim() || buildVersion?.trim() || '';
}

async function main() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  let declaredVersion = '';
  try {
    declaredVersion = await readFile(resolve(root, 'apps/agent/VERSION'), 'utf8');
  } catch {
    const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    declaredVersion = packageJson.version;
  }

  const version = resolveE2eAgentVersion({
    agentVersion: process.env.E2E_AGENT_VERSION,
    resourceVersion: process.env.E2E_RESOURCE_VERSION,
    buildVersion: process.env.RIRICLOUD_VERSION,
    declaredVersion
  });
  if (!version) throw new Error('无法确定 E2E Agent 版本；请设置 E2E_AGENT_VERSION');
  process.stdout.write(version);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
