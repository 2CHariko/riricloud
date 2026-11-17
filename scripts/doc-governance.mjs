#!/usr/bin/env node

/**
 * @file doc-governance.mjs
 * @description RiriCloud 文档治理与规划归档机械约束脚本
 * 
 * 功能：
 * 1. check: 校验 docs/ 根目录白名单、docs/plans/ 进行中规划（100% 打钩阻断）、docs/plans/archive/ 命名与元数据、索引有效性
 * 2. archive <file>: 一键归档指定规划（自动加日期前缀、改状态、更新 archived_at、移动目录、刷新 README 索引）
 * 3. new <name>: 一键从标准模板生成新规划并注册至 docs/plans/README.md
 * 4. sync: 自动扫描并同步 docs/plans/README.md 的进行中与归档表格
 */

import { execFileSync, execSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DOCS_DIR = path.resolve(ROOT_DIR, 'docs');
const PLANS_DIR = path.resolve(DOCS_DIR, 'plans');
const ARCHIVE_DIR = path.resolve(PLANS_DIR, 'archive');
const PLANS_README = path.resolve(PLANS_DIR, 'README.md');

// 允许在 docs/ 根目录直接存在的白名单文件与目录
const ALLOWED_ROOT_DOCS = new Set([
  'README.md',
  'ARCHITECTURE.md',
  'TECH_STACK.md',
  'DATA_MODELS.md',
  'API_AND_PROTOCOLS.md',
  'FRONTEND_UI_GUIDELINES.md',
  'DEPLOYMENT_GUIDE.md',
  'ROADMAP.md',
  'VERSIONING.md',
  'GIT_WORKFLOW.md',
  'CODE_REVIEW.md',
  'PROJECT_CONSTRAINTS.md',
  'VISUAL_VERIFICATION.md',
]);

const ALLOWED_ROOT_DIRS = new Set([
  'plans',
  'assets',
]);

/**
 * 获取今天的 YYYY-MM-DD 格式日期
 */
function getTodayString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 简易 YAML Frontmatter 解析
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) {
    return { data: {}, body: content, raw: '' };
  }

  const raw = match[1];
  const body = content.slice(match[0].length);
  const data = {};

  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let val = trimmed.slice(colonIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    data[key] = val;
  }

  return { data, body, raw };
}

/**
 * 简易 YAML Frontmatter 字符串化
 */
function stringifyFrontmatter(data, body) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    const escaped = typeof v === 'string' && (v.includes(':') || v.includes('#') || v.includes(' ') || v.includes('-')) 
      ? `"${v.replace(/"/g, '\\"')}"` 
      : v;
    lines.push(`${k}: ${escaped}`);
  }
  lines.push('---');
  lines.push('');
  return lines.join('\n') + body.replace(/^\r?\n+/, '');
}

/**
 * 统计 Markdown 中的复选框
 */
function countCheckboxes(content) {
  const uncheckedMatches = content.match(/^\s*-\s*\[ \]/gm) || [];
  const checkedMatches = content.match(/^\s*-\s*\[[xX]\]/gm) || [];
  const total = uncheckedMatches.length + checkedMatches.length;
  return {
    total,
    checked: checkedMatches.length,
    unchecked: uncheckedMatches.length,
  };
}

/**
 * 确保目录存在
 */
