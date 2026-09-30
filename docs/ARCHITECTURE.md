# 系统架构设计 (Architecture Design)

## 1. 总体架构拓扑

RiriCloud 采用清晰的 **Master-Agent（控制平面 - 数据平面）** 分布式解耦架构设计：

```mermaid
graph TB
    subgraph "客户端终端 (End Users & Admins)"
        UserBrowser["管理员 & 用户 Web 浏览器<br/>(Chrome / Safari / Edge)"]
        VpnClients["多平台代理/VPN 客户端<br/>(Clash Meta / Sing-box / Shadowrocket / v2rayN)"]
    end

    EdgeProxy["Nginx 边缘代理<br/>(HTTPS / rewrite / WSS / 限流)"]

    subgraph "主控中心 (Master Server - Control Plane)"
        direction TB
        FrontendUI["Web 前端静态站点<br/>(React + Vite + shadcn/ui)"]
        APIServer["RESTful API 业务服务<br/>(NestJS + TypeScript)"]
        WSGateway["WebSocket 主从实时网关<br/>(@nestjs/websockets - ws)"]
        AgentPollAPI["Agent HTTP 轮询适配器<br/>(POST /api/v1/agent/poll)"]
        SubscriptionEngine["通用多格式订阅生成引擎<br/>(YAML / JSON / Base64)"]
        SQLiteMain[("主业务库 SQLite (WAL)<br/>app.db / riri.db")]
        SQLiteTelemetry[("时序与日志库 SQLite (WAL)<br/>telemetry.db")]
        LocalAgent["内置本机 Agent<br/>(riri-agent)"]
        LocalSingbox["内置本机 Sing-box"]
        
        FrontendUI -->|"HTTP(S)"| APIServer
        APIServer <-->|"核心业务 CRUD"| SQLiteMain
        APIServer <-->|"时序指标与系统日志"| SQLiteTelemetry
        APIServer <--> WSGateway
        APIServer <--> AgentPollAPI
        APIServer <--> SubscriptionEngine
        LocalAgent <-->|"WS / 本机进程"| WSGateway
        LocalAgent <-->|"本地 JSON 配置管理"| LocalSingbox
        LocalAgent -->|"本地 gRPC StatsService"| LocalSingbox
        LocalAgent -->|"CPU/内存/网络与用户流量遥测"| APIServer
    end

    subgraph "边缘节点 A (Edge Node 1 - Data Plane)"
        direction TB
        AgentA["Go Node Agent 守护进程<br/>(riri-agent binary)"]
        SingboxA["Sing-box 代理内核进程<br/>(Inbounds: VLESS-Reality / Hysteria2)"]
        SystemMonitorA["系统资源与网络监测器<br/>(gopsutil)"]

        AgentA <-->|"本地进程 & JSON 配置管理"| SingboxA
        SystemMonitorA -->|"收集 CPU/内存/IO"| AgentA
    end

    subgraph "边缘节点 B (Edge Node 2 - Data Plane)"
        direction TB
        AgentB["Go Node Agent 守护进程<br/>(riri-agent binary)"]
        SingboxB["Sing-box 代理内核进程<br/>(Inbounds: Shadowsocks / TUIC)"]
        SystemMonitorB["系统资源与网络监测器<br/>(gopsutil)"]

        AgentB <-->|"本地进程 & JSON 配置管理"| SingboxB
        SystemMonitorB -->|"收集 CPU/内存/IO"| AgentB
    end

    UserBrowser -->|"HTTPS 管理与访问"| EdgeProxy
    VpnClients -->|"HTTPS 标准或伪静态订阅"| EdgeProxy
    EdgeProxy -->|"反向代理 HTTP / WSS"| APIServer
    EdgeProxy -.->|"/<UUID> 内部 rewrite 到 /api/v1/sub/<UUID>"| SubscriptionEngine
    UserBrowser -.->|"Master 托管 Web 静态资源"| FrontendUI
    VpnClients -.->|"标准订阅业务处理"| SubscriptionEngine
    VpnClients -->|"加密代理流量"| SingboxA
    VpnClients -->|"加密代理流量"| SingboxB

    AgentA <-->|"WSS 安全长连接 (心跳 / 配置下发 / 流量上报 / 升级 / 探针)"| WSGateway
    AgentB <-->|"WSS 安全长连接 (心跳 / 配置下发 / 流量上报 / 升级 / 探针)"| WSGateway
    AgentA -->|"HTTP/HTTPS 定时轮询 (遥测 / 配置 / 任务)"| AgentPollAPI
    AgentB -->|"HTTP/HTTPS 定时轮询 (遥测 / 配置 / 任务)"| AgentPollAPI
```

---

## 2. 核心组件分工

