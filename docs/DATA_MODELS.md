# 数据模型设计 (Data Models)

## 1. 数据库架构设计

RiriCloud 采用 SQLite 配合 Prisma ORM 进行持久化。Master 启动时会为当前数据库显式开启 **WAL (Write-Ahead Logging)**，并设置 10 秒写锁等待上限；生产环境仍应将数据库放在本地持久化文件系统，避免网络文件系统的锁语义和延迟放大问题。

> **落地说明（v0.4.20）**：Prisma 对 SQLite 不支持 `enum` 类型，角色、节点状态、协议、线路类型、线路状态、套餐匹配模式、订阅状态、钱包流水类型与卡密状态在 `schema.prisma` 中落地为 **String 字段 + 默认值**，取值约束由应用层完成（DTO 的 class-validator 与服务层校验）。下方 schema 中的 `enum` 定义视为**逻辑枚举**，实际类型以仓库内 schema.prisma 为准。Line 顶层编排已通过迁移 `20260831100000_line_centric_pipeline` 落地。

---

## 2. 种子数据（首次启动引导）

管理员初始化与演示 seed 分离：

- 启动入口先执行 `apps/server/prisma/bootstrap-admin.js`。数据库没有 `role=ADMIN` 时，按 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 创建首个管理员；兼容 `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`，优先级为正式配置高于旧配置。已有管理员时完全跳过，不改密码，也不因邮箱配置变化创建重复账号。
- 空数据库没有管理员且未提供凭据时启动失败；管理员邮箱沿用 `class-validator` 的 `IsEmail` 规则，密码长度必须为 `8-64` 位，并且必须同时包含大写字母、小写字母、数字和特殊字符。
- `AUTO_SEED=false`（生产默认值）迁移数据库、初始化管理员、确保内嵌默认订阅模板存在，并始终创建或复用系统保留的 `Master-Local` 本机节点；不会创建演示用户、体验套餐和线路。
- `AUTO_SEED=true` 才执行 `apps/server/prisma/seed.js`，额外幂等创建演示用户、体验套餐、VLESS/Reality 直连线路和盲转发示例线路；默认模板由通用 bootstrap 负责，完整 seed 会将其同步为内嵌模板定义，不会重复创建。本机节点由通用 bootstrap 负责，不会重复创建。重复执行不会覆盖已有管理员密码；本地 `pnpm setup` 仍通过该脚本使用演示默认凭据。
- `Master-Local` 使用 `Node.isLocal=true` 标记，是 Master 内置 Agent 的固定数据库身份。启动时复用已有 `agentToken` 与节点配置；管理端删除接口对该节点返回 `409`，防止误删内置 Agent 身份。
- 管理员密码不能通过启动环境变量隐式修改；使用 `pnpm admin:reset -- --email <email>` 或发行包 `./admin-reset.sh` 显式重置，目标账号必须已存在且角色为 `ADMIN`。

---

## 3. Prisma Schema 完整定义

文件路径：`apps/server/prisma/schema.prisma`

