# 部署与运维指南 (Deployment & Operations Guide)

## 1. 主控端 (Master) 部署

主控端集成了前端 Web 面板、后端 API、SQLite 数据库与 WebSocket 实时网关。

### 1.1 环境要求
- Node.js >= 20.0.0
- pnpm >= 9.0.0
- Linux / macOS / Windows Server
### 1.2 方式一：自包含发行包部署（推荐）

从 GitHub Release 下载 `riri-master_<version>_linux_amd64.tar.gz`（内置后端、Web 面板静态资源、Linux x64 本机 Agent、Sing-box 与全部生产依赖，目标机只需 Node.js >= 20）：

```bash
tar -xzf riri-master_<version>_linux_amd64.tar.gz && cd riri-master_<version>_linux_amd64
cp .env.example .env   # 编辑：JWT_SECRET、ADMIN_EMAIL、ADMIN_PASSWORD 必填
./start.sh             # 首启自动：生成 Prisma client → migrate deploy → admin/Master-Local bootstrap → 启动 Master
```

- 访问 `http://<host>:<port>` 即 Web 面板（生产模式下后端直接托管面板静态资源，非 `/api` 路径自动 SPA 回退）；生产环境出于安全考虑默认禁用 Swagger API 文档（返回 404），如需排查联调可在 `.env` 中设置 `ENABLE_SWAGGER=true` 后访问 `/api/docs`。
- 首次启动空数据库时，bootstrap 按 `ADMIN_EMAIL`、`ADMIN_PASSWORD` 创建首个管理员；兼容旧配置 `SEED_ADMIN_EMAIL`、`SEED_ADMIN_PASSWORD`，不再提供生产默认管理员密码。
- 生产环境 `AUTO_SEED=false` 时创建管理员、内嵌默认订阅模板和系统保留的 `Master-Local`，不会创建演示用户、套餐和线路；Docker 入口与发行包 `start.sh` 会在生产模式拒绝 `AUTO_SEED=true`。开发/演示环境明确设置 `AUTO_SEED=true` 才会额外执行完整演示 seed。内嵌模板允许管理员通过模板编辑器修改，但不能删除。
- 重置已有管理员密码：`./admin-reset.sh --email admin@example.com`（默认隐藏交互输入，新密码需同时包含大小写字母、数字和特殊字符）；自动化场景可用 `printf '%s\n' 'New-admin-password1!' | ./admin-reset.sh --email admin@example.com --password-stdin`。该命令不会创建或提权账号。
- 主控采用双层二进制分发仓：持久运行态仓 `data/binaries/`（支持多架构上传、热更新与缓存，优先级最高）与静态内置仓 `binaries/`（发行包仅精准内置当前宿主架构的本机 Agent 与 Sing-box）。远端不同架构 VPS 节点若需下载安装或升级，可将目标架构文件放入持久卷 `data/binaries/` 或在后台导入。生产环境建议在「系统设置 → 基础与品牌」配置 `publicBaseUrl=https://<master-domain>`；未配置时，节点管理请求会按反向代理的 `X-Forwarded-Proto` 与 `X-Forwarded-Host` 自动匹配当前网站域名，也可设置 `RIRICLOUD_PUBLIC_URL=https://<master-domain>` 作为环境变量兜底。只有显式设置 `RIRICLOUD_TRUST_PROXY=true` 时才信任 `X-Forwarded-For`，不得把该开关暴露给不受信任的直连客户端。

### 1.3 方式二：源码构建与运行

```bash
# 1. 克隆代码并安装依赖
pnpm install

# 2. 生成 Prisma 数据库迁移与客户端（开发态）
pnpm --filter @riricloud/server exec prisma migrate dev

# 3. 构建前端与后端
pnpm --filter @riricloud/web build
pnpm --filter @riricloud/server build

# 4. 生产启动（web 构建产物由 server 托管，启动时自动应用数据库迁移与管理员引导）
pnpm --filter @riricloud/server start:prod
```

> 源码方式下请先在当前 shell 或 `apps/server/.env` 设置强随机 `JWT_SECRET` 与首次启动所需的 `ADMIN_EMAIL`、`ADMIN_PASSWORD`；`start:prod` 会自动先行执行 `prisma migrate deploy` 与 `bootstrap-admin.js`，已有管理员时安全跳过；服务启动 15 秒后 `TrafficCleanupService` 还会自动在后台平滑归拢存量未聚合的历史流量明细。`start:prod` 同时会探测并托管 `apps/web/dist`（monorepo 布局自动命中）。

根目录 `pnpm build` 可一次构建三端：Server 输出保留在 `apps/server/dist/`，Web 输出保留在 `apps/web/dist/`，当前平台 Agent 输出到 `artifacts/dev/agent/<os>-<arch>/riri-agent[.exe]`。其中两个 `dist/` 是框架和运行时的约定目录，不与可分发二进制产物混放。

Agent 编译统一由 `scripts/build-agent.sh` 负责：

```bash
pnpm build:agent                                    # 当前平台，开发模式
pnpm build:agent:all                                # Linux/macOS/Windows 五个平台
pnpm build:agent -- --target linux/amd64 --release  # 指定平台，发布模式
```

发布脚本也复用同一入口，发布模式会启用 `-s -w` 去除符号和调试信息；所有构建仍强制 `CGO_ENABLED=0`，并通过 `-ldflags` 注入根 `package.json` 的统一版本号。构建与打包脚本（`build-agent.sh`、`build-binaries.sh`、`bundle-master.sh`、`gate-agent.sh`、`docker-build.sh`、`release.sh`）在 Linux / WSL 环境下严格强制使用当前系统的原生 Linux `go`、`node` 与 `pnpm` 工具链，**严禁回退调用 Windows 宿主机的 `.exe` / `.cmd` 工具链**（防止 WSL 跨系统调用丢失 `GOOS`/`GOARCH` 导致编译出错误的 Windows PE 二进制）；同时在缓存复用、编译完成、内嵌归档打包与 Agent 运行时释放全链路强制校验二进制文件头（ELF / Mach-O / PE 及 CPU 架构）。

### 1.4 方式三：Docker Compose

仓库根目录提供主控 `Dockerfile`、边缘节点 `Dockerfile.agent`、默认协同编排 `docker-compose.yml` 与离线运行模板 `docker-compose.image.yml`。

两个 Dockerfile 的 Agent 编译阶段统一使用 digest 固定的 Go 1.26 基础镜像，必须与 `apps/agent/go.mod` 的 `go 1.26.0` 保持一致或更高；构建不依赖 `GOTOOLCHAIN=auto` 在线下载额外工具链。

在解耦架构下，**Docker Compose 默认同时拉起 `master` 与 `agent`（Master-Local 本机节点）两个独立容器**：
- **Master 容器**：专注控制平面与 Web 面板，仅暴露 3000 端口，不托管业务 Agent；Sing-box 服务端分发基线仍保留，独立客户端 Mihomo 放置于 `/usr/local/bin/mihomo`，Sing-box 兼容客户端位于 `/usr/local/bin/sing-box`。ClientKernelsService 统一版本/路径画像，ProbeService 默认 Mihomo 真实端到端，模板按对应格式验证，不无条件执行双内核。客户端内核只作受管临时子进程，不暴露控制/代理端口到公网。
- **Agent 容器（Master-Local）**：独立容器运行，镜像通过 `AGENT_IMAGE`（默认 `riricloud/agent:latest`）注入；采用 `network_mode: host` 与 `NET_ADMIN` 能力直接监听宿主机网络，并通过 `MASTER_LOCAL_AGENT_TOKEN` 环境变量与 Master 服务端完成 Token 预置与生命周期对接。

Docker 构建、镜像导出和 Compose 运行均应在 Linux shell 执行；Windows 开发环境必须使用 WSL（且 WSL 内须安装原生 Linux `node` 与 `pnpm`，严禁调用 Windows `node.exe`），PowerShell/Git Bash 不直接承担 Docker 操作：

```bash
cp .env.example .env  # 或手动创建 .env
# 填写 JWT_SECRET、RIRICLOUD_ENCRYPTION_KEY、ADMIN_EMAIL、ADMIN_PASSWORD、MASTER_LOCAL_HOST；可选填写 MASTER_LOCAL_AGENT_TOKEN 与 AGENT_IMAGE
pnpm docker:build
pnpm docker:up
```

Windows 开发机可从 PowerShell 调用 WSL，但实际命令必须在 WSL 内执行：

```powershell
wsl.exe -d Ubuntu -- bash -lc "cd /path/to/riricloud && pnpm docker:build"
```

`scripts/docker-build.sh` 会拒绝 `MSYS` / `MINGW` 等原生 Windows shell，并检查 Docker daemon 是否为 Linux containers。`pnpm docker:tags` 只输出当前版本对应的完整镜像标签，不需要连接 Docker daemon。

也可直接通过脚本执行构建与启动：

```bash
bash scripts/docker-build.sh build
bash scripts/docker-build.sh up
```

脚本会自动读取根 `package.json`（Master 版本）与 `apps/agent/VERSION`（Agent 版本），并为两个组件分别打标：

```text
riricloud/master:<master-version>
riricloud/master:latest
riricloud/agent:<agent-version>
riricloud/agent:latest
```

主控和 Agent Dockerfile 使用 Dockerfile heredoc 执行内置资源 `manifest.json` 的生成脚本，要求使用支持 `# syntax=docker/dockerfile:1` 的 BuildKit 构建器；脚本会继续为 Agent、Sing-box 和 `libcronet.so` 写入文件大小及 SHA-256。

同一次构建默认还会把镜像导出到 `artifacts/docker/<os>-<arch>/`。该目录已加入 `.dockerignore`，不会再次进入 Docker 构建上下文：

```text
artifacts/docker/linux-amd64/riricloud-master_<master-version>_linux_amd64.tar.gz
artifacts/docker/linux-amd64/riricloud-agent_<agent-version>_linux_amd64.tar.gz
artifacts/docker/linux-amd64/riricloud-docker-images_<master-version>_linux_amd64.manifest.json
artifacts/docker/linux-amd64/riricloud-docker-images_<master-version>_linux_amd64.sha256
```