### 2.1 主控中心 (Master Server)
- **Web UI (`apps/web`)**：为用户和管理员提供现代化的 Web 控制界面。包括用户注册登录、融合公告/订阅管理/可用线路/客户端指引的「我的订阅」控制台、通用订阅导出，以及管理员的用户管理、节点纳管、线路拓扑配置、配置下发和系统状态监控。
- **业务 API 服务 (`apps/server`)**：基于 NestJS 框架开发，提供标准的 RESTful 接口与 JWT 鉴权；浏览器会话使用 HttpOnly/SameSite Cookie，服务端以 `sessionVersion` 递增实现注销、改密、重置和禁用后的旧会话失效。
- **Agent 统一业务服务 (`apps/server/agent-gateway/agent.service.ts`)**：维护节点鉴权、遥测落库、配置快照、任务队列、探针快照与健康判定；同一节点的心跳串行处理，流量账务使用短事务；WS 网关和 HTTP 轮询控制器均为薄传输适配器。
- **主控二进制分发中心 (`apps/server/src/binaries`)**：维护规范的双层存储架构：最高优先级的运行态持久仓 `data/binaries/`（支持多架构自定义导入、热更新与远程缓存）与静态内置仓 `binaries/`（发行包仅精准预置当前宿主架构的二进制）；开发环境下智能回退至 `artifacts/binaries`。升级任务按节点 `osArch` 选择主控内置或导入版本，下载端点使用 AgentToken 鉴权。
- **批量 Agent 升级**：管理员节点列表批量入口由 `NodesService` 以最多 4 个并发逐节点复用单节点升级资源解析与持久化部署任务，按每个节点操作系统/架构选择并校验资产；结果逐节点区分 WS 已下发、HTTP/离线任务排队和失败。该能力不引入额外任务系统、数据库模型或 Agent/WS 协议变更。
- **WebSocket 实时网关 (`apps/server/agent-gateway`)**：与分布在全球的各 Node Agent 保持双向全双工长连接，实现秒级状态同步与实时配置热推。
- **HTTP 轮询适配器 (`POST /api/v1/agent/poll`)**：为无法完成 WS Upgrade 的网络提供 HTTPS 主动上报、配置差异拉取和异步任务回执。
- **Master-Local 本机节点纳管 (`apps/agent` + `riri-agent`)**：Master 镜像与 Agent 镜像在进程及容器层面彻底解耦；Docker Compose 默认编排独立的 `master` 与 `agent` 容器，通过 `AGENT_IMAGE` 与 `MASTER_LOCAL_AGENT_TOKEN` 环境变量完成自动对接；Master 启动时 bootstrap 自动为 Master-Local 节点绑定该凭据，Agent 独立运行并作为宿主机网络上的节点纳管服务。远程 VPS 使用 Agent 原生 CLI 安装或 Docker 容器运行并接入，支持通过管理面板快捷复制多模式启动命令。
- **线路与订阅引擎 (`apps/server/lines`、`apps/server/subscription`)**：Line 是用户订阅端点的唯一业务实体，直接拥有协议、参数、监听地址、Tag、入口/出口拓扑和端口，支持直连、盲转发和协议代理中继；订阅服务按套餐匹配公开启用且入口/出口节点在线的线路，动态组装 Clash Meta YAML、Sing-box Client JSON 和 Base64 URI，并应用地址/端口、SNI/Host 与倍率覆盖。
- **入站配置组装 (`apps/server/common/inbound.ts`)**：入站参数归一化（默认值填充/密钥自动生成/必填校验）、服务端入站 JSON 与客户端 TLS/Transport JSON 组装的单一实现，`config_sync` 与订阅 builders 复用，避免两处各持一份协议知识；其中 WebSocket `host` 统一映射为 `headers.Host`，SS2022 用户密钥按算法长度归一化。ShadowTLS 固定为 v3 + SS2022 内层，配置生成两个入站：公网 ShadowTLS 外层通过 `detour` 接入仅监听回环地址的 SS 入站，用户凭证只用于外层用户鉴权。
- **多设备在线限制与设备管理 (`apps/agent/internal/devices`、`apps/server/agent-gateway`)**：Agent 每 2 秒读取 Sing-box 本地 Clash API `/connections`，将可识别的用户凭据、来源 IP、线路和连接数随心跳/HTTP 轮询上报；Master 只在内存中按用户 + IP 跨节点去重，并按 `deviceOnlineWindowSecs` 过滤陈旧报告。Master 下发正数用户限额，Agent 在本机选择较早出现的 IP 保留并断开超额连接；跨节点超限由 Master 按最早 `firstSeenAt` 保留设备、向相关节点下发 `kick_devices`，30 秒防抖并默认阻断 60 秒。手动用户/管理员踢设备复用同一任务通道。Agent 自编译 Sing-box 的 Clash API JSON 增加 `metadata.inboundUser` 字段（不解析日志）；短连接可能被 2 秒采样漏过，外部 Clash API 地址必须为 loopback。
- **套餐与订阅控制面 (`apps/server/plans`、`apps/server/subscription`、`apps/server/subscription-templates`)**：Plan 决定线路标签/显式 ID 授权范围与流量重置策略，Subscription 维护用户唯一订阅和当前流量周期，UserLineGrant 维护独立于订阅生命周期的用户额外线路授权，Template 驱动 Clash/Sing-box 的策略组、规则、DNS 与顶层覆写；订阅和 User 兼容镜像在事务中同步。
- **套餐购买台账与限购 (`PlanPurchaseIdentity` / `PlanPurchase`)**：Plan 可配置每位用户的限购次数与是否允许续费；购买身份通过邮箱 HMAC 别名与可删除的 User 解耦，订阅取消、过期、升配或账号删除后购买记录仍保留。自助订购/升配、注册默认套餐和管理员发放统一写入购买台账，唯一约束 `(identityId, planId, sequence)` 负责并发兜底；续费只校验套餐允许续费，不消耗限购次数。免费套餐默认限购 1 次且不可续费，管理员补发可通过 `ADMIN` 来源破例但仍记账。
- **卡密分类与兑换履约 (`apps/server/src/redeem-codes`)**：每张卡密保存生成时的余额金额或完整套餐权益快照；分类额度以共享购买身份为键累计，不使用标签计数。兑换在单一 SQLite 事务中条件核销卡密、原子递增分类额度，并提交余额流水或订阅/套餐购买台账，确保同卡并发只履约一次且跨账号共享身份不能突破上限。套餐卡与其他来源共用购买限购；有效订阅时拒绝且回滚，不核销。软删除只隐藏后台记录，不影响兑换，显式作废才禁止兑换；过期清理同样只软删除。
- **持久化层 (Prisma + 双 SQLite 物理分库)**：零外部服务与网络数据库依赖，由主业务库（`app.db` / `riri.db`，由 `@prisma/client` 管理）与时序日志库（`telemetry.db`，由 `@prisma/telemetry-client` 管理）组成。两库物理隔离并分别开启独立 WAL 模式与 10s `busy_timeout`，高频的小时流量时序（`TrafficHourlyMetric`）、节点网卡速率（`NodeRateMetric`）与全链路日志（`SystemLog`）写入与业务账务完全物理分流，彻底杜绝单文件 SQLite 写锁争用风险。