```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

// 用户角色（SQLite 落地为 String，逻辑枚举）
enum Role {
  ADMIN   // 系统超级管理员
  USER    // 普通终端用户
}

// 节点运行状态
enum NodeStatus {
  ONLINE    // 在线正常工作中
  OFFLINE   // 离线/失联
  DISABLED  // 手动禁用维护中
}

// Sing-box 日志采集模式（SQLite 逻辑枚举）
enum SingboxLogMode {
  NORMAL    // 默认：内核 warn，Master 只接收真实 WARN/ERROR
  INFO      // 固定 30 分钟诊断
  DEBUG     // 固定 30 分钟诊断
}

// Agent 通信模式
enum AgentTransportMode {
  WS     // WS/WSS 长连接
  HTTP   // HTTP/HTTPS 主动轮询
}

// 支持的代理协议类型（逻辑枚举）
enum ProtocolType {
  VLESS VMESS TROJAN HYSTERIA2 TUIC SHADOWSOCKS NAIVE SHADOWTLS MIXED SOCKS HTTP DIRECT
}

// ==============================
// 1. 用户实体 (User)
// ==============================
model User {
  id                String       @id @default(uuid())
  uid               Int?         @unique                          // 6 位随机数字用户标识，存量用户由启动回填
  nickname          String?                                      // 自定义昵称；为空时展示 用户_<UID>
  email             String       @unique
  emailVerifiedAt   DateTime?                                 // 邮箱核验时间戳；未验证或存量老用户为 null
  passwordHash      String
  role              String       @default("USER")
  balance           Int          @default(0)             // 账户余额，单位为分
  
  // 流量与套餐控制
  trafficLimitBytes BigInt       @default(107374182400) // 流量配额 (默认 100GB)
  trafficUsedBytes  BigInt       @default(0)            // 已用流量 (字节)
  expireAt          DateTime?                           // 账号过期时间 (为空表示永久)
  deviceLimit        Int?         // null 跟随套餐，0 显式不限，正数覆盖为用户上限
  
  // 代理与订阅凭证
  subscriptionToken String       @unique @default(uuid()) // 订阅 URL 唯一样条
  uuid              String       @unique @default(uuid()) // 用户代理凭据（底层 UUID；VLESS/VMess 等协议使用）
  password          String?                               // 用于 Shadowsocks/Hysteria2 连接密码
  
  isActive          Boolean      @default(true)          // 是否启用
  sessionVersion    Int          @default(0)             // 密码修改、注销、禁用或管理员重置时递增，使旧 JWT 失效
  createdAt         DateTime     @default(now())
  updatedAt         DateTime     @updatedAt

  // 关联
  trafficLogs       TrafficLog[]
  subscription      Subscription?
  planPurchaseIdentityId String?
  planPurchaseIdentity PlanPurchaseIdentity? @relation(fields: [planPurchaseIdentityId], references: [id], onDelete: SetNull)
  extraLineGrants   UserLineGrant[]
  balanceTransactions BalanceTransaction[]
  redeemedCodes     RedeemCode[] @relation("RedeemedCodes")
  proxyKeys         ProxyKey[]

  @@index([role])
  @@index([isActive])
  @@index([planPurchaseIdentityId])
}

// 套餐购买身份：与可删除账号解耦；邮箱哈希别名确保同邮箱重建账号仍继承限购记录。
model PlanPurchaseIdentity {
  id        String   @id @default(uuid())
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  users             User[]
  emailAliases      PlanPurchaseEmailAlias[]
  purchases         PlanPurchase[]
  redeemCodeUsages  RedeemCodeCategoryUsage[]
}

model PlanPurchaseEmailAlias {
  id         String   @id @default(uuid())
  identityId String
  emailHash  String   @unique
  createdAt  DateTime @default(now())

  identity PlanPurchaseIdentity @relation(fields: [identityId], references: [id], onDelete: Cascade)

  @@index([identityId])
}

model PlanPurchase {
  id             String   @id @default(uuid())
  identityId     String
  planId         String
  sequence       Int
  source         String // SELF_BUY | SELF_UPGRADE | REGISTRATION | ADMIN | MIGRATED
  subscriptionId String?
  purchasedAt    DateTime @default(now())

  identity     PlanPurchaseIdentity @relation(fields: [identityId], references: [id], onDelete: Restrict)
  plan         Plan                 @relation(fields: [planId], references: [id], onDelete: Restrict)
  subscription Subscription?        @relation(fields: [subscriptionId], references: [id], onDelete: SetNull)

  @@unique([identityId, planId, sequence])
  @@index([identityId, planId])
  @@index([planId])
}

// 注册、换绑邮箱、当前邮箱核验与找回密码使用的一次性验证码
model VerificationCode {
  id        String   @id @default(uuid())
  email     String
  codeHash  String   // 使用应用密钥 HMAC；迁移后旧明文验证码全部失效
  action    String   // REGISTER | CHANGE_EMAIL | VERIFY_CURRENT_EMAIL | RESET_PASSWORD
  attempts  Int      @default(0)
  expiresAt DateTime
  createdAt DateTime @default(now())

  @@index([email, action, createdAt])
  @@index([expiresAt])
}

// 本地图形验证码的服务端短期状态；答案、令牌与 IP 均不可逆保存
model CaptchaChallenge {
  id         String    @id @default(uuid())
  tokenHash  String    @unique
  answerHash String
  ipHash     String?
  attempts   Int       @default(0)
  consumedAt DateTime?
  expiresAt  DateTime
  createdAt  DateTime  @default(now())

  @@index([expiresAt])
}

// ==============================
// 2. 节点实体 (Node)
// ==============================
model Node {
  id              String        @id @default(uuid())
  name            String                                // 节点显示名称 (如 "🇯🇵 东京 01 - 专线")
  serverHost      String                                // 节点公网 IP 或解析域名
  reachability    String        @default("PUBLIC")      // 节点网络可达性：PUBLIC (公网 VPS) | NAT (无公网 IP/家宽节点，通过反向隧道作为落地中继)
  isLocal         Boolean       @default(false)          // 是否为主控本机预置节点；系统节点不可删除

  // 高级模式：完整 singboxConfig 顶层覆盖 JSON（与生成配置深合并；含 inbounds 则整组替换）
  configOverride String?

  // Sing-box 临时日志诊断：NORMAL | INFO | DEBUG；INFO/DEBUG 到期后由巡检恢复 NORMAL
  singboxLogMode      SingboxLogMode @default(NORMAL)
  singboxLogModeUntil DateTime?

  // 主从长连接通信凭证
  agentToken      String        @unique @default(uuid()) // Agent 接入认证密钥
  agentTokenHash  String?       @unique                    // AgentToken HMAC/SHA-256 校验值，避免仅依赖可逆密文
  communicationMode AgentTransportMode @default(WS)      // 当前/期望通信模式
  pollIntervalSecs Int           @default(15)             // HTTP 轮询建议周期（秒）
  status          NodeStatus    @default(OFFLINE)        // 实时状态
  lastSeenAt      DateTime?                              // 最近心跳时间；Master 重启后的短暂订阅恢复宽限会据此判断心跳是否仍在健康窗口内

  // 实时遥测指标
  cpuUsage        Float         @default(0)             // CPU 使用率 (0~100)
  memoryUsage     Float         @default(0)             // 内存使用率 (0~100)
  bandwidthRate   Float         @default(0)             // 实时网络速率 (bytes/s)
  uploadRate      Float?                                // 当前上行速率 (bytes/s)，旧版 Agent 未上报时为空
  downloadRate    Float?                                // 当前下行速率 (bytes/s)，旧版 Agent 未上报时为空

  // 内核状态（v0.3.0，Agent 心跳上报；旧版 Agent 不上报时保持 null）
  kernelRunning   Boolean?                               // sing-box 内核进程存活
  configError     String?                                // 最近一次配置应用失败原因（成功后清空）
  lastProbeResult String?                                // 最近一次网络探针结果 JSON（含时间、延迟、解析地址与错误）
  agentVersion   String?                                 // Agent 编译版本
  osArch         String?                                 // Agent 运行平台与架构，例如 linux/amd64
  kernelVersion  String?                                 // sing-box 内核版本
  capabilitiesJson String      @default("[]")             // Agent 能力数组，含 singbox_log_capture 时支持临时诊断，含 agent_log_rotation 时支持本地日志轮转

  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt

  // 关联；NodeInbound 仅为旧数据迁移兼容表，新线路使用 entryLines/landingLines
  inbounds        NodeInbound[]
  entryLines      Line[]        @relation("LineEntryNode")
  landingLines    Line[]        @relation("LineLandingNode")
  trafficLogs     TrafficLog[]
  trafficCursors  TrafficCursor[]

  @@index([status])
  @@index([isLocal])
}

// ==============================
// 2.1 节点速率指标实体 (NodeRateMetric，telemetry.db 物理分库，v0.9.2)
// 保存在独立的 telemetry.db 数据库中，通过 TelemetryPrismaService 访问，无跨库物理外键
// ==============================
model NodeRateMetric {
  id               String   @id @default(uuid())
  nodeId           String
  bucketStart      DateTime                         // UTC 五分钟桶起点
  sampleCount      Int      @default(0)
  uploadRateSum    Float    @default(0)             // 桶内心跳上行速率之和
  downloadRateSum  Float    @default(0)             // 桶内心跳下行速率之和
  uploadRatePeak   Float    @default(0)             // 节点桶内上行峰值
  downloadRatePeak Float    @default(0)             // 节点桶内下行峰值

  @@unique([nodeId, bucketStart])
  @@index([nodeId, bucketStart])
  @@index([bucketStart])
}

// ==============================
// 2.1.1 流量累计游标 (TrafficCursor，v0.5.0)
// 每个节点按 Agent 上报的原始凭证保存已观察累计值，避免断线重试重复计费。
// ==============================
model TrafficCursor {
  id           String   @id @default(uuid())
  nodeId       String
  credential   String   // Sing-box 用户名称，通常为邮箱，也兼容 User.uuid
  uploadTotal  BigInt   @default(0)
  downloadTotal BigInt  @default(0)
  updatedAt    DateTime @updatedAt

  node Node @relation(fields: [nodeId], references: [id], onDelete: Cascade)

  @@unique([nodeId, credential])
  @@index([nodeId, updatedAt])
}

// ==============================
// 2.2 历史节点入站实体 (NodeInbound，迁移兼容)
// 保留旧数据以便迁移与审计；新线路创建、配置下发和管理 API 均不再依赖该表。
// ==============================
model NodeInbound {
  id         String   @id @default(uuid())
  nodeId     String
  type       String   // ProtocolType: VLESS | VMESS | TROJAN | HYSTERIA2 | TUIC | SHADOWSOCKS | NAIVE | SHADOWTLS | MIXED | SOCKS | HTTP | DIRECT
  tag        String   // sing-box 入站 tag，节点内唯一
  listen     String   @default("0.0.0.0")
  port       Int
  paramsJson String   @default("{}") // 协议专属参数 JSON（结构见 §3.1）
  sortOrder  Int      @default(0)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  node Node @relation(fields: [nodeId], references: [id], onDelete: Cascade)

  @@unique([nodeId, tag])
  @@index([nodeId])
}

// ==============================
// 2.2 接入线路实体 (Line，v0.4.0)
// Node 是底座资源；Line 是面向用户订阅的唯一接入端点，并拥有协议、参数与拓扑。
// ==============================
model Line {
  id              String   @id @default(uuid())
  name            String
  tag             String?
  listen          String   @default("0.0.0.0")
  type            String   @default("DIRECT") // DIRECT | RELAY | EXTERNAL
  relayMode       String? // BLIND_FORWARD | PROTOCOL_PROXY | TARGET_LINE | UPSTREAM_NODE
  protocolType    String   @default("VLESS") // ProtocolType
  paramsJson      String   @default("{}") // 协议专属参数 JSON；Reality 私钥按应用层 AES-GCM 加密保存
  entryNodeId     String? // DIRECT/RELAY 必填，EXTERNAL 必须为空
  entryPort       Int?    // EXTERNAL 不分配端口
  landingNodeId   String?  // 普通中继落地节点；直连与 TARGET_LINE 为 null
  landingPort     Int?     // 普通中继落地监听端口；直连与 TARGET_LINE 为 null
  targetLineId    String? // TARGET_LINE 模式引用的其他节点直连线路
  certificateId   String? // 关联标准 TLS 证书；为空时使用 Agent 本地路径
  endpointOverrideEnabled Boolean @default(false) // 是否启用线路对外覆盖；关闭时复用底层默认设置
  serverHost      String?
  serverPort      Int?
  serverName      String?
  host            String?
  landingEndpointOverrideEnabled Boolean @default(false) // 是否启用中继落地端点覆盖；关闭时复用落地节点或目标线路默认设置
  landingServerHost String?   // 中继落地连接地址/域名覆盖 (仅 RELAY 生效)
  landingServerPort Int?      // 中继落地连接端口覆盖 (仅 RELAY 生效)
  trafficRate     Float    @default(1)
  allowLanAccess  Boolean  @default(false) // 落地端是否允许访问局域网私网 IP (默认 false 拦截私网目标保护家庭内网安全)
  tunnelType      String?  // 反向穿透隧道类型：TCP_MUX (Yamux 多路复用) | WIREGUARD (NAT 落地中继时生效)
  tunnelPort      Int?     // 入口 VPS 监听的隧道连接端口
  tunnelSecret    String?  // AES-GCM 加密存储的隧道握手鉴权凭据
  speedLimitMbps  Int?     // 单端口物理限速（Mbps，0 或 null 为不限速，边缘 Agent 执行 tc 整形）
  tcpFastOpen     Boolean  @default(false) // TCP Fast Open 开关
  tcpMultiPath    Boolean  @default(false) // TCP MultiPath 开关
  udpFragment     Boolean  @default(true)  // 允许 UDP 分片
  udpTimeout      String?  // UDP 会话超时（如 5m、30s）
  proxyProtocol   Boolean  @default(false) // 开启 PROXY Protocol 解析 (自动兼容 v1 与 v2)
  proxyProtocolAcceptNoHeader Boolean @default(false) // 允许缺少 PROXY Protocol 头的连接
  tagsJson        String   @default("[]")
  level           Int      @default(0)
  sortOrder       Int      @default(0)
  isPublic        Boolean  @default(true)
  status          String   @default("ACTIVE") // ACTIVE | DISABLED
  lastLatencyMs   Int?     // 最近测速延迟（毫秒），null 为未测速或失败
  lastTestedAt    DateTime? // 最近一次测速时间
  lastTestStatus  String?  // 最近测速状态：SUCCESS | TIMEOUT | ERROR
  lastTestMessage String?  // 最近测速诊断详情
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  entryNode     Node? @relation("LineEntryNode", fields: [entryNodeId], references: [id], onDelete: Cascade)
  landingNode   Node? @relation("LineLandingNode", fields: [landingNodeId], references: [id], onDelete: Cascade)
  targetLine    Line? @relation("LineRelayTarget", fields: [targetLineId], references: [id], onDelete: Restrict)
  relaySources  Line[] @relation("LineRelayTarget")
  certificate   Certificate? @relation(fields: [certificateId], references: [id], onDelete: SetNull)
  upstreamNodeId String?  // UPSTREAM_NODE 中继与 EXTERNAL 必填
  upstreamNode  UpstreamNode? @relation("LineUpstreamNode", fields: [upstreamNodeId], references: [id], onDelete: SetNull)

  @@index([entryNodeId])
  @@index([landingNodeId])
  @@index([targetLineId])
  @@index([certificateId])
  @@index([protocolType])
  @@index([type, status])
  @@index([isPublic])
  @@index([sortOrder])
  @@index([upstreamNodeId])
}

// ==============================
// 2.2.1 TLS 证书实体 (Certificate，v0.4.15)
// PEM 私钥仅由管理员接口明文回显；普通列表与线路响应不返回私钥。
// ==============================
model Certificate {
  id             String   @id @default(uuid())
  name           String
  certificatePem String   // X.509 叶子证书 PEM
  privateKeyPem  String   // AES-GCM 应用层密文；仅管理员详情与 Agent 配置组装时解密
  subject        String
  issuer         String
  serialNumber   String
  sansJson       String   @default("[]")
  validFrom      DateTime
  validTo        DateTime
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  lines Line[]

  @@index([validTo])
}

// 2.3 套餐实体 (Plan，v0.4.0)
// ==============================
model Plan {
  id                String   @id @default(uuid())
  name              String
  description       String?
  price             Int      @default(0) // 最小货币单位（分）；API 的 price 使用元
  durationDays      Int
  trafficLimitBytes BigInt
  trafficResetMode  String   @default("NONE") // NONE | CALENDAR_MONTH | SUBSCRIPTION_CYCLE
  lineMatchMode     String   @default("ALL") // ALL | TAGS | EXPLICIT
  lineTagsJson      String   @default("[]")
  lineIdsJson       String   @default("[]")
  templateId        String?
  badgeText         String?  // 市场角标文本（如 HOT、推荐、特惠；为空不展示）
  isFeatured        Boolean  @default(false) // 是否主推推荐套餐（市场卡片高亮与微光边框）
  featuresJson      String   @default("[]")  // 自定义权益特性清单 JSON 数组；空数组降级展示系统默认特性
  cardConfigJson    String   @default("{}")  // 套餐市场卡片视觉动效与定制配置 JSON（结构见 §3.8）
  isPublic          Boolean  @default(true)
  sortOrder         Int      @default(0)
  purchaseLimitPerUser Int?  // null 表示不限购；>=1 时限制每购买身份累计次数
  allowRenewal      Boolean  @default(true)
  deviceLimit        Int      @default(0) // 同时在线设备上限，0 不限制
  speedLimitMbps    Int?     // 套餐带宽速率上限（Mbps，0 或 null 为不限速）
  appendSpeedBadge  String   @default("INHERIT") // 节点追加速率角标策略：INHERIT | ENABLE | DISABLE
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  template      SubscriptionTemplate? @relation(fields: [templateId], references: [id], onDelete: SetNull)
  subscriptions       Subscription[]
  purchases           PlanPurchase[]
  redeemCodeCategories RedeemCodeCategory[]

  @@index([isPublic])
  @@index([sortOrder])
}

// ==============================
// 2.4 订阅模板实体 (SubscriptionTemplate，v0.3.0)
// ==============================
model SubscriptionTemplate {
  id               String   @id @default(uuid())
  name             String
  description      String?
  isDefault        Boolean  @default(false)
  isBuiltin        Boolean  @default(false)
  proxyGroupsJson  String   @default("[]")
  ruleSetsJson     String   @default("[]")
  dnsConfigJson    String   @default("{}")
  customInjectYaml String?
  customInjectJson String?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  plans Plan[]

  @@index([isDefault])
}

// ==============================
// 2.5 用户订阅实例 (Subscription，v0.3.0)
// userId 唯一，保证每个用户只有一条订阅实例；生命周期由 status + expireAt 表达
// ==============================
model Subscription {
  id                String    @id @default(uuid())
  userId            String    @unique
  planId            String
  status            String    @default("ACTIVE") // ACTIVE | CANCELED | EXPIRED | REVOKED
  trafficLimitBytes BigInt
  trafficUsedBytes  BigInt    @default(0)
  startedAt         DateTime  @default(now())
  expireAt          DateTime?
  subscriptionToken String    @unique @default(uuid())
  canceledAt        DateTime?
  trafficPeriodStartAt DateTime? // 当前流量周期起点；旧订阅首次启用策略时惰性初始化
  planSnapshotJson  String?   // 套餐卡兑换时冻结的完整套餐权益快照，避免编辑套餐影响已发卡权益
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  plan Plan @relation(fields: [planId], references: [id])
  planPurchases PlanPurchase[]

  @@index([status])
  @@index([expireAt])
  @@index([trafficPeriodStartAt])
}

// ==============================
// 2.6 用户额外线路授权 (UserLineGrant，v0.5.0)
// 用户级授权独立于 Subscription 生命周期，删除订阅不会删除授权。
// ==============================
model UserLineGrant {
  id        String   @id @default(uuid())
  userId    String
  lineId    String
  createdAt DateTime @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  line Line @relation(fields: [lineId], references: [id], onDelete: Cascade)

  @@unique([userId, lineId])
  @@index([userId])
  @@index([lineId])
}

// ==============================
// 2.7 钱包余额流水 (BalanceTransaction，v0.4.20)
// amount 为带符号的金额，正数表示入账，负数表示扣款；每条记录保存变更前后余额。
// ==============================
model BalanceTransaction {
  id             String   @id @default(uuid())
  userId         String
  amount         Int
  balanceBefore  Int
  balanceAfter   Int
  type           String
  description    String?
  referenceId    String?
  redeemCodeId   String?  @unique
  createdAt      DateTime @default(now())

  user       User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  redeemCode RedeemCode? @relation(fields: [redeemCodeId], references: [id], onDelete: SetNull)

  @@index([userId, createdAt])
  @@index([type, createdAt])
  @@index([referenceId])
}

// ==============================
// 2.7 卡密分类、额度占用与兑换凭据 (v0.9.0)
// 分类的 limitPerIdentity 为购买身份累计上限，null 表示不限；标签仅用于管理筛选。
// 每次成功兑换的分类额度与卡密履约在同一 SQLite 事务中提交。
// ==============================
model RedeemCodeCategory {
  id               String   @id @default(uuid())
  name             String   @unique
  tagsJson         String   @default("[]")
  rewardType       String   @default("BALANCE") // BALANCE | PLAN
  rewardAmount     Int?     // 余额奖励，单位分
  planId           String?
  limitPerIdentity Int?     @default(1) // null 表示不限
  isActive         Boolean  @default(true) // 归档仅阻止新生成，不影响已发卡兑换
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  redeemCodes RedeemCode[]
  usages      RedeemCodeCategoryUsage[]
  plan        Plan? @relation(fields: [planId], references: [id], onDelete: SetNull)

  @@index([isActive])
}

model RedeemCodeCategoryUsage {
  identityId String
  categoryId String
  usedCount  Int      @default(0)
  updatedAt  DateTime @updatedAt

  identity PlanPurchaseIdentity @relation(fields: [identityId], references: [id], onDelete: Restrict)
  category RedeemCodeCategory  @relation(fields: [categoryId], references: [id], onDelete: Restrict)

  @@id([identityId, categoryId])
  @@index([categoryId])
}

// 卡密删除是软隐藏，不改变核销状态或兑换能力；奖励快照在生成时固化。
model RedeemCode {
  id                 String    @id @default(uuid())
  code               String    @unique
  amount             Int       @default(0) // 余额快照金额，单位分；套餐卡为 0
  categoryId         String?
  rewardType         String    @default("BALANCE") // BALANCE | PLAN
  rewardSnapshotJson String?   // 余额金额或完整套餐权益快照
  planId             String?   // 套餐奖励关联，用于保护仍未兑换的套餐
  status             String    @default("UNUSED") // UNUSED | REDEEMED | REVOKED
  expiresAt          DateTime?
  note               String?
  redeemedAt         DateTime?
  redeemedByUserId   String?
  deletedAt          DateTime? // 仅从默认管理列表隐藏，不作废卡密
  deletedByUserId    String?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt

  redeemedBy         User?               @relation("RedeemedCodes", fields: [redeemedByUserId], references: [id], onDelete: SetNull)
  category           RedeemCodeCategory? @relation(fields: [categoryId], references: [id], onDelete: Restrict)
  balanceTransaction BalanceTransaction?

  @@index([status, createdAt])
  @@index([expiresAt])
  @@index([categoryId, status])
  @@index([deletedAt])
  @@index([planId, status])
  @@index([redeemedByUserId])
}

// ==============================
// 2.8 直连代理池凭据 (ProxyKey，v0.9.0)
// 面向爬虫/指纹浏览器/脚本工具的独立 SOCKS5/HTTP 凭证，与订阅体系完全解耦。
// ==============================
model ProxyKey {
  id               String    @id @default(uuid())
  userId           String
  name             String    // 凭据备注名称（≤60 字符）
  username         String    @unique // pk_<24 位十六进制>，注入 Sing-box mixed 入站
  password         String    // 该凭据独立密码（明文，Sing-box 入站校验必需）
  whitelistIps     String    @default("") // 逗号分隔的 IP/CIDR 白名单，空串表示不限制来源
  exportToken      String    @unique @default(uuid()) // 免登录动态拉取令牌
  isActive         Boolean   @default(true)
  trafficUsedBytes BigInt    @default(0) // 该凭据累计计费流量（与主账户口径一致）
  lastUsedAt       DateTime?
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt

  user        User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  trafficLogs TrafficLog[] @relation("ProxyKeyTrafficLogs")

  @@index([userId])
  @@index([isActive])
  @@index([userId, isActive])
}

// ==============================
// 3. 流量流水记录 (TrafficLog)
// ==============================
model TrafficLog {
  id         String   @id @default(uuid())
  nodeId     String
  userId     String
  lineId     String?  // 入口线路归属；历史流水或裸节点可为空
  proxyKeyId String?  // 直连代理池凭据归属；订阅流量为 null
  upload     BigInt   @default(0) // 增量上传字节数
  download   BigInt   @default(0) // 增量下载字节数
  recordedAt DateTime @default(now())

  node       Node      @relation(fields: [nodeId], references: [id], onDelete: Cascade)
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  line       Line?     @relation(fields: [lineId], references: [id], onDelete: SetNull)
  proxyKey   ProxyKey? @relation("ProxyKeyTrafficLogs", fields: [proxyKeyId], references: [id], onDelete: SetNull)

  @@index([nodeId])
  @@index([userId])
  @@index([lineId])
  @@index([proxyKeyId])
  @@index([recordedAt])
  @@index([recordedAt, lineId])
  @@index([recordedAt, userId])
}

// ==============================
// 3.1 流量小时时序聚合指标 (TrafficHourlyMetric，v0.9.1)
// 按 UTC 整点小时桶聚合，彻底替代秒级细碎的 TrafficLog，保障大盘查询亚毫秒级响应
// ==============================
model TrafficHourlyMetric {
  id          String   @id @default(uuid())
  bucketStart DateTime // UTC 整点小时起始时间戳
  nodeId      String
  userId      String
  lineId      String   @default("") // 归属线路 ID（空串表示未分配/直连节点）
  proxyKeyId  String   @default("") // 直连代理池凭据归属（空串表示订阅流量）
  upload      BigInt   @default(0) // 当小时累计上行字节
  download    BigInt   @default(0) // 当小时累计下行字节
  billedBytes BigInt   @default(0) // 当小时累计计费字节（含线路倍率）
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([bucketStart, nodeId, userId, lineId, proxyKeyId])
  @@index([bucketStart])
  @@index([userId, bucketStart])
  @@index([lineId, bucketStart])
  @@index([nodeId, bucketStart])
}

// ==============================
// 4. 全局系统配置 (SystemSetting)
// ==============================
model SystemSetting {
  key         String   @id
  value       String   // 存储系统设置的 JSON、布尔、数字或纯文本值
  description String?
  updatedAt   DateTime @updatedAt
}

// ==============================
// 5. 帮助中心与使用文档 (HelpArticle)
// ==============================
model HelpArticle {
  id          String   @id @default(uuid())
  slug        String   @unique
  title       String
  platform    String   @default("ALL") // WINDOWS | MACOS | IOS | ANDROID | ROUTER | FAQ | GENERAL
  clientName  String?  // 如 "Clash Verge Rev", "Shadowrocket"
  icon        String?  // 图标标识
  summary     String?  // 简短摘要
  content     String   // Markdown 正文，支持动态变量插值
  sortOrder   Int      @default(0)
  isPublished Boolean  @default(true)
  locale      String   @default("zh-CN")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([platform, isPublished, sortOrder])
  @@index([locale, isPublished])
  @@index([sortOrder])
}
```

