# 项目全局硬约束 (Project Constraints)

本文档定义 **RiriCloud** 的不可协商红线。任何 PR（含 AI 代理的自动变更）触碰以下约束即为打回项；需要突破红线时，唯一途径是先提 RFC 修订本文档。分层架构与代码组织规则见 [CODE_REVIEW.md](./CODE_REVIEW.md)。

---

## 1. 技术栈锁定

以下选型为项目基石（选型依据见 [TECH_STACK.md](./TECH_STACK.md)），**更换任一项属于 MAJOR 级决策**：必须先更新本文档与 [TECH_STACK.md](./TECH_STACK.md)、[VERSIONING.md](./VERSIONING.md) 中的相关章节，再动代码。

| 领域 | 锁定选型 |
| :--- | :--- |
| 包管理 / 工程结构 | pnpm Workspace (Monorepo) |
| 前端 | React + TypeScript + Vite + Tailwind CSS + shadcn/ui |
| 主控后端 | NestJS + TypeScript |
| 持久化 | SQLite (WAL) + Prisma ORM |
| 实时通信 | `@nestjs/websockets` + `ws`（WSS） |
| 边缘节点 | Go ≥ 1.26（`CGO_ENABLED=0` 单静态二进制，内置 Cobra CLI、Bubble Tea TUI 与系统服务适配） |
| 代理内核 | 服务端 Sing-box；主客户端配置/验证/拨测 Mihomo，Sing-box 客户端限明确能力白名单兼容回退 |
| Node.js / pnpm 版本 | Node ≥ 20，pnpm ≥ 9 |

在既有选型内新增**小型**辅助库不受限，但须遵守 [CODE_REVIEW.md](./CODE_REVIEW.md) §4 的依赖说明义务。

客户端职责分离不改变 Agent 数据平面或外部服务零依赖。Mihomo 在 Master 上作为受管临时子进程，仅回环控制与代理端口；禁止因网络/鉴权/配置/环境失败静默回退 Sing-box，回退必须记录原因、实际内核与版本。只有真实代理请求满足目标响应与证书契约才能称为端到端测速成功；TCP 可达性不能代替。

### 1.1 Linux 开发环境与工具安装

Linux 是本项目的首选本地开发环境，Node.js、pnpm 与 Go 必须安装到系统环境并从系统 `PATH` 使用：

- Node.js `>=20.0.0`（推荐使用与 CI 一致的 22.x）。
- pnpm `9.15.9`（根 `package.json` 的 `packageManager` 为唯一版本来源），通过系统 npm 全局安装。
- Go `>=1.26`，以 `apps/agent/go.mod` 的 `go 1.26.0` 为最低兼容基线。
- Linux 不得通过 `.npmrc`、`scripts/dev-env.sh` 或其他脚本把运行时、pnpm store、npm cache、Prisma cache 或 Go cache 重定向到仓库内；项目依赖本身仍按 pnpm Workspace 安装到本地 `node_modules`。
- `source scripts/dev-env.sh` 在 Linux 下必须保持系统 `PATH` 与用户默认缓存不变。`.cache/`、`.tools/` 只用于 Windows Git Bash 兼容场景和临时构建产物，不作为 Linux 工具链来源。
- CI 使用 runner 提供的 Node.js、pnpm、Go 与缓存，不依赖开发机 `.cache/` 或 `.tools/`。

### 1.2 Agent Docker 构建工具链一致性

- `apps/agent/go.mod` 的 `go` 指令是 Agent 编译工具链的最低版本真相源；升级该指令时，必须在同一 PR 同步更新根 `Dockerfile` 与 `Dockerfile.agent` 的 `agent-build` 阶段。
- 两个 Dockerfile 的 `agent-build` 阶段必须使用不低于 `apps/agent/go.mod` 的官方 Go 基础镜像，并保留 digest 固定，确保 Master 内置 Agent 与独立 Agent 镜像使用同一编译基线。
- Agent Docker 构建不得依赖自动下载或隐式切换 Go toolchain；构建容器应直接提供满足 `go.mod` 要求的 Go 版本，`GOTOOLCHAIN=local` 下也必须能够完成 `go mod download` 与编译。
- Go module/build cache 只能缓存依赖和编译中间产物，不能替代或掩盖编译器版本校验；修改 Go 最低版本后必须验证 `Dockerfile` 与 `Dockerfile.agent` 的 `agent-build` 阶段均可独立构建。

---

## 2. 零外部服务依赖红线

系统整体（主控端）**开箱即用，不依赖任何外部数据库或中间件**：

