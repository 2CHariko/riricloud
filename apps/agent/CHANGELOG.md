# RiriCloud Agent 更新日志 (Changelog)

本项目 Go 边缘 Agent（riri-agent）的所有显著变更都记录在本文件中。

格式基于 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，
版本管理遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/) 与
[docs/VERSIONING.md](../../docs/VERSIONING.md)。

变更类型说明：`Added` 新增 · `Changed` 变更 · `Fixed` 修复 · `Removed` 移除 · `Security` 安全 · `Deprecated` 弃用。
约定：日常特性与修复 PR 在 `[Unreleased]` 中维护更新条目；正式发版时运行 `pnpm bump:agent` 固化为版本小节并打 `agent-vA.B.C` Tag。


## [Unreleased]

### Added

### Changed

### Fixed


## [0.8.6] - 2026-10-02

### Fixed
- **修复 WS 重连协程泄漏与日志递归风暴、Linux TC 限速五位端口 `classid` 溢出及错误字段序列化丢失**：
  - `internal/ws` 为每次 WebSocket 会话派生独立 `connCtx` 并使用 `sync.WaitGroup` 收敛 `readLoop`、`heartbeatLoop` 与 `logFlushLoop` 生命周期；`sendLogReport` 与 `internal/poll` 上报失败时不再打印递归 `WARN` 日志，而是调用 `Collector.Requeue` 将日志批次重入队至有界环形缓冲区；
  - `internal/trafficshaper` 新增 `portClassID`，将端口号格式化为 16 位十六进制 `1:%x` 作为 `tc` HTB 子类 ID（对与默认类 `1:999` 冲突的端口 `2457` 自动重映射至高段空闲子类），彻底解决端口 `> 9999` 时 `tc` 报错 `exit status 255` 的问题；
  - `internal/logging` 在采集 `logrus.Entry.Data` 时自动将实现 `error` 接口的值转换为 `.Error()` 字符串，解决结构化日志 `metadata.error` 被 JSON 序列化为 `{}` 的问题；
  - `internal/singbox` 将 QUIC/Hysteria2 正常流关闭（`canceled by remote/local with error code 0`）归类为 `ACCESS` 并降级为 `INFO`，避免常规模式下产生误报 `WARN` 刷屏。



## [0.8.5] - 2026-09-28

### Fixed
- **修复 Sing-box 本地回环管理端口（V2Ray API / Clash API）被占用或落入 Windows WinNAT 动态排除端口区间导致内核启动 Fatal 崩溃重启循环**：
  - 在 `apps/agent/internal/singbox/manager.go` 中新增 `sanitizeLoopbackListeners`：在原子落盘与拉起内核前，自动检测 `experimental.v2ray_api.listen` 与 `experimental.clash_api.external_controller` 本机回环监听端口可用性；
  - 当端口被其他进程占用或遭遇 Windows Socket 权限拒绝（`WSAEACCES` / `bind: An attempt was made to access a socket in a way forbidden by its access permissions.`）时，自动顺延重映射到本机空闲 loopback 端口，彻底根除因 Windows Hyper-V/WSL2 动态保留端口范围命中 10085/10086 引发的死循环崩溃；
  - `StatsAddress()` 与 `ClashAPIAddress()` 同步读取实际生效的回环端口，流量采集与多设备连接追踪无缝连通。



## [0.8.4] - 2026-09-27

### Fixed
- **修复跨平台构建工具链污染导致内嵌错误格式 `sing-box`（触发 Linux `exec format error`）及运行时二进制头自愈校验**：
  - 在 `internal/embedded`、`internal/kernel` 与 `internal/runner` 中新增基于 `runtime.GOOS`/`runtime.GOARCH` 的可执行文件头（`ELF` `e_machine`、`Mach-O` `cputype`、`PE` `Machine`）校验；当内嵌 `singbox.tar.gz` 或本地磁盘残留的 `sing-box` 二进制格式与当前运行平台不匹配时，拒绝释放或直接跳过失效文件，自动回退至远程镜像拉取对应架构合法内核并完成原子替换自愈；
  - 构建脚本（`build-binaries.sh`、`build-agent.sh`、`gate-agent.sh`）在 Linux/WSL 环境下严格隔离宿主 Windows `.exe` 工具链，并在编译缓存命中、归档打包内嵌及产物输出阶段强制校验二进制魔数与目标架构。