**已启用键定义（v0.4.8）**：

| 键 | value 格式 | 缺省默认 | 用途 |
| :--- | :--- | :--- | :--- |
| `siteName` | 纯文本（1~32 字符） | `"RiriCloud"` | 站点名称，展示于登录页/注册页/侧边栏 |
| `siteDescription` | 纯文本（≤120 字符） | `""` | 登录页和品牌区域副标题；留空时不展示 |
| `publicBaseUrl` | HTTP/HTTPS URL 或空字符串 | `""` | 全站对外访问基准主入口；作为订阅与二进制下载基准的默认回退源，并用于 Agent 节点安装与升级命令行生成 |
| `logoUrl` / `faviconUrl` | URL 或空字符串 | `""` | Logo 与 Favicon 地址 |
| `siteAnnouncement` | Markdown 文本（≤10000 字符） | `""` | 用户订阅控制台公告横幅（向下兼容首条启用横幅公告） |
| `siteAnnouncementsJson` | JSON 数组字符串（≤50000 字符） | `"[]"` | 结构化多条公告列表配置（含 ID、标题、Markdown 正文、分类 `NOTICE`/`MAINTENANCE`/`EVENT`/`URGENT`、置顶、横幅开关、登录未读弹窗强提醒开关、启用状态与创建/更新时间） |
| `footerCopyright` | 纯文本 | `""` | 页脚版权文案，展示于登录/注册页、个人中心及侧边栏底栏 |
| `supportTelegramUrl` / `supportDiscordUrl` / `supportCustomUrl` | URL 或空字符串 | `""` | 客服、群组与自定义支持入口，在侧边栏底栏、个人中心及登录注册页快捷触发弹窗 |
| `supportEmail` | 邮箱或空字符串 | `""` | 客服邮箱入口 |
| `registrationEnabled` | `"true"` / `"false"` | `"false"` | 注册开关，控制 `POST /auth/register` 与前端注册入口 |
| `defaultPlanId` | UUID 或空字符串 | `""` | 注册时自动激活的公开套餐；新用户权益统一由此套餐决定，未配置时新用户无初始订阅 |
| `defaultBalance` | 十进制字符串（分，≥0） | `"0"` | 新用户注册初始余额；注册时写入 `SYSTEM_GIFT` 流水 |
| `emailDomainMode` | `none` / `whitelist` / `blacklist` | `"none"` | 注册邮箱域名过滤模式 |
| `emailDomainList` | JSON 字符串数组 | `[]` | 注册邮箱域名过滤列表 |
| `passwordMinLength` | 十进制整数（8~64） | `"8"` | 密码最小长度（与下方 `passwordRequire*` 开关共同构成密码复杂度策略） |
| `passwordRequireLowercase` | `"true"` / `"false"` | `"true"` | 密码必须包含小写字母 |
| `passwordRequireUppercase` | `"true"` / `"false"` | `"false"` | 密码必须包含大写字母 |
| `passwordRequireDigit` | `"true"` / `"false"` | `"true"` | 密码必须包含数字 |
| `passwordRequireSpecial` | `"true"` / `"false"` | `"false"` | 密码必须包含特殊字符（非字母数字且非空白的可打印字符，空格不计） |
| `subscriptionBaseUrl` | URL 或空字符串 | `""` | 用户端拼装订阅链接的基准地址（覆盖项；留空时自动回退继承 `publicBaseUrl` 或请求来源） |
| `subscriptionShortLinksEnabled` | `"true"` / `"false"` | `"false"` | 用户端是否展示由 Nginx rewrite 提供的 UUID 伪静态订阅地址 |
| `subscriptionEffectsSyncEnabled` | `"true"` / `"false"` | `"true"` | 是否开启「我的订阅」卡片套餐特效同步；开启后用户端「我的订阅」主卡片将自动同步当前套餐的主题色彩底色、流体极光与晶体漫射微边框，关闭后保持经典极简原生卡片 |
| `subscriptionUpdateIntervalHours` | 十进制整数（1~168） | `"24"` | `Profile-Update-Interval` 响应头值 |
| `appendSubscriptionSpeedBadge` | `"true"` / `"false"` | `"true"` | 订阅节点名称是否默认追加如 `[50M]` 速率角标（套餐可单独覆盖） |
| `speedLimitUnitConversionEnabled` | `"true"` / `"false"` | `"true"` | 速率达到 1000 Mbps 及以上时是否自动换算为 G 单位（如 1G、2.5G），全站 UI 与订阅节点名称角标同步生效 |
| `speedLimitColorTiers` | JSON 数组字符串 | `[{"maxMbps":300,"color":"blue"},{"maxMbps":1000,"color":"emerald"},{"maxMbps":null,"color":"violet"}]` | 速率分级色彩阶梯配置，支持科技蓝、极光青、翡翠绿、琥珀金、星曜紫、玫瑰红等语义色阶 |
| `defaultTemplateId` | UUID 或空字符串 | `""` | 套餐未指定模板时优先使用的模板；系统设置中以只读卡片展示，引导前往模板页维护 |
| `publicLinesEnabled` | `"true"` / `"false"` | `"true"` | 全局公开线路开关 |
| `includeUsageHeaders` | `"true"` / `"false"` | `"true"` | 是否返回 `Subscription-Userinfo` |
| `deviceLimitEnabled` | `"true"` / `"false"` | `"true"` | 是否启用自动多设备上限执行；关闭时保留配置值供展示，但不自动执行上限，手动踢设备仍可用 |
| `deviceOnlineWindowSecs` | 十进制整数（15~600） | `"60"` | Master 认定 Agent 设备上报仍新鲜的秒数；超窗报告不计入在线设备或跨节点限制 |
| `heartbeatTimeoutSecs` | 十进制整数（5~3600） | `"15"` | Agent 离线判定基础超时 |
| `configSyncDebounceMs` | 十进制整数（0~10000） | `"250"` | 全量配置推送防抖延迟 |
| `defaultPollIntervalSecs` | 十进制整数（5~300） | `"15"` | 新节点与 HTTP 轮询的默认周期 |
| `binaryDownloadBaseUrl` | URL 或空字符串 | `""` | 内置 Agent/内核二进制下载基准地址（覆盖项；留空时自动回退继承 `publicBaseUrl`） |
| `githubRepoUrl` | URL | `https://github.com/Nanako660/riricloud` | 项目 GitHub 仓库地址，节点安装脚本从该仓库 Release（agent-v* Tag）优先下载二进制 |
| `githubMirrorUrls` | URL JSON 数组 | 内置默认公共镜像 | GitHub 加速镜像列表（前缀代理），节点安装时对直连与镜像自动测速择优，全部失败回退主控内置下载 |
| `probePresetTargets` | 探针目标 JSON 数组 | TCP Apple 443 + DNS Cloudflare | 管理端探针预设目标 |
| `jwtSessionDays` | 十进制整数（1~30） | `"1"` | 新签发 JWT 的会话有效天数 |
| `customCss` | CSS 文本 | `""` | 面板运行时自定义样式 |
| `customHeadHtml` | HTML/JS 文本 | `""` | 管理员可信边界内由面板 `document.head` 运行时注入；可读取当前页面 JWT，默认 CSP 不允许任意 inline script |
| `lineSpeedtestEnabled` | `"true"` / `"false"` | `"true"` | 是否开启后台线路自动定时测速 |
| `lineSpeedtestIntervalMins` | 十进制整数（1~1440） | `"30"` | 线路自动测速执行周期（分钟） |
| `lineSpeedtestTargetUrl` | HTTP/HTTPS URL | `"http://cp.cloudflare.com/generate_204"` | 线路测速探测目标 URL |
| `lineSpeedtestTimeoutMs` | 十进制整数（500~30000） | `"3000"` | 单次测速连接超时阈值（毫秒） |
| `systemTimezone` | IANA 时区标识（如 `Asia/Shanghai`） | `"Asia/Shanghai"` | 全系统统一时区设置；驱动全站前端时间格式化、后端流量图表按小时/天聚合时间桶以及自然月重置边界精确计算 |
| `smtpEnabled` | `"true"` / `"false"` | `"false"` | 是否启用 SMTP 发信；密码只在服务端保存，管理端读取时脱敏 |
| `smtpHost` / `smtpPort` / `smtpSecure` | 主机文本 / 十进制端口 / 布尔 | `""` / `"587"` / `"false"` | SMTP 服务器连接参数；`smtpSecure=true` 使用 SSL/TLS |
| `smtpUser` / `smtpPass` / `smtpFrom` | 文本 | `""` | SMTP 登录账号、密码和发信人地址；密码使用 AES-GCM 应用层密文保存，管理端返回 `********` |
| `emailVerificationEnabled` | `"true"` / `"false"` | `"false"` | 是否要求注册提交 6 位邮箱验证码 |
| `enforceEmailVerification` | `"true"` / `"false"` | `"false"` | 是否强制要求已核验邮箱才能使用订阅与连接节点（未核验普通用户拦截 403 并从节点入站名单剔除；ADMIN 豁免） |
| `captchaMode` | `OFF` / `LOCAL` / `TURNSTILE` | `"OFF"` | 注册、获取注册/重置验证码前的人机验证模式 |
| `turnstileSiteKey` / `turnstileSecretKey` | 文本 | `""` | Cloudflare Turnstile 公钥与服务端密钥；仅 Site Key 进入公共设置，Secret Key 管理端读取时脱敏 |
| `trafficHourlyRetentionDays` | 十进制整数（1~3650） | `"90"` | `TrafficHourlyMetric` 小时汇总保留天数 |
| `nodeRateRetentionDays` | 十进制整数（1~3650） | `"30"` | `NodeRateMetric` 节点速率指标保留天数 |
| `logsRetentionDays` | 十进制整数（1~3650） | `"7"` | `SystemLog` 系统日志保留天数 |
| `logsMaxCount` | 十进制整数（1000~1000000） | `"100000"` | `SystemLog` 最大记录数，自动清理保留最新记录 |
| `logsMinIngestLevel` | `DEBUG` / `INFO` / `WARN` / `ERROR` | `"INFO"` | 系统日志最低采集级别；清理审计日志显式绕过该门槛 |
| `agentLogMaxSizeMb` | 十进制整数（1~1024） | `"50"` | Master 下发的 Agent 本地单文件日志轮转上限（MiB） |
| `agentLogMaxFiles` | 十进制整数（1~20） | `"5"` | Agent 本地日志文件总数上限，包含当前文件 |
| `landingEnabled` | `"true"` / `"false"` | `"true"` | 是否启用首页门户（关闭时访问 `/` 回退至重定向逻辑） |
| `landingHeroBadge` | 纯文本（≤100 字符） | `""` | 首页 Hero 顶部徽章标签文案（留空使用默认） |
| `landingHeroTitle` | 纯文本（≤150 字符） | `""` | 首页主标题（留空使用默认） |
| `landingHeroSubtitle` | 纯文本（≤500 字符） | `""` | 首页副标题描述（留空使用默认） |
| `landingShowFeatures` | `"true"` / `"false"` | `"true"` | 首页是否展示核心特性优势网格模块 |
| `landingShowPlans` | `"true"` / `"false"` | `"true"` | 首页是否展示公开售卖套餐卡片模块 |
| `landingShowFaq` | `"true"` / `"false"` | `"true"` | 首页是否展示常见问答 FAQ 折叠模块 |
| `landingCustomFeaturesJson` | JSON 数组字符串 | `"[]"` | 首页自定义特性卡片列表（留空使用内置高质量默认特性） |
| `landingCustomFaqJson` | JSON 数组字符串 | `"[]"` | 首页自定义 FAQ 问答列表（留空使用内置高质量默认问答） |