导出包内同时保留版本标签和 `latest` 标签；manifest 记录组件、标签、平台、Sing-box 版本、OCI 元数据和 SHA-256。只导出现有镜像可执行 `pnpm docker:export`，查看本次构建的完整标签可执行 `pnpm docker:tags`。导出目录可通过 `DOCKER_EXPORT_DIR=/path/to/output` 覆盖，构建但不导出可使用 `DOCKER_EXPORT=false pnpm docker:build`。镜像归档、校验文件和 manifest 全部成功生成后，脚本默认自动删除 Docker daemon 中本次导出的四个镜像标签，避免 WSL 中长期积累 Master/Agent 镜像；设置 `DOCKER_CLEANUP=false pnpm docker:export` 可保留本地镜像。该清理不会删除 `artifacts/docker/` 导出包、BuildKit 依赖缓存或其他无关镜像；若镜像仍被容器使用，脚本会告警并保留无法删除的镜像。

运行时镜像使用 Distroless 基础镜像。Master 镜像约 `376 MB`、压缩导出包约 `87 MB`；Agent 镜像约 `155 MB`、压缩导出包约 `38 MB`。Master 容器启动入口自动执行 `migrate deploy`、管理员 bootstrap 和 `Master-Local` bootstrap，并可通过 `MASTER_LOCAL_AGENT_TOKEN` 自动为本机节点对齐通信凭证。容器内显式重置管理员密码命令为：

```bash
docker compose exec master /nodejs/bin/node /app/prisma/admin-reset.js --email admin@example.com
printf '%s\n' 'New-admin-password1!' | docker compose exec -T master /nodejs/bin/node /app/prisma/admin-reset.js --email admin@example.com --password-stdin
```

Compose 在 Linux/WSL 下使用 `network_mode: host`，`MASTER_PORT` 控制 Master 面板监听端口（默认 3000）；Agent 容器直接在 host 网络中监听配置的入站 TCP/UDP 端口。持久化目录：Master 为 `${MASTER_DATA_PATH:-./data}:/app/data`，Agent 为 `${AGENT_DATA_PATH:-./data/agent}:/var/lib/riri-agent`。

> **挂载权限与启动自检说明**：
> - 官方镜像基于 Distroless 默认以 `65532:65532` 非 Root 安全用户运行。宿主机首次拉起时，建议预先确保数据目录可写：`chmod -R 777 ./data ./data/agent` 或 `sudo chown -R 65532:65532 ./data ./data/agent`；
> - 主控入口内置**全链路前置启动诊断机制**，在执行数据库迁移前自动预检数据目录可写性、SQLite 探测锁创建、存量 db/wal 文件及核心密钥。若检测到权限受限，控制台将输出格式化的现场取证与一键修复卡片；
> - 在 VPS 上以 root 用户（或位于 `/root/` 目录）部署时，可在 `.env` / `.env.image` 设置 `DOCKER_USER=0:0`，使容器进程直接以宿主机身份运行，彻底免去宿主机权限调整。

导入离线镜像时，在目标 Docker 环境执行：

```bash
gzip -dc artifacts/docker/linux-amd64/riricloud-master_<master-version>_linux_amd64.tar.gz | docker load
gzip -dc artifacts/docker/linux-amd64/riricloud-agent_<agent-version>_linux_amd64.tar.gz | docker load
(cd artifacts/docker/linux-amd64 && sha256sum -c riricloud-docker-images_<master-version>_linux_amd64.sha256)
```

仓库提供 `docker-compose.image.yml` 与 `.env.image.example`，默认已配置使用 Docker Hub 官方在线镜像（`2chariko/riricloud-master:latest` 与 `2chariko/riricloud-agent:latest`），亦支持导入的离线镜像包或 GHCR 备用源：

**方式 A：从 Docker Hub 官方镜像在线拉取运行（推荐，默认 `pull_policy: if_not_present`）**

只需准备 `.env.image` 配置文件，无需本地预先构建即可一键拉取并启动：

```bash
cp .env.image.example .env.image
# 编辑 .env.image：填写 JWT_SECRET、RIRICLOUD_ENCRYPTION_KEY、ADMIN_EMAIL、ADMIN_PASSWORD 等必要环境配置
docker compose --env-file .env.image -f docker-compose.image.yml pull
docker compose --env-file .env.image -f docker-compose.image.yml up -d
```

默认配置下 `docker-compose.image.yml` 会自动从 Docker Hub 拉取：
- `MASTER_IMAGE`: `2chariko/riricloud-master:latest`
- `AGENT_IMAGE`: `2chariko/riricloud-agent:latest`

**方式 B：从 GitHub Packages (GHCR) 在线拉取或运行离线导入镜像**

若需切换至 GitHub Packages (GHCR) 或离线包导入，可在 `.env.image` 中覆盖指定：

```env
# 选项 1：切换为 GHCR 备用源
MASTER_IMAGE=ghcr.io/2chariko/riricloud-master:latest
AGENT_IMAGE=ghcr.io/2chariko/riricloud-agent:latest
IMAGE_PULL_POLICY=if_not_present

# 选项 2：运行本地导入的离线镜像包（设置 pull_policy 为 never）
# MASTER_IMAGE=riricloud/master:0.9.5
# AGENT_IMAGE=riricloud/agent:0.8.5
# IMAGE_PULL_POLICY=never
```

> 官方镜像流水线采用双 Registry 并行分发与严格双轨解耦：发布 `vX.Y.Z` Release 时主控镜像（`riricloud-master`）自动打上 `vX.Y.Z`、`X.Y.Z` 与 `latest` 标签；发布 `agent-vA.B.C` Release 时边缘节点镜像（`riricloud-agent`）自动打上 `agent-vA.B.C`、`vA.B.C`、`A.B.C` 与 `latest` 标签（同时支持通过 GitHub Actions `workflow_dispatch` 手动按需触发构建）。构建过程自动同步推送至 Docker Hub 与 GHCR。

停止并清理容器：

```bash
pnpm docker:down
```

### 1.5 Nginx 反向代理与订阅伪静态链接

生产环境建议让 Nginx 作为唯一边缘代理，负责 HTTPS 终止、域名入口、订阅短链 rewrite、WebSocket Upgrade 和限流；Master 只监听内网地址并继续提供标准 API。配置示例位于 `scripts/nginx/riricloud.conf.example`，其中默认上游为 `http://127.0.0.1:3000`。Master 自身默认拒绝未列入 `CORS_ORIGINS` 的跨域来源，并设置 CSP、HSTS、`nosniff`、Frame 防护和 `no-referrer`；只有确认代理链可信时才设置 `RIRICLOUD_TRUST_PROXY=true`。

```bash
sudo cp scripts/nginx/riricloud.conf.example /etc/nginx/conf.d/riricloud.conf
sudo nginx -t
sudo systemctl reload nginx
```

示例默认提供以下行为：

- 严格匹配 `/<UUID>`，内部 rewrite 到 `/api/v1/sub/<UUID>`，不覆盖查询参数；`?type=clash`、`?type=sing-box` 和客户端 `User-Agent` 会继续参与后端格式协商。
- `/ws/agent` 使用 HTTP/1.1 并转发 `Upgrade`、`Connection`，生产 Agent 地址使用 `wss://<domain>/ws/agent`。
- `/api/**`、`/login`、`/admin`、SPA 路由和其他请求继续代理给 Master，不会被短链规则捕获。
- 示例将 `client_max_body_size` 设置为 `2m`，与 Master 的 JSON/表单请求体上限一致；若自定义 Nginx 配置，请保留该值或更大值，否则大模板保存可能在到达 Master 前返回 HTTP `413`。
- 代理统一传递 `Host`、`X-Real-IP`、`X-Forwarded-For`、`X-Forwarded-Proto` 和 `X-Forwarded-Host`。

管理员在「系统设置 → 订阅与分发」开启「使用 Nginx 伪静态短链接」后，用户页面会展示 `https://domain.com/<UUID>`。若 `subscriptionBaseUrl` 设置为 `https://domain.com/panel`，前端会展示 `https://domain.com/panel/<UUID>`，必须同时把示例中的短链 location/rewrite 改成 `/panel/` 前缀。开关只改变展示地址，不会自动检测 Nginx 配置；配置不一致时应先关闭开关或修正 Nginx。

短链只支持 GET 和严格 UUID 单段路径。Token 失效、订阅过期或账号被禁用时，仍由 Master 返回现有 404/403 响应。HTTPS 证书、域名 DNS、访问控制和限流属于 Nginx/部署环境职责。

---

## 2. 节点端 (Edge Node Agent) 部署

### 2.1 方式一：原生 CLI 一键安装（推荐）
在主控面板点击“添加节点”后，复制对应的原生 CLI 命令，登录节点 VPS 终端以 root 身份执行。命令从主控拉取按平台与镜像设置渲染的安装脚本，由脚本完成下载与安装。

**下载顺序（三级回退）**：GitHub Release 直连 → GitHub 加速镜像（`系统设置 → Agent 运维 → GitHub 加速镜像列表`，内置默认公共镜像）→ 主控内置二进制。安装脚本对直连与镜像逐个做 128KB Range GET 测速（单源 6 秒超时），选择最快可用源；发布资产附带 `checksums.txt`，下载后强制 SHA-256 校验。

Linux / macOS（POSIX）：

```bash
read -r -s -p 'AgentToken: ' RIRI_AGENT_TOKEN; echo; export RIRI_AGENT_TOKEN
curl -fsSL --location -A 'riri-agent-installer/linux-amd64'   -H "X-Agent-Token: $RIRI_AGENT_TOKEN"   'https://<master-domain>/api/v1/downloads/agent-installer?mode=ws'   -o /tmp/riri-agent-install.sh && sh /tmp/riri-agent-install.sh --master='wss://<master-domain>/ws/agent' &&   rm -f /tmp/riri-agent-install.sh
```