1. **禁止引入** MySQL / PostgreSQL / MongoDB / Redis / RabbitMQ / Kafka / etcd 等任何外部服务客户端依赖。
2. 需要缓存 → 进程内缓存；需要队列 → 进程内异步任务；需要锁 → SQLite 事务。**先证明当前方案不够用，再讨论突破**（此时走 RFC，且大概率意味着架构文档重写）。
3. 部署形态承诺不变：主控端单进程 + 单 SQLite 文件（`docker-compose.yml` 不得出现数据库/缓存服务条目）。

---

## 3. 资源约束（边缘节点）

Agent 面向最低配 VPS 运行，资源预算是验收指标而非建议：

| 指标 | 上限 |
| :--- | :--- |
| Agent 常驻内存（不含 Sing-box 内核） | ≤ 30 MB |
| 目标运行环境 | 256 MB 内存 / 1 核 VPS 可正常工作 |
| 二进制体积 | ≤ 25 MB（gzip 后） |
| 启动到 WSS 连接建立 | ≤ 5 秒（正常网络） |

新依赖引入后必须复核上述指标；遥测采集频率默认 5~10 秒，不得为省事提高到秒级以下。

---

## 4. 安全红线

1. **凭据管理**：JWT 密钥通过环境变量或外部密钥注入；AgentToken、SMTP/Turnstile Secret、Reality 私钥和证书私钥在数据库中使用 AES-GCM 应用层加密，AgentToken 另存 SHA-256 校验值；**禁止**明文硬编码、入 git、入日志或放入 URL query。
2. **传输加密**：生产环境 Master 面板强制 HTTPS、Agent 通道强制 WSS；开发环境可降级为本地 ws/http，但代码不得内置"生产关闭 TLS"的开关。
3. **密码存储**：`bcrypt`（成本因子 ≥ 10），禁止 MD5/SHA1/明文；禁止可逆加密存密码。浏览器 JWT 只允许放入 HttpOnly、SameSite Cookie，禁止 localStorage/sessionStorage；密码修改、重置、注销、禁用和管理员 CLI 重置必须递增 `sessionVersion`。
4. **鉴权默认拒绝**：所有 API 默认挂 JWT Guard，公开端点须显式 `@Public()` 声明并逐一登记；Agent 鉴权失败必须断开连接；AgentToken 仅允许 Header，SSE 仅允许一次性短期票据。
5. **输入校验**：服务端对一切外部输入（HTTP / WS / 订阅 token）校验后才使用（详见 [CODE_REVIEW.md](./CODE_REVIEW.md) §5）。
6. **日志脱敏**：`passwordHash`、`agentToken`、`uuid`（用户凭证）不得以任何级别输出到日志。
7. **认证输入与会话**：邮箱统一 trim/小写并限制 254 字符；密码统一受系统 `passwordMinLength` 与 64 字符上限约束；认证响应禁止缓存，注册/找回密码/验证码发送不得通过响应差异枚举邮箱。
8. **依赖安全**：CI 中运行 `pnpm audit` 与 `govulncheck`，高危漏洞阻断合并。

---

## 5. 文档同步约束

**代码与文档不一致视为 bug。** 修改以下内容时，对应文档必须在**同一个 PR** 内更新，由 `pnpm gate:docs` 进行机械化强约束拦截：

| 你改了什么 (Trigger Paths) | 必须同步更新 (Required Docs) |
| :--- | :--- |
| Prisma 模型、字段、迁移 (`apps/server/prisma/**`) | [DATA_MODELS.md](./DATA_MODELS.md) |
| REST 控制器、WS 网关、订阅格式 (`apps/server/src/**/*.controller.ts` 等) | [API_AND_PROTOCOLS.md](./API_AND_PROTOCOLS.md) |
| 容器化、部署与发布脚本 (`Dockerfile*`、`scripts/docker-*.sh` 等) | [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) |
| 依赖库、Go 模块 (`package.json` 依赖、`go.mod`) | [TECH_STACK.md](./TECH_STACK.md) |
| 前端页面与交互组件 (`apps/web/src/pages/**`) | [FRONTEND_UI_GUIDELINES.md](./FRONTEND_UI_GUIDELINES.md) 或 [VISUAL_VERIFICATION.md](./VISUAL_VERIFICATION.md) |
| 任务规划与细粒度待办 | [plans/README.md](./plans/README.md)（进行中放入 `docs/plans/`，完成后必须 `pnpm plan:archive` 归档） |
| 规范与红线本身 | 本文档 / [VERSIONING.md](./VERSIONING.md) / [GIT_WORKFLOW.md](./GIT_WORKFLOW.md) / [CODE_REVIEW.md](./CODE_REVIEW.md) |
| 里程碑进度 | [ROADMAP.md](./ROADMAP.md)（完成的条目打勾） |