存储日志设置仅更新清理和采集策略，不会在保存时立即删除数据；旧版 `TrafficLog` 作为过渡数据继续按固定 7 天清理，不暴露为长期保留项。

读取时与默认值合并：键缺失或 value 解析失败一律回退默认值（新库无需预先 seed）；更新走事务 upsert（`PUT /admin/settings`，接受任意子集）；重置通过删除指定覆盖键回到默认值。密码复杂度策略由 `passwordMinLength` 与 `passwordRequire*` 四个开关构成，对注册、找回密码、修改密码与管理员建户/重置密码全场景生效，全部开关关闭时仅校验长度；公开信息端点 (`GET /system/public-info`) 返回该策略供前端动态校验。敏感设置 `smtpPass` 与 `turnstileSecretKey` 在管理端读取时返回 `********`，更新时提交该占位值表示保留原密钥。`defaultPlanId` 与 `defaultTemplateId` 写入时会校验关联实体，公开信息端点 (`GET /system/public-info`) 返回品牌、公告、客服、版权、注册开关、时区 `systemTimezone`、基准 URL `publicBaseUrl` 与 `subscriptionBaseUrl`、短链接开关、特效同步开关 `subscriptionEffectsSyncEnabled`、运行时样式以及注册邮箱验证和 CAPTCHA 的公共参数（不含 SMTP 或 Turnstile Secret）。废弃字段 `defaultTrafficLimitBytes` 与 `defaultValidityDays` 已彻底下线，新用户初始权益完全由默认套餐与初始余额决定。

---

## 3. 核心字段与业务说明

### 3.1 `Line.paramsJson` 协议结构（v0.4.0）

系统支持 Sing-box 官方全套线路协议，采用**协议 + 传输层 (Transport) + 安全层 (TLS)** 模块化解耦设计。创建/更新 Line 时由服务端统一归一化与参数校验（`apps/server/src/common/inbound.ts`）：自动填充默认值、补全缺失密钥（Reality 密钥对 / SS 密码）。**API 输出脱敏**：线路响应自动剥离 `privateKey`，但服务端保留密钥用于 Agent 配置下发与后续深度合并。

#### 传输层 (Transport)
适用于 VLESS、VMESS、TROJAN 等支持多传输层的协议：
- `tcp`：原生流传输（默认）
- `ws`：WebSocket（`path`、`host`、`headers`、`maxEarlyData`、`earlyDataHeaderName`）
- `grpc`：gRPC（`serviceName`）
- `http`：HTTP（`path`、`host`、`headers`）
- `httpupgrade`：HTTPUpgrade（`path`、`host`、`headers`）

#### 安全层 (TLS / Reality / ACME)
- `none`：无加密明文直连
- `tls`：标准 TLS（`serverName`、`certificatePath`、`keyPath`、`certificate`、`key`、`alpn`、`insecure`）。`alpn` 为字符串数组，管理端按传输层提供预设多选：TCP/HTTP 默认 `h2` + `http/1.1`，gRPC 默认 `h2`，WebSocket/HTTPUpgrade 默认 `http/1.1`，NaiveProxy 默认 `h2`；显式空数组表示不发送 ALPN。线路关联 `Certificate` 时，服务端在生成 `config_sync` 的临时参数中以内嵌文本数组 `certificate: ["-----BEGIN CERTIFICATE-----..."]` 与 `key: ["-----BEGIN PRIVATE KEY-----..."]` 下发；未关联证书时继续使用 Agent 机本地路径。
- `reality`：VLESS Reality 伪装（`dest`、`serverNames`、`privateKey`、`publicKey`、`shortIds`）；Reality 不使用 `alpn`，管理端不展示该字段
- `acme`：Sing-box 内置 ACME 自动申请证书（`domain`、`email`、`provider`）

