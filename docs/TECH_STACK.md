# 技术选型全景 (Technology Stack)

## 1. 技术全景概览

RiriCloud 在设计之初便秉持 **“开发敏捷、架构清晰、零运维依赖、边缘资源极简”** 的原则，选型矩阵如下：

| 分层 / 领域 | 选用技术 / 框架 | 核心定位与价值 |
| :--- | :--- | :--- |
| **工程架构** | **pnpm Workspace (Monorepo)** | 统一包管理，前后端代码同仓维护，统一构建脚本、类型定义与仓库元数据（根 `package.json` `repository.url` 在构建与打包期自动注入前后端，作为 GitHub Release 资源拉取的默认公开仓库地址） |
| **前端框架** | **React 19 + TypeScript + Vite 6** | 快速热更新开发体验，强类型保障，现代 Web 生态 |
| **前端样式与组件库** | **Tailwind CSS + shadcn/ui + Lucide Icons** | 极简现代化无边框风格设计，高可定制性，开箱即用高质量组件 |
| **主控后端框架** | **NestJS + TypeScript** | 企业级 IoC/DI 依赖注入架构，模块化清晰，代码组织规范 |
| **持久化与 ORM** | **SQLite + Prisma ORM (WAL 模式)** | 单文件数据库零外部依赖，Prisma 提供端到端类型安全与自动迁移 |
| **主从通信网关** | **`@nestjs/websockets` + `ws`** | 高性能双向长连接，低延迟全双工推送心跳与配置 |
| **认证与密码** | **JWT (Passport) + bcryptjs + HttpOnly Cookie** | JWT 由 Passport 校验并通过 HttpOnly/SameSite Cookie 传递；bcryptjs 为 bcrypt 算法的纯 JS 实现（成本因子 ≥ 10），哈希产物与原生 bcrypt 兼容，免去 Windows/交叉编译环境的原生依赖问题 |
| **敏感配置保护** | **Node.js `crypto` AES-256-GCM** | AgentToken、SMTP/Turnstile Secret、证书私钥与 Reality 私钥按应用层加密保存；AgentToken 额外保存 SHA-256 校验值，运行时仅在必要的 Agent 配置/发信链路中解密 |
| **边缘节点 Agent** | **Go (Golang 1.26+) + Cobra + Bubble Tea + Lip Gloss + kardianos/service** | 单一静态二进制，内置跨平台 CLI、全屏控制台 GUI/TUI、服务生命周期和前台运行模式 |
| **代理与诊断内核** | **Sing-box + Mihomo** | Sing-box 固定承担服务端入站、用户鉴权、统计及中继出口；Mihomo/Clash Meta 是主要客户端配置与真实端到端拨测/验证内核，Sing-box 客户端仅作明确能力白名单兼容回退 |

### 1.1 Linux 本地开发环境

Linux 开发机使用系统环境安装 Node.js、pnpm 与 Go，不在仓库内维护可执行运行时：Node.js 至少 20.x（推荐 22.x）、pnpm 固定为 9.15.9、Go 至少 1.26。pnpm 的 store/cache/state、npm cache、Prisma cache 与 Go module/build cache 均使用系统或当前用户的默认路径；仓库内 `.cache/` 与 `.tools/` 仅保留 Windows Git Bash 兼容和临时构建用途。`source scripts/dev-env.sh` 在 Linux 下不注入仓库路径。

---

## 2. 前端技术栈详解 (`apps/web`)

### 2.1 核心选型与工具链
- **Vite**：下一代前端构建工具，极速冷启动与秒级 HMR 热更新。
- **React Router v6**：声明式路由管理，支持路由守卫（AuthGuard、AdminGuard）与懒加载。
- **TanStack Query (React Query)**：处理服务端状态缓存、自动重新请求与加载状态管理。
- **Zustand**：极简轻量的前端全局状态管理（仅存储内存中的当前登录用户信息及全局 UI 配置，JWT 不落入 Web Storage）。
- **Tailwind CSS & shadcn/ui**：
  - 基于 Radix UI 原语的优质无障碍组件，采用 New York 风格预设与 Zinc 灰色系。
  - 直接复制代码进项目源码，杜绝第三方重型 UI 库的样式锁定与难以覆盖的问题。详细规范见 [FRONTEND_UI_GUIDELINES.md](./FRONTEND_UI_GUIDELINES.md)。