### 2.2 边缘节点守护程序 (Node Agent - `apps/agent`)
- **双模式通信与自愈**：Agent 根据 `MASTER_URL` 的 `ws(s)://` / `http(s)://` 前缀推导模式，也可由 `AGENT_MODE=ws|http` 显式指定；WS 模式具备指数退避重连，HTTP 模式按 `POLL_INTERVAL_SECS` 轮询并接受 Master 的 `nextPollSecs` 调整；服务端只接受通过结构校验的 Agent 上行数据。
- **内核生命周期管理**：Agent 内置 supervisor 单协程托管 Sing-box 子进程——`config_sync` 原子落盘后拉起内核（二进制路径由 YAML 配置或 `SINGBOX_BINARY_PATH` 指定），配置字节比对变化时优雅重启（SIGTERM → 宽限 → Kill）即热应用，进程异常退出按指数退避自动拉起。Docker Master 镜像和自包含发行包直接携带 Linux Sing-box；远程 Agent 由 `install` 命令从 Master 获取内核，失败时可回退 GitHub Release。
- **Sing-box 日志治理**：Agent 将内核 stdout/stderr 行解析为真实级别并去除 ANSI，保留 `stream` 元数据；正常模式只采集真实 WARN/ERROR，连接访问类输出标记为 ACCESS 并丢弃，异常退出由 supervisor 生成结构化 ERROR。Master 按节点诊断状态二次拦截并将 WARN/ERROR 指标与普通生命周期 INFO 分离；临时 INFO/DEBUG 诊断通过同一 `config_sync` 重启链路下发，30 分钟后自动回收。
- **Agent 生命周期 CLI**：`riri-agent` 由 Cobra 分发一级命令；无参数且连接终端时进入 Bubble Tea + lipgloss 全屏控制台 GUI/TUI，使用 raw mode 直接消费方向键，提供菜单、安装表单、卸载确认、异步任务和结果滚动页；无 TTY 或显式子命令仍走非交互 CLI。服务注册与启停通过 `kardianos/service` 适配 systemd/OpenRC/SysVinit、Windows Service 和 macOS Launchd。标准配置为 `/etc/riri-agent/config.yaml`，运行时目录为 `/var/lib/riri-agent/`。
- **配置预检与回滚（v0.3.0）**：落盘后、拉起前执行 `sing-box check -c` 预检（15s 超时）；失败则拒绝该配置、把磁盘回滚为 lastGood、在跑内核不受影响，并通过 `config_apply_result` 回执失败原因。内核 stderr 环形采样尾部 8KB，**非预期退出**（崩溃）原因随心跳 `lastError` 上报；配置变更引发的主动重启（SIGTERM/Kill 退出码非 0）属预期停止，不记错误、不计退避；内核拉起成功即清除历史失败原因。
- **远程升级与网络诊断（v0.3.0）**：升级任务默认使用 Master 内置二进制分发中心，也可显式指定已校验的自定义 URL；Agent 流式下载至临时文件并校验。Sing-box 在升级窗口抑制 supervisor，保留旧二进制备份，确认新进程启动后再清理备份，失败则恢复旧版本。Agent 自身升级或管理员快捷重启均保留启动参数；探针支持 TCP、DNS、ICMP，返回延迟、丢包率、DNS 地址和错误，并由 Master 保存最近一次快照。
- **Line 驱动的监听与中继**：节点不再由管理员维护业务入站；主控按节点承担的启用 Line 自动生成协议入站、盲转发 `direct` 入站、协议代理 outbound 和 route。监听地址由 Line 可视化编辑，默认 `0.0.0.0`；Tag 可自定义，空值时按 Line ID 派生，中继入口/出口自动追加角色后缀。Line 端口未指定时由主控随机分配 `20000~65535` 的五位端口；同节点同 TCP/UDP 传输层端口互斥，已有端口在编辑、重启和配置同步时保持不变。历史 `NodeInbound` 仅保留作迁移兼容，不参与新配置生成。标准 TLS 可通过 `Certificate` 实体统一托管，Master 在 `config_sync` 时以内嵌 PEM 数组下发并在证书更新后级联同步关联节点；未关联证书的线路仍支持 Agent 机本地路径。
- **系统遥测 (Telemetry)**：基于 `gopsutil` 定期采集服务器 CPU 占用、内存使用、磁盘及实时网络带宽吞吐，随心跳上报。网络吞吐拆分为 `uploadRate` / `downloadRate`（bytes/s），并保留兼容字段 `bandwidthRate`；计数器回绕或采样异常时对应方向归零。节点当前速率落在 `Node`，历史速率进入 `NodeRateMetric` 的 UTC 五分钟桶，默认保留 30 天并按设置可配置，由 12 小时巡检清理过期桶。
- **Agent 本地日志轮转**：新 Agent 以 `agentLogMaxSizeMb`/`agentLogMaxFiles` 接收 Master 的可选策略，默认 50 MiB/5 个文件（包含当前文件）；本地 YAML/环境变量在远端配置缺失时生效。轮转 writer 与前台、服务和 TUI 共用同一 `agent.log` 路径，轮转失败时保留当前文件写入并报告错误。旧 Agent 未声明 `agent_log_rotation` 时继续通信和业务运行，但管理端显示升级提示。
- **流量统计与上报（协议 v2）**：服务端为每个节点配置本地 `experimental.v2ray_api` gRPC StatsService，Agent 使用 `QueryStats(reset=false)` 读取 `user>>>{name}>>>traffic>>>uplink/downlink` 累计值，并在 WS/HTTP 两种模式中统一上报 `trafficSnapshots`。Master 按 `nodeId + credential` 保存 `TrafficCursor`，以 BigInt 差分计算增量；首次值计入，计数器下降按重置告警并计入当前值，相等值不生成流水。启用套餐重置策略的订阅在心跳入账前检查自然月或 `durationDays` 周期边界，跨界时先在事务内同步清零 Subscription 与 User 镜像，再计入当前增量；`TrafficLog`、`TrafficCursor`、`Subscription.trafficUsedBytes` 与 `User.trafficUsedBytes` 在同一短 SQLite 事务内提交；未知凭证只建立游标基线。共享密码模式的 SS 没有用户归属，按协议粒度不产生用户流量记录。
- **Agent 写入调度**：Master 对同节点心跳使用最新值覆盖积压数据，并通过单写者队列串行化 Agent 相关数据库写入；速率指标先在内存按 UTC 五分钟桶聚合，再批量写入 `NodeRateMetric`。写入失败保留最新任务并指数退避重试，队列等待、队列长度、事务耗时和计数器重置均记录到日志。SQLite 继续使用 WAL 与 `busy_timeout`，不通过无限增大事务等待时间掩盖写锁争用。
- **网络速率统计查询**：`GET /admin/traffic/overview` 同时返回节点网络吞吐当前摘要与历史 `rateSeries`。当前值仅汇总在线且未超时节点；历史按查询周期重采样为 5 分钟、30 分钟或 1 小时。该指标描述网卡吞吐，不进入 `TrafficLog`，中继入口与出口的重复网络传输允许分别计入。