#### 协议专属参数结构
- **VLESS**：`flow`（如 `xtls-rprx-vision`，根据 Sing-box 规范仅适用于纯 TCP 传输且启用 TLS/Reality 的场景，WS/gRPC/HTTP 传输或无 TLS 自动清空抑制）、`transport`、`tls`
- **VMESS**：`alterId`（默认 0）、`transport`、`tls`
- **TROJAN**：`transport`、`tls`
- **HYSTERIA2**：`upMbps`、`downMbps`、`ignoreClientBandwidth`、`obfs: { type: "salamander", password }`、`tls`
- **TUIC**：`congestionControl`（`bbr`/`cubic`/`new_reno`）、`zeroRttHandshake`（默认关闭）、`heartbeat`、`tls`
- **SHADOWSOCKS**：`method`、`password`、`udpOverTcp`（开启时根据 Sing-box 规范与多路复用互斥，自动抑制出站 `multiplex` / `smux`）、`mode`（`shared` 共享单密码 / `multi-user` SS2022 多用户）；SS2022 密钥必须是对应算法长度的 Base64 原始密钥（128 位为 16 字节，256 位为 32 字节），普通密码会由服务端稳定派生为合规密钥；多用户客户端密码按协议组装为 `server_password:user_password`
- **NAIVE**：`network`、`tls`
- **SHADOWTLS**：固定 v3，结构为 `version: 3`、`handshakeDest`、`strictMode`、`inner: { type: "SHADOWSOCKS", method, password }`。内层必须使用 SS2022；`password` 是内层 SS2022 服务端密钥，外层 ShadowTLS 用户密码由用户凭证注入。旧版 v2 与独立 ShadowTLS 密码结构不再接受。
- **MIXED / SOCKS / HTTP**：`allowLan`、`usersEnabled`
- **DIRECT**：`overrideAddress`、`overridePort`

#### 用户凭证与订阅注入规则

| 协议 | 用户标识 (User Identifier) | 密码/凭证 (Password/Credential) | 多用户模式支持 |
| :--- | :--- | :--- | :--- |
| **VLESS** | `User.uuid` | —（UUID 即凭证，支持 flow） | 是（逐用户注入） |
| **VMESS** | `User.uuid` | —（UUID + alterId 0） | 是（逐用户注入） |
| **TROJAN** | `User.email`（name） | `User.password ?? User.uuid` | 是（逐用户注入） |
| **HYSTERIA2** | `User.email`（name） | `User.password ?? User.uuid` | 是（逐用户注入） |
| **TUIC** | `User.uuid` | `User.password ?? User.uuid` | 是（逐用户注入） |
| **NAIVE** | `User.email`（username） | `User.password ?? User.uuid` | 是（逐用户注入） |
| **SHADOWSOCKS** | `User.email`（name） | 共享模式用入站密钥；多用户 SS2022 客户端使用 `server_password:user_password`，用户密钥按 UUID 稳定派生 | 共享/多用户可选 |
| **SHADOWTLS** | v3 使用 `User.email`（name） | 外层使用用户密码；内层使用线路固定的 SS2022 服务端密钥 | v3 支持用户列表 |
| **MIXED/SOCKS/HTTP**| `User.email`（username） | `User.password ?? User.uuid`（若启用认证） | 是 |

**端口冲突规则**：同节点同传输层（TCP/UDP）端口互斥；HYSTERIA2/TUIC 视为 UDP，可与 TCP 线路共存于同一端口。Line 的入口端口和出口端口都会参与占用检查；未提供端口时，服务端从 `20000~65535` 随机生成五位端口。编辑已有 Line 会保留原端口，显式修改仍按上述规则校验。

### 3.2 `Node.configOverride` 高级模式（v0.3.0）

完整 sing-box 配置的**顶层覆盖 JSON**（字符串落库，服务端校验必须为 JSON 对象）。`config_sync` 组装时与生成配置做**顶层深合并**：嵌套 plain object 按键递归合并，数组与标量整体替换（`inbounds`/`outbounds` 提供即整组替换，`log`/`route` 等按键合并）。出站与路由配置不建关系表，全部走该覆盖层。

生成配置默认使用 `log.level=warn`。诊断模式只在有效期内覆盖最终 `log.level` 为 `info` 或 `debug`，不会覆盖 `timestamp`、`output` 等其他 `configOverride.log` 字段；到期后配置缓存失效并恢复正常模式。

### 3.3 `Line` 线路与 `Plan` 匹配

`Node` 只描述底层机器、Agent 和遥测状态；历史 `NodeInbound` 仅用于旧数据兼容。`Line` 描述用户实际连接的端点，并直接持有协议、归一化参数、入口节点/端口与出口节点/端口。Agent 根据 Line 在相关节点自动派生 sing-box 入站、出站和路由规则。

| 字段 / 规则 | 说明 |
| :--- | :--- |
| `type=DIRECT` | 入口节点与出口节点相同，入口端口与出口端口相同；Agent 在该节点生成 Line 协议入站 |
| `type=RELAY` | 必须指定入口/出口节点与 `relayMode`；入口或出口端口省略时从 `20000~65535` 随机生成，并按 TCP/UDP 传输层检查冲突 |
| `tag` | 可选的入站 Tag 基础名；为空时使用 `line-<id>`，中继线路自动派生 `<tag>-entry` 与 `<tag>-exit`，同节点冲突返回 `409` |
| `listen` | 线路派生入站的监听地址，默认 `0.0.0.0`；直连和中继入口/出口复用该地址 |
| `relayMode=BLIND_FORWARD` | 入口节点生成 `direct` inbound，并用 `override_address` / `override_port` 指向出口节点的 Line 端口，保持端到端协议加密 |
| `relayMode=PROTOCOL_PROXY` | 入口节点生成 Line 协议入站、目标协议 outbound 与 route rule；出口节点生成对应协议入站 |
| `relayMode=TARGET_LINE` | 入口节点生成当前 Line 的协议入站和指向目标直连线路的异构协议 outbound；目标节点复用目标直连线路的协议入站，不重复占用端口 |
| `targetLineId` | 仅用于 `TARGET_LINE`；必须引用其他节点上的 `DIRECT` 线路，目标协议限定为 `VLESS`、`VMESS`、`TROJAN`、`HYSTERIA2`、`TUIC`、`SHADOWSOCKS` 或 `NAIVE` |
| `endpointOverrideEnabled=false` | 默认关闭；用户连接地址/端口复用入口节点与入口端口，SNI/Host 从 Line 协议 TLS/Transport 参数回退 |
| `endpointOverrideEnabled=true` | 启用 `serverHost/serverPort/serverName/host` 覆盖；覆盖值单独保留，关闭开关不会清空 |
| `serverHost/serverPort` | 用户端实际连接地址/端口覆盖；线路 API 顶层字段返回最终生效值，`endpointOverrides` 返回原始值 |
| `serverName/host` | 订阅编译与协议代理中继分别覆盖 SNI 与传输层 Host；开关关闭时回退到 `Line.paramsJson` |
| `landingEndpointOverrideEnabled` | 中继线路专属落地端点覆盖开关；开启时允许显式为入口出站指定内网专线 IP / 回源域名与端口 |
| `landingServerHost/landingServerPort` | 中继向落地节点发起连接时使用的拨号目标覆盖值；`TARGET_LINE` 模式未开启落地覆盖时自动继承目标直连线路生效的对外端点（`serverHost:serverPort`）与 SNI；NAT 落地时锁定走 127.0.0.1 反向隧道 |
| `protocolType/paramsJson` | Line 自己拥有协议和协议参数；响应字段为 `protocolType` + 脱敏后的 `params`，管理端通过可视化分组表单编辑 |
| `trafficRate` | 线路流量倍率；`TrafficLog.upload/download` 记录物理原始字节，Agent 心跳入账时以该倍率折算 `billedBytes` 扣减 `Subscription.trafficUsedBytes` 与兼容的 `User.trafficUsedBytes`，大盘同时展示物理值与折算值；订阅展示倍率非 1 时线路名称追加 `[Nx]` |
| `tagsJson/level/sortOrder/isPublic/status` | 线路标签、等级、排序、公开性与启停状态；只在线且公开的启用线路可进入套餐匹配，额外授权线路可绕过公开性与套餐规则但仍须启用且入口/出口在线 |

线路 API 为旧客户端保留只读 `targetInbound` 摘要，但它由 Line 的出口节点、出口端口和协议参数派生，不再对应 `NodeInbound` 外键。

`Plan` 保存用户可订购的流量配额、有效期、价格和线路授权范围：

| 字段 | 说明 |
| :--- | :--- |
| `trafficLimitBytes` | 套餐周期总流量，服务边界序列化为 Number |
| `trafficResetMode=NONE` | 保持现有行为，累计配额不自动重置 |
| `trafficResetMode=CALENDAR_MONTH` | 按服务器本地时区每月 1 日 00:00 开始新周期 |
| `trafficResetMode=SUBSCRIPTION_CYCLE` | 从订阅 `startedAt` 起每 `durationDays` 天开始新周期 |
| `lineMatchMode=ALL` | 匹配所有入口节点与出口节点均在线、且线路公开启用的线路 |
| `lineMatchMode=TAGS` | `lineTagsJson` 与 `Line.tagsJson` 有任一标签交集 |
| `lineMatchMode=EXPLICIT` | 仅匹配 `lineIdsJson` 中列出的线路 |
| `templateId` | 可选订阅模板；为空时使用全局 `isDefault=true` 模板 |
| `badgeText` | 市场推荐角标文本（如 HOT、推荐、特惠），为空不展示 |
| `isFeatured` | 是否主推推荐套餐；为 true 时市场卡片展示微光边框与景深阴影 |
| `featuresJson` | 自定义权益特性清单 JSON 数组；留空时自动降级展示系统默认 4 项基础特性 |
| `cardConfigJson` | 套餐市场卡片视觉动效定制 JSON，包含主题色、Lucide 矢量图标、流光边框动效模式、流光色彩、原价划线、折扣文案、自定义行动按钮文案、微光扫光、角标视觉风格及「我的订阅」特效同步开关（`syncToSubscription`） |

节点只提供底层健康状态；线路只有 `status=ACTIVE`、`isPublic=true` 且入口节点与出口节点均在线时，才会作为套餐市场的可用线路返回；`TARGET_LINE` 还要求目标直连线路自身为 `ACTIVE`。订阅详情直接返回线路协议、倍率、等级、标签、端点覆盖和中继机制。

### 3.4 `Subscription` 生命周期与兼容镜像

每个用户通过 `userId @unique` 只有一条订阅实例。首次订购或原订阅已失效时复用/创建实例；升配立即重置已用流量并按新套餐重算周期；取消将状态置为 `CANCELED`，在 `expireAt` 前仍可使用；巡检将到期的 `ACTIVE`/`CANCELED` 更新为 `EXPIRED`；管理员可设置 `ACTIVE`、`CANCELED`、`EXPIRED`、`REVOKED`、配额、已用流量和有效期。

当套餐启用流量重置策略时，`trafficPeriodStartAt` 表示当前累计配额周期起点。自然月策略按服务器本地时区计算每月边界，订阅周期策略按 `startedAt + N × durationDays` 计算；订阅读取、Agent 心跳入账和每分钟后台巡检都会惰性或定时推进周期。旧订阅首次启用策略只补写周期起点，不清空已有用量；跨过边界时在同一事务内把 `Subscription.trafficUsedBytes` 与 `User.trafficUsedBytes` 清零，再计入本次心跳增量。`TrafficLog` 只记录原始流水，不因重置删除或改写。

`User.trafficLimitBytes`、`trafficUsedBytes`、`expireAt`、`subscriptionToken` 暂时保留为兼容镜像。订阅模块存在时以 `Subscription` 为准，每次订购、升配、管理员修改或 Token 重置在同一事务中同步镜像；旧迁移/旧测试缺少订阅表时沿用原 User 配额路径。