## [0.8.3] - 2026-09-26

### Added
- **内嵌二进制版本识别标记 (`BuildMarker`)**：新增 `RIRICLOUD_AGENT_VERSION:<ver>` 编译期标记注入，支持主控资源中心直接从跨平台裸二进制或归档包中提取真实 Agent 版本号。



## [0.8.2] - 2026-09-26

### Fixed
- **修复空闲节点心跳 `onlineDevices` 序列化为 `null` 被主控网关拒收**：`devices.Tracker.ReportItems()` 改为始终返回非 `nil` 切片（无活跃连接时序列化为 `[]` 而非 `null`），并在 WS 心跳、HTTP 轮询与探针回执中增加非 `nil` 切片保底，防止空闲节点心跳被主控网关判定为非法载荷丢弃。



## [0.8.1] - 2026-09-26

### Changed
- **定制 Sing-box 编译标签与版本注入**：构建内嵌 Sing-box 内核时统一注入 `-X github.com/sagernet/sing-box/constant.Version` 与 `with_riri_device_tracking` 标签，全平台（`linux/amd64`、`linux/arm64`、`darwin/amd64`、`darwin/arm64`、`windows/amd64`）均从补丁源码交叉编译并内嵌 `singbox.tar.gz`。

### Fixed
- **修复 Docker 与 Release 构建未内嵌定制内核**：修正 `Dockerfile` / `Dockerfile.agent` 内嵌归档路径为 `internal/embedded/assets/singbox.tar.gz`，并移除 `release.sh --agent` 的 `--agent-only` 参数，确保容器与各平台发行包均完整内嵌定制 Sing-box 内核。
- **修复启动时内嵌内核未覆盖存量旧内核**：`startKernelBootstrap` 在未显式指定外部 `SINGBOX_BINARY_PATH` 时优先执行 `kernel.EnsureWithStatus` SHA-256 校验与自愈释放，不再被磁盘已有旧二进制短路跳过；若释放覆盖了正在运行的旧内核则自动重启子进程。
- **修复内核版本与设备追踪能力缓存锁死**：`singbox.Manager` 改为按二进制文件大小与修改时间指纹动态刷新版本与 `SupportsClashAPI()` 结果，并排除含 `with_dhcp` / `with_tailscale` 的上游未打补丁官方构建，防止误报 `device_tracking` 能力。
- **修复设备追踪器 (`devices.Tracker`) 槽位抢占、长连接误踢与回环 IP 误判**：
  - 阻断期内的设备不再占用 `allowedDevicesLocked` 名额，避免重连风暴把合法新设备挤出名额；
  - 踢出或阻断设备时立即清理 `firstSeen`、`lastActive` 与 `reports` 缓存，避免下一轮心跳继续上报已下线设备；
  - 改用 `lastActive`（5 分钟无连接过期）维护 `firstSeen` 生命周期，防止连续在线超过 24 小时的长连接设备丢失先到先得优先级；
  - 忽略 `127.0.0.1` / `::1` 等回环与未指定地址，防止 NAT 反向隧道本地转发连接被误识别为客户端设备 IP；
  - 请求 Clash API `/connections` 与断开连接接口时支持携带 `experimental.clash_api.secret` Bearer 令牌。



## [0.8.0] - 2026-09-26

### Added
- **多设备在线追踪与限制执行**：新增 loopback Clash API 连接采集，按用户/IP/线路汇总并随 WS/HTTP poll 上报；接收 Master 用户上限与踢设备任务，在节点本地保留较早设备并断开超限连接。构建 Sing-box 源码时幂等应用 `inboundUser` 元数据 patch。