> **豁免机制**：若某次改动纯属内部微调/重构且未影响外部接口与数据模型契约，可在 commit message 或 PR 描述中添加 `[skip-doc-sync]` 或 `docs-exempt` 显式豁免阻断。

`feat` / `fix` 等核心代码变更必须执行 `pnpm bump` 并在 [CHANGELOG.md](../CHANGELOG.md) 顶部的对应版本小节中记录条目（详见 [VERSIONING.md](./VERSIONING.md) §5/§6）。

---

## 6. 语言与命名约定

| 场景 | 语言 |
| :--- | :--- |
| 代码标识符（变量/函数/类型/包名） | 英文 |
| 日志消息 | 英文（节点日志可能被任意语言环境的运维检索） |
| 代码注释 | 中文，解释"为什么"而非复述代码 |
| commit 描述、PR 描述、CHANGELOG 条目 | 中文（type 用英文，见 [GIT_WORKFLOW.md](./GIT_WORKFLOW.md) §3） |
| 用户可见的 UI 文案 | **以简体中文（zh-CN）为唯一 SSOT 基准**；新增/修改 UI 文本时强制要求且仅强制要求录入 `zh-CN` 字典并使用 `t(...)` 引用；TSX 视图中严禁未国际化的硬编码中文（JSX 裸文本、属性、Toast、Zod 校验），由 `pnpm gate:i18n` 机械阻断；非基准语言（`en-US`、`ja-JP` 等）与日常 UI 特性解耦，允许异步补齐，运行时由 `fallbackLng: 'zh-CN'` 自动平滑兜底；文案描述用户可观察的业务行为，不暴露后端实现术语，表单关闭原生校验（`noValidate`） |

### 6.1 中文第一基准（Chinese-First SSOT）与 i18n 机械门禁
1. **基准语言单源 (SSOT)**：所有功能迭代以 `apps/web/src/locales/zh-CN/` 为唯一真理源。日常 UI 特性 PR 必须且仅强制要求完善中文词条。
2. **机械门禁阻断硬编码**：`pnpm gate:i18n`（`scripts/i18n-governance.mjs check`）自动对 `apps/web/src/` 下所有 TSX 视图源码进行静态分析。任何未走 `t(...)` 的裸中文文本、用户可见属性（`placeholder`、`title`、`label`、`aria-label` 等）、`toast.*` 字符串及 Zod 错误文本均会触发门禁阻断（技术例外可使用 `// i18n-ignore` 豁免）。
3. **多语言交付解耦与运行时回退**：非中文语言（`en-US`、`ja-JP` 等）与常规 UI 特性交付解耦，不要求单个 PR 一次性齐套。当非基准语言字典缺失键位时，i18next 配置（`fallbackLng: 'zh-CN'`）自动降级回退至中文，保障界面永不展示裸露的键路径（如 `admin:nodes.title`）。
4. **覆盖率台账与异步补全**：运行 `pnpm i18n:report` 可即时输出全语言字典对齐 `zh-CN` 的覆盖率看板及各命名空间待翻译词条清单，便于后续集中、批量化完成翻译。

命名风格沿用各语言生态惯例：TS 用 `camelCase` / `PascalCase`，Prisma model 用 `PascalCase` + 字段 `camelCase`，Go 用 `camelCase` / `PascalCase`（导出）。

---

## 7. 其他工程红线

1. **分支管理与 main 绝对保护**：`main` 分支绝对禁止直接修改、提交（commit）与推送（push）；一切变更 100% 走独立分支经 PR 由 CI 门禁全绿后 Squash Merge 合入；严禁使用 `--no-verify` 绕过本地 pre-commit / pre-push hook。
2. **测试策略**：业务逻辑（配额扣减、订阅生成、权限判定）单元测试必写；WS 协议与流量核算保留端到端联调用例（Phase 5 落地）。不追求行覆盖率数字，但修 bug 必须先有复现测试。
3. **接口与启动流程变更必须联动核对 E2E**：修改 REST/WS 接口、鉴权方式、响应结构、节点/Agent 生命周期或联调启动流程时，同一 PR 必须检索并评估 `scripts/dev-e2e*`、E2E 测试与相关 fixture 是否需要同步更新；若需要，必须同一 PR 更新并补充回归用例，若不需要则须在 PR 自查记录中明确说明。E2E/联调脚本视为正式接口消费者，不得因其位于 `scripts/` 而跳过契约同步。
4. **迁移安全**：Prisma 迁移一旦合入 main 不得修改历史迁移文件，只能追加新迁移。
5. **配置管理**：所有可配置项集中一处定义（server：`@nestjs/config` + `.env`；agent：`/etc/riri-agent/config.yaml` + 环境变量），禁止散落的魔法常量。
6. **禁止"临时"绕行**：禁用门禁、跳过校验、`// TODO 稍后处理` 式的安全空缺，一律不允许进 main。