如果节点所在网络不支持 WebSocket Upgrade，可在安装向导切换为 HTTP 模式（`?mode=http` 且 `--master='https://<master-domain>'`）。

#### CLI 安装步骤：
1. 主控面板的安装命令弹窗支持选择目标操作系统（Linux / macOS / Windows）与部署方式（原生安装 / 免安装运行 / Docker），命令由主控按选择动态生成；也可参考下方示例手工执行。
2. User-Agent 使用 `riri-agent-installer/<os>-<arch>` 声明目标平台，例如 `linux-amd64`、`linux-arm64`、`macos-arm64` 或 `windows-amd64`；安装脚本端点 `GET /api/v1/downloads/agent-installer` 据此渲染脚本。
3. 安装脚本从 GitHub Release（`agent-v<AGENT_VERSION>` Tag）下载 `riri-agent_<ver>_<os>_<arch>.tar.gz`（Windows 为 zip）并用 `checksums.txt` 校验；镜像列表与仓库地址取自系统设置。主控缺该平台内置二进制时前端会提示“将从 GitHub Release 下载”。
4. `riri-agent install` 将 Sing-box 优先从主控 `GET /api/v1/downloads/binaries/singbox-<os>-<arch>` 下载；主控没有该资产时，`--singbox-source auto` 回退到 GitHub Release（安装脚本注入的 `GITHUB_MIRRORS` 环境变量同样作用于该回退路径）。
5. 默认写入 `/etc/riri-agent/config.yaml`（权限 `0600`）与 `/var/lib/riri-agent/`，配置包含 Token、Master 地址、通信模式、内核路径和日志路径；Windows 写入 `%ProgramData%\RiriCloud\`。
6. 基于 `kardianos/service` 注册并启动开机服务：Linux 使用 systemd/OpenRC/SysVinit，macOS 使用 Launchd；Windows 注册 Windows Service。Agent 二进制内置 Windows 服务入口（检测到 SCM 上下文时自动接入服务控制管理器的启动/停止生命周期），因此 Windows 服务的启动、停止与重启均由 SCM 正常驱动。

**Windows 原生安装示例**（以管理员身份运行 PowerShell）：

```powershell
$Token = Read-Host 'AgentToken'
curl.exe -fsSL --location -A 'riri-agent-installer/windows-amd64' `
  -H "X-Agent-Token: $Token" `
  'https://<master-domain>/api/v1/downloads/agent-installer?mode=ws' `
  -o "$env:TEMP\riri-install.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\riri-install.ps1" -MasterUrl 'wss://<master-domain>/ws/agent' -AgentToken $Token
Remove-Item "$env:TEMP\riri-install.ps1" -ErrorAction SilentlyContinue
```

#### 免安装直接运行（便携模式）
无需写入系统目录或注册服务，仅凭 `AGENT_TOKEN` 环境变量即可前台运行；连接 Master 失败会持续重试，sing-box 配置完全由 Master 下发。若内核二进制缺失，Agent 会在后台自动下载（默认 `auto`：先主控后 GitHub，可用 `--singbox-source none` 关闭）。该模式适合临时验证、无法注册服务的受限环境以及 Windows 上的快速体验：

```bash
# Linux / macOS（数据目录 $HOME/.riri-cloud，Ctrl+C 停止）
read -r -s -p 'AgentToken: ' RIRI_AGENT_TOKEN; echo
curl -fsSL --location -A 'riri-agent-installer/linux-amd64' \
  -H "X-Agent-Token: $RIRI_AGENT_TOKEN" \
  'https://<master-domain>/api/v1/downloads/agent' \
  -o /tmp/riri-agent && chmod +x /tmp/riri-agent && \
  RIRICLOUD_DATA_DIR="$HOME/.riri-cloud" AGENT_TOKEN="$RIRI_AGENT_TOKEN" \
  MASTER_URL='wss://<master-domain>/ws/agent' /tmp/riri-agent run
```

```powershell
# Windows（数据目录 %LOCALAPPDATA%\RiriCloud，Ctrl+C 停止）
$Token = Read-Host 'AgentToken'
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\RiriCloud" | Out-Null
curl.exe -fsSL --location -A 'riri-agent-installer/windows-amd64' `
  -H "X-Agent-Token: $Token" `
  'https://<master-domain>/api/v1/downloads/agent' `
  -o "$env:LOCALAPPDATA\RiriCloud\riri-agent.exe"
$env:RIRICLOUD_DATA_DIR = "$env:LOCALAPPDATA\RiriCloud"
$env:AGENT_TOKEN = "$Token"
$env:MASTER_URL = 'wss://<master-domain>/ws/agent'
& "$env:LOCALAPPDATA\RiriCloud\riri-agent.exe" run
```

`riri-agent run` 支持 `--singbox-source`（auto/master/github/none，环境变量 `SINGBOX_SOURCE`）、`--singbox-url` 与 `--singbox-version` 控制内核自举来源；显式设置 `SINGBOX_BINARY_PATH` 时视为用户自管内核，不做自动下载。

常用生命周期命令：

```bash
riri-agent status
riri-agent doctor
riri-agent logs --follow --lines 100
riri-agent restart
riri-agent uninstall --purge --yes
```

> **Agent 环境变量**：`AGENT_TOKEN`、`MASTER_URL`、`AGENT_MODE`、`POLL_INTERVAL_SECS`、`HEARTBEAT_SECS`、`SINGBOX_CONFIG_PATH`、`SINGBOX_BINARY_PATH`、`SINGBOX_SOURCE`、`RIRICLOUD_LOG_PATH`、`RIRICLOUD_LOG_MAX_SIZE_MB` 与 `RIRICLOUD_LOG_MAX_FILES` 可覆盖 YAML 配置；`MASTER_WS_URL` 继续兼容旧版 Agent。日志轮转默认单文件 50 MiB、总计 5 个文件（包含当前文件），有效范围分别为 1~1024 MiB 与 1~20 个；Master 下发的有效 `agentLogRotation` 优先于本地 YAML/环境变量。安装后的标准配置路径为 Linux/macOS `/etc/riri-agent/config.yaml`，Windows `%ProgramData%\RiriCloud\config.yaml`。

直接在连接终端中运行 `riri-agent`（不带子命令）会进入 Bubble Tea 全屏控制台 GUI/TUI：使用方向键选择菜单，Enter 执行，Esc 返回，q 退出；安装页提供 AgentToken、Master URL 和通信模式表单，长诊断/日志输出可在结果页滚动查看。脚本、服务管理器、内置 Agent 和无 TTY 环境继续使用上面的一级子命令，不依赖交互输入。

### 2.2 方式二：Docker 容器化部署
如果节点偏好容器化环境，可直接通过 Docker 启动（默认从 Docker Hub 拉取官方镜像）：

```bash
docker run -d \
  --name riri-agent \
  --restart always \
  --network host \
  -e AGENT_TOKEN="<YOUR_AGENT_TOKEN>" \
  -e MASTER_WS_URL="wss://<master-domain>/ws/agent" \
  2chariko/riricloud-agent:latest
```

HTTP 容器模式只需替换为：

```bash
  -e MASTER_URL="https://<master-domain>" \
  -e AGENT_MODE="http" \
  -e POLL_INTERVAL_SECS="15" \