## [0.7.8] - 2026-09-18

### Changed
- **Sing-box 用户流量采集失败日志级别与限流优化**：在长连接心跳与主动轮询模式下，内核流量统计采集失败日志由低可见度的 `Debug` 提升为带 1 分钟节流限制的 `Warn` 级别，兼顾内核异常快速感知与防止高频刷屏。



## [0.7.7] - 2026-09-18

### Added
- **Linux Traffic Control (tc) 物理端口双向限速整形器**：新增 `apps/agent/internal/trafficshaper` 模块，自动探测默认公网出口网卡，通过 Linux `tc`（HTB 根队列与子类、u32 端口双向 filter）对指定监听端口实施物理级出入双向限速整形；非 Linux 或无权限环境平滑跳过记 Warn，并在进程退出或重连时自动执行 `Cleanup` 队列清理。
- **配置同步与主动轮询限速表联动**：在 `config_sync`（WebSocket）与主动轮询（HTTP Poll）响应协议中支持 `portSpeedLimits` 映射，实时驱动 `trafficshaper` 动态重配物理限速。
- **Sing-box 分级日志治理与临时诊断采集**：解析 stdout/stderr 真实级别，支持 `singbox_log_capture` 能力和 WARN/INFO/DEBUG 动态采集门槛；保留 500 条环形缓冲、2 秒/50 条批量上报与 ERROR 快速冲刷。
- **Agent 本地日志轮转**：`agent.log` 默认按 50 MiB 单文件上限轮转，最多保留 5 个文件（包含当前文件），支持文件数量淘汰、轮转失败回退写入和 `agent_log_rotation` 能力宣告。

### Changed
- **内核输出降噪**：去除 ANSI 控制字符，stderr 不再自动升级为 WARN；连接访问类日志标记 ACCESS，NORMAL 模式默认丢弃；相同模块与消息的 Sing-box WARN 在 60 秒内合并并记录 `repeatCount`。
- **日志轮转配置同步**：支持 YAML、`RIRICLOUD_LOG_MAX_SIZE_MB` / `RIRICLOUD_LOG_MAX_FILES` 环境变量及 Master `config_sync` 动态下发，并按 Master 配置、Agent 本地配置、默认值的顺序生效；旧版 Agent 保持业务运行但不启用轮转。

### Fixed
- **异常退出级别修正**：预期停止记录 INFO，非预期 Sing-box 退出记录 ERROR，避免正常重启污染告警面板。



## [0.7.6] - 2026-09-17

### Security
- **依赖漏洞修复**：升级 `google.golang.org/grpc` 至 `v1.83.1`，修复 GO-2026-6348（HTTP/2 DATA 帧碎片化漏洞）；升级 `golang.org/x/text` 至 `v0.42.0`，修复 GO-2026-5970（非法输入导致的死循环漏洞）。



## [0.7.5] - 2026-09-14

### Added
- **环形有界日志收集器与 Logrus 全局挂钩**：新增 `apps/agent/internal/logging/collector.go`，构建具备容量上限（默认 500 条）与并发读写锁的环形日志收集器 `Collector`；通过 Logrus Hook 自动分级拦截过滤 Agent 自身的 INFO/WARN/ERROR 日志，支持单向消耗式 Drain。
- **Sing-box 托管内核标准输出/错误流捕获**：在 `singbox/manager.go` 中实现行缓冲 `lineLogWriter`，实时捕获托管内核 stdout/stderr，智能提取分级日志并聚合至全局日志收集器，支持 WARN/ERROR 等级告警主动收集。
- **WebSocket 与 HTTP 轮询双通道增量日志上报**：
  - WebSocket 长连接活跃时启动 `logFlushLoop` 定时协同循环，每 2 秒或累积 50 条批量推送 `log_report` 消息帧，遇 ERROR 立即主动冲刷。
  - HTTP 轮询模式下，在心跳 `pollPayload` 中新增 `Logs` 数组字段，每次轮询原子打包并清空暂存的日志数据增量上报给主控。



