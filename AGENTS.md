# AGENTS.md — AI 代理工作规范

本文件面向在本仓库工作的一切 AI 编码代理（以及新加入的人类协作者）。开始任何任务前，你被默认已阅读并同意本文件。项目详细设计见 `docs/` 文档库，本文件只做**索引与硬性规则摘要**，规则冲突时以 `docs/` 下的规范文档为准。

---

## 项目概述

**RiriCloud** 是一个多节点 VPN/代理管理系统：NestJS + React + SQLite 的主控面板（Master），通过 WSS 长连接纳管运行在多台 VPS 上的 Go Agent（托管 Sing-box 内核），统一输出多格式订阅。

**当前进度：Master 与 Agent 双轨迭代，基础链路与工程治理已落地。** 当前版本分别以根 `package.json` 与 `apps/agent/VERSION` 为准，不在进度摘要中重复维护版本号。控制面与数据面解耦、节点与中继线路、Agent CLI/TUI、升级分发、多格式订阅、六类基础门禁与脚本回归已具备；真实内核已存在原生测试，跨平台与生产验收以实际证据为准。完整路线图见 [docs/ROADMAP.md](docs/ROADMAP.md)。

> **开发环境**：Linux 是首选本地开发环境，Node.js、pnpm 与 Go 必须使用系统安装，pnpm/npm/Prisma/Go 缓存使用当前用户默认路径。Linux 下执行 `source scripts/dev-env.sh` 不会改写 `PATH` 或缓存；Windows Git Bash 才使用项目内 `.cache/` 与 `.tools/` 兼容缓存和便携 Go 工具链。首次搭建：pnpm 环境下执行 `pnpm setup`（install + 迁移 + 种子数据）。

### 目录结构

```
riricloud/
├── docs/              # 设计与规范文档库
│   └── plans/         # 规划任务总台账（进行中，archive/ 存放历史归档）
├── apps/              # 三端应用（已落地）
│   ├── web/           # React + Vite 前端（@riricloud/web）
│   ├── server/        # NestJS 主控后端（@riricloud/server，含 Prisma schema）
│   └── agent/         # Go 边缘节点守护程序（Cobra CLI + Bubble Tea TUI）
├── scripts/           # dev-env.sh、doc-governance.mjs、version-governance.mjs 等
├── artifacts/         # 【gitignore】统一的本地 Agent、Release 与 Docker 产物目录
├── .cache/            # 【gitignore】Windows 兼容缓存与临时构建缓存
├── .tools/            # 【gitignore】Windows 兼容工具链与临时构建资源
├── AGENTS.md          # 本文件
└── CHANGELOG.md       # 变更日志
```

> `apps/*` 脚手架建立后，各子目录可按需增设更细粒度的 AGENTS.md（如 `apps/agent/AGENTS.md` 覆盖 Go 特有约定），子级规则不得与本文件和 `docs/` 规范冲突。

---

## 按任务类型的必读文档

动手前**必读**对应列的全部文档（`docs/` 前缀省略）：

| 任务类型 | 必读 | 参考 |
| :--- | :--- | :--- |
| 任何任务（首次进入仓库） | `README.md`、`ARCHITECTURE.md`、`PROJECT_CONSTRAINTS.md` | — |
| 写 `apps/server` 代码 | `TECH_STACK.md`、`API_AND_PROTOCOLS.md`、`DATA_MODELS.md`、`CODE_REVIEW.md` | `DEPLOYMENT_GUIDE.md` |
| 写 `apps/web` 代码 | `TECH_STACK.md`、`API_AND_PROTOCOLS.md`、`FRONTEND_UI_GUIDELINES.md`、`VISUAL_VERIFICATION.md`、`CODE_REVIEW.md` | `ARCHITECTURE.md` |
| 写 `apps/agent` 代码 | `TECH_STACK.md`、`API_AND_PROTOCOLS.md`、`CODE_REVIEW.md` | `DEPLOYMENT_GUIDE.md` |
| 改 WS 协议 / API / 订阅格式 | `API_AND_PROTOCOLS.md`、`VERSIONING.md`（判断破坏性变更） | `ARCHITECTURE.md` |
| 改数据模型 | `DATA_MODELS.md`、`PROJECT_CONSTRAINTS.md` §5 | — |
| 提交 / 合并 / 发版 | `GIT_WORKFLOW.md`、`VERSIONING.md` | `CODE_REVIEW.md` §2 |
| 改工程配置 / CI / 依赖 | `PROJECT_CONSTRAINTS.md`、`CODE_REVIEW.md` §4 | `TECH_STACK.md` |