- **Lucide React**：全站统一图标库。
- **React Hook Form + Zod**：强类型端到端表单状态管理与 Schema 校验。
- **Sonner**：现代化轻量全局 Toast 提示。
- **TanStack Table (React Table v8)**：复杂数据表格（节点列表、用户列表、审计日志）的核心驱动。
- **CodeMirror 6（`@uiw/react-codemirror` + `@codemirror/view` + `@codemirror/lang-json` / `@codemirror/lang-yaml` / `@codemirror/lang-css` / `@codemirror/lang-html`）**：节点详情页高级模式、系统设置页 CSS/HTML/JS 编辑器和订阅模板 YAML/JSON 编辑器，带语法高亮、行号与可控的内部滚动；`@uiw/react-codemirror` 为官方推荐的 React 封装，按路由懒加载分包。
- **Recharts (via shadcn/ui Chart)**：用于呈现管理员流量统计与单用户流量下钻的流量/速率时序面积图、柱状图和线路 Donut 图；图表通过 CSS 语义 Token 适配明暗主题。
- **next-themes**：暗黑/明亮主题平滑切换与系统偏好监听。
- **i18next + react-i18next + i18next-browser-languagedetector**：全站国际化（i18n）解决方案，支持简体中文（zh-CN）、英语（en-US）与日语（ja-JP）三语切换、浏览器语言偏好探测与 localStorage 持久化；采用模块化命名空间架构（common、auth、user、admin、errors、landing）与 TypeScript 强类型键校验，确保翻译健壮性与无未翻译死角。

---

## 3. 主控后端技术栈详解 (`apps/server`)

### 3.1 核心选型与架构分层
- **NestJS**：
  - 标准 Controller -> Service -> Repository 分层架构。
  - 内置基于 Decorator 的 `class-validator` 与 `class-transformer`，对入参进行强校验。
  - 内置 Swagger (`@nestjs/swagger`)，自动生成 OpenAPI 交互式在线接口文档。
- **Prisma ORM**：
  - 通过清晰的 `schema.prisma` 建模，生成强类型 TypeScript 客户端。
  - 支持声明式 Database Migrations。
- **SQLite (WAL 模式)**：
  - 零配置安装，避免额外维护 MySQL / PostgreSQL 服务。
  - Master 启动时显式设置 `journal_mode=WAL` 与 `busy_timeout=10000`；如果运行目录不支持 WAL，启动日志会记录调优失败。
  - Agent 心跳按节点串行落库，流量账务保留短事务，速率历史清理由低频巡检执行，避免高频心跳长期占用写锁。
- **JWT & Passport**：
  - 服务端支持 Bearer 兼容鉴权，浏览器面板使用 HttpOnly、SameSite Cookie；JWT payload 带 `sessionVersion`，注销、改密、重置和禁用账号时立即失效旧会话。