## [0.7.4] - 2026-09-14

### Added
- **Agent 内嵌 Sing-box 内核直接交付与自愈释放**：新增 `apps/agent/internal/embedded/` 模块，通过 Go `//go:embed` 将定制 Sing-box 内核及依赖库打包于 Agent 二进制中；启动与安装时自动完成 SHA-256 校验与自愈解压释放，无需再向 Master 或 GitHub 二次下载内核。
- **Sing-box 内核 GitHub 下载支持加速镜像**：新增 `GITHUB_MIRRORS` 环境变量 / `--github-mirrors` 安装旗标 / 配置项 `githubMirrors`（前缀代理列表，安装脚本自动注入并持久化）；内核 GitHub 回退路径按「直连 → 镜像」顺序尝试，免安装运行的后台内核自举同样生效。

### Changed
- **内核自愈与启动时序优化**：Agent 启动初期同步自愈释放内嵌内核，确保 Sing-box 管理器与监管子进程初始化前内核文件已就绪；优化惰性版本识别与心跳字段序列化，避免空值导致校验失败。
- **内核确保逻辑显式来源放行**：`kernel.Ensure` 在 `source == "auto"` 且未指定自定义 URL 时优先使用内嵌内核；显式指定 `--singbox-source github` / `master` 或自定义 URL 时放行穿透到远程下载逻辑，支持显式测试与自定义镜像拉取。

### Fixed
- **修复主控心跳网关空版本强校验拦截**：修复内核未就绪上报空版本时被主控网关判定为非法有效负载并标记离线的异常。



## [0.7.3] - 2026-09-14

### Fixed
- **反向穿透隧道鉴权兼容性增强**：在服务端（`RoleServer`）握手鉴权时新增隧道 ID 前缀归一化容错机制，兼容匹配 `tunnel-server-`、`tunnel-client-` 与 `tunnel-` 前缀，确保跨版本主控与 Agent 协同交互时握手鉴权平滑通过。
- **修复自升级重启使用陈旧可执行路径**：`restartSelf` 在原子替换二进制之后才调用 `os.Executable()`，Linux 上 `/proc/self/exe` 会反映改名后的 `.riri-old` 备份路径（实机复现：`fork/exec /usr/local/bin/riri-agent.riri-old: no such file or directory`），导致 spawn 必然失败、旧进程带旧版本继续心跳——即面板画像版本不更新的直接根因。现改为启动时解析一次可执行路径并缓存，自拉起与服务工厂均使用该路径；路径缺失时自拉起直接报错，绝不 exec 备份文件。
- **升级后进程接管策略重构**：修复远程升级替换二进制后仅依赖自拉起（spawn 新进程 + 退出）导致的静默失败——spawn 失败时旧进程带旧版本继续心跳，面板画像版本永远不更新。重启决策改为系统服务重启优先（服务已安装且运行中时直接 `svc.Restart()`，由 systemd/SCM 立即从磁盘新二进制拉起并恢复监管，同时消除自拉起导致的 `RestartSec=120` 空窗与双连接竞态）；未安装服务、状态检测失败或服务重启失败时降级为原有自拉起兜底。两路均失败时旧进程继续运行，WS 模式会向主控上报 `log_report` 错误日志，配合主控升级版本对账在 5 分钟内暴露"重启可能失败"。



## [0.7.2] - 2026-09-13

### Added
- **免安装直接运行（便携模式）内核自举**：`riri-agent run` 仅凭 `AGENT_TOKEN` 等环境变量即可前台运行（配置文件可选），sing-box 内核缺失时后台自动下载（`--singbox-source auto|master|github|none`，默认 auto 先主控后 GitHub，失败按 5 分钟间隔重试，不阻断 Agent 存活）；显式设置 `SINGBOX_BINARY_PATH` 视为用户自管内核跳过下载。新增 `--singbox-url` 与 `--singbox-version` 旗标及 `SINGBOX_SOURCE` 环境变量。
- **日志目录错误提示**：日志目录创建或打开失败时，错误信息附带 `RIRICLOUD_DATA_DIR` / `RIRICLOUD_LOG_PATH` 可写目录设置提示。