```

### 2.3 本地一键联调（开发）

`scripts/dev-e2e.sh` 一键拉起全套本地联调环境（主控 + Web 面板 + Agent + 真实 sing-box 内核）：

```bash
bash scripts/dev-e2e.sh                  # 全套启动并跟踪 Agent 日志，Ctrl+C 退出
SKIP_WEB=1 bash scripts/dev-e2e.sh       # 不启动 Web 面板
NODE_PORT=9443 USE_MASTER_LOCAL=0 bash scripts/dev-e2e.sh # 使用独立联调节点并自定义端口
E2E_SYNC_RESOURCES=0 bash scripts/dev-e2e.sh # 跳过本地构建产物同步
```

- 脚本默认使用独立的 `apps/server/prisma/dev-e2e.db` 联调数据库，再检查并应用数据库迁移，数据库首次创建时执行种子播种；这样即使本地 `3000` 端口的手动开发主控正在运行，也不会与其共享 SQLite WAL 写锁。可通过 `E2E_DATABASE_URL` 显式指定要复用的 SQLite URL；若主控已经在运行则跳过迁移，复用时需由调用者确保目标主控与该数据库匹配。随后自动完成管理员登录，优先使用显式 `ADMIN_EMAIL`/`ADMIN_PASSWORD`，其次读取 `apps/server/.env` 中的正式或兼容 `SEED_ADMIN_*` 配置，最后才回退到本地演示默认值；也可通过 `SERVER_ENV_FILE` 指定凭据配置文件。使用临时权限受限 Cookie jar 调用管理 API（登录响应不再读取 `accessToken` JSON；解析器兼容 curl Netscape 格式的 `#HttpOnly_` Cookie 标记）。登录失败时会显示 HTTP 状态和对应排查提示，不再直接暴露 `curl (22)`。脚本默认复用 seed 预置的 `Master-Local` 节点，并通过本地 Prisma bootstrap helper 读取其 AgentToken（节点列表 API 已脱敏，不再返回凭证），再构建并启动 Agent。`SINGBOX_BINARY_PATH` 可显式指定内核；未指定时脚本会按当前系统与 CPU 架构自动过滤候选文件，Linux 优先查找 `.cache/sing-box-v2ray-api/<version>/linux-<arch>/sing-box`，Windows 优先查找 `.exe`，并通过 `sing-box version` 验证文件确实可执行。如需使用独立联调节点，可设置 `USE_MASTER_LOCAL=0`，脚本会按 `127.0.0.1:<NODE_PORT>` 查找或创建节点；复用既有独立节点时必须显式设置 `AGENT_TOKEN`，否则脚本会提示删除旧节点后重新创建对应端口的 VLESS Reality 线路。
- E2E 主库与遥测库 URL 在脚本启动时分别以 `prisma/` 与 `prisma/telemetry/` 的 schema 目录规范化成绝对 `file:` URL，文件存在判断、上游预检、迁移、种子、主控和 AgentToken helper 复用相同路径。双库部署入口也进行同样规范化；不要将 scratch/custom-output 客户端的生成文件复制进默认 Prisma client，Windows 引擎占用解除后从正式 schema 正常执行 `prisma generate`。
- 遇到 `P3018` / `backup_and_remove_legacy_upstream_before_upgrade` 应按迁移保护处理，不是写锁或 Prisma 未安装。开发者明确选择不保留专用 E2E 数据时，先确认相关服务已停止，再删除 `prisma/dev-e2e.db`、`prisma/telemetry/dev-e2e-telemetry.db` 及对应 WAL/SHM 后重新运行脚本；不要删除 `dev.db` 或生产库。脚本不会自动清库。两库重建后旧失败记录不保留，正常从空库迁移和播种。
- 默认资源同步版本跟随 `apps/agent/VERSION`，构建二进制与上传资源使用同一 Agent 版本；可通过 `E2E_AGENT_VERSION` 同时覆盖构建和资源版本。为兼容已有脚本，单独设置 `E2E_RESOURCE_VERSION` 也会作为 Agent 构建版本覆盖；若同时设置两个变量但值不一致，脚本会在启动前报错。`E2E_APP_VERSION` 只记录资源构建来源，不再用作 Agent 版本。设置 `E2E_SYNC_RESOURCES=0` 可跳过同步；`E2E_AGENT_RESOURCE_FILE`、`E2E_AGENT_RESOURCE_TARGET`、`E2E_SINGBOX_RESOURCE_FILE`、`E2E_SINGBOX_RESOURCE_TARGET` 和 `E2E_SINGBOX_RESOURCE_VERSION` 仍可覆盖资源文件、架构或 Sing-box 版本。
- 主控端默认尝试 `http://localhost:30800`（避开 Windows 系统保留与动态端口区间）；若未检测到可复用的服务且该端口无法绑定，脚本会自动向后探测最多 1000 个可用端口，并同步更新主控地址、Web API 代理地址和 Agent WebSocket 地址；实际使用的端口会记录在 `.cache/dev-e2e-server-port`，后续运行据此复用已在运行的主控端（不再因端口漂移而重复拉起）。若端口在探测与绑定之间被其他进程抢占（`EADDRINUSE`），脚本会顺延到下一个可用端口重试（默认 5 次，可用 `SERVER_START_ATTEMPTS` 调整）。可通过 `SERVER_PORT` 或 `PORT` 固定端口（固定后不自动顺延），或通过 `SERVER_PORT_SCAN_LIMIT` 调整探测范围。手动启动 Web 时可用 `VITE_API_PROXY_TARGET` 指定 `/api` 代理目标。应用自身的默认端口仍为 `3000`，联调端口仅作用于本脚本。
- 每次新启动的 E2E 主控使用 `apps/server/.cache/dev-e2e-server-*/tsconfig.json`，继承正式构建配置并写入该次独立 `dist`，不删除手动 `pnpm dev:server` 的输出或编译状态；退出或端口重试时只清理本次目录。即使旧 watcher 暂时未监听，也不会因为第二个 Nest 编译器清空共享 `dist` 而丢失入口。已在运行的服务仍按原规则复用，不自动终止其他开发进程。
- 新实例就绪要求本次进程存活、本次日志出现监听成功后的 `HTTP listener ready` 标记，以及版本接口可达；单独的 `Nest application successfully started` 或旧实例 HTTP 成功不算就绪。端口冲突/编译与启动错误优先结算。资源同步网络失败显示请求方法、接口路径及脱敏错误码（如 `ECONNREFUSED`/`UND_ERR_SOCKET`/`TIMEOUT`），不输出 Cookie/底层消息；读请求最多 15 秒、写请求最多 120 秒，不自动重试上传、激活或默认切换。
- 启动隔离回归：`node --test scripts/dev-e2e-server.test.mjs scripts/dev-e2e-sync-resource.test.mjs scripts/dev-e2e-agent-version.test.mjs`，覆盖旧实例响应不能冒充就绪、进程退出/端口冲突优先、真实 Nest CLI 相对配置并行构建及网络错误脱敏/不重试写入。2026-10-03 Windows Git Bash 验证完整 E2E 资源同步与 Agent/内核启动成功，常规 server 构建期间 23 次 API 检查无失败，原 1 个订阅、48 个上游节点、4 条线路及设置快照未变化；未修改 REST/WS 契约或清库。
- StatsService 默认监听 `127.0.0.1:10085`，Clash API 默认监听 `127.0.0.1:10086`；若这些端口在本地无法绑定（如落入 Windows WinNAT / Hyper-V 动态排除端口段或被占用），开发联调会自动探测可用端口并通过 `STATS_API_LISTEN` 与 `CLASH_API_LISTEN` 注入主控配置，Agent 也会在本地落盘前自动校验并重映射不可用的本地回环管理端口；Agent 会自动读取下发或重映射后的地址进行指标与设备连接轮询。也可手动设置 `STATS_API_LISTEN=127.0.0.1:xxxx` 或 `CLASH_API_LISTEN=127.0.0.1:yyyy`。
- 开发联调启动的 Agent 会显式使用非交互模式，避免 Git Bash 后台进程误判为 Bubble Tea 终端并触发无效 console handle 错误。
- 开发联调要求 Sing-box 启用 `with_v2ray_api`、`with_utls`、`with_quic` 和 `with_naive_outbound`。脚本会先按当前系统与 CPU 架构选择可执行的内核并检查这些标签；如果缓存中没有匹配版本，脚本会使用项目内 Go 工具链从 `SINGBOX_VERSION`（默认 `1.14.0`）源码构建并缓存到 `.cache/sing-box-v2ray-api/`。显式设置 `SINGBOX_BINARY_PATH` 时，若文件无法执行或缺少所需标签会直接报错，不会静默切换到其他内核。
- 未显式设置 `JWT_SECRET` 时，脚本会为本地联调生成强随机密钥并按数据库 URL 维度持久化到 `.cache/dev-e2e-secrets/`（同一联调数据库始终复用同一密钥），既避免空白开发 `.env` 阻止主控启动，也保证持久复用的联调库中加密凭据（Master-Local AgentToken 等）跨运行可解密；显式提供的 `JWT_SECRET` 优先但不落盘，若与目标数据库历史密钥不一致会出现解密失败，需换用历史密钥或删除该联调库重建。生产环境仍必须按源码部署要求手动配置强随机密钥。Cookie 会话仅在本次脚本生命周期内使用，退出时清理临时 jar。
- 已在运行的主控/Web 服务会被复用而非重启；脚本退出时按进程树回收其自身启动的主控/Web/Agent 进程（Windows 下使用 `taskkill /T`，避免 pnpm 派生的 `nest`/`sing-box` 子进程成为孤儿继续占用端口）。若主控端口发生变化，需先停止旧的 5173 Web 进程，再重新执行脚本，使 Vite 重新读取 API 代理目标。
- 若主控进程启动失败，脚本会立即输出 `server.log` 最近 40 行并退出，不再静默等待完整超时；迁移、登录或节点准备阶段失败也会回收本次已启动的主控/Web 进程。
- 可验证的内核行为：配置下发拉起（含 `sing-box check` 预检）、本地 StatsService 监听实际选定地址、面板编辑线路后优雅重启热应用、`taskkill` 内核后自动重拉、关闭 Agent 无残留进程。

---

## 3. 版本发布与产物分发

### 3.1 CI 质量门禁（自动）
PR 与 main 推送自动触发 `.github/workflows/ci.yml`：三端门禁（server tsc/lint/test/build、web tsc/lint/build、agent vet/gofmt/test/build）+ 安全审计（`pnpm audit --audit-level high`、`govulncheck`）。CI 未全绿禁止合并（见 [CODE_REVIEW.md](./CODE_REVIEW.md) §2）。

已评估豁免的 npm advisory 在根 `package.json` 的 `pnpm.auditConfig.ignoreGhsas` 登记（附 GHSA 编号与理由）。

### 3.2 发布流程（本地脚本）
发布不依赖 GitHub Actions，在本地执行（Git Bash，需已登录 `gh` CLI）。Master 与 Agent 采用独立发布的双轨流程：

```bash
# 1. 发布 Master 主控端（缺省模式，Tag 为 vX.Y.Z）
pnpm release:master          # 或 bash scripts/release.sh --master [vX.Y.Z]

# 2. 发布 Agent 边缘程序（Tag 为 agent-vA.B.C）
pnpm release:agent           # 或 bash scripts/release.sh --agent [agent-vA.B.C]
```

脚本自动完成（流程约定见 [VERSIONING.md](./VERSIONING.md) §6）：

1. 前置校验：main 分支、工作区干净且与远端同步、目标 Tag 与对应版本源一致（Master 对齐 `package.json`，Agent 对齐 `apps/agent/VERSION`）、CHANGELOG 存在对应版本小节、Release 未重复创建；
2. 在 Tag 指向的提交上（`git worktree` 隔离检出，不污染工作区）复跑对应质量门禁；
3. **Master 发布构建**：
   - 准备目标架构（`linux-amd64`）的内置 Agent 与 Sing-box 二进制；
   - 装配**主控端生产发行包**（`riri-master_${VERSION}_linux_amd64.tar.gz`，包含 `pnpm --prod deploy` 生产依赖 + `web-dist/` 面板资源 + `start.sh`/`admin-reset.sh`/README/.env.example）；
   - 输出至 `artifacts/packages/master/`，生成单项校验和文件；
   - 创建 GitHub Release (`vX.Y.Z`)，仅挂载主控包与校验和，彻底解耦 Agent 归档包。