用户流量由在线 Agent 从 Sing-box `experimental.v2ray_api` 使用 `QueryStats(reset=false)` 上报累计值。Master 以 `nodeId + credential` 查询 `TrafficCursor` 计算增量：首次出现计入当前值，累计值上升只计入差额，累计值下降视为内核重启/计数器重置并计入当前值，同时记录告警，累计值相等则不生成流水。Master 解析节点线路时优先选择 ACTIVE 入口线路；节点没有入口线路时，回退到其作为 ACTIVE `RELAY + BLIND_FORWARD` 出口的承载线路。普通用户流水的 `upload/download` 保留物理字节，配额扣减按归属线路的 `trafficRate` 计算 `billedBytes`；没有归属线路时倍率按 `1.0` 处理。协议代理/异构桥接使用固定内部中继凭证，内部凭证只更新游标，不创建 `TrafficLog`，不扣减普通用户或订阅配额。未知普通凭证同样只更新游标，不计费；用户之后恢复时只计算新增流量。订阅存在时，`Subscription.trafficUsedBytes` 是计费与资格判断的真实来源，`User.trafficUsedBytes` 仅作为兼容镜像；未绑定订阅的旧用户继续使用 User 字段。

每次账务事务同时提交 `TrafficLog`、`TrafficCursor`、`Subscription.trafficUsedBytes` 和 `User.trafficUsedBytes`。同一节点积压的心跳允许合并为最新快照，用户与订阅配额按批次聚合更新，因而重试和中间样本丢失不会重复计费或丢失累计差额。节点实时遥测与速率聚合独立落库，历史速率桶由低频巡检按保留周期清理，不在每个心跳事务内执行删除。

`UserLineGrant` 是管理员维护的用户级线路授权关系。绑定/更新订阅接口接收完整 `extraLineIds` 列表，空数组表示清空；授权跨续费、升配、过期和重新购买保留，删除用户订阅时也不清除。订阅线路是套餐匹配线路与额外授权线路的并集；额外线路仍要求 `status=ACTIVE` 且入口、出口节点在线，全局 `publicLinesEnabled=false` 仍会关闭全部线路输出。

### 3.5 `SubscriptionTemplate` 模板数据

`proxyGroupsJson` 与 `ruleSetsJson` 分别保存策略组和分流规则数组；`dnsConfigJson` 使用平台无关的语义结构：`{ enable?, fakeIp?, directDns?: string[], proxyDns?: string[], ipv6? }`。启动 bootstrap/seed 会扫描存量记录，将旧的 Clash `enhanced-mode`、`nameserver`、`fallback` 等字段转换为该结构；不改变 SQLite 表结构。`customInjectYaml` 与 `customInjectJson` 是客户端配置顶层对象覆写。

策略组支持 `select`、`url-test`、`fallback`、`load-balance`，并可组合 `filter`、`includeTags`、`excludeTags`、`protocols`、`maxRate`，多条件按 AND 匹配。规则项支持 `domain`、`domain-suffix`、`domain-keyword`、`ip-cidr`、`geosite`、`match`、`remote-rule-set`；远程规则集可分别提供 Clash `url` 与 Sing-box `singboxUrl`/`format`。编译器为 Clash 自动生成 `rule-providers`/`RULE-SET`，为 Sing-box 1.8+ 自动生成 `route.rule_set` 顶层 remote 定义与引用。

模板服务校验覆写语法并以事务同步唯一默认模板：设置模板 `isDefault=true` 会更新 `SystemSetting.defaultTemplateId`，系统设置切换该 ID 会同步模板表，其余模板取消默认；取消当前默认时清空系统设置并回退到其他 `isDefault=true` 模板。

`apps/server/prisma/default-template.js` 内嵌「默认通用全能分流模板」，包含地区节点自动优选、AI/流媒体/Telegram 分流、广告拦截、国内直连、DNS/Fake-IP 与客户端覆写配置。所有部署方式的生产 bootstrap 都会确保该模板存在；如果管理员已修改模板，启动时保留修改，不覆盖内容。模板记录通过 `isBuiltin=true` 标记，只能编辑不能删除；执行完整 `prisma db seed` 时才会按内嵌定义同步模板内容。

### 3.6 `User.deviceLimit` 与 `Plan.deviceLimit`（多设备管理）

`User.deviceLimit` 为可空用户覆盖：`null` 跟随有效订阅套餐、正数指定用户上限、`0` 显式不限；`Plan.deviceLimit` 默认为 `0`（不限）。当用户跟随套餐时，兑换权益快照 `Subscription.planSnapshotJson.deviceLimit` 优先于当前 `Plan.deviceLimit`，因此已快照的套餐权益不随套餐后续编辑改变。

`resolveEffectiveDeviceLimit()` 先解析用户覆盖，再解析套餐（快照优先），最后应用 `deviceLimitEnabled` 全局执行开关。响应同时提供 `configuredDeviceLimit`、`effectiveDeviceLimit`、`configuredDeviceLimitSource` 与 `deviceLimitSource`；全局关闭只令有效上限为空，不擦除配置。在线设备报告由 Master 进程内存按最近 `deviceOnlineWindowSecs` 秒暂存，不写入 Prisma，也不构成历史审计数据。

## 4. 二进制资源中心模型（v0.5.0，v0.9.x 精简重构）

二进制资源中心专注管理跨平台 `riri-agent` 运行时二进制（定制 Sing-box 内核已内嵌封装于 Agent 二进制中，不再作为独立资源维护）。`BinaryRelease` 表示一个逻辑 Agent 资源版本，`BinaryAsset` 表示某个 OS/架构平台（`agent-linux-amd64`、`agent-linux-arm64`、`agent-macos-amd64`、`agent-macos-arm64`、`agent-windows-amd64`）的可分发资产，`BinaryAssetFile` 表示资产内的文件明细。

| 模型 | 关键字段与约束 |
| :--- | :--- |
| `BinaryRelease` | `kind=AGENT`、`upstreamVersion`、`revision` 唯一确定资源版本；`source=LOCAL\|UPLOAD\|REMOTE\|GITHUB`（兼容旧 `BUILTIN`）；`status=DRAFT\|ACTIVE\|DISABLED\|RETIRED`；可保存 `builtFromAppVersion`、`compatibilityJson`、备注和全局唯一的默认标记。不区分内置与非内置权限，**所有资源均可直接物理删除**。 |
| `BinaryAsset` | 记录 `target`、OS、架构、主文件名、`storageRoot`、本地 `storagePath`、SHA-256、大小和可用状态；关联 `BinaryRelease` 级联删除（`onDelete: Cascade`）。 |
| `BinaryAssetFile` | 记录资产内每个文件的名称、角色、存储路径、SHA-256、大小与 Unix mode。关联 `BinaryAsset` 级联删除（`onDelete: Cascade`）。 |
| `BinaryDeploymentTask` | 记录节点、目标/旧资产、资源类型、`UPGRADE\|ROLLBACK` 操作、`QUEUED\|DISPATCHED\|COMPLETED\|FAILED` 状态、尝试次数、请求人、错误原因与时间线。`assetId`/`previousAssetId`/`releaseId` 均配置 `onDelete: SetNull`，资源或资产删除后历史部署任务仍保留完整审计轨迹。 |

文件内容保存在本地 `data/binaries/resources/<releaseId>/<target>/`，SQLite 不保存 BLOB。启动时读取 `manifest.json` 或旧目录认领初始资源，并将已初始化的版本键记录在 `data/binaries/.seeded-releases.json` 中；若管理员删除了某初始版本，Master 重启时识别该标记不会再次自动恢复。删除默认资源时，系统自动将 `isDefault=true` 转移至剩余最新的 `ACTIVE` 资源。

资源中心的全部管理动作（上传、远程导入、GitHub Release 同步、编辑、启停、归档、恢复、切换默认、删除）不再使用独立审计表，统一并入 `SystemLog`（`source='SERVER'`、`module='BinaryResource'`）。

## 5. 系统日志与全链路观测模型（SystemLog，v0.6.11）

`SystemLog` 表统一汇聚 Master 服务端、Web 前端与 VPS 边缘节点（Agent 守护进程与 Sing-box 内核）的结构化日志，支撑全系统可观测性与运维诊断。

### 5.1 数据表定义

```prisma
// 独立保存在 telemetry.db 物理库中（apps/server/prisma/telemetry/schema.prisma）
model SystemLog {
  id        String   @id @default(uuid())
  traceId   String?  // 全链路关联 ID (X-Request-Id)
  source    String   // SERVER | WEB | AGENT | SINGBOX
  level     String   // DEBUG | INFO | WARN | ERROR
  module    String   // 产生模块/上下文（如 Auth, Lines, Nodes, Gateway, UI, Kernel）
  message   String   // 核心描述文本
  metadata  String   @default("{}") // 结构化 JSON 详情（IP、路由、耗时、状态码、堆栈等）
  nodeId    String?  // 关联 VPS 节点 ID（逻辑关联，应用层异步回填）
  userId    String?  // 关联用户 ID（逻辑关联，应用层异步回填）
  createdAt DateTime @default(now())

  @@index([createdAt])
  @@index([source, createdAt])
  @@index([level, createdAt])
  @@index([traceId])
  @@index([nodeId, createdAt])
  @@index([userId, createdAt])
}
```

### 5.2 字段说明与约束

| 字段 | 类型 | 说明与约束 |
| :--- | :--- | :--- |
| `id` | String (UUID) | 日志全局主键 |
| `traceId` | String? | 统一全链路追踪 ID（通过 HTTP `X-Request-Id` 贯穿 Web 前端与 Master API） |
| `source` | String | 来源端：`SERVER` (Master 服务端)、`WEB` (浏览器前端)、`AGENT` (边缘 Agent 守护程序)、`SINGBOX` (Sing-box 内核) |
| `level` | String | 日志级别：`DEBUG`、`INFO`、`WARN`、`ERROR` |
| `module` | String | 业务模块标签（例如 `Auth`、`Lines`、`Nodes`、`Gateway`、`Traffic`、`UI`、`Kernel`） |
| `message` | String | 核心描述摘要 |
| `metadata` | String (JSON) | 扩展元数据，包含 IP、请求方法、URL、状态码、耗时、异常调用栈堆栈等结构化信息 |
| `nodeId` | String? | 关联的边缘节点 ID，可为空；节点删除时级联设置为 `null`（`SetNull`） |
| `userId` | String? | 关联的操作/请求用户 ID，可为空；用户删除时级联设置为 `null`（`SetNull`） |
| `createdAt` | DateTime | 记录产生时间戳，建有复合时序索引保障毫秒级分页检索 |

NORMAL 节点的 SINGBOX INFO/DEBUG 不进入 `SystemLog`；有效诊断期内仅允许不高于请求级别的 SINGBOX 日志受控绕过全局 `logsMinIngestLevel`。历史日志不迁移、不重分类；系统日志也不参与流量计费，账务继续由 StatsService、heartbeat 与 `TrafficHourlyMetric` 小时桶驱动。入库前除既有敏感键掩码外，还清洗域名、IP、Token、密码和密钥模式。