---

## 硬性规则摘要（违反即返工）

1. **技术栈锁定**：只用 [docs/TECH_STACK.md](docs/TECH_STACK.md) 选定的技术；禁止引入外部数据库/Redis/MQ（零依赖红线）。
2. **版本最小递增与 Unreleased 缓冲机制**：能 PATCH 不 MINOR，能 MINOR 不 MAJOR；Master（Server/Web）版本源为根 `package.json`，Agent 版本源为 `apps/agent/VERSION`；日常 PR 分别维护根 `CHANGELOG.md` / `apps/agent/CHANGELOG.md` 的 `[Unreleased]`，版本号保持不变；发版通过短生命周期 Release PR 分别执行 `pnpm bump` / `pnpm bump:agent` 固化版本小节（[docs/VERSIONING.md](docs/VERSIONING.md)）。
3. **提交规范**：Conventional Commits，英文 type + 中文描述（`feat(server): 实现用户登录`）；原子提交；破坏性变更标 `!` + `BREAKING CHANGE`（[docs/GIT_WORKFLOW.md](docs/GIT_WORKFLOW.md)）。
4. **分支模型与 main 绝对保护（零容忍红线）**：GitHub Flow；main 绝对受保护，**严禁在 main 分支直接修改、提交（commit）或推送（push）**；AI Agent 动代码前**第一步必须执行 `git branch --show-current` 并切出独立特性分支**；严禁使用 `--no-verify` 绕过拦截；一切变更无例外 100% 走 PR 合并。
5. **分层约束**：Controller 不碰 Prisma；WS Gateway 复用 Service；前端请求只走统一 API 客户端；前端 UI 强制遵循 [docs/FRONTEND_UI_GUIDELINES.md](docs/FRONTEND_UI_GUIDELINES.md) 与 shadcn/ui 规范（禁裸 HTML 交互标签）；Go 禁 CGO、goroutine 必须可退出（[docs/CODE_REVIEW.md](docs/CODE_REVIEW.md) §3）。
6. **文档同步**：改了什么就必须同一 PR 更新对应文档（映射表见下）；代码与文档不一致视为 bug。
7. **安全红线**：密钥不入 git/日志；生产强制 HTTPS/WSS；密码 bcrypt；服务端默认拒绝鉴权（[docs/PROJECT_CONSTRAINTS.md](docs/PROJECT_CONSTRAINTS.md) §4）。
8. **语言约定**：标识符与日志英文，注释/commit/文档中文（[docs/PROJECT_CONSTRAINTS.md](docs/PROJECT_CONSTRAINTS.md) §6）。
9. **质量门禁**：合入 main 前本 §常用命令 全绿；修 bug 先写复现测试。
10. **接口与启动流程变更必须联动核对 E2E**：修改 REST/WS 接口、鉴权方式、响应结构、节点/Agent 生命周期或联调启动流程时，必须在同一 PR 检索并评估 `scripts/dev-e2e*`、E2E 测试与 fixture 是否需要同步更新；需要更新时必须补回归用例，不需要时须在 PR 自查记录中说明。
11. **不越权**：架构级决策（换框架、加外部服务、突破资源上限）不得自行实施——先提 RFC 改文档，获批准后再动代码。
12. **视觉验证约束**：前端 UI 视觉验证为**按需执行**且**仅在 Antigravity 代理环境下执行**；严禁在自动化 CI / Git hook 中挂接视觉测试，严禁私自引入重型测试框架。UI 改动需核对并维护 [docs/VISUAL_VERIFICATION.md](docs/VISUAL_VERIFICATION.md) 索引台账。
13. **任务规划与归档机械约束**：所有中短期任务规划必须存放于 `docs/plans/`；严禁在 `docs/` 根目录散落 TODO/计划文档；规划任务 100% 完成后必须使用 `pnpm plan:archive <file>` 归档至 `docs/plans/archive/`，未归档将触发 `pnpm gate:docs` 门禁阻断。
14. **中文第一基准与 i18n 机械门禁**：前端多语言以中文（`zh-CN`）为唯一 SSOT 基准。新增或修改 UI 文本时，强制要求且仅强制要求录入 `apps/web/src/locales/zh-CN/` 并通过 `t(...)` 引用；TSX 视图中严禁裸露未走 i18n 的硬编码中文文本/属性/Zod 校验（由 `pnpm gate:i18n` 机械阻断）；非基准语言（`en-US`、`ja-JP` 等）允许在 PR 中暂缺并异步补齐，未翻译词条在运行时平滑回退至中文（`fallbackLng: 'zh-CN'`），可通过 `pnpm i18n:report` 随时输出全量覆盖率与待补齐台账。