4. **Agent 发布构建**：
   - 交叉编译 Agent 5 大平台产物（`CGO_ENABLED=0` + `-trimpath`，版本号经 `-ldflags` 注入）：`linux/amd64`、`linux/arm64`、`darwin/amd64`、`darwin/arm64`、`windows/amd64`；
   - 打包 tar.gz / zip 输出至 `artifacts/packages/agent/` 并生成校验和文件；
   - 创建 GitHub Release (`agent-vA.B.C`)，仅挂载这 5 个平台的 Agent 归档包与校验和。

产物输出目录结构如下（按发布目标物理隔离）：

```text
artifacts/packages/
├── master/                      # Master 发布产物
│   ├── riri-master_<version>_linux_amd64.tar.gz
│   ├── checksums.txt
│   └── release-notes.md
└── agent/                       # Agent 发布产物
    ├── riri-agent_<agent_version>_linux_amd64.tar.gz
    ├── riri-agent_<agent_version>_linux_arm64.tar.gz
    ├── riri-agent_<agent_version>_darwin_amd64.tar.gz
    ├── riri-agent_<agent_version>_darwin_arm64.tar.gz
    ├── riri-agent_<agent_version>_windows_amd64.zip
    ├── checksums.txt
    └── release-notes.md
```

### 3.3 节点 Agent 升级
节点详情「升级中心」默认从主控 `/api/v1/downloads/binaries/:target` 下载对应架构版本，校验 SHA-256 后执行原子替换；主控不具备对应 Sing-box 架构时，管理员可在面板导入自定义 URL 与 SHA-256 后再下发。Agent 也可通过详情页快捷重启并保留原始启动参数。

### 3.4 主控端升级
下载新版本 `riri-master_*.tar.gz` → 停服 → 解压新包替换目录 → 拷回旧目录的 `.env` 与 `prisma/data/` 数据目录 → `./start.sh`（数据库迁移自动执行，数据与 `.env` 独立于程序目录，升级不丢数据）。

### 3.5 v0.5.0 Master-Agent 协议升级与回滚

由于 Master v0.5.0 拒绝协议 v1，生产发布必须按以下顺序执行，不能让新旧版本同时在线：

1. 停止或替换全部旧版 Agent，确认旧 Agent 不再向 Master 发送心跳。
2. 备份 SQLite 数据库，至少保存主文件以及同目录下的 `dev.db-wal`、`dev.db-shm`（实际文件名以 `DATABASE_URL` 为准）。
3. 编译并分发 v0.5.0 Agent，先不要启动切换后的 Agent。
4. 停止旧 Master，部署 v0.5.0 Master，执行 `prisma migrate deploy` 创建 `TrafficCursor`。
5. 启动新 Master，确认 WAL、写入队列和数据库迁移日志正常，再启动全部 v0.5.0 Agent。
6. 观察 `traffic counter reset detected`、`agent write queue delayed`、`agent write slow` 和 Prisma 错误；重点核对 `TrafficCursor` 是否持续更新、重复快照是否没有产生重复流水。

### 3.6 Phase 2 时序与日志物理分库升级与维护（v0.9.2）

为彻底消除 SQLite 高频指标与海量日志写锁争用，系统采用双数据库物理隔离架构：
- **主业务数据库** (`DATABASE_URL`)：默认 `file:/app/data/riri.db`（Docker）或 `file:./dev.db`（开发），承载核心用户、节点、套餐、线路与业务账务。
- **时序与日志数据库** (`TELEMETRY_DATABASE_URL`)：默认 `file:/app/data/telemetry.db`（Docker）或 `file:./dev-telemetry.db`（开发），承载 `TrafficHourlyMetric`、`NodeRateMetric` 与 `SystemLog`。

**自动回退机制**：若用户未在 `.env` 中显式指定 `TELEMETRY_DATABASE_URL`，系统服务与部署脚本将自动推导同目录下的 `telemetry.db` 或 `dev-telemetry.db`，确保开箱即用平滑兼容。

**平滑升级与自动化数据迁移**：
1. 部署与启动时，Master 自动通过 `node prisma/deploy-databases.js` 统一执行：
   - 步骤 1：部署 `telemetry.db` 结构迁移（`prisma migrate deploy --schema=prisma/telemetry/schema.prisma`）。
   - 步骤 2：执行存量数据内联迁移（`node prisma/migrate-telemetry-data.js`），利用 SQLite `ATTACH DATABASE` 在数据库引擎内零拷贝复制旧表数据至新库，亚秒级完成数万行记录无损迁移。
   - 步骤 3：部署主库结构迁移（`prisma migrate deploy`），安全清理主库旧指标与日志表。
2. **备份建议**：在进行数据冷备或容灾时，请同步备份主库与时序库文件，包括：
   - `riri.db`、`riri.db-wal`、`riri.db-shm`
   - `telemetry.db`、`telemetry.db-wal`、`telemetry.db-shm`

管理员可在「系统设置 → 存储与日志」维护小时流量、节点速率、系统日志和 Agent 本地日志策略；策略保存不会立即删除数据。系统日志每小时自动清理，小时汇总、节点速率与旧版 `TrafficLog` 每 12 小时自动清理，旧版明细固定按 7 天过渡保留。手动清理使用 `/admin/telemetry/cleanup/preview` 预览与 `/admin/telemetry/cleanup` 执行，并要求 `CLEAR_HISTORY` 确认短语；执行后审计日志写入时序库。清理接口不修改主业务库中的额度、订阅用量、流量游标、节点实时状态或计费数据。

---

## 4. 运维排错与常用指令

### 4.1 查看 Agent 运行状态与日志
```bash
# 查看 systemd 服务状态
systemctl status riri-agent

# 查看 Agent 实时日志
journalctl -u riri-agent -f -n 50

# 重启 Agent
systemctl restart riri-agent
```

### 4.1.1 长时间运行退化：先保留证据，再按需恢复

1. 故障期间先在节点详情或日志页请求「只读快照」，确认 Agent 心跳含 singbox_diagnostics_snapshot；旧 Agent 仍可通信但须升级才支持。任务不重启、不改配置，等待上限 30 秒，未返回表示未知而非健康。HTTP 间隔较长可能错过观察窗口，未下发快照 30 秒过期，可在合适窗口重新请求。
2. 按节点/时间筛选并导出诊断 bundle，保留发生时间与 receivedAt、Agent/内核实例、配置版本/operationId、进程 PID/uptime/RSS/FD/线程数、本地 API readiness 和 dropped/retries/pending。资源字段不可用须如实保留；HMAC 目标关联仅在本次 Master 进程内有效。
3. 对比退化前/故障中/人工恢复后的周期快照与生命周期，区分 DNS、拨号超时、资源增长、本地 API 超时等证据。/version 成功只证明本地接口响应，不证明出口、DNS 或网页恢复；配置 accepted 也不代表完成重启。禁止仅凭日志稀疏断言内存泄漏。
4. 紧急恢复可以照常 reload/重启，无需等待快照；记录操作时点。INFO/DEBUG 临时诊断是另一种操作，仍可能触发内核重启且有隐私风险，30 分钟自动回收，不能把它误当无重启快照。
5. bundle/JSON/CSV 最多导出 5000 条；统计趋势最多采样 20,000 条。采集/传输/写库均为有界最佳努力，实时可见不是已持久化；必要时分时间窗口导出并同时保留安全的本地 Agent 日志。不使用定时重启替代排障，不公开本地 Clash API，不收集全量访问内容。

本次改动不要求 schema 迁移或新增服务；Master 与 Agent 的当前版本保持不变，发布时分别按 Unreleased 进入各自版本轨道。

### 4.2 节点网络与端口检测
- 检查 Sing-box 监听端口是否正常（将 `<port>` 替换为管理端显示的实际五位端口）：
  ```bash
  ss -tulpn | grep <port>
  ```
- 检查防火墙是否放行：
  ```bash
  ufw allow <port>/tcp
  ufw allow <port>/udp
  ```

---

## 5. 线路编排与中继模式指南 (Lines & Relay Mode Guide)

RiriCloud 采用**以线路（Line）为中心（Line-Centric Pipeline）**的自动化网络编排架构。线路是面向用户订阅的唯一业务实体，直接内聚代理协议、传输层、安全层以及底层节点流转拓扑。管理员无需在节点上逐一手动添加入站，系统会根据线路定义自动向边缘节点下发配对的 Sing-box 配置。

### 5.1 核心概念与拓扑架构

系统支持两种线路模式（`type`）：

- **直连线路 (`DIRECT`)**：单节点接入。仅绑定单个入口节点与监听端口，落地字段为 `null`，客户端直连落地机出网。
- **中继线路 (`RELAY`)**：跨节点中转级联。将前置**入口节点（Entry Node，如国内优质 BGP / 专线中转 VPS）**与后置**落地节点（Landing Node，如境外落地 VPS）**串联。客户端仅连接入口节点，流量由入口节点在内核态透明中继至落地节点解密出网。

```text
                               【中继模式端到端流量拓扑】
               ┌───────────────────────────┐                    ┌───────────────────────────┐
               │     入口节点 (中转 VPS)     │                    │     落地节点 (境外 VPS)     │
[用户客户端] ───> │  监听: 入口端口 (entryPort) │ ─────────────────> │  监听: 落地监听端口 (landingPort)│ ───> [目标互联网]
 (订阅连接)     │  例: 203.0.113.1:25001    │   (公网转发/代理)   │  例: 198.51.100.2:25002   │      (真实访问)
               └───────────────────────────┘                    └───────────────────────────┘
```

### 5.2 三种中继机制深度对比

在中继线路的高级设置中，支持两种中继机制（`relayMode`）：