### 5.3 存储缓冲与自动滚动淘汰机制
1. **内存队列与批量入库**：高频日志优先写入 Master 内存环形队列，每隔 1 秒或积攒 50 条日志异步执行批量写入（`createMany`），消除 SQLite 单写锁争用风险。
2. **生命周期双上限自动清理**：后台每小时按 `SystemSetting` 中的 `logsRetentionDays`（默认 7 天）与 `logsMaxCount`（默认 100,000 条）执行旧日志清理，防止 SQLite 数据库膨胀；管理员也可从统一遥测清理中心预览、按时间/数量清理或清空。
3. **清理审计与数据边界**：`POST /admin/telemetry/cleanup` 按 `TrafficHourlyMetric`、`NodeRateMetric`、`SystemLog` 和旧版 `TrafficLog` 分表执行，支持部分成功结果。操作要求二次确认和 `CLEAR_HISTORY` 短语，完成后以绕过最低采集级别的 `TelemetryCleanup` 日志记录操作者、请求 ID、条件、匹配数、删除数和耗时；审计写入在数据清理之后执行，因此清空系统日志仍保留本次审计。清理不触及 `User`/`Subscription` 用量、`TrafficCursor`、节点实时快照或计费数据。
4. **敏感信息脱敏红线**：所有 Token、密码、UUID 凭证与 Cookie 在入库前必须经过不可逆掩码处理（如 `eyJ...***`）。

## 6. 实时节点镜像站模型

`Node.capabilitiesJson` 保存 Agent 最近一次心跳宣告的能力数组；管理端向前端暴露解析后的能力、`supportsMirrorProxy`、`supportsSingboxLogCapture` 与 `supportsAgentLogRotation` 布尔值。只有在线、WS/WSS 且宣告 `mirror_proxy` 的节点可以承载实时镜像请求；只有在线且宣告 `singbox_log_capture` 的节点可以开启临时 Sing-box 诊断；缺少 `agent_log_rotation` 的旧 Agent 继续承载业务，但不会执行本地日志轮转。

`MirrorSite` 是可复用的实时反向代理配置，不保存响应体：

| 字段 | 类型 | 说明与约束 |
| :--- | :--- | :--- |
| `id` / `name` / `slug` | String | 主键、展示名、唯一访问 slug；slug 只允许小写字母、数字和连字符 |
| `enabled` | Boolean | 是否允许非管理员访问 |
| `upstreamBaseUrl` | String | 规范化的公开 HTTP/HTTPS 基址，不得含凭据、查询或片段 |
| `allowedOriginsJson` | String (JSON) | 允许的上游域名集合，必须包含基址域名 |
| `nodeId` | String | 指定出网节点，节点删除时级联删除镜像配置 |
| `accessMode` | String | `ADMIN`、`SHARE` 或 `PUBLIC` |
| `shareTokenHash` | String? | 分享 Token 的 SHA-256 哈希；绝不返回 API 或日志 |
| `shareExpiresAt` / `shareRotatedAt` | DateTime? | 分享地址过期时间与最近轮换时间 |
| `lastRequestAt` / `lastStatusCode` / `lastErrorCode` | DateTime?/Int/String? | 最近一次请求的低敏运行摘要 |

`slug` 具有唯一约束，`nodeId`、`enabled`、`createdAt` 及其组合建立查询索引。迁移、备份和回滚只涉及 SQLite 结构与配置元数据；禁止写入响应 BLOB，也不引入外部数据库、缓存或对象存储。生产备份必须同时考虑 SQLite 主文件及 WAL/SHM 文件，分享 Token 轮换后旧哈希立即失效。

## 7. 直连代理池凭据模型（ProxyKey，v0.9.0）

面向自动化环境（爬虫、指纹浏览器多开、海外社媒运营、脚本工具）的**独立直连代理凭据**，与面向客户端翻墙的订阅体系完全解耦：不向自动化环境暴露用户主登录密码、UUID 或订阅 Token。

### 7.1 字段字典

| 字段 | 类型 | 说明与约束 |
| :--- | :--- | :--- |
| `id` | String (UUID) | 凭据主键 |
| `userId` | String | 归属用户；`User` 删除时 `onDelete: Cascade` 级联删除 |
| `name` | String | 凭据备注名称，服务端清洗首尾空白并限制 ≤60 字符（如“爬虫项目 A”“AdsPower 环境 3”） |
| `username` | String @unique | 高熵用户名，固定形态 `pk_<24 位小写十六进制>`（96 bit 熵）。**必须冒号安全**：Sing-box `mixed`/`socks`/`http` 入站的认证用户名会同时出现在 SOCKS5 用户名长度前缀与 HTTP `Proxy-Authorization` Basic 头中，而后者按首个 `:` 切分，因此不得追加 `::lineId` 后缀 |
| `password` | String | 该凭据独立密码，24 字节 base64url（192 bit 熵）。因 Sing-box 入站校验需要，落库为明文（与 `User.password` 同口径）；可随时轮换 |
| `whitelistIps` | String | 逗号分隔的 IP/CIDR 白名单，空串表示不限制来源；单条须为合法 IPv4/IPv6 地址或 CIDR（IPv4 前缀 0~32、IPv6 前缀 0~128），最多 64 条 |
| `exportToken` | String @unique | 免登录动态拉取令牌，默认 `uuid()`；用于 `GET /api/v1/user/proxy-pool/export?token=`，可独立轮换且不影响代理密码 |
| `isActive` | Boolean | 单键启停；置为 `false` 后该凭据立即从节点配置中吊销 |
| `trafficUsedBytes` | BigInt | 该凭据累计**计费**流量（已按线路倍率折算），与主账户 `User.trafficUsedBytes` 同口径 |
| `lastUsedAt` | DateTime? | 最近一次产生流量的时间，由心跳账务事务同步刷新 |
| `createdAt` / `updatedAt` | DateTime | 创建与更新时间 |

索引：`userId`、`isActive`、`(userId, isActive)`；`username` 与 `exportToken` 为唯一约束。

### 7.2 与既有模型的 ER 关系

- `User 1 ── n ProxyKey`（`onDelete: Cascade`）：账号删除时凭据一并清除。
- `ProxyKey 1 ── n TrafficLog`（关系名 `ProxyKeyTrafficLogs`，`onDelete: SetNull`）：凭据删除后历史流水保留并置空 `proxyKeyId`，不影响主账户与线路维度的历史统计。
- `TrafficLog.proxyKeyId` 为可空外键：订阅体系产生的流水为 `null`，直连代理池流量在 `pk_` 凭据经 `ProxyKey.username` 映射回 `userId` 后写入归属凭据。
- 线路维度归属不变：直连代理流水的 `lineId` 由节点级活动线路解析（`resolveActiveLineForNode`）填充，因此同样参与线路倍率折算与线路排行统计。

### 7.3 生命周期与一致性

1. **创建**：用户名在 `pk_` 命名空间内以 5 次重试规避唯一约束冲突（Prisma `P2002`）；单账号凭据上限 20 条。
2. **注入**：`buildConfigSync` 只注入 `isActive = true` 且归属用户仍具备订阅资格（账号启用、邮箱核验通过、未超额、未过期）的凭据，单节点上限 512 条。
3. **账务**：心跳累计快照的增量在同一 SQLite 事务内写入 `TrafficLog`、累加 `User` / `Subscription` / `ProxyKey` 用量并刷新 `lastUsedAt`；任一环节失败整批回滚。
4. **熔断**：本批次入账后触及配额的账号触发全局 `config_sync`，凭据与订阅凭证在数秒内同步吊销；管理端启停/删除凭据同样即时重下发。

---

## 8. 流量小时时序聚合模型（TrafficHourlyMetric，v0.9.1）

面向高频节点与高并发场景下的**时序小时聚合指标表**，彻底替代旧版秒级增量明细表（`TrafficLog`），解决 SQLite 高频写锁争用与看板大盘拉全表遍历的高开销问题。

### 8.1 字段字典

| 字段 | 类型 | 说明与约束 |
| :--- | :--- | :--- |
| `id` | String (UUID) | 记录主键 |
| `bucketStart` | DateTime | 该统计周期的 UTC 整点小时起点（如 `2026-09-17T00:00:00.000Z`） |
| `nodeId` | String | 关联边缘节点 ID |
| `userId` | String | 归属用户 ID |
| `lineId` | String | 归属接入线路 ID；空字符串 `""` 表示未分配/节点裸连接 |
| `proxyKeyId` | String | 直连代理池凭据 ID；空字符串 `""` 表示普通用户订阅流量 |
| `upload` | BigInt | 该小时桶内累计物理上行字节 |
| `download` | BigInt | 该小时桶内累计物理下行字节 |
| `billedBytes` | BigInt | 该小时桶内累计计费字节（已乘线路倍率折算） |
| `createdAt` / `updatedAt` | DateTime | 记录创建与最后更新时间戳 |

复合唯一索引：`[bucketStart, nodeId, userId, lineId, proxyKeyId]`  
单列/组合查询索引：`bucketStart`、`(userId, bucketStart)`、`(lineId, bucketStart)`、`(nodeId, bucketStart)`。

### 8.2 解耦与物理分库设计
- **无物理外键级联**：`TrafficHourlyMetric` 中的 `nodeId`、`userId`、`lineId`、`proxyKeyId` 均设计为独立普通索引 String 字段，不与主业务表建立 Prisma `@relation` 强外键约束。
- **物理分库落地（Phase 2）**：指标数据独立持久化在 `telemetry.db`（`apps/server/prisma/telemetry/schema.prisma`），主库仅维护核心用户、订阅、线路与配置元数据。

### 8.3 缓冲写入与生命周期
1. **内存微批缓冲（10~15s）**：心跳解析的流量增量先行注入 `AgentGatewayService` 内存缓冲队列，由定时任务以原生 SQL `ON CONFLICT(...) DO UPDATE` 进行原子累加，彻底消除高频秒级写锁。
2. **优雅停机保护**：服务销毁时触发 `onModuleDestroy` 强制清空残余缓冲，保障时序数据完整性。
3. **可配置滑动窗口 TTL**：系统每 12 小时按 `trafficHourlyRetentionDays`（默认 90 天）清理小时记录，并按 `nodeRateRetentionDays`（默认 30 天）清理节点速率桶；旧版 `TrafficLog` 继续按固定 7 天过渡策略清理。保留策略只删除历史观测数据，不修改计费游标和用户用量。

---

## 9. 双 SQLite 数据库物理分库架构（Dual-Database Architecture，v0.9.2）

为彻底杜绝高频指标收集、系统日志写入与主业务交易（用户登录、套餐购买、节点管理等）对单一 SQLite 文件写锁的竞争，系统全面实施物理分库架构。

### 9.1 数据库职责划分

| 数据库文件 | 环境变量 | Prisma Schema 路径 | 生成 Client | 承载模型 | 调优策略 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **主业务库** (`app.db` / `riri.db` / `dev.db`) | `DATABASE_URL` | `apps/server/prisma/schema.prisma` | `@prisma/client` | `User`, `Subscription`, `Plan`, `Line`, `Node`, `ProxyKey`, `TrafficCursor`, `SystemSetting`, `BalanceTransaction` 等 | WAL 模式，`busy_timeout = 10000ms`，单写队列调度 |
| **时序与日志库** (`telemetry.db` / `dev-telemetry.db`) | `TELEMETRY_DATABASE_URL` | `apps/server/prisma/telemetry/schema.prisma` | `@prisma/telemetry-client` | `TrafficHourlyMetric`, `NodeRateMetric`, `SystemLog` | 独立 WAL 模式与 `busy_timeout`，内存批量合并写入与定期滑动窗口清理 |

### 9.2 跨库数据关联与 Hydration 模式

时序与日志库中包含 `nodeId`、`userId`、`lineId`、`proxyKeyId` 等逻辑关联标识，但两库物理隔离，不建立跨数据库 Foreign Key 约束：
1. **日志查询动态组装（Application-level Hydration）**：`SystemLogsService.query()` 分页获取 `telemetry.db` 中的 `SystemLog` 行后，提取唯一的 `nodeId` 和 `userId` 集合，并发通过 `PrismaService` 批量读取主库中的 `Node` 与 `User`，在应用层反序列化并挂载关联对象，对外 API 契约与前端响应数据结构 100% 保持向后兼容。
2. **流量与速率时序展示**：`TrafficService` 查询 `telemetry.db` 中的聚合指标，结合主库线路与用户基础资料进行倍率与名称匹配计算。