---

## 3. 核心业务与数据交互时序

### 3.1 节点接入与全自动初始化流程

```mermaid
sequenceDiagram
    autonumber
    actor Admin as 管理员
    participant Web as Master Web面板
    participant Master as Master 后端服务
    participant Agent as VPS Node Agent
    participant Singbox as Sing-box 内核

    Admin->>Web: 1. 在面板创建节点基础信息，再通过线路向导定义协议、参数与入口/出口拓扑
    Web->>Master: POST /api/v1/admin/nodes 与 /admin/lines
    Master-->>Web: 返回 Node ID 及一次性 AgentToken
    Web-->>Admin: 展示一键原生 CLI 命令 (Header 下载 Agent + riri-agent install)
    
    Admin->>Agent: 2. 在 VPS 执行一键原生 CLI 命令
    Note over Agent: 下载 Agent 二进制，执行 install，写入 YAML、下载 Sing-box 并注册系统服务
    Agent->>Master: 3. 发起 WSS 连接: /ws/agent，并在 Header 传递 X-Agent-Token
    Master->>Master: 4. 鉴权 AgentToken & 标记节点状态为 ONLINE
    Master-->>Agent: 5. 握手成功并下发当前全量 Sing-box 配置文件 JSON
    Agent->>Singbox: 6. 写入 config.json 并启动 Sing-box 守护进程
    Singbox-->>Agent: 启动成功 (监听端口就绪)
    Agent-->>Master: 7. 上报服务启动成功状态
```

### 3.2 线路、中继与配置联动

线路管理由 Line 实体一次性内聚定义协议参数、传输安全、入口节点/端口和落地节点/端口：
- **直连线路 (`DIRECT`)**：仅绑定单个入口节点与业务监听端口 (`entryNodeId` + `entryPort`)，落地字段保持为 `null`，直接由该节点监听业务入站。
- **中继线路 (`RELAY`)**：跨节点级联。由中转入口节点监听 `entryPort`，再将流量转发到落地节点的 `landingPort`；端口缺省时由服务端在 `20000~65535` 范围自动分配可用端口，同节点同传输层端口互斥保护。
  - **盲转发机制 (`BLIND_FORWARD`)**：入口节点生成 Sing-box `direct` 入站（带有 `override_address` 与 `override_port`），仅作四层 TCP/UDP 透传；握手与解密完全在落地节点的目标协议入站完成，实现端到端加密与极低开销。
  - **协议代理机制 (`PROTOCOL_PROXY`)**：入口节点先拉起完整协议入站终结连接，再经由 Sing-box 内部 `route.rules` 和动态生成的对应协议 `outbound` 向落地节点重新握手建连。
  - **桥接已有线路 (`TARGET_LINE`)**：入口节点将连接中转至其他节点上已有的直连目标线路，数据库中落地字段保持 `null`，完全基于关联动态解析（单一真理源 SSOT），落地节点复用目标直连入站。