function ensureDirs() {
  if (!fs.existsSync(PLANS_DIR)) fs.mkdirSync(PLANS_DIR, { recursive: true });
  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

/**
 * 重新扫描并同步 docs/plans/README.md 索引表格
 */
function syncIndex() {
  ensureDirs();

  // 读取进行中 plans
  const activeFiles = fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.md') && f !== 'README.md');
  const activeEntries = [];

  for (const file of activeFiles) {
    const fullPath = path.join(PLANS_DIR, file);
    const content = fs.readFileSync(fullPath, 'utf8');
    const { data } = parseFrontmatter(content);
    const counts = countCheckboxes(content);
    const progress = counts.total > 0 ? `${counts.checked}/${counts.total} (${Math.round((counts.checked / counts.total) * 100)}%)` : '—';
    activeEntries.push({
      file,
      title: data.title || file.replace(/\.md$/, ''),
      targetVersion: data.target_version || '—',
      createdAt: data.created_at || '—',
      progress,
    });
  }

  // 读取已归档 plans
  const archiveFiles = fs.existsSync(ARCHIVE_DIR) 
    ? fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.md')).sort().reverse() 
    : [];
  const archiveEntries = [];

  for (const file of archiveFiles) {
    const fullPath = path.join(ARCHIVE_DIR, file);
    const content = fs.readFileSync(fullPath, 'utf8');
    const { data } = parseFrontmatter(content);
    archiveEntries.push({
      file,
      title: data.title || file.replace(/\.md$/, ''),
      targetVersion: data.target_version || '—',
      archivedAt: data.archived_at || data.created_at || file.slice(0, 10),
      pr: data.pr || data.pr_or_commits || '—',
    });
  }

  const activeTableRows = activeEntries.length > 0
    ? activeEntries.map(e => `| [${e.title}](./${e.file}) | \`${e.targetVersion}\` | ${e.createdAt} | ${e.progress} |`).join('\n')
    : '| *(暂无进行中规划，使用 `pnpm plan:new <name>` 创建)* | — | — | — |';

  const archiveTableRows = archiveEntries.length > 0
    ? archiveEntries.map(e => `| [${e.title}](./archive/${e.file}) | \`${e.targetVersion}\` | ${e.archivedAt} | ${e.pr} |`).join('\n')
    : '| *(暂无已归档规划)* | — | — | — |';

  const readmeContent = `# 规划与任务台账 (Plans & Archival Ledger)

本文档是 **RiriCloud** 项目全部中短期任务规划、架构改造清单与历史实施记录的总台账。

---

## 📌 规划管理生命周期与机械约束

1. **新建规划**：通过 \`pnpm plan:new <name>\` 在 \`docs/plans/\` 下创建标准模板，并在本文档进行中表格登记。
2. **执行推进**：在对应 \`docs/plans/<name>.md\` 中维护任务勾选框（\`- [ ]\` -> \`- [x]\`）。
3. **完成归档（机械硬约束）**：
   - 门禁脚本 \`pnpm gate:docs\` 将扫描进行中文档：**若某文档内所有任务项均已勾选（100% \`[x]\` 且无 \`[ ]\`），门禁将直接阻断报错**，强制要求归档。
   - 执行 \`pnpm plan:archive <filename>\` 一键自动打上归档时间戳、更改状态为 \`completed\`、追加 \`YYYY-MM-DD-\` 前缀移入 \`docs/plans/archive/\`，并自动刷新本文档台账。
4. **根目录保护**：禁止在 \`docs/\` 根目录随意堆放散乱的 TODO / 计划文件，所有计划类文档必须收敛至本目录。

---

## 🚀 进行中规划 (Active Plans)

| 规划名称 | 目标版本 | 创建日期 | 任务进度 |
| :--- | :--- | :--- | :--- |
${activeTableRows}

---

## 📦 历史归档规划 (Archived Plans)

| 归档规划名称 | 达成版本 | 归档日期 | 关联 PR / 提交 |
| :--- | :--- | :--- | :--- |
${archiveTableRows}
`;

  fs.writeFileSync(PLANS_README, readmeContent, 'utf8');
  console.log(`[doc-governance] 索引台账已同步: docs/plans/README.md`);
}

// 只保护现行规范的少量关键契约；历史路线图与 plans/archive 不参与旧表述扫描。
const POLICY_FILES = [
  'AGENTS.md', 'README.md', 'docs/PROJECT_CONSTRAINTS.md',
  'docs/GIT_WORKFLOW.md', 'docs/CODE_REVIEW.md', 'docs/VERSIONING.md',
];
const REQUIRED_GATES = ['version', 'docs', 'i18n', 'server', 'web', 'agent'].map(name => 'gate:' + name);

function readPolicyFile(file, errors) {
  try {
    return fs.readFileSync(path.join(ROOT_DIR, file), 'utf8');
  } catch {
    errors.push('[规范文件缺失] ' + file + ' 无法读取。');
    return '';
  }
}

function policySection(content, heading) {
  const match = content.match(new RegExp('^##\\s+[^\\r\\n]*' + heading + '[^\\r\\n]*\\r?$', 'm'));
  return match ? content.slice(match.index + match[0].length).split(/^##\s+/m)[0] : '';
}

/**
 * 表格只核对四行契约标识，不锁定说明文案、具体发行版本或整篇 Markdown。
 */
function checkVersionPolicy(documents, errors) {
  const obsoletePolicies = [
    /三应用共用[^\n。]*统一版本号/,
    /全局唯一真实源|单仓唯一版本源|统一版本号策略/,
    /核心代码变更强制递增|PR\s*级连续递增/,
    /核心代码变更[^\n。]*必须执行[^\n。]*pnpm\s+bump/,
    /不使用[^\n。]*release\s*分支/i,
  ];
  for (const [file, content] of documents) {
    for (const pattern of obsoletePolicies) {
      if (pattern.test(content)) errors.push('[版本模式漂移] ' + file + ' 仍含已废弃的统一版本/每 PR bump/禁止 release 分支规则；请遵循双轨 Unreleased + Release PR 流程。');
    }
  }

  const table = policySection(documents.get('docs/VERSIONING.md'), '双轨');
  const rows = table.split(/\r?\n/).filter(line => /^\s*\|/.test(line)).map(line => line.split('|').slice(1, -1));
  const contract = [
    ['版本源', ['package.json'], ['apps/agent/VERSION']],
    ['日志缓冲', ['CHANGELOG.md', '[Unreleased]'], ['apps/agent/CHANGELOG.md', '[Unreleased]']],
    ['自增命令', ['pnpm bump'], ['pnpm bump:agent']],
    ['发布 Tag', ['vX.Y.Z'], ['agent-vA.B.C']],
  ];
  for (const [label, master, agent] of contract) {
    const row = rows.find(cells => cells[0].replace(/[*\s]/g, '') === label.replace(/\s/g, ''));
    const codes = cell => [...(cell || '').matchAll(/\x60([^\x60]+)\x60/g)].map(match => match[1].trim());
    if (!row || row.length !== 3 || !master.every(value => codes(row[1]).includes(value)) || !agent.every(value => codes(row[2]).includes(value))) {
      errors.push('[双轨版本契约] docs/VERSIONING.md 的“' + label + '”行须分别描述 Master (' + master.join(', ') + ') 与 Agent (' + agent.join(', ') + ')。');
    }
  }
}

/**
 * 门禁集合从实际总入口读取，清单按章节核对，不能用别处提及掩盖遗漏。
 */
function checkGatePolicy(documents, errors) {
  let scripts;
  try {
    scripts = JSON.parse(readPolicyFile('package.json', errors)).scripts || {};
  } catch {
    errors.push('[门禁集合漂移] package.json 无法解析。');
    return;
  }
  const actual = [...new Set([...String(scripts.gate || '').matchAll(/\bpnpm\s+(?:run\s+)?(gate:[\w-]+|test:scripts)/g)].map(match => match[1]))];
  const missing = REQUIRED_GATES.filter(gate => !actual.includes(gate));
  const undefinedGates = actual.filter(gate => typeof scripts[gate] !== 'string' || !scripts[gate].trim());
  if (missing.length || undefinedGates.length) {
    errors.push('[门禁集合漂移] package.json scripts.gate 缺少必要门禁或引用未定义命令：' + [...missing, ...undefinedGates].join(', '));
  }

  const catalogs = new Map([
    ['AGENTS.md', policySection(documents.get('AGENTS.md'), '常用命令')],
    ['README.md', policySection(documents.get('README.md'), '质量门禁')],
    ['docs/CODE_REVIEW.md', policySection(documents.get('docs/CODE_REVIEW.md'), '质量门禁')],
    ['docs/GIT_WORKFLOW.md', documents.get('docs/GIT_WORKFLOW.md').match(/^\|[^\r\n]*合并前门禁[^\r\n]*\|\s*$/m)?.[0] || ''],
  ]);
  for (const [file, content] of catalogs) {
    const declared = new Set(content.match(/\b(?:gate:[\w-]+|test:scripts)/g) || []);
    const absent = actual.filter(gate => !declared.has(gate));
    const extra = [...declared].filter(gate => !actual.includes(gate));
    if (!content || absent.length || extra.length) {
      errors.push('[门禁集合漂移] ' + file + ' 门禁清单与 package.json scripts.gate 不一致（缺少：' + (absent.join(', ') || '无') + '；多余：' + (extra.join(', ') || '无') + '）。');
    }
  }
  for (const [file, content] of documents) {
    if (/五(?:合一|项|端)?(?:质量)?门禁/.test(content)) {
      errors.push('[门禁集合漂移] ' + file + ' 仍使用五门禁表述，请同步包含 i18n 的六项门禁。');
    }
  }
  const webRow = catalogs.get('docs/CODE_REVIEW.md').match(/^\|[^\r\n]*apps\/web[^\r\n]*\|\s*$/m)?.[0] || '';
  if (/\btest\b/.test(scripts['gate:web'] || '') && !/\btest\b/.test(webRow)) {
    errors.push('[Web 测试契约] docs/CODE_REVIEW.md 的 apps/web 门禁须包含 node --test 回归测试。');
  }
}

function checkPolicyConsistency(errors) {
  const documents = new Map(POLICY_FILES.map(file => [file, readPolicyFile(file, errors)]));
  checkVersionPolicy(documents, errors);
  checkGatePolicy(documents, errors);
}

/**
 * 校验逻辑 (check)
 */
function runCheck() {
  ensureDirs();
  console.log('[doc-governance] 正在执行文档治理与规划归档机械约束校验...');
  const errors = [];
  const warnings = [];

  // 1. 检查 docs/ 根目录文件白名单
  if (fs.existsSync(DOCS_DIR)) {
    const rootItems = fs.readdirSync(DOCS_DIR, { withFileTypes: true });
    for (const item of rootItems) {
      if (item.isDirectory()) {
        if (!ALLOWED_ROOT_DIRS.has(item.name)) {
          errors.push(`[docs 根目录违规] 发现未声明的子目录: docs/${item.name}/。如需新增目录请在 doc-governance 白名单登记。`);
        }
      } else if (item.isFile()) {
        if (!ALLOWED_ROOT_DOCS.has(item.name)) {
          errors.push(`[docs 根目录违规] 发现未白名单的散落文档: docs/${item.name}。所有计划/TODO类文档必须存放在 docs/plans/ 或 docs/plans/archive/ 中。`);
        }
      }
    }
  }

  // 2. 检查 docs/plans/ 进行中文档
  if (fs.existsSync(PLANS_DIR)) {
    const planFiles = fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.md') && f !== 'README.md');
    for (const file of planFiles) {
      const fullPath = path.join(PLANS_DIR, file);
      const content = fs.readFileSync(fullPath, 'utf8');
      const { data } = parseFrontmatter(content);

      // 命名检查：kebab-case
      if (!/^[a-z0-9-]+(\.md)$/.test(file)) {
        errors.push(`[plans 命名违规] docs/plans/${file} 命名不符合 kebab-case 规范 (如 my-feature-plan.md)。`);
      }

      // 元数据检查
      if (!data.title) {
        errors.push(`[plans 元数据缺失] docs/plans/${file} 缺少 Frontmatter title 字段。`);
      }
      if (data.type !== 'plan') {
        errors.push(`[plans 元数据违规] docs/plans/${file} Frontmatter type 必须为 "plan"。`);
      }
      if (data.status !== 'active') {
        errors.push(`[plans 状态违规] docs/plans/${file} 处于进行中目录，但 status 为 "${data.status}"（应为 "active"）。`);
      }
      if (!data.created_at || !/^\d{4}-\d{2}-\d{2}$/.test(data.created_at)) {
        errors.push(`[plans 元数据违规] docs/plans/${file} created_at 格式必须为 YYYY-MM-DD。`);
      }

      // 复选框与 100% 完成度机械阻断检查
      const counts = countCheckboxes(content);
      if (counts.total > 0 && counts.unchecked === 0) {
        errors.push(
          `[机械约束触发 - 强制归档] docs/plans/${file} 内的所有任务 (${counts.checked}/${counts.total}) 已 100% 全部完成！\n` +
          `  👉 已完成的规划禁止滞留在进行中目录。请执行归档命令：pnpm plan:archive ${file}`
        );
      } else if (counts.total === 0) {
        warnings.push(`[plans 缺少任务] docs/plans/${file} 未发现复选框清单 (- [ ] 或 - [x])。`);
      }
    }
  }

  // 3. 检查 docs/plans/archive/ 归档文档
  if (fs.existsSync(ARCHIVE_DIR)) {
    const archiveFiles = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.md'));
    for (const file of archiveFiles) {
      const fullPath = path.join(ARCHIVE_DIR, file);
      const content = fs.readFileSync(fullPath, 'utf8');
      const { data } = parseFrontmatter(content);

      // 归档命名检查：YYYY-MM-DD-*.md
      if (!/^\d{4}-\d{2}-\d{2}-.+\.md$/.test(file)) {
        errors.push(`[archive 命名违规] docs/plans/archive/${file} 必须以 YYYY-MM-DD- 日期前缀开头 (如 2026-08-31-my-plan.md)。`);
      }

      // 元数据检查
      if (!data.title) {
        errors.push(`[archive 元数据缺失] docs/plans/archive/${file} 缺少 Frontmatter title 字段。`);
      }
      if (data.type !== 'plan') {
        errors.push(`[archive 元数据违规] docs/plans/archive/${file} Frontmatter type 必须为 "plan"。`);
      }
      if (data.status !== 'completed' && data.status !== 'archived') {
        errors.push(`[archive 状态违规] docs/plans/archive/${file} status 必须为 "completed" 或 "archived"（当前为 "${data.status}"）。`);
      }
      if (!data.archived_at || !/^\d{4}-\d{2}-\d{2}$/.test(data.archived_at)) {
        errors.push(`[archive 元数据违规] docs/plans/archive/${file} 缺少有效的 archived_at 日期 (YYYY-MM-DD)。`);
      }

      // 检查归档文件中是否有残留未打勾的任务
      const counts = countCheckboxes(content);
      if (counts.unchecked > 0) {
        errors.push(`[archive 未完结任务] docs/plans/archive/${file} 仍有 ${counts.unchecked} 项未完成任务 (- [ ])。归档文档必须全部完成或关闭。`);
      }
    }
  }

  // 4. 检查 docs/plans/README.md 索引文件是否存在
  if (!fs.existsSync(PLANS_README)) {
    errors.push(`[索引缺失] docs/plans/README.md 索引台账不存在，请运行 pnpm plan:sync 生成。`);
  }

  // 5. 关键规范始终检查，不能通过代码-文档同步豁免绕过。
  checkPolicyConsistency(errors);

  // 6. 校验代码-文档联动同步规则 (Coupled Doc-Code Governance)
  checkDocCodeCoupling(errors, warnings);

  // 输出警告
  for (const w of warnings) {
    console.warn(`⚠️  ${w}`);
  }

  // 输出错误并判定通过
  if (errors.length > 0) {
    console.error('\n❌ 文档治理门禁检查失败，发现以下违规问题：\n');
    for (const e of errors) {
      console.error(`  ✖ ${e}\n`);
    }
    process.exit(1);
  }

  console.log('✅ [doc-governance] 文档治理门禁校验全绿！所有规划、归档与代码文档联动符合规范。');
}

/**
 * 比较真实元数据，避免 scripts 变更旁边的 diff 上下文误触发依赖联动。
 */
export function dependencyMetadataChanged(before, after) {
  return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'engines', 'packageManager']
    .some(field => !isDeepStrictEqual(before[field], after[field]));
}

/**
 * 代码-文档联动规则配置
 */
const COUPLED_RULES = [
  {
    name: 'Prisma 数据库模型与迁移',
    description: '修改了 Prisma Schema 或数据库迁移脚本',
    triggers: [
      /^apps\/server\/prisma\/schema\.prisma$/,
      /^apps\/server\/prisma\/migrations\//,
      /^prisma\/schema\.prisma$/,
    ],
    requiredDocs: ['docs/DATA_MODELS.md'],
  },
  {
    name: 'API 控制器与通信网关',
    description: '修改了 REST 控制器、WebSocket 网关、订阅编译器或 Agent WS 模块',
    triggers: [
      /^apps\/server\/src\/.*\.controller\.ts$/,
      /^apps\/server\/src\/agent-gateway\//,
      /^apps\/server\/src\/subscription\/builders\./,
      /^apps\/agent\/internal\/ws\//,
    ],
    requiredDocs: ['docs/API_AND_PROTOCOLS.md'],
  },
  {
    name: '系统部署与容器化发布',
    description: '修改了 Dockerfile、docker-compose、打包部署脚本或发行包模板',
    triggers: [
      /^Dockerfile(\..*)?$/,
      /^docker-compose(\..*)?\.ya?ml$/,
      /^scripts\/docker-.*\.sh$/,
      /^scripts\/release\.sh$/,
      /^scripts\/master-bundle\//,
    ],
    requiredDocs: ['docs/DEPLOYMENT_GUIDE.md'],
  },
  {
    name: '技术栈与核心依赖',
    description: '修改了依赖配置 (package.json 依赖部分 / go.mod)',
    customCheck: (changedFiles, baseRef) => {
      const hasGoMod = changedFiles.some(f => f === 'apps/agent/go.mod' || f === 'apps/agent/go.sum');
      if (hasGoMod) return ['apps/agent/go.mod'];

      const packageFiles = changedFiles.filter(file => ['package.json', 'apps/server/package.json', 'apps/web/package.json'].includes(file));
      const diffTarget = baseRef ? (typeof baseRef === 'object' ? baseRef.mergeBase : baseRef) : 'HEAD';
      return packageFiles.filter(file => {
        try {
          const before = JSON.parse(execFileSync('git', ['show', diffTarget + ':' + file], { encoding: 'utf8', cwd: ROOT_DIR, stdio: 'pipe' }));
          const fullPath = path.join(ROOT_DIR, file);
          const after = fs.existsSync(fullPath) ? JSON.parse(fs.readFileSync(fullPath, 'utf8')) : {};
          return dependencyMetadataChanged(before, after);
        } catch {
          // 新文件或不可解析的基准按需同步文档，不能静默豁免真实依赖变化。
          return true;
        }
      });
    },
    requiredDocs: ['docs/TECH_STACK.md'],
  },
  {
    name: '前端 UI 页面与视图交互',
    description: '修改了前端业务页面或核心视图组件',
    triggers: [
      /^apps\/web\/src\/pages\//,
    ],
    requiredDocs: ['docs/FRONTEND_UI_GUIDELINES.md', 'docs/VISUAL_VERIFICATION.md'],
  },
];

const EXEMPTION_KEYWORDS = ['[skip-doc-sync]', '[skip-docs-sync]', 'docs-exempt', 'skip-doc-sync'];

/**
 * 查找 git 基准 commit / 分支
 */
function getGitBaseRef() {
  try {
    if (process.env.GITHUB_BASE_REF) {
      return `origin/${process.env.GITHUB_BASE_REF}`;
    }

    const candidates = ['origin/main', 'main', 'master'];
    for (const ref of candidates) {
      try {
        execSync(`git rev-parse --verify ${ref}`, { stdio: 'ignore', cwd: ROOT_DIR });
        const mergeBase = execSync(`git merge-base HEAD ${ref}`, { encoding: 'utf-8', cwd: ROOT_DIR }).trim();
        if (mergeBase) {
          return { ref, mergeBase };
        }
      } catch {
        // 继续尝试下一个候选
      }
    }
  } catch {
    // Git 命令不可用
  }
  return null;
}

/**
 * 获取变更文件列表（包含暂存区与未暂存工作区改动）
 */
function getChangedFiles(baseRef) {
  const filesSet = new Set();
  try {
    if (baseRef) {
      const diffTarget = typeof baseRef === 'object' ? baseRef.mergeBase : baseRef;
      const output = execSync(`git diff --name-only ${diffTarget} HEAD`, { encoding: 'utf-8', cwd: ROOT_DIR });
      output.split(/\r?\n/).map(s => s.trim()).filter(Boolean).forEach(f => filesSet.add(f));
    }

    // 包含工作区未提交的文件（staged + unstaged + untracked）
    const statusOutput = execSync(`git status --porcelain`, { encoding: 'utf-8', cwd: ROOT_DIR });
    statusOutput.split(/\r?\n/).filter(Boolean).forEach(line => {
      const rawPath = line.slice(2).trim();
      if (rawPath) {
        const finalPath = rawPath.includes(' -> ') ? rawPath.split(' -> ')[1].trim() : rawPath;
        filesSet.add(finalPath);
      }
    });
  } catch {
    // 忽略 Git 错误
  }
  return Array.from(filesSet);
}

/**
 * 获取提交历史中的 Commit Messages（用于检测豁免标记）
 */
function getCommitMessages(baseRef) {
  try {
    let messages = '';
    if (baseRef) {
      const diffTarget = typeof baseRef === 'object' ? baseRef.mergeBase : baseRef;
      messages = execSync(`git log ${diffTarget}..HEAD --pretty=format:"%B"`, { encoding: 'utf-8', cwd: ROOT_DIR });
    } else {
      messages = execSync(`git log -n 5 --pretty=format:"%B"`, { encoding: 'utf-8', cwd: ROOT_DIR });
    }
    return messages;
  } catch {
    return '';
  }
}

/**
 * 校验代码与文档的联动同步规则
 */
function checkDocCodeCoupling(errors, warnings) {
  const baseRef = getGitBaseRef();
  const changedFiles = getChangedFiles(baseRef).map(f => f.replace(/\\/g, '/'));

  if (changedFiles.length === 0) {
    return;
  }

  // 检查是否有显式豁免标记
  if (process.env.SKIP_DOC_SYNC === '1' || process.env.SKIP_DOC_SYNC === 'true') {
    warnings.push('[doc-sync 豁免] 检测到环境变量 SKIP_DOC_SYNC，已跳过代码-文档联动规则校验。');
    return;
  }

  const commitMessages = getCommitMessages(baseRef);
  const isExempted = EXEMPTION_KEYWORDS.some(kw => commitMessages.toLowerCase().includes(kw.toLowerCase()));
  if (isExempted) {
    warnings.push('[doc-sync 豁免] 提交信息中检测到 [skip-doc-sync] / docs-exempt 豁免标记，已跳过代码-文档联动规则校验。');
    return;
  }

  for (const rule of COUPLED_RULES) {
    let triggeredFiles = [];
    if (rule.customCheck) {
      triggeredFiles = rule.customCheck(changedFiles, baseRef);
    } else if (rule.triggers) {
      triggeredFiles = changedFiles.filter(f => rule.triggers.some(re => re.test(f)));
    }

    if (triggeredFiles.length > 0) {
      const hasRequiredDoc = rule.requiredDocs.some(doc => changedFiles.includes(doc));
      if (!hasRequiredDoc) {
        errors.push(
          `[代码-文档联动违规] ${rule.name}\n` +
          `  触发代码变更: ${triggeredFiles.slice(0, 3).join(', ')}${triggeredFiles.length > 3 ? ` 等共 ${triggeredFiles.length} 个文件` : ''}\n` +
          `  必须同步修改: ${rule.requiredDocs.join(' 或 ')}\n` +
          `  👉 若本次变更纯属内部微调且未改变外部契约，可在 commit message 中添加 [skip-doc-sync] 声明豁免。`
        );
      }
    }
  }
}

/**
 * 归档操作 (archive)
 */
function runArchive(targetArg) {
  if (!targetArg) {
    console.error('❌ 请指定要归档的规划文件名，例如: pnpm plan:archive my-feature.md');
    process.exit(1);
  }

  ensureDirs();
  const baseName = path.basename(targetArg);
  const sourcePath = path.resolve(PLANS_DIR, baseName);

  if (!fs.existsSync(sourcePath)) {
    console.error(`❌ 未找到待归档文件: docs/plans/${baseName}`);
    process.exit(1);
  }

  const content = fs.readFileSync(sourcePath, 'utf8');
  const { data, body } = parseFrontmatter(content);
  const today = getTodayString();

  // 更新元数据
  data.type = 'plan';
  data.status = 'completed';
  data.archived_at = today;
  if (!data.created_at) data.created_at = today;
  if (!data.title) data.title = baseName.replace(/\.md$/, '');

  const newContent = stringifyFrontmatter(data, body);

  // 计算目标文件名：若未带日期前缀，则补充 YYYY-MM-DD- 前缀
  let targetFileName = baseName;
  if (!/^\d{4}-\d{2}-\d{2}-/.test(baseName)) {
    targetFileName = `${today}-${baseName}`;
  }

  const targetPath = path.resolve(ARCHIVE_DIR, targetFileName);

  // 写入并移动
  fs.writeFileSync(targetPath, newContent, 'utf8');
  fs.unlinkSync(sourcePath);

  console.log(`🎉 规划已成功归档:`);
  console.log(`  原路径: docs/plans/${baseName}`);
  console.log(`  新路径: docs/plans/archive/${targetFileName}`);

  // 刷新索引
  syncIndex();
}

/**
 * 新建规划模板 (new)
 */
function runNew(nameArg) {
  if (!nameArg) {
    console.error('❌ 请指定规划名称 (kebab-case)，例如: pnpm plan:new user-traffic-stats');
    process.exit(1);
  }

  ensureDirs();
  const kebabName = nameArg.replace(/\.md$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const fileName = `${kebabName}.md`;
  const filePath = path.resolve(PLANS_DIR, fileName);

  if (fs.existsSync(filePath)) {
    console.error(`❌ 规划文件已存在: docs/plans/${fileName}`);
    process.exit(1);
  }

  const today = getTodayString();
  const title = nameArg.replace(/\.md$/, '');

  const template = `---
title: "${title}"
type: plan
status: active
target_version: "Unreleased"
created_at: "${today}"
author: "Contributors & Maintainers"
---

# ${title}

## 🎯 目标与背景

简要说明本阶段/特性的目标、背景上下文与预期交付成果。

---

## 📋 里程碑与任务清单

### 里程碑 1：核心业务设计与开发
- [ ] 任务 1.1: 需求与接口定义
- [ ] 任务 1.2: 核心业务逻辑落地

### 里程碑 2：前端交互与联调
- [ ] 任务 2.1: 界面与交互开发
- [ ] 任务 2.2: 联调与测试

### 里程碑 3：文档与质量门禁
- [ ] 任务 3.1: 同步更新相关设计文档与 CHANGELOG
- [ ] 任务 3.2: 门禁全绿自查与归档准备

---

## 🧪 验收标准与测试记录

- [ ] 单元测试 / 门禁全绿
- [ ] 联调验收通过
`;

  fs.writeFileSync(filePath, template, 'utf8');
  console.log(`🎉 新规划模板已创建: docs/plans/${fileName}`);

  // 刷新索引
  syncIndex();
}

// 直接执行才路由命令；测试导入纯比较函数不会扫描或改写工作区。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const command = args[0] || 'check';

  switch (command) {
    case 'check':
      runCheck();
      break;
    case 'archive':
      runArchive(args[1]);
      break;
    case 'new':
      runNew(args[1]);
      break;
    case 'sync':
      syncIndex();
      break;
    default:
      console.error(`未知命令: ${command}。支持命令: check, archive <file>, new <name>, sync`);
      process.exit(1);
  }
}