### 9.3 存量数据平滑迁移机制（SQLite ATTACH DATABASE）

从旧版单库升级至双库时，`apps/server/prisma/deploy-databases.js` 自动调度执行 `apps/server/prisma/migrate-telemetry-data.js`：
- 使用 SQLite 内核级 `ATTACH DATABASE "${telemetryDbPath}" AS telemetry` 引擎指令。
- 直接在数据库引擎内部执行 `INSERT OR IGNORE INTO telemetry.TrafficHourlyMetric SELECT ... FROM main.TrafficHourlyMetric`，无需经由 Node.js 内存周转，可在亚秒级完成数万条存量记录的零拷贝迁移。
- 迁移脚本具备完全幂等性，主库表结构迁移在数据迁移完成后安全移除废弃表。

---

## 10. 帮助中心与使用文档模型（HelpArticle）

帮助中心为面向 0 基础小白用户的系统内置文档库，提供客户端使用教程、配置导入指引与常见问题解答。文档保存在主业务库中，支持管理端富文本/Markdown 实时编辑、平台分类过滤、多语言与动态变量自动插值。

### 10.1 字段字典

| 字段 | 类型 | 默认值 | 约束与说明 |
| :--- | :--- | :--- | :--- |
| `id` | String (UUID) | uuid() | 文档记录唯一主键 |
| `slug` | String | 必填 | 唯一标识与 URL 路径别名（如 `windows-clash-verge`、`faq`），唯一约束 `@@unique([slug])` |
| `title` | String | 必填 | 文档主标题（如 `Windows 客户端使用教程`） |
| `platform` | String | `"ALL"` | 归属平台分类：`WINDOWS` / `MACOS` / `IOS` / `ANDROID` / `ROUTER` / `FAQ` / `GENERAL` |
| `clientName` | String? | `null` | 客户端软件名称（如 `Clash Verge Rev`、`Shadowrocket`），用于快速导入识别 |
| `icon` | String? | `null` | 前端渲染图标标示，支持 Lucide 图标名称 |
| `summary` | String? | `null` | 文档摘要/副标题，展示于目录列表或卡片预览 |
| `content` | String | 必填 | Markdown 正文内容，支持 GFM 语法、代码高亮、Callout 警告块及动态变量插值 |
| `sortOrder` | Int | `0` | 排序权重（数值越小越靠前） |
| `isPublished` | Boolean | `true` | 上架/发布开关；未发布的文档仅管理员可见 |
| `locale` | String | `"zh-CN"` | 语言代码（`zh-CN` / `en-US`），支撑全站多语言切换 |
| `createdAt` | DateTime | now() | 创建时间戳 |
| `updatedAt` | DateTime | 自动 | 最后编辑时间戳 |

### 10.2 索引设计

- `@@unique([slug])`：URL 路由别名唯一性校验
- `@@index([platform, isPublished, sortOrder])`：客户端按平台与发布状态快速排序筛选
- `@@index([locale, isPublished])`：多语言与公开文档过滤
- `@@index([sortOrder])`：全局目录树有序检索

### 10.3 动态变量插值机制 (Dynamic Variables)

文档 Markdown 正文内可自由引用占位符变量，用户端在获取文章正文时由服务端依据当前登录用户身份和系统全局配置自动完成安全上下文替换：

| 变量占位符 | 替换值含义 | 回退/默认处理 |
| :--- | :--- | :--- |
| `{{subscription_url}}` | 当前用户专属主订阅 URL | 用户未登录时保留原样或提示占位 |
| `{{clash_import_url}}` | 一键导入 Clash 协议链接 (`clash://install-config?url=...`) | 自动基于当前用户订阅链接编码生成 |
| `{{shadowrocket_import_url}}` | 一键导入 Shadowrocket 协议链接 (`sub://...`) | 自动以 Base64 安全编码转换生成 |
| `{{site_name}}` | 当前站点名称 (`SystemSetting.siteName`) | 未配置时默认 `"RiriCloud"` |
| `{{public_base_url}}` | 站点基准对外访问 URL (`SystemSetting.publicBaseUrl`) | 未配置时自动回退为请求 Host |

### 10.4 官方预置教程与安全恢复

- 系统在首次 `pnpm db:seed` 时自动灌入涵盖 Windows (Clash Verge Rev)、macOS (Clash Verge Rev)、iOS (Shadowrocket)、Android (Clash Meta) 及常见故障排查 (FAQ) 的 5 篇官方标准化图文教程。
- 管理端提供 `POST /api/v1/admin/help/articles/reset-defaults` 安全重置机制，支持在文档损毁或配置错乱时一键恢复官方标准预设文档，可选择覆写冲突项或全量刷新。

---\n
## 11. 上游订阅与外部线路

### 11.1 来源与资源职责

`UpstreamSubscription` 只负责 URL/文本来源及同步，`UpstreamNode` 是外部连接资源。面向用户的授权统一在 `Line`：自建中继为 `RELAY + UPSTREAM_NODE`，直接分发为 `EXTERNAL`。不再提供 `isDirectSub` 或全局合并授权。

| UpstreamSubscription 字段 | 说明 |
| :--- | :--- |
| `id` / `name` | UUID 与管理名称 |
| `sourceType` | `URL` / `TEXT` |
| `format` / `detectedFormat` | 管理员配置与实际检测结果分离；AUTO 每次重新检测 |
| `url` / `content` / `customHeadersJson` | 整段 AES-GCM 密文；内容为文本源或 last-good 拉取快照；管理员详情按需解密，列表掩码 |
| `autoUpdate` / `updateIntervalMins` | 默认 720 分钟，允许 10~43200 分钟 |
| `lastSyncAt` / `lastSuccessAt` | 最近尝试和最近成功快照的时间分离 |
| `lastSyncStatus` / `lastSyncMessage` | PENDING / SUCCESS / FAILED 与脱敏诊断 |
| `userInfoUsedBytes` / `userInfoTotalBytes` / `userInfoExpireAt` | 上游账户元信息快照，未知为 null；API 字节值用十进制字符串，不计作本地用户流量 |
| `nodeCount` | 当前成功快照去重后的 PRESENT 节点数，不含缺失保留记录 |
| `status` | ACTIVE / DISABLED；源禁用立即停止直接分发与中继，不覆盖独立线路启停状态 |

| UpstreamNode 字段 | 说明 |
| :--- | :--- |
| `id` / `subscriptionId` | 稳定资源 UUID 与所属源；显式删除源才级联删除 |
| `name` / `protocolType` / `serverHost` / `serverPort` | 展示名、归一化协议、地址和 1~65535 端口 |
| `paramsJson` / `rawConfigJson` | 归一化连接及原始配置的整段 AES-GCM 密文，不通过用户摘要返回 |
| `sourceKey` | 可选可靠的源内标识，不使用数组顺序猜测 |
| `connectionHash` / `configHash` | 全长 SHA-256 规范化完整连接特征和配置变化哈希；不是业务 ID，也不使用随机密文计算 |
| `presenceStatus` / `missingSince` | PRESENT / MISSING 与缺失时间；独立于管理员启用状态 |
| `tagsJson` | 地区标签数组，用于资源筛选；Line 自身标签用于套餐授权 |
| `latencyMs` / `lastTestedAt` / `lastTestStatus` / `lastTestMessage` | 只镜像新端到端拨测摘要；没有有效 lastProbeJson 时不展示旧 TCP 数字 |
| `status` | 管理员 ACTIVE / DISABLED；同步不覆盖 |

### 11.2 业务不变量与授权

- DIRECT/RELAY 必须有真实入口节点与端口。EXTERNAL 只绑定上游节点，不挂假节点、不分配监听、不生成 Agent 入站；协议/端点/参数从资源动态解析，不复制到 Line 参数中。
- EXTERNAL 默认非公开且禁用；沿用 ALL/TAGS/EXPLICIT 和 UserLineGrant。公开启用后 ALL 套餐可包含它，新增/发布时必须提示影响范围。
- EXTERNAL 不计本地流量、不执行本地限速或设备限制；管理员停止分发不能追回用户已获得的共享上游凭据。
- 中继只允许可归属用户、可撤除用户的入口鉴权配置，拒绝共享 SS 或关闭用户鉴权的入口；客户端只获取本地入口凭据。
- 上游有效性共用源启用、节点启用、PRESENT、有效连接及已知到期/耗尽规则。未知元信息不视为无限，网络失败保留 last-good；成功响应缺元信息时清除旧值。

### 11.3 原子同步与生命周期

同源首次/手动/定时同步、修改和删除串行化；网络/解析在事务外，节点变更、缺失线路停用、统计和 last-good 快照在短事务内提交，提交后才清缓存并通知 Agent。

一对一匹配顺序为可靠 sourceKey → 完整 connectionHash → 源内唯一名称加协议；多候选拒绝提交，不按顺序猜测。完整重复去重，不同 WS 路径等连接特征不合并。缺失资源保留 UUID 和引用，停用关联线路；重新出现不自动启用线路。无效或不支持的代理条目阻止快照替换，不能用部分解析结果执行删除。

### 11.4 破坏性结构升级

删除 `fingerprint`、`isDirectSub`，不保留兼容接口或旧数据回填。新增迁移 `20260930190000_upstream_breaking_refactor` 保留非上游业务记录，但要求旧上游域为空；部署脚本在任何双库迁移前只读检查，SQL 本身也在持久结构变化前拒绝旧上游记录。维护者先备份并明确处理旧源、节点及关联线路，再重新导入；程序不自动清理。回退必须配套恢复数据库备份，详见部署指南。

## 12. 统一客户端测量摘要

Line 与 UpstreamNode 新增 `lastProbeJson String?`，保存 schemaVersion=1 的安全结果，API 输出 `lastProbe` 白名单对象：实际内核/版本、回退原因、主要客户端兼容性、Master 视角、链路类型、测试目标 ID/host、时间、耗时、延迟、状态/原因码、配置 hash/applied。禁止保存连接秘密、完整含凭据 URL、原始内核日志或控制 Secret。

迁移 `20261001010000_client_probe_metadata` 只新增列，并将旧延迟/状态/诊断/时间置空；不删除来源、节点、线路、用户、余额或流量，不要求清库。旧未标内核/目标的 TCP 或兼容结果不能冒充端到端测量，新版以 schemaVersion 与资源配置版本确认有效性。

拨测读取不可变短快照，在来源同步锁外执行；结果在短事务中再次验证连接/线路/关联来源和节点状态、配置 hash、更新时间与最新任务提交序列，条件 updateMany 写入。资源删除、失效、缺失、轮换或重绑后的旧结果为 STALE，不覆盖新配置。同资源旧任务晚结束不能覆盖新任务。环境不可用、取消和不支持不更改业务启停；测速失败不自动禁用资源。

任务只在 Master 内存保留，完成 15 分钟后清理、最多保留 50 个完成任务；重启丢失任务但保留资源最后有效测量。不新增数据库任务表或外部队列。系统新增 `probeSingboxFallbackEnabled`（默认 true），仅允许能力白名单兼容执行；既有 lineSpeedtestTargetUrl/Timeout 作为统一节点/线路拨测设置，默认目标 HTTPS generate_204，已有显式设置保留。

线路探针版本还纳入关联证书的 `id/updatedAt`，包括 TARGET_LINE 的实际证书依赖；同 ID 更新 PEM 后，旧结果展示为 STALE，运行中旧结果不能写回。快照及列表只加载证书版本元信息，不为该验证读取或返回私钥。