- **YAML 序列化（`yaml`）**：
  - Clash Meta 订阅输出需要将配置对象序列化为 YAML；选用纯 JS、零传递依赖且活跃维护的 [`yaml`](https://github.com/eemeli/yaml) 包，不引入原生编译依赖。
- **SMTP 邮件（`nodemailer`）**：
  - 通过成熟的 Node.js SMTP 客户端发送注册与换绑邮箱验证码，并复用同一 Transporter 执行管理员测试邮件；连接参数来自 `SystemSetting`，不新增外部邮件服务或队列。
- **本地 CAPTCHA（`svg-captcha`）**：
  - 生成纯 SVG 图形/算术验证码，答案、令牌和客户端 IP 仅以 HMAC 保存于 SQLite，令牌一次性消费并带过期、失败次数和并发保护；无需浏览器插件、原生编译或额外基础设施。Cloudflare Turnstile 作为可选在线模式，通过官方校验接口核对 success、action、hostname 和时间窗口。
- **流式离线打包（`archiver` & `adm-zip`）**：
  - 用于主控端动态打包 Agent 边缘端离线安装包（Windows `.zip` 与 Linux/macOS `.tar.gz`），将预填凭据的 `config.yaml`、平台二进制与 4 阶段自动化安装/卸载脚本内嵌打包；选用纯 JS 实现的 `archiver@7.0.1`（CommonJS 兼容，流式低内存开销）配合 `adm-zip` 处理解压提取，零原生编译依赖。

### 3.2 安全依赖审计说明

截至 **2026-09-06**，`pnpm audit --prod` 仅报告一条已在根 `package.json` 忽略清单中登记的 High advisory：`deepmerge-ts` 经 `prisma -> @prisma/config` 引入（`GHSA-ggr8-5vv4-36mx`）。该依赖只存在于 Prisma CLI/config 合并链路，不进入 RiriCloud 的业务请求合并路径；业务线路与订阅配置使用服务端显式校验和本地合并函数。残余风险由 Prisma 版本升级、`pnpm audit --prod` 和发布门禁持续复核，若调用链或上游修复状态变化，必须移除忽略项或重新评估。

**2026-09-10 补充 — `multer` 传递依赖强制升级**：新披露 3 条 High DoS advisory（`GHSA-wc9g-mqfw-jrwm`、`GHSA-qfvm-cv95-jqjf`、`GHSA-535w-7cp7-47q4`）影响 `multer@2.2.0`，该版本经 `@nestjs/platform-express -> multer` 传递进入主控的上传链路。由于 `@nestjs/platform-express` 11.x 最新版（11.2.3）仍精确依赖 `multer@2.2.0`，在 **NestJS 11 内无版本可升**，因此在根 `package.json` 的 `pnpm.overrides` 中强制 `multer: 2.3.0`（advisory 声明的已修复版本），并随 `pnpm-lock.yaml` 一并锁定。该 override 属**临时安全锁定**：当 `@nestjs/platform-express` 自行依赖 `multer>=2.3.0`（或升级到 NestJS 12 时）必须移除本项，避免长期漂移；`pnpm audit --audit-level high` 已恢复通过（仅剩上方已登记的忽略项）。

**2026-09-30 补充 — `nodemailer` / `multer` / `fast-uri` / `brace-expansion` / `js-yaml` 安全补丁锁定**：针对新披露的 High/Moderate advisory（`GHSA-v53p-9fqp-m79j`、`GHSA-qw65-cvwx-89v3`、`GHSA-58mr-gqgx-xq4g`、`GHSA-qhr7-859c-m2p7`、`GHSA-6j4f-fj2g-mc7p` 等），在根 `package.json` 的 `pnpm.overrides` 中将 `multer` 升至 `>=2.4.0`、`nodemailer` 升至 `>=10.0.9`、`fast-uri@>=3.0.0 <3.1.7` 升至 `>=3.1.7`、`brace-expansion` 各主版本分别锁定至 `1.1.21` / `2.1.7` / `5.0.12`、`js-yaml@>=5.0.0 <=5.4.0` 升至 `>=5.4.1`，并同步更新 `pnpm-lock.yaml`，使 `pnpm audit --audit-level high` 持续保持零未评估高危漏洞。

---

## 4. 边缘节点技术栈详解 (`apps/agent`)

### 4.1 为什么节点端选择 Go 语言？
1. **单静态二进制分发**：编译后为一个独立的可执行文件（`riri-agent`），不依赖目标服务器的 glibc 版本，无需安装 Node.js、Python 或任何运行环境。
2. **极低资源开销**：常驻内存占用仅需 10MB~20MB，即使在 256MB / 512MB 的低配 VPS 上也能丝滑运行。
3. **原生网络与并发模型**：Goroutine 与 Channel 天然适合处理网络长连接心跳与子进程管理。

### 4.2 核心第三方库
- `github.com/gorilla/websocket`：工业级成熟稳定的 WebSocket 客户端实现。
- `github.com/shirou/gopsutil/v3`：跨平台采集 Linux / Darwin / Windows 的 CPU、Memory、Disk、Net IO 指标。
- `github.com/sirupsen/logrus` 或 `go.uber.org/zap`：结构化日志输出。
- `google.golang.org/grpc` (v1.83.1) + `google.golang.org/protobuf`：访问 Sing-box `experimental.v2ray_api` 的本地 StatsService；仅携带最小生成客户端代码，不引入 V2Ray/Sing-box Go 运行时。
- `github.com/spf13/cobra`：扁平一级子命令（`install`、`uninstall`、`start`、`stop`、`restart`、`status`、`doctor`、`logs`、`run`、`version`）。
- `github.com/charmbracelet/bubbletea`：提供 raw mode、方向键事件、全屏备用缓冲区和异步命令消息循环；无参数运行时的 TUI 不依赖按行输入或数字菜单。
- `github.com/kardianos/service`：封装 Linux systemd/OpenRC/SysVinit、Windows Service 和 macOS Launchd 的注册与控制。
- `github.com/charmbracelet/lipgloss`：全屏 TUI 的 Banner、表单、状态卡片、结果页和诊断颜色。
- `github.com/mattn/go-isatty`：精准检测 Stdin / Stdout 真实终端控制台与 Cygwin/MSYS TTY，确保 Docker 容器与无交互环境静默运行后台守护进程、交互终端下唤起全屏 TUI。
- `gopkg.in/yaml.v3`：读写 `/etc/riri-agent/config.yaml`（Windows 使用 `%ProgramData%\RiriCloud\config.yaml`），并以环境变量覆盖容器运行时配置。
- `github.com/hashicorp/yamux`：轻量高可靠的流式多路复用库，支撑 Agent 原生内置基于 TLS/TCP 的双向反向穿透隧道，实现无公网 IP 内网主机（NAT/CGNAT 家宽 NAS/软路由）安全接入系统作为落地中继。

Docker 与发行包中的 Sing-box 使用 `with_v2ray_api,with_utls,with_quic,with_naive_outbound` 构建标签，以启用按用户流量统计、VLESS Reality、Hysteria2、TUIC 和 NaiveProxy 出站；Agent 仍保持 `CGO_ENABLED=0` 静态构建。

---

## 5. 代理核心对比 (Sing-box vs Xray-core)

| 特性维度 | Sing-box (本项目采用) | Xray-core |
| :--- | :--- | :--- |
| **现代协议支持** | 原生支持 VLESS-Reality、Hysteria2、TUIC、Shadowsocks、WireGuard 等 | 强力支持 VLESS-Reality、Trojan、VMess、XTLS |
| **内存与 CPU 开销** | 极低（Golang 原生精简架构） | 较低 |
| **配置文件格式** | 结构规范、层级极简清晰的 JSON | 历史包袱略多，配置项较繁琐 |
| **通用客户端生态** | Sing-box iOS/Android/Desktop 官方客户端、Clash Meta | v2rayN、v2rayNG、Shadowrocket |

## 6. 客户端内核职责与资源基线

主客户端 Mihomo 固定基线为 1.19.30，资产定义及官方 Release SHA-256 统一放在 `scripts/client-kernel-assets.json`，Docker、Master 发行包、本地准备与 E2E 共用；准备阶段校验归档与 ELF/PE/Mach-O 架构，运行时不自动下载或升级。Mihomo 不内嵌 Agent，也不改变服务端 Sing-box 技术栈。

订阅预览地理资源同样由该清单的 `validationResources` 固定：MetaCubeX/meta-rules-dat 的不可变提交 `a6544a371c34182ecec0363eafccd4ab3b93a58f`，包含 Country.mmdb、geoip.dat、geosite.dat 与 ASN.mmdb，实际字节总计约 38.6 MiB。准备脚本验证固定 SHA-256/大小后产生离线资源目录；运行时还必须匹配应用随包携带的 `scripts/client-kernel-assets.json`，资源目录自身清单不能替换固定地理资产，避免格式损坏触发内核自动下载。无新增 npm/Go 依赖。来源仓库 GPL-3.0，数据库还须遵守各上游数据许可（含 ASN 的 MaxMind 条款），来源与许可提示保留在清单。

连接结构/通用校验不依赖具体内核；Mihomo 和 Sing-box 客户端各自校验能力并独立编译。保留 Sing-box JSON 与 URI/Base64 为兼容/辅助格式，不因另一格式失败否定本格式。主拨测默认 Mihomo；仅明确不支持 Mihomo 且进入验证白名单的组合可回退 Sing-box，超时/鉴权/配置/环境错误不回退。缺 Cronet 等依赖应报环境不可用，不能标节点失效。

Mihomo 1.19.30 实测 delay API 对 HTTP 500/302 仍返回 delay，因此项目采用独立 Mihomo 回环 mixed 代理和 Node 标准 HTTP CONNECT/TLS 客户端进行严格响应状态与证书验证。临时内核只绑定回环、禁 TUN/自动健康检查/规则下载；所有验证/拨测共用全局 2 进程、4 连接限额，取消/异常后回收进程与凭据配置，不引入额外外部服务。

### 6.1 能力与验证证据矩阵

下表是当前固定版本的验证证据，不承诺每种参数组合或每个平台均已实测。能力层对未知参数和不可表达项明确拒绝；网络或配置失败不能扩大回退白名单。

| 连接/组合 | 默认客户端 | 当前 Windows / WSL Linux amd64 原生证据 | 回退边界 |
| :--- | :--- | :--- | :--- |
| HTTP 鉴权、VLESS/WS、SS AEAD、Hysteria2、TUIC | Mihomo | 真实 HTTP 204 请求，错误凭据拒绝；WS 错路径拒绝 | 不允许失败后回退 |
| VMess/WS、Trojan/gRPC、SS2022、SS obfs、ShadowTLS v3、TLS SOCKS5、HTTPS 代理 | Mihomo | 固定版本原生配置检查；不代表全部真实链路实测 | 不允许运行错误回退 |
| SOCKS4 / SOCKS4a | Sing-box 显式兼容 | 原生配置检查及真实代理 HTTP 204；MIHOMO_ONLY 返回 UNSUPPORTED | `MIHOMO_SOCKS_VERSION_UNSUPPORTED`，还须 Sing-box 能力可表达 |
| TLS 自定义证书信任 | Sing-box 显式兼容 | 原生检查及 HTTPS 代理鉴权真实请求，错误密码拒绝 | `MIHOMO_CERTIFICATE_UNSUPPORTED`；未白名单额外限制同时存在则拒绝 |
| NaiveProxy | Sing-box 显式兼容 | Windows 依赖不可用；WSL Linux/Cronet 真实 TLS HTTP/2 CONNECT + padding + 鉴权请求 204，通过；错误密码/不可信证书/错误 SNI/500 拒绝 | `MIHOMO_NAIVE_UNSUPPORTED`；MIHOMO_ONLY 启动前拒绝，依赖缺失报环境错误 |
| httpupgrade、自定义 HTTP headers、特定 TLS/mux/packet 参数 | 按能力明确拒绝 Mihomo | 单元拒绝与独立编译契约 | 不在回退白名单，不可静默丢弃参数 |

实际请求统一拒绝非预期 200/500/302、超时/取消，以及不可信/主机名不匹配的目标证书；测试 CA 下的 HTTPS 目标通过。WSL2 Debian 13 amd64 系统 Node20 和 Node22 测试容器已进行原生执行、隔离 HTTP/中继链路、Master/Agent Docker 构建/运行和 Linux Master 包装配/启动验证。Linux arm64/macOS 仍只有资产校验，不宣称原生执行；Naive 本轮为 HTTP/2，不包含 HTTP/3。

固定 Mihomo 启动时 listener 监听早于内部 Running 状态，版本 API/TCP 不足以判定数据面就绪；执行器使用独立回环 HTTP 204 自检屏障（DIRECT 仅属于该自检 listener），不访问业务目标、不计业务延迟。业务 listener 仍固定指定代理、无 DIRECT 回退，最终结果仍来自严格真实请求；自检也受全局连接槽与启动取消预算约束。