---

## 改了什么 → 必须更新什么（机械门禁强制校验）

以下映射规则由 `pnpm gate:docs`（`scripts/doc-governance.mjs`）在本地自查与 CI 中强制阻断；纯内部微调且未改变外部契约时可在 commit message 附带 `[skip-doc-sync]` 声明豁免：

| 变更内容 (触发路径) | 必须同一 PR 更新 (目标文档) |
| :--- | :--- |
| Prisma 模型或迁移 (`apps/server/prisma/**`) | `docs/DATA_MODELS.md` |
| REST / WS / 订阅格式 (`apps/server/src/**/*.controller.ts` 等) | `docs/API_AND_PROTOCOLS.md` |
| 部署方式、Docker 或脚本 (`Dockerfile*`、`scripts/docker-*.sh` 等) | `docs/DEPLOYMENT_GUIDE.md` |
| 选型或依赖库增删 (`package.json` 依赖、`go.mod`) | `docs/TECH_STACK.md` |
| 前端 UI 页面 / 模态框 / 样式 (`apps/web/src/pages/**`) | `docs/FRONTEND_UI_GUIDELINES.md` 或 `docs/VISUAL_VERIFICATION.md` |
| 任务规划与细粒度待办 | `docs/plans/`（进行中）/ 完成后必须 `pnpm plan:archive` 归档 |
| 组件、通信链路、时序 | `docs/ARCHITECTURE.md` |
| 规范与红线本身 | `docs/VERSIONING.md` / `GIT_WORKFLOW.md` / `CODE_REVIEW.md` / `PROJECT_CONSTRAINTS.md` |
| 里程碑完成 | `docs/ROADMAP.md` 勾选 |
| 用户可感知的功能/修复/核心代码 | Master 维护根 `CHANGELOG.md`，Agent 维护 `apps/agent/CHANGELOG.md` 的 `[Unreleased]`；跨端变更两处均维护（发版再各自 bump） |

---

## 常用命令

> 所有命令在 bash 中执行；Linux 使用系统 Node.js、pnpm 与 Go，Windows Git Bash 的兼容工具链由 `source scripts/dev-env.sh` 注入。