### Changed
- `internal/install` 的 sing-box 下载逻辑抽取为可复用的 `internal/kernel` 包，安装与免安装运行共用同一内核获取链路。

### Fixed
- **修复 Windows 服务模式下 agent.log 恒为空**：日志输出原为 `io.MultiWriter(os.Stdout, file)`，而 Windows 服务进程的 stdout 是无效句柄，`MultiWriter` 遇到写入失败即短路跳过后续 writer，导致文件永远收不到日志（`riri-agent logs` 与 TUI 查看日志随之失效）。现改为文件优先写入，并仅在 stdout 可用的上下文（前台终端、Linux systemd/容器）附加 stdout 镜像；服务模式下不再产生无效写入。
- **修复无法以 Windows 服务方式启动/停止（错误 1053）**：Agent 二进制此前缺少 Windows SCM 服务端入口，SCM 拉起 `riri-agent run` 后从未上报 `SERVICE_RUNNING`，导致服务启动/停止/安装一律以 "The service did not respond to the start or control request in a timely fashion" 超时失败。现检测 Windows 服务上下文并接入 `kardianos/service` 生命周期（`Start` 非阻塞拉起守护进程、`Stop` 取消上下文并限时等待优雅退出），Linux/macOS 前台行为不变。



## [0.7.1] - 2026-09-13

### Added
- **原生 TCP/TLS 反向多路复用隧道引擎 (Yamux)**：新增 `internal/tunnel` 核心模块，支持 `SERVER`（公网入口 VPS 监听与本地端口转发桥接）与 `CLIENT`（内网 NAT 落地端主动拨号与本地 Sing-box 流量泵出）双模式。基于 `github.com/hashicorp/yamux` 实现高并发流式解复用，严格遵循 `CGO_ENABLED=0`，零系统依赖，常驻内存 < 30MB，免疫家庭宽带 UDP QoS 限速并完全免除 root/TUN 特权要求。
- **长连接心跳保活与指数退避断线自愈**：客户端集成 25 秒周期底层 Ping 探测与超时自毁判定，内置 1s~30s 指数退避断线重连状态机，提供对家庭宽带运营商 PPPoE 定时重拨、光猫休眠与网络瞬断的秒级平滑自愈。



## [0.7.0] - 2026-09-09

### Added
- **节点镜像代理**：新增 `mirror_proxy` 能力宣告与受限 HTTP/HTTPS GET/HEAD 执行器，支持安全重定向、Range/条件请求、二进制流式回传、取消、超时、响应大小和并发限制。

### Changed
- **独立版本构建适配**：构建脚本优先读取 `apps/agent/VERSION` 独立版本注入二进制版本标识，解耦对主控根 package.json 的依赖。

### Fixed
- **无交互与 Docker 环境 TTY 判定修复**：引入 `github.com/mattn/go-isatty` 精准判定控制台终端，修复非交互与 Docker 容器环境因 Stdin 为 `/dev/null` 误触发 Bubble Tea 全屏 TUI 导致 cancelreader epoll 崩溃退出的缺陷；镜像默认补充 `CMD ["run"]` 守护指令。



## [0.6.14] - 2026-09-07

### Changed
- **独立版本体系分水岭**：Agent 正式从 Master 统一版本管理中解耦，建立独立版本号 `apps/agent/VERSION` 与独立变更日志；首发继承 `0.6.14` 基线版本，后续按 `agent-vA.B.C` 独立迭代发布。
- **架构解耦与纯独立守护**：取消 Master 容器/发行包对 Agent 进程的内嵌托管，Agent 全面作为独立服务或 Docker 容器运行，通过 WS/HTTP 协议连接 Master。