## 8. 前端操作卡片视觉一致性

1. **统一基础控件层级**：表单中承载 `Switch`、`Checkbox` 或操作按钮的边框卡片，必须直接复用 shadcn/ui 的 `FormItem` / `Card` 结构；与同层 `Input`、`SelectTrigger` 等基础控件并列时，外层卡片统一使用 `shadow-sm`、语义边框和一致的高度与间距。
2. **禁止自定义视觉分叉**：不得仅用裸 `div` 替代既有 shadcn/ui 卡片结构，也不得为相似操作卡片单独引入不一致的阴影、圆角或内边距；新增相似样式必须同步更新 [FRONTEND_UI_GUIDELINES.md](./FRONTEND_UI_GUIDELINES.md) 并纳入对应 UI 走查。

## 9. 任务规划与机械归档约束

1. **统一收敛**：所有中短期任务清单、架构重构计划等必须存放于 `docs/plans/`；严禁在 `docs/` 根目录随意堆放散落的 TODO / 计划文件（门禁脚本白名单强制校验）。
2. **机械阻断**：进行中规划（`docs/plans/`）内所有任务复选框 100% 勾选完成时，`pnpm gate:docs` 门禁将强制阻断报错，防止陈旧完成项滞留在活跃目录。
3. **规范归档**：必须通过 `pnpm plan:archive <file>` 或符合 `YYYY-MM-DD-*.md` 规范将已完结任务移入 `docs/plans/archive/`，并同步刷新 [plans/README.md](./plans/README.md) 台账。

## 10. 统一版本管理与 PR 级连续递增约束

1. **单仓唯一版本源**：根 `package.json` 的 `version` 字段为全局唯一真实源，子包（`apps/server`、`apps/web`）与 `apps/agent` 一律不得私自维护版本号。
2. **核心代码变更强制递增**：凡涉及 `apps/server`、`apps/web`、`apps/agent` 或 `prisma` 等核心代码修改的 PR，在合入 `main` 前分支上必须执行 `pnpm bump [patch|minor|major]` 递增版本号，并在 [CHANGELOG.md](../CHANGELOG.md) 顶部的对应版本小节中记录改动。纯文档、脚本或配置改动允许免增版本。
3. **三重防线机械阻断**：`pnpm gate:version`、CI 流水线及 `.husky/pre-push` 构成三重防线，自动校验版本号大小、CHANGELOG 格式与 Git 变更差分，杜绝未升版本的核心代码变更合入主干。

---

## 11. 容器安全、运行身份与启动诊断约束

1. **非 Root 默认锁定与最小特权**：官方发布的 Master 与 Agent 容器镜像必须基于 Distroless 极简安全底座，镜像内置与 Docker Compose 默认运行身份必须强制锁定为 `65532:65532` 非 Root 安全用户，严禁在构建阶段将默认用户回退为 `0:0`。
2. **运行身份自适应接口约束**：所有 Compose 模板（含 `docker-compose.yml` 与 `docker-compose.image.yml`）必须统一通过 `${DOCKER_USER:-65532:65532}` 暴露运行身份覆盖接口，在兼顾默认非 Root 安全规范的同时，允许宿主机管理员在复杂权限环境（如 root 工作目录或权限受限的挂载卷）下通过 `DOCKER_USER=0:0` 获得免权限配置的自愈通道。
3. **前置健康体检与 Fail-Fast 原则**：主控容器入口（`docker-entrypoint.js`）在执行任何数据库迁移（`prisma migrate`）或子进程拉起前，必须执行全链路前置深度自检（涵盖挂载数据目录 `/app/data` 读写可穿透性、临时探测锁创建与销毁、存量 `*.db` 及 WAL/SHM 读写锁状态、`/tmp` 临时目录可用性及核心安全密钥强度）；严禁将底层原生异常（如 Rust `os error 13`）未加工直接暴露给终端。
4. **结构化诊断卡片输出标准**：启动自检发现任何异常时，必须以标准结构化格式输出诊断卡片，完整呈现：① 明确的诊断结论；② 现场取证（容器 UID/GID、挂载点实际属主与权限、出错具体环节）；③ 针对宿主机环境的多方案一键修复命令（放宽权限、对齐属主或配置 DOCKER_USER）。