| 中继机制 | 底层实现原理 | 优势与限制 | 推荐场景 |
| :--- | :--- | :--- | :--- |
| **盲转发 (`BLIND_FORWARD`)**<br>*四层端口转发* | 入口节点运行 Sing-box `direct` 入站，将收到的原始四层 TCP/UDP 流量原封不动透传至落地节点的公网 IP 与落地监听端口；握手解密完全在落地节点完成。 | **性能最高、延迟最低、系统资源消耗极小**；实现真正的端到端加密，中转机不接触 TLS 私钥与明文流量；支持所有协议（含 VLESS-Reality、ShadowTLS、Hysteria2、TUIC、Trojan 等）。 | **强烈推荐（绝大多数中转场景首选）** |
| **协议代理 (`PROTOCOL_PROXY`)**<br>*协议重加密中继* | 入口节点作为一个完整协议入站终结客户端握手，再由本地内核出站规则（`outbound` + `route`）向落地节点重新握手建连转发。 | 入口与落地分别进行独立协议握手；但中转机需要消耗 CPU 资源进行解密与重封装。受内核架构限制，**不支持 ShadowTLS**。 | 需要入口处完全终结客户端握手的特殊网络拓扑 |
| **桥接已有线路 (`TARGET_LINE`)**<br>*异构协议桥接* | 入口节点使用当前线路协议生成客户端入站，再从所引用的其他节点 `DIRECT` 线路读取协议参数，生成异构 outbound；落地节点直接复用目标线路已有入站与端口。 | 不重复填写落地线路密钥和端口；可实现 Hysteria2/VLESS-Reality 到 Shadowsocks/Trojan 等异构分段。目标线路删除受保护，目标必须是其他节点的直连线路。 | 已有稳定落地线路，需要更换入口协议或规避入口网络 QoS |

### 5.2.1 最终落地代理出站与 WARP 接入

在线路「高级设置 → 最终落地出站」启用指定代理，选择 HTTP 或 SOCKS5 并填写实际地址/端口；可选用户名密码。HTTP 是非 TLS CONNECT 代理，只承载 TCP；SOCKS5 目标域名交给代理解析，UDP 默认关闭，确认工具提供 UDP ASSOCIATE 后方可开启。本版不支持 HTTPS 代理、SOCKS4、分流或故障自动切换。

直连执行节点为当前入口，自建盲转发/协议代理中继执行节点为最终落地；入口到落地的路径不改变。桥接已有线路继承目标直连的出站，需要到目标线路编辑；UPSTREAM_NODE/EXTERNAL 不叠加。可为同一台落地节点创建普通出口和 WARP 出口两条线路，用户按线路选择。

WARP 客户端/适配工具由管理员自行安装配置，RiriCloud 只对接已运行的 SOCKS5 端点，不管理 WARP 生命周期或修改系统路由。若工具在落地本机回环监听，可填 `127.0.0.1` 和工具实际端口（不假定固定端口），认证按工具实际设置填写。此地址指落地 Sing-box 的网络命名空间；独立 Docker 容器的 loopback 不是宿主机，需要确保代理地址在 Agent/Sing-box 容器内可访问，并用防火墙/认证保护远程代理，不将本机 WARP 无鉴权端口暴露公网。

指定出站的业务连接失败时不回退 VPS 默认出口，未支持的 UDP 明确拒绝；代理地址域名仍需本地解析，目标若已由客户端解析为 IP 不会恢复域名。既有私网保护与代理池来源白名单优先执行。节点高级覆盖接管 inbounds/outbounds/route/dns 会与指定出站冲突，须清除相应覆盖后配置；其他节点及不相关覆盖不变。

保存后观察节点配置应用回执/内核错误，不能把保存成功当作已应用：WS 防抖推送、HTTP 下一轮拉取，失败预检沿用 last-good，离线节点和旧连接不保证即时切换。实际验收通过完整线路查询出口 IP，再访问所需服务；停止 WARP 确认不会直连回退。WARP 出口地区、IP 信誉和解锁能力由服务实际判定，不保证固定国家或服务解锁，正常线路 204 拨测不等于解锁验证。

开发回归使用 `SINGBOX_BINARY_PATH=<实际交付内核> node scripts/line-egress-integration.cjs` 和 `node --test scripts/line-egress-migration.test.cjs`，隔离临时库/端口覆盖 HTTP/SOCKS5、直连/两种中继/桥接、代理域名解析、UDP 开关、认证失败及停代理不直出。未连接真实 WARP，不宣称已验证实际解锁。

### 5.3 端口机制与传输层协议映射

在中继线路中，核心由两个端口协同工作：

1. **入口端口 (`entryPort`)**：
   - 监听在**入口节点（中转 VPS）**上。
   - 客户端订阅配置中展示并连接的正是该端口（客户端连接 `入口节点公网IP:入口端口`）。
2. **落地监听端口 (`landingPort`)**：
   - 监听在**落地节点（境外 VPS）**上。
   - 落地节点的代理内核（Sing-box）在该端口上启动真实的协议监听，负责接收来自入口节点的流量并解密出网（在 `TARGET_LINE` 桥接模式下动态复用目标直连线路的 `entryPort`）。
3. **端口传输层协议（TCP 还是 UDP？）**：
   - **入口端口与落地监听端口的传输层类型完全跟随整条线路所选的协议类型**，两端永远保持严格一致：
     - **Hysteria 2 / TUIC**：基于 QUIC/UDP，入口端口与落地监听端口**均为 UDP 端口**。
     - **VLESS / Trojan / VMess / ShadowTLS / NaiveProxy**：基于 TCP，入口端口与落地监听端口**均为 TCP 端口**（在这些协议中，用户产生的 UDP 数据包已在协议内层封装并通过该 TCP 隧道传输）。
     - **Shadowsocks**：主要使用 **TCP 端口**（原生 UDP 时复用同端口）。
4. **为什么采用独立端口管道，而非复用已有端口？**
   - **精准计费与倍率隔离**：直连与中继通常倍率不同（如直连 1.0x、中继 1.5x），独立端口使得边缘 Agent 上报的用户流量增量能够 100% 精准归属到对应线路并按倍率扣费。
   - **生命周期解耦**：管理员增删改查、启用或停用某条线路时，不会对其他线路产生意外连锁影响。
   - **独立健康熔断**：中转机离线时系统自动仅将该中继线路标记为不可用并从订阅剔除，落地机上的直连线路仍能继续服务。
   - **极低资源开销**：现代 Linux 与 Sing-box 多监听一个空闲端口仅占用数十 KB 内存，无额外 CPU 开销，且让端口级排错极为清晰。

### 5.4 管理端配置实操流程

1. **前置准备**：确保在管理后台「节点管理」中至少有两个处于 **在线 (`ONLINE`)** 状态的节点（如国内中转 VPS 与境外落地 VPS）。
2. **新建线路**：进入 **「线路管理」**（`/admin/lines`），点击右上角 **「新建线路」**。
3. **「基础与网络」配置**：
   - 输入**线路名称**（如 `沪日专线 · 东京 [中继]`）。
   - 选择**协议类型**（如 `VLESS`、`HYSTERIA2` 等）。
   - **入口节点**：选择中转 VPS。
   - **入口监听端口**：填入目标端口，或**直接留空让系统在 20000~65535 范围自动分配**。
   - 按需配置传输层（WS/gRPC/TCP）与安全层（Reality 公私钥/TLS 证书）。
4. **「高级与覆盖设置」配置拓扑**：
   - 切换到 **「高级与覆盖设置」** 页签。
   - **线路模式**：切换为 **`中继` (`RELAY`)**。
   - **落地节点**：选择落地 VPS。
   - **落地监听端口**：填入落地机监听端口，或**直接留空自动分配**。
   - **中继机制**：选择 **`盲转发：保持端到端协议`**（推荐）。若要复用已有落地线路，选择 **`协议转换：桥接已有线路`**，再在「目标落地线路」中选择其他节点上的启用直连线路；落地节点与端口由目标线路动态绑定，无需手填。
   - **对外端点覆盖（可选）**：若入口节点前端配置了 DDNS 域名、弹性公网 IP 或 NAT 端口映射，可开启覆盖开关并填写对外域名与端口。
   - 设置流量倍率（如 `1.5`）、标签与启用状态。
5. **保存生效**：
   - 点击 **「保存」**。主控系统将在 250ms 内通过 WSS 向入口与落地节点自动下发 `config_sync`，Sing-box 热加载就绪。

### 5.5 云防火墙与网络排错建议

1. **云厂商安全组放行策略（强烈推荐）**：
   - RiriCloud 默认端口分配范围为 **`20000 ~ 65535`**。
   - 建议在云厂商控制台（阿里云、腾讯云、AWS、Oracle Cloud 等）为中转机和落地机配置安全组放行规则：
     - **协议**：`TCP/UDP`
     - **端口范围**：`20000-65535`
   - 这样新增或调整中继线路时无需频繁手动修改云安全组。
2. **双机在线门禁机制**：
   - 中继线路要求**入口节点与落地节点同时处于在线 (`ONLINE`) 状态**才会向普通用户生成订阅并允许连通。若任一节点下线，系统会自动屏蔽该中继线路以防客户端产生死链。
3. **连通性排查指令**：
   - 在中转机上测试能否正常连通落地机的落地监听端口：
     ```bash
     # TCP 协议测试 (VLESS / Trojan / Shadowsocks 等)
     nc -zv <landing-node-ip> <landing-port>
     # 或使用 curl
     curl -v telnet://<landing-node-ip>:<landing-port>
     ```
   - 在落地机上确认 Sing-box 正在监听对应端口：
     ```bash
     ss -tulpn | grep <exit-port>
     ```

### 5.6 常见疑问与进阶拓扑 (FAQ)

- **Q: 能否实现 3 个及以上节点的多级跳中转（A -> B -> C）？**
  - 当前 RiriCloud 原生支持两节点中继（入口 -> 出口）。如需三跳（如 国内 A -> 香港 B -> 日本 C），最简便高效的方案是在中间机 B 上通过系统级端口转发工具（如 `realm`、`gost` 或 `iptables`）将 B 的端口直接转给 C 的出口监听端口；在 RiriCloud 后台只需纳管 A -> B 的中继即可。