- **独立端口管道设计**：系统为每条线路分配独立的端口管道（除桥接模式复用落地直连入站外）。这确保了不同线路的流量倍率（如直连 1.0x vs 中转 1.5x）在边缘 Agent 增量统计时精准隔离，且任何单条线路的启停或变更均不影响其他线路的生命周期与健康检测。
- **配置推送与在线门禁**：保存线路后复用 250ms 防抖，自动为承担入口或落地角色的在线节点重新编译并下发 `config_sync`。中继线路在套餐订阅中要求中转入口节点与落地节点**同时在线**才会向客户端呈现并允许连通。


### 3.3 Sing-box 日志诊断时序

```mermaid
sequenceDiagram
    autonumber
    actor Admin as 管理员
    participant Web as Web 面板
    participant Master as Master 后端
    participant Agent as 在线 Agent
    participant Singbox as Sing-box 内核

    Admin->>Web: 选择 INFO/DEBUG 并确认重启与隐私风险
    Web->>Master: POST /admin/nodes/:id/log-diagnostics
    Master->>Master: 校验 ONLINE + singbox_log_capture，写入 30 分钟策略并清理 config cache
    alt WS
        Master-->>Agent: config_sync(log.level=info/debug, singboxLogCaptureLevel=INFO/DEBUG)
    else HTTP
        Agent->>Master: 下一次 POST /api/v1/agent/poll
        Master-->>Agent: 配置差异 + singboxLogCaptureLevel
    end
    Agent->>Singbox: 预检、原子落盘并重启
    Singbox-->>Agent: stdout/stderr（解析真实级别，ACCESS 单独标记）
    Agent-->>Master: log_report（批量；ERROR 快速冲刷）
    Master->>Master: 按有效诊断期与来源门槛入库/实时推流并执行脱敏
    Master->>Agent: 过期巡检后下发 NORMAL + WARN 采集配置
```

诊断结束、手动停止或节点策略过期时，Master 清理该节点配置缓存；WS 节点立即收到新配置，HTTP 节点在下一次轮询获得新配置。

### 3.4 节点遥测心跳与流量核算

```mermaid
sequenceDiagram
    autonumber
    participant Agent as VPS Node Agent
    participant Singbox as Sing-box 内核
    participant Master as Master 后端服务
    participant DB as SQLite 数据库

    loop WS 每 5~10 秒 / HTTP 每 15 秒
        Agent->>Agent: 采集系统 CPU / 内存 / 网速
        Agent->>Singbox: 通过本地 gRPC StatsService 查询累计用户流量（reset=false）
        alt WS/WSS 模式
            Agent->>Master: 发送 Heartbeat WSS 消息 (协议 v2 + 系统指标 + 累计快照)
        else HTTP/HTTPS 模式
            Agent->>Master: POST /api/v1/agent/poll (协议 v2 + 系统指标 + 累计快照 + 回执)
            Master-->>Agent: 协议版本、配置差异、任务队列与 nextPollSecs
        end
        Master->>DB: 单写者队列更新节点状态
        Master->>DB: 事务内差分 TrafficCursor、实时扣减用户与订阅配额（超额即刻熔断）
        Master->>Master: 增量时序点投递至内存 TrafficHourlyMetricBuffer（按小时/节点/用户/线路归拢）
        Note over Master,DB: 异步每 10~15 秒定时执行微批 UPSERT 落库 TrafficHourlyMetric，停机优雅 Flush
        
        alt 发现某用户已过期或配额耗尽
            Master->>Master: 从该节点白名单中剔除该用户 UUID
            Master-->>Agent: 下发 config_sync (更新后的配置 JSON)
            Agent->>Singbox: 持久化并优雅重启内核 (配置热应用)
        end
    end
```

同一节点在写入队列中只保留最新遥测和最新累计快照；累计计数器本身支持请求重试和断线恢复，因此不依赖 ACK 作为流量正确性的基础。

系统日志与流量账务严格解耦：`SystemLogsService` 只承载运维事件与异常，SINGBOX 连接访问日志默认不入库；流量计费、配额熔断和小时桶仍由 StatsService、heartbeat 与 TrafficHourlyMetric 管线完成，不从 `SystemLog` 推导连接流量。
流量时序看板查询直接读取 `TrafficHourlyMetric` 小时桶数据，彻底根除秒级明细插入带来的写锁竞争与百万级原始行内存遍历；后台 `TrafficCleanupService` 每 12 小时按 `trafficHourlyRetentionDays` 滑动窗口清理，`AgentSweepService` 同周期按 `nodeRateRetentionDays` 清理速率桶，旧版 `TrafficLog` 继续按固定 7 天过渡策略清理，保障 SQLite 体积恒定可控。