```bash
# 首次搭建（安装依赖 + 数据库迁移 + 种子数据，含演示管理员）
pnpm setup

# 安装依赖（根目录执行）
pnpm install

# 开发模式
pnpm dev:server    # NestJS 主控（http://localhost:3000，API 文档 /api/docs）
pnpm dev:web       # Vite 前端（http://localhost:5173，代理 /api → 3000）

# 版本自增（仅 Release PR 执行，日常 PR 保持版本）
pnpm bump                  # Master PATCH：固化根 Unreleased 并重置空模板
pnpm bump minor            # Master MINOR
pnpm bump major            # Master MAJOR
pnpm bump:agent            # Agent PATCH：固化 apps/agent/CHANGELOG.md 的 Unreleased
pnpm bump:agent minor      # Agent MINOR
pnpm bump:agent major      # Agent MAJOR

# 规划与任务管理
pnpm plan:new <name>       # 创建 Unreleased 规划模板（放入 docs/plans/）
pnpm plan:archive <file>   # 一键归档已完成规划（移入 docs/plans/archive/ 并刷新台账）

# 质量门禁（提交前本地自查，六类基础门禁 + 脚本回归一次全跑用 pnpm gate）
pnpm gate:version  # Master/Agent 双轨版本、各自日志与 Master README 徽标一致性
pnpm gate:docs     # 文档联动、规划归档、双轨版本规则与门禁清单一致性
pnpm gate:i18n     # 前端 TSX 源码无硬编码中文机械门禁校验
pnpm gate:server   # tsc --noEmit + eslint + jest
pnpm gate:web      # node --test（自动发现 .test.mjs）+ eslint + 类型检查 + vite build
pnpm gate:agent    # go vet + gofmt + go test + go build（经 scripts/gate-agent.sh）
pnpm test:scripts  # scripts 下 .test.mjs / .test.cjs 回归，已包含在 pnpm gate
pnpm gate          # 六类基础门禁后追加 pnpm test:scripts
pnpm test:native   # 独立原生验收（Node 22、当前宿主平台），不加入常规本地 gate
pnpm i18n:report   # 输出多语言字典覆盖率与未翻译键位待办台账

# 数据库迁移与种子（server）
pnpm --filter @riricloud/server exec prisma migrate dev
pnpm --filter @riricloud/server exec prisma db seed

# 本地运行 Agent（演示联调；token 来自管理员节点页）
pnpm build:agent
AGENT_TOKEN=<token> MASTER_WS_URL=ws://localhost:3000/ws/agent ./artifacts/binaries/agent/<os>-<arch>/riri-agent[.exe]

# 发布版本（本地脚本：门禁复跑 → 目标构建 → 打包校验 → gh CLI 创建 Release）
pnpm release:master        # 发布 Master 主控端（Tag 为 vX.Y.Z，仅上传 riri-master 发行包）
pnpm release:agent         # 发布 Agent 边缘端（Tag 为 agent-vA.B.C，仅上传 5 架构 Agent 包）
```

### 标准 Git 分支与 PR 工作流（强制执行 SOP）

1. **动代码前必先切分支**：执行 `git checkout -b <type>/<scope>-<desc>`（严禁在 main 分支编辑/暂存/提交）
2. **完成特性开发并维护更新日志**：修改 Master 核心代码时维护根 `CHANGELOG.md`，修改 Agent 时维护 `apps/agent/CHANGELOG.md` 的 `## [Unreleased]`（跨端变更两处均维护）；日常 PR 保持两条版本不变。发版分别从 `release/vX.Y.Z` / `release/agent-vA.B.C` 分支执行 `pnpm bump` / `pnpm bump:agent`
3. **本地门禁自查**：`pnpm gate`（含 `gate:version` / `gate:docs` / `gate:i18n` / `gate:server` / `gate:web` / `gate:agent` 六类基础门禁及 `pnpm test:scripts`）全绿
4. **原子提交**：`git add <files>` → `git commit -m "<type>(<scope>): <中文描述>"`（严禁 `--no-verify`）
5. **推送并提 PR**：`git push -u origin <branch>` → `gh pr create --title "<type>(<scope>): <中文描述>" --body "..."`
6. **等待 CI 并合并**：等待 GitHub Actions 门禁通过 → `gh pr merge --squash --delete-branch`
7. **切回主分支同步**：`git checkout main && git pull origin main`

---

## 工作习惯要求

- **先读后写**：修改任何模块前先读该模块现有代码与对应文档；不确定契约时以文档为准，文档缺失时先补文档。
- **小步提交**：每次提交都应是可编译、可回滚的完整单元；长任务拆多个原子提交。
- **如实汇报**：门禁失败、跳过的步骤、未完成的 TODO 必须在 PR/回复中明说，不得静默绕过。
- **不擅自扩权**：发现需要破坏红线或改规范时，停下来把问题与建议写清楚交给维护者决策。