- **Q: 为什么出口监听端口不能直接填已有直连线路的端口？**
  - 为了保证流量倍率计费准确性与线路生命周期解耦，每条线路享有独立的端口通道。多开端口在 Linux 下资源占用可忽略不计，且能带来故障隔离的运维优势。
  - **Q: ShadowTLS 为什么不能选协议代理？**
  - ShadowTLS 依赖独特的握手验证与内层 Shadowsocks 端口协同，目前仅支持直连模式与盲转发模式。
  - **Q: 如何让入口使用 Hysteria2、落地复用 Shadowsocks？**
  - 先在落地节点创建并启用 Shadowsocks 直连线路，再创建入口节点的中继线路，选择 `TARGET_LINE` 并绑定该直连线路。系统会在入口节点生成 Hysteria2 入站和 Shadowsocks 出站，在落地节点沿用原直连入站；目标直连线路必须保持启用，且被引用时不能直接删除。

## 8. 二进制资源与版本化构建产物

### 8.1 版本与目录

应用版本从根 `package.json` 读取，传给 Agent 构建和 Docker 镜像标签；Sing-box 版本使用独立参数 `SINGBOX_VERSION`、`SINGBOX_REVISION`，Cronet 使用 `CRONET_VERSION`。构建产物目录示例：

```text
artifacts/binaries/
├── agent/linux-amd64/riri-agent
├── singbox/1.14.0-r2/linux-amd64/sing-box
├── singbox/1.14.0-r2/linux-amd64/libcronet.so
└── manifest.json
```

`manifest.json` 记录应用版本與 Agent 跨平台资源、文件大小和 SHA-256（定制 Sing-box 内核在构建阶段编译后直接内嵌进 `riri-agent` 二进制中，不再作为独立资源写入 `manifest.json`）。

### 8.2 Master 包与 Docker

`bundle-master.sh` 将目标架构的 Agent（已内嵌定制 Sing-box 内核与 `libcronet.so`）及 `manifest.json` 一起放入 Master 发行包。Docker 构建保留独立的 `SINGBOX_VERSION`、`SINGBOX_REVISION` 和 `CRONET_VERSION` build args，并将资源版本写入镜像 label 与容器内 `/app/binaries/manifest.json`。SQLite 和 `data/binaries` 必须使用持久化卷，以保留资源文件、`.seeded-releases.json` 初始化标记、任务历史和逻辑状态。

### 8.3 运行时资源管理与内核内嵌

自编译 Sing-box 内核（以及 Linux 下的 `libcronet.so`）已深度封装内嵌于各平台 `riri-agent` 二进制中。节点 VPS 执行安装命令下载 Agent 后，启动时直接在本地按 SHA-256 自愈校验并解压覆盖旧内核，不再需要向外网或 Master 请求二次下载，实现 100% 离线自闭环。节点升级流程统一收敛为「升级 Agent」单一动作，升级 Agent 落地启动后自动自愈更新内置内核。

管理员可在 `/admin/binaries` 统一维护各平台 Agent 二进制资源：支持从项目 GitHub Release 列表一键拉取（仓库地址 `githubRepoUrl` 可在资源中心弹窗或系统设置中配置，自动复用 `githubMirrorUrls` 镜像加速）、本地多文件上传或 URL 远程导入（服务端自动解压 `.tar.gz`/`.zip`、解析 ELF/Mach-O/PE 魔数头与内嵌版本标记并计算 SHA-256，无需手填元数据）。所有资源均不区分是否内置，支持随时直接删除；操作审计统一并入系统日志（`module=BinaryResource`）。

### 8.4 多设备在线管理的内核要求

Master 下发的 Sing-box 配置默认将 `experimental.clash_api.external_controller` 绑定到 `127.0.0.1:10086`（可通过主控环境变量 `CLASH_API_LISTEN` 或节点级 `configOverride.experimental.clash_api.external_controller` 调整为其他本机回环端口，并支持配置 `experimental.clash_api.secret`），Agent 在应用配置时会自动检测回环端口可用性，并在端口冲突或被系统保留时自动安全重映射到空闲 loopback 端口。Agent 仅访问 loopback 上的 `/connections` 与连接删除接口。**不要将 Clash API 监听地址改为公网或非 loopback 地址，也不要通过防火墙/端口映射暴露该管理 API。** Agent 会拒绝非 loopback 的 API 地址。

仓库内构建的 Sing-box 会启用 `with_clash_api` 与 `with_riri_device_tracking` 编译标签，注入 `-X github.com/sagernet/sing-box/constant.Version` 版本号，并由 `scripts/build-binaries.sh`、`Dockerfile` 与 `Dockerfile.agent` 对上游 `experimental/clashapi/connections.go` 应用 `apps/agent/patches/sing-box-clashapi-inbound-user.patch`，让连接元数据包含 `inboundUser`；源码构建需要 Bash、Go 与 `patch` 工具。自行提供的 Sing-box 内核也必须启用上述标签并返回等价的用户元数据，否则 Agent 不会宣告 `device_tracking` 能力。Agent 与 Master 会自动忽略 `127.0.0.1`、`::1` 等回环来源地址（避免反向隧道落地节点的本地转发流量被误计为客户端设备）。Agent 每 2 秒采样一次，瞬时短连接可能未被观察到；Master 默认按最近 60 秒报告判定在线，管理员可在系统设置将窗口调整为 15~600 秒。

## 9. 实时节点镜像站部署

镜像站依赖节点通过 WS/WSS 长连接宣告 `mirror_proxy` 能力。生产环境必须由 Nginx 或同类入口终止 HTTPS，并将 `/mirror/`、`/api/` 和 `/ws/agent` 正确转发到 Master；Master 的直接 HTTP 端口不应暴露到公网。生产配置要求镜像上游使用 HTTPS、Agent 使用 WSS，并保持反向代理的 Upgrade、Connection、超时和响应流配置正确。

首次上线应只创建 `ADMIN` 或短期 `SHARE` 镜像验证指定节点的实际出口、GitHub Raw/API/Release 响应、重定向白名单和 Range 行为，确认监控后再逐站启用 `PUBLIC`。服务端默认限制单请求 10 分钟、响应 256 MiB、单节点并发 4；公开请求还按 IP/镜像站限速。禁止把 GitHub PAT、Cookie、Authorization、响应体或完整分享 Token 写入日志，日志仅记录镜像 ID、节点 ID、最终 host、状态码、字节数、耗时和稳定错误码。

发布前先备份 SQLite 主文件及对应 `-wal`、`-shm`，再部署 Master 数据库迁移，最后滚动升级并确认 Agent 心跳能力。旧 Agent 会继续运行既有功能但不会接收镜像任务。回滚时先关闭镜像站入口或全部禁用配置，进行中的流按失败处理；不要求旧版本恢复进行中的镜像会话。

## 10. 上游订阅破坏性重构部署

本次删除 `isDirectSub`、旧 `fingerprint` 与 `/admin/upstream/nodes/:nodeId/direct-sub`，不保留旧数据/接口兼容，不自动转换为 EXTERNAL，也不回填加密数据。**不要直接在带旧上游记录的主库上执行迁移或新版服务。**

1. 停止旧 Master 的写入，使用 SQLite 在线备份或停机后完整备份主库及 WAL/SHM；保存与该备份匹配的旧二进制和加密密钥。
2. 维护者明确选择新数据库，或在备份后显式处理旧上游源、节点与引用它们的线路。只处理上游域，不清空用户/套餐/余额/流量或其他线路；本程序不执行这一步，也没有自动清理开关。
3. 执行正常部署命令。`prisma/deploy-databases.js`、Docker 入口与 `scripts/dev-e2e.sh` 在任何双库变更前执行 `upstream-upgrade-preflight.js`。检测到旧上游记录时以明确错误中止；SQL 新迁移也在结构变化前设置 CHECK 保护，直接调用 Prisma 同样不能悄悄转换旧数据。
4. 迁移完成后重新导入上游，等待完整成功快照；创建 EXTERNAL 或 UPSTREAM_NODE 中继线路，确认授权与启停再发布。EXTERNAL 默认禁用/非公开，公开启用可能被 ALL 套餐包含。
5. 回退必须同时恢复旧数据库备份与旧二进制；新版 EXTERNAL/加密连接不能由旧版安全读取。直接 Prisma 迁移被拒绝留下失败迁移记录时，确认结构未改变并完成维护者的数据处理后，按 Prisma 官方流程标记该失败迁移回滚再重试，禁止修改历史 SQL。

上游 URL、Header、源内容/缓存、参数和原始快照均使用现有 `RIRICLOUD_ENCRYPTION_KEY`（或 JWT_SECRET）AES-GCM 加密；部署必须持续保留同一密钥。管理列表不展示秘密，管理员编辑按需获取详情，日志/错误不能包含完整 URL 或认证内容。

远程拉取仅公共 HTTP(S)，生产必须 HTTPS，禁止私网、回环和 metadata 目标；最多 5 次重定向、20 秒总预算和 5 MiB 响应。实际连接使用已检查的 DNS 地址，跨 origin 不转发自定义秘密 Header。内网来源请使用文本导入，而不是放宽生产 SSRF 检查。

自建中继只允许可归属用户的鉴权入口，用户流量按入口线路倍率计费；共享 SS/关闭用户鉴权不能作为受控上游中继入口。EXTERNAL 为共享外部凭据分发，不计本地用量、不执行本地设备/速率限制，停止分发或用户到期不能撤回已保存的凭据；需要独立停权时使用自建入口中继。

裸节点与全部线路现在均由 Master 的独立 Mihomo 客户端访问目标进行真实代理拨测，Hysteria2/TUIC 不再返回 TCP 不适用；只在严格目标响应与 HTTPS 证书验证通过时记录端到端延迟，失败不自动停用资源。定向回归：`node --test scripts/upstream-upgrade-preflight.test.cjs scripts/upstream-migration.test.cjs scripts/client-probe-migration.test.cjs`；测试在隔离 SQLite 执行，不操作现有业务库。

## 11. Mihomo 主客户端拨测部署