管理员可以通过统一遥测清理中心先预览再执行 `TrafficHourlyMetric`、`NodeRateMetric`、`SystemLog` 和 `TrafficLog` 的按策略、时间、数量或全量历史清理。清理按表独立返回成功/失败，执行结束后才追加 `TelemetryCleanup` 审计日志并刷新日志队列，清空系统日志不会删除本次审计。该边界明确排除用户额度、订阅已用流量、`TrafficCursor`、节点实时状态和计费数据。

### 3.5 订阅生命周期与配置联动

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant Web as Web 面板
    participant Nginx as Nginx 边缘代理
    participant Master as Master 后端
    participant DB as SQLite
    participant Agent as 在线 Agent

    User->>Web: 订购 / 升配 / 取消订阅
    Web->>Master: /user/subscription/*
    Master->>DB: 事务更新 Subscription 与 User 兼容镜像
    Master-->>Web: 返回订阅状态、Token 与匹配节点
    Master->>Master: 250ms 配置推送防抖合并
    Master->>Agent: config_sync（重新计算有效用户白名单）
    Agent->>Agent: 预检、原子落盘、按需优雅重启内核

    User->>Web: 复制标准或伪静态订阅 URL
    Web-->>User: /api/v1/sub/<UUID> 或 /<UUID>
    User->>Nginx: GET /<UUID>?type=clash
    Nginx->>Master: 内部 rewrite 为 GET /api/v1/sub/<UUID>
    Master-->>Nginx: Clash / Sing-box / Base64 内容与响应头
    Nginx-->>User: 原样转发订阅响应
```

订阅输出请求通过 Token 定位 Subscription，再按“套餐匹配线路 + UserLineGrant 额外线路”并集计算可用 Line；套餐线路要求公开且处于启用状态（`status=ACTIVE`），额外线路可绕过公开性和套餐规则但仍要求启用，若为目标线路桥接模式（`TARGET_LINE`）则要求目标直连线路亦处于启用状态，全局 `publicLinesEnabled=false` 作为总开关。控制平面与数据平面彻底解耦：订阅下发不再与节点 Agent 心跳状态强绑定，即使节点 Agent 暂时失联，只要线路本身启用均全量下发，由客户端本地测速（url-test/fallback）实现健康检查与自动切换，避免服务端单点网络抖动导致订阅节点全量失效。节点离线扫描按 `lastSeenAt` 做乐观并发校验，避免旧扫描结果覆盖扫描期间已恢复的节点。Token 重置同时更新 Subscription 与 User，旧 URL 立即失效。流量周期在订阅读取、心跳入账和每分钟后台巡检中惰性或定时推进；旧订阅首次启用策略只初始化周期起点，不修改已有用量和 TrafficLog。Nginx 只承担入口 rewrite 和代理，不参与 Token、权限或订阅格式业务判断。

### 3.6 远程升级与网络探针时序

```mermaid
sequenceDiagram
    autonumber
    actor Admin as 管理员
    participant Master as Master 后端
    participant Agent as Go Agent
    participant Kernel as Sing-box

    Admin->>Master: POST /admin/nodes/:id/upgrade 或 /probe
    Master->>Agent: upgrade_task / probe_task / restart_agent_task
    alt 升级
        Agent->>Agent: 流式下载 + SHA-256 校验
        Agent->>Kernel: 预检当前配置并优雅停止
        Agent->>Agent: 原子替换并保留旧二进制备份
        Agent->>Kernel: supervisor 启动新版本
        alt 启动失败
            Agent->>Agent: 恢复旧二进制并重新拉起
        end
        Agent-->>Master: upgrade_result
    else 探针
        Agent->>Agent: TCP / DNS / ICMP 探测
        Agent-->>Master: probe_result（逐项延迟、DNS 地址、丢包率）
    else Agent 重启
        Agent-->>Master: restart_agent_result
        Agent->>Agent: 保留原始参数重新启动
    end
```

---

## 4. 安全设计 (Security Architecture)

1. **管理与用户访问安全**：
   - 密码使用 `bcrypt` 单向哈希加盐存储。
   - API 采用 JWT 鉴权；浏览器通过 HttpOnly/SameSite Cookie 携带，JWT 带 `sessionVersion`，密码/账号状态变化后旧会话立即失效。
   - 角色访问控制（RBAC）：细分 `ADMIN` 和 `USER` 权限路由守卫。
2. **Master-Agent 通信安全**：
   - 生产环境强制采用 WSS (WebSocket over TLS) 加密传输。
   - 每个节点在主控端创建时分配唯一的 `AgentToken`（32 字节 CSPRNG），数据库保存 AES-GCM 密文与 SHA-256 校验值；AgentToken 只在创建/轮换响应中返回一次，握手和二进制下载统一使用 `X-Agent-Token` Header，旧连接在轮换后立即断开。
   - SSE 日志流先由管理员 JWT 创建一次性短期票据，SSE URL 不接受长期 JWT；日志、下载响应和订阅响应均禁止缓存并设置 `Referrer-Policy: no-referrer`。
   - 线路 `paramsJson` 中的 Reality 私钥按应用层 AES-GCM 加密保存，只有编译 Agent 配置时在内存中解密；管理端线路响应始终脱敏。
   - Agent 上行消息先经过类型、范围、数组长度和文本长度校验；升级任务同时校验 URL 协议与 64 位十六进制 SHA-256，失败输入不进入业务层。
3. **代理传输安全 (Reality / TLS)**：
   - 首推 **VLESS + Reality** 协议：无需自备域名与公网证书，通过窃用大型合法网站（如 `www.apple.com`, `gateway.icloud.com` 等）的 SNI 与 TLS 握手特征，实现极强的抗封锁能力。
   - 支持 **Hysteria2 / TUIC** 协议：基于 UDP/QUIC，具备拥塞控制与抗高丢包能力。
4. **边缘入口安全**：
   - 生产环境由 Nginx 终止 HTTPS/WSS，并将管理面板、标准订阅、UUID 伪静态订阅和 `/ws/agent` 统一代理到 Master；Master 不内置通用反向代理。
   - 短链 location 只匹配严格 UUID 单段 GET 路径，避免吞掉 `/login`、`/admin`、`/api/**` 和 SPA 路由；部署者必须保持 `subscriptionBaseUrl` pathname 与 Nginx rewrite 前缀一致。

## 8. 二进制资源中心与升级分发

Master 将“应用发布”和“可分发二进制资源”拆成两条生命周期。根 `package.json` 版本继续代表 Master/Web/Agent 应用与协议版本；Sing-box 资源由 `upstreamVersion + revision` 独立标识，平台文件由 `BinaryAsset` 管理，`libcronet.so` 与 Sing-box 主文件挂在同一资产包内。

启动时 `BinaryResourcesService` 读取静态内置仓和运行态 `data/binaries` 中的 `manifest.json`，将资源元数据认领到 SQLite，再兼容旧目录扫描；随后自动收敛内置资源生命周期——镜像/发行包主 manifest 解析成功时，把不在当前 manifest 中的 `BUILTIN` 资源自动归档（保留审计、可手动恢复），避免升级镜像后在资源列表中积累历史“内置”版本；同时把磁盘文件缺失或 SHA-256 不符的资产标记为不可用（文件恢复后自愈回填），无任何可用资产的启用资源自动停用，并将每类资源的默认版本收敛为唯一一条。资源文件不进入数据库，运行态文件按 `data/binaries/resources/<releaseId>/<target>/` 保存。管理员通过资源中心上传或远程导入，资源状态流转为 DRAFT、ACTIVE、DISABLED、RETIRED；节点或默认配置引用的资源只能逻辑停用/归档。

节点升级由 `BinaryDeploymentTask` 驱动：服务端按节点平台与兼容约束解析 ACTIVE 资源，生成受 AgentToken 保护的下载 URL 和文件清单；任务状态与尝试次数落库，WS/HTTP 两种传输都复用同一任务服务。Master 重启后继续处理队列，WS 重连会恢复已投递但未收到回执的任务。

**Agent 封装内嵌与单二进制交付**：
定制编译的 Sing-box（以及 Linux 平台的 `libcronet.so` 伴生动态库）在构建期经 Gzip 归档内嵌编入 Agent 二进制中（体积由 ~60MB 缩减至 ~25MB）。Agent 启动时比对 SHA-256，缺失、损坏或 Agent 升级后自动解压释放并自愈，以独立子进程托管运行（维持管理面与数据面崩溃隔离）。节点安装实现 100% 离线自闭环；节点升级收敛为统一升级 Agent 单一动作，升级 Agent 自动同步更新内核。旧协议单文件与多文件事务升级能力保留用于兼容与自愈。

## 9. 实时节点镜像链路

实时镜像保持控制面与数据面分离：浏览器请求先到 Master 的 `/mirror/...` 路由，Master 根据 `MirrorSite` 完成访问策略、路径拼接、请求头白名单、限速和节点能力检查，再通过当前节点的 WSS/WS 长连接发送 `mirror_request`。Agent 在节点本地重新解析并校验目标地址后访问上游，将安全响应头、二进制分片和结束/错误事件回传；Master 只把事件映射为 Express 响应，不保存响应体。

`taskId -> MirrorSession` 只存在 Master 内存中。客户端关闭、请求超时、Agent 断开或 Master 重启都会取消并清理会话；进行中的流不跨重启恢复。旧 Agent 不宣告 `mirror_proxy` 时不会收到镜像任务，HTTP 轮询节点也不参与实时镜像。所有 Agent 写帧继续经过既有写锁，二进制帧按任务 ID 路由到对应会话。

## 10. 直连代理池双轨架构（v0.9.0）

RiriCloud 在同一套节点、线路与账务底座上并行承载**两条互不耦合的代理交付轨道**：

| 维度 | 订阅轨道（客户端翻墙） | 直连代理池轨道（自动化环境） |
| :--- | :--- | :--- |
| 目标客户端 | Clash Meta / Sing-box / Shadowrocket | 爬虫框架、指纹浏览器、脚本与 CLI 工具 |
| 协议 | VLESS+Reality、Hysteria2、TUIC、Trojan 等 | Sing-box `mixed` 单端口（SOCKS5 + HTTP CONNECT） |
| 凭据 | 用户 `uuid` / `password` / 订阅 Token | 独立 `ProxyKey`：`pk_xxxx` 用户名 + 独立密码 |
| 交付 | 多格式订阅链接与模板编译 | `IP:Port:User:Pass`、URI、JSON、免登录 RESTful 拉取 |
| 准入控制 | 套餐线路匹配 + 邮箱核验 + 配额 | 同左，外加可选的来源 IP/CIDR 白名单 |
| 计费 | `TrafficLog` → `User` / `Subscription` | 同一事务内额外累加 `ProxyKey.trafficUsedBytes` |

两条轨道共用 `Line` 实体作为端点定义：管理员创建一条 `protocolType = MIXED` 的 `DIRECT` 线路，该线路的入口节点与端口即成为直连代理池端点，无需新增任何节点侧配置或第二个监听端口。

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户 / 自动化脚本
    participant Web as Web 面板 (/proxy-pool)
    participant Master as Master 后端
    participant DB as SQLite
    participant Agent as VPS Node Agent
    participant Singbox as Sing-box mixed 入站

    User->>Web: 创建 Proxy Key（名称 + 可选来源 IP 白名单）
    Web->>Master: POST /api/v1/user/proxy-pool/keys
    Master->>DB: 写入 ProxyKey（pk_xxxx / 高熵密码 / exportToken）
    Master-->>Agent: config_sync（重建节点配置）
    Agent->>Singbox: 重启内核，inbounds[].users 注入 pk_xxxx 与白名单 route.rules

    User->>Web: 选择节点与协议，导出多格式列表
    Web->>Master: GET /api/v1/user/proxy-pool/export?format=text|uri|json
    Master-->>Web: 纯文本 / URI / JSON（另附多语言代码片段）

    loop 每 5~10 秒
        Agent->>Singbox: 查询 v2ray 累计用户流量
        Agent->>Master: heartbeat（含 pk_xxxx 累计快照）
        Master->>DB: 同事务写 TrafficLog(proxyKeyId) + 累加 User/Subscription/ProxyKey
        alt 本批次触及配额或账号被停用
            Master-->>Agent: config_sync（剔除该账号全部凭据，快速熔断）
        end
    end
```

**关键架构约束**：

1. **强制鉴权**：`mixed`/`socks`/`http` 入站在生成配置时一律启用用户认证。Sing-box 中 `users` 为空的这三类入站等价于开放代理，属于安全红线。
2. **冒号安全的入站用户名**：HTTP CONNECT 的 Basic 认证按首个 `:` 切分用户名，因此代理池凭据使用裸 `pk_xxxx` 而非 `pk_xxxx::lineId` 复合形态；线路归属由节点级活动线路解析确定（详见 docs/API_AND_PROTOCOLS.md §5.1）。
3. **白名单以逻辑路由规则表达**：`invert` 必须内嵌在 `logical/and` 子规则中，避免顶层反转误伤同入站的其他凭据与订阅用户。
4. **零新增基础设施**：不引入额外数据库、缓存或守护进程；代理池与订阅共享同一 Agent 通道、同一 `config_sync` 热更新链路与同一 WAL 单写者事务模型。

## 5. 上游订阅与外部交付架构

```text
UpstreamSubscription（来源/调度/成功快照）
    → UpstreamNode（稳定 UUID/加密连接/配置哈希/PRESENT-MISSING）
    → Line（统一套餐/额外授权）
        ├─ RELAY + UPSTREAM_NODE → 自建入口 → 外部出口
        └─ EXTERNAL → 客户端直连外部出口
    → 已授权资源集合 → 用户安全摘要 / 客户端编译 / Agent 配置
```

上游导入只提取代理节点，不合并来源中的 DNS、规则或策略组。取消 `isDirectSub` 与全局直接分发；EXTERNAL 不绑定真实或虚构的 Node，也不生成 Agent 监听。普通 DIRECT/RELAY 的入口节点/端口仍强制必填。EXTERNAL 默认私有且禁用，沿用套餐 ALL/TAGS/EXPLICIT 与额外授权。

用户详情与客户端订阅复用同一资格和线路解析：用户无权益时仅显示订阅状态，不给连接资源；摘要采用字段白名单，不能展开含上游 `paramsJson/rawConfigJson` 的 Prisma 关联。EXTERNAL 客户端必须使用原上游凭据，中继客户端只能获得自己的入口凭据。外部直发不计本地流量、不执行本地限速或设备管理，本地停权不能撤回已交付的共享凭据；需要这些控制的管理员应使用有用户鉴权的自建中继入口。

连接编译集中到 `common/upstream-connection.ts`，中继、客户端和端到端测速复用，按格式明确报告不支持的组合。有效性集中到 `common/upstream-availability.ts`，检查源/节点启用、PRESENT、连接配置及已知上游期限/配额；元信息是账户快照而非本地用户计费数据，未知不等于无限。

同步以源串行化，跨源有限并发。远程拉取逐跳校验公共地址、绑定实际拨号 DNS、保留 Host/SNI，生产只用 HTTPS，并设置响应大小/总时长上限；跨 origin 不携带自定义秘密 Header。网络/严格解析在事务外，完整差异提交在短事务内，提交后再使配置缓存失效和推送。配置变化通知 WS 与 HTTP 两种 Agent 通道；仅名称变化不制造内核重启。

匹配使用可靠源内 ID、完整连接特征、唯一名称加协议三层一对一规则；歧义拒绝整个快照，不按顺序猜测。缺失节点保留 UUID/引用、停用关联线路，重现不自动启用线路；错误/不完整解析不删除资源，网络失败保留 last-good。禁用源立即撤下相关中继与直接分发，巡检负责到期跨界失效。裸上游 TCP 探针只反映 Master 可达性，UDP-only 不适用；协议可用性用实际代理端到端请求验证。

这是无旧兼容的破坏性升级：删除旧指纹与直发字段/接口、不自动转换或清理旧数据，部署前保护见 `docs/DEPLOYMENT_GUIDE.md`。