Mihomo 固定 1.19.30，官方五平台资产与 SHA-256 在 `scripts/client-kernel-assets.json`。准备命令 `node scripts/prepare-client-kernels.mjs --target <platform>` 输出 `artifacts/binaries/mihomo/1.19.30/<platform>/mihomo[.exe]` 并验证归档、文件头、架构与二进制摘要；`--archive` 可读取离线官方归档，但不能跳过校验。Docker 构建、Master Linux amd64/arm64 发行包和本地 E2E 共用清单，不在运行时下载。开发支持 windows-amd64、darwin-amd64/arm64、linux-amd64/arm64；不把 Mihomo 放进 Agent 或作为 Agent 升级目标。

`MIHOMO_BINARY_PATH` / `SINGBOX_BINARY_PATH` 显式覆盖错误时明确环境不可用，不静默寻找另一个内核掩盖配置错误。常规解析优先环境路径、发行包版本目录、系统安装位置、开发 artifacts，并读取真实版本；缺资源不是“节点连接失败”。主拨测统一全局 4 连接/2 进程，临时目录私有、回环控制 Secret、禁 TUN/GeoIP/provider 自动下载；取消或异常应退出并清理。Sing-box 回退需要自身协议及运行依赖，Naive/Cronet 缺失不可伪称通过。

上游与线路单/批量拨测返回 202 taskId，通过任务 API 查看进度、分页结果和取消；请求不等待整批网络操作。完成结果内存保留 15 分钟，重启后任务消失但资源 lastProbe 摘要保留。结果标实际内核/版本、Master 视角、链路与目标；Sing-box 兼容成功不等于 Mihomo 主客户端已验证。网络/鉴权/配置/环境失败不自动换内核，不自动停用业务资源。

默认目标 HTTPS generate_204，严格响应状态与证书验证；已有显式 HTTP 目标保留但不提供目标 TLS 验证。目标只能公共地址、禁止任意请求传入 URL/认证、重定向不跟随；上游节点公共端点和目标实际 IP 固定，Host/SNI 保留。自建受控入口可以本机/私网，不提供生产用户私网绕过开关。固定 Mihomo delay API 对 500/302 返回数字，因此项目使用其 mixed 代理和标准 HTTP 客户端的严格请求，不直接把 delay 当成功。

新增 `20261001010000_client_probe_metadata` 仅增加 lastProbeJson 并清除旧派生延迟/状态，不清来源、节点、线路、用户或账务。此迁移不要求清库；之前上游破坏性迁移的前置要求仍独立适用。内核/模板验证缺 GeoIP、规则/provider 或本地证书资源时显示 EXTERNAL_RESOURCES_REQUIRED，不篡改规则后标 FULL 通过。

回归：`node --test scripts/client-kernels.test.mjs scripts/client-probe-migration.test.cjs`；真实任务/内核隔离验收 `node scripts/client-probe-integration.cjs`（HTTPS fixture 与测试 CA 可在 scratch 准备）；中继链路 `node scripts/upstream-integration.cjs`。上述脚本新建临时库并清理，不操作默认 E2E/dev 业务库。

Windows 本机六门禁/隔离 E2E 已通过；本机 WSL2 Debian 13 amd64 已补验系统 Node20、Node22 Linux 测试容器、Mihomo 1.19.30/Sing-box 1.14.0 + Cronet，原生测试 83 项通过，真实 HTTP/TLS、JWT/RBAC、任务/STALE、EXTERNAL/VLESS/HTTP 中继及 Naive HTTP/2 CONNECT + padding 链路通过。正式 Master/Agent 镜像构建、双标签离线导出/摘要/重载，以及 Linux Master 发行包装配/解压后独立启动通过；生产 Master、隔离双库迁移/管理员引导、Cookie、内核画像、真实 Agent/Sing-box、异步 202/取消及格式对应模板检查均验证。所有运行使用临时库/数据目录，不操作现有部署；非 root 原生 Agent 须将 `RIRICLOUD_DATA_DIR` 指向可写目录。

WSL 验证发现并修复 `docker-build.sh export` 引用未定义 HOST_UNAME（Linux-only 脚本不需要 Windows 路径转换），补 `node --test scripts/docker-export.test.mjs`；发现 Mihomo listener 早于 Running 的冷启动竞态，增加仅回环数据面就绪屏障，不访问目标或计入延迟，业务路由无 DIRECT 兜底；端口就绪轮询显式移除 abort listener。发布前其他平台仍须原生补验：Linux arm64/macOS 目前仅资产摘要/文件头通过，未实测原生运行；Naive 本轮未测 HTTP/3。视觉验证按需且仅限 Antigravity。

### 11.1 模板预览的离线校验资源

「客户端配置校验」不等同于链路测速。黄色 EXTERNAL_RESOURCES_REQUIRED 表示校验环境尚不能完整复现依赖，不表示订阅必然不可用。先查看展开的资源明细和配置位置：MISSING 需准备资源；INVALID 需重新校验/准备；UNREADABLE 需修复目录权限；REMOTE_DISABLED/UNSUPPORTED 应在具备资源的客户端验证，不能通过删掉规则消除提示。

```bash
# 固定地理资源准备（开发机产物 artifacts/validation-resources/）
node scripts/prepare-validation-resources.mjs
# 离线准备：目录中须包含清单锁定的同版本、同 SHA-256 文件
node scripts/prepare-validation-resources.mjs --offline-dir /path/to/offline-resources --output-root /opt/riri/binaries/validation-resources
```

固定文件与来源/版本/哈希统一定义在 `scripts/client-kernel-assets.json` 的 validationResources，构建/显式准备阶段下载，预览运行时不下载。Docker 与 Master 包携带 `binaries/validation-resources/`；开发自动发现 `artifacts/validation-resources/`。可通过 `CLIENT_VALIDATION_RESOURCES_DIR` 显式指定受控资源根目录（推荐绝对路径）；覆盖错误不会静默回退。目录只能由受信任部署者维护，服务 UID 需可读，禁止面向用户可写；Docker 默认仍为 65532:65532。

受控目录需有 `manifest.json`：`{schemaVersion:1,version,files:[{path,size,sha256}]}`。Mihomo 默认 GEOIP 使用 `Country.mmdb`，DAT 模式使用 `geoip.dat`，GEOSITE 使用 `geosite.dat`，ASN 使用 `ASN.mmdb`。不能把自定义 geox-url 对应的数据静默替换成默认包。自行准备本地 domain/ipcidr provider 时，将 YAML（payload 数组）或 text 文件及其实际大小/SHA-256 加入受控清单，配置只允许例如 `rules/domains.yaml` 的相对路径；classical/MRS、远程 provider、Sing-box 外部 rule-set 和任意证书/私钥路径不在本轮本地映射支持范围。

运行时拒绝绝对路径、目录穿越、文件/子目录符号链接、坏哈希及超限资源；单文件最多 32 MiB、单次快照最多 80 MiB、清单最多 256 项。两个校验任务限额包住资源读取和原生进程，进程仍共享全局两槽位；只向私有临时目录写独立副本，不向共享资源写回。配置检查超时为 5 秒，失败/取消后回收文件；API 只回安全诊断码，不暴露原始内核输出。

验证命令：`VALIDATION_RESOURCE_FIXTURE_DIR=artifacts/validation-resources node --test scripts/client-kernels.test.mjs scripts/prepare-validation-resources.test.mjs`；准备固定内核与资源后运行 `RUN_NATIVE_CLIENT_TESTS=1 pnpm --filter @riricloud/server exec jest --runInBand client-kernels`。地理资源还须匹配随应用分发的 `scripts/client-kernel-assets.json`，不能在资源目录清单中随意替换数据；缺少应用清单会安全拒绝。本轮原生验证证据与环境受限项记录于对应规划归档，不沿用上一版本的 Docker/跨平台验证结论。

## 12. 代理池统一授权与上游中继升级

本轮BREAKING CHANGE：旧裸pk_用户名停止新连接，JSON导出改v2逐端点真实凭据，公开代理池线路也遵守套餐ALL/TAGS/EXPLICIT及额外授权；共享配额不再隐含所有线路访问权。Key记录/密码/exportToken不轮换、不删除，用户必须重新导出脚本/工具配置，不能手工将原始Key标识当登录名。

部署顺序：停止旧Master与可能继续旧配置的入口服务→备份业务/观测SQLite（含WAL安全备份）→升级代码并执行追加迁移→同步Master/Web→检查线路proxyPoolEnabled、套餐匹配与额外授权→确认Agent已应用新配置→让用户重新导出。网络分区/离线Agent不承诺立刻撤销，控制面的期望配置和数据面实际应用分开核对；需要强制中断旧连接时使用既有维护操作，不新增踢连接协议。

迁移20261001020000_proxy_pool_line_access只加开关、回填旧ACTIVE/public/DIRECT/MIXED且入口存在/端口有效线路，私有/停用/上游中继默认关闭；不改用户/Key/密码/Token/账务/游标。新增中继须手工开启代理池并开启用户鉴权；普通MIXED/HTTP/SOCKS不会仅因协议自动获得Key。先核对套餐权限，容量每节点512个Key-Line绑定，管理页面显示排除数量，改变UI排序不改变分配。

回滚须同时恢复匹配代码与数据库备份，不能编辑已应用历史迁移；仅回退Web会无法使用v2导出。TLS入口只通过HTTPS或具备相应能力的JSON交付，不能导出普通SOCKS5/TXT冒充兼容；超过200端点须分批选择。原有exportToken可以继续拉取，但返回范围因正确授权收紧且用户名改变；日志/浏览器历史保护、必要时独立轮换Token。

定向回归：`node --test scripts/proxy-pool-migration.test.cjs`、`node scripts/proxy-pool-integration.cjs`（真实Sing-box路径由SINGBOX_BINARY_PATH指定）。脚本使用正式schema临时绝对SQLite库和回环fixture，HTTP CONNECT/SOCKS5、Key/授权/白名单/上游失效、实际gRPC累计计数与倍率事务验证，不使用或清理默认dev/E2E库。无需新Agent协议、外部服务或依赖库。
