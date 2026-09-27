# 接口与通信协议规范 (API & Protocols)

所有 HTTP 接口基于 `http(s)://<master-host>/api/v1` 前缀。

生产环境推荐由 Nginx 负责 HTTPS 终止、反向代理和边缘路由。后端唯一真实订阅接口仍为 `GET /api/v1/sub/:token`；伪静态订阅地址由 Nginx 将严格匹配的 UUID 单段路径内部 rewrite 到该接口，不新增 NestJS 路由或通用代理 middleware。

> **API 文档与安全（Swagger / OpenAPI）**：主控端支持自动生成 OpenAPI 交互文档（路径 `/api/docs` 与 `/api/docs-json`）。出于公网部署安全基线考虑，生产环境（`NODE_ENV=production` 或 `RIRICLOUD_ENV=production`）**默认关闭** API 文档挂载（访问返回 404）；开发与测试环境默认开启。若需在生产环境中开启调试，可在环境变量中显式配置 `ENABLE_SWAGGER=true`（兼容 `RIRICLOUD_ENABLE_SWAGGER=true`）。
>
> **实现状态（v0.6.12）**：标注 ⭐ 的端点已实现；其余端点为完整版规划，随对应里程碑落地。浏览器面板登录通过 `HttpOnly`、`SameSite=Lax` Cookie 保存 JWT；兼容脚本仍可使用 `Authorization: Bearer`，但登录/注册 JSON 不再返回 JWT。除 `@Public()` 显式放行的端点（登录、注册、验证码发送、CAPTCHA、本地订阅、版本、站点公开信息、Agent 二进制下载和 SSE 连接）外一律需要鉴权；管理员端点要求 `role=ADMIN`。AgentToken 只允许通过 `X-Agent-Token` 请求头传递，禁止放入 URL query。
>
> **首管理员引导**：系统不提供「首个注册用户自动成为管理员」机制。生产启动由 `ADMIN_EMAIL` 与 `ADMIN_PASSWORD` 显式创建首管理员；完整 Prisma seed 的演示账号只允许在非生产环境且显式 `AUTO_SEED=true` 时使用。
>
> **统一分页结构**：列表端点返回 `{ data: T[], total: number, page: number, pageSize: number }`；查询参数 `page`（默认 1）、`pageSize`（默认 20，上限 100）。
>
> **管理操作保护规则**：管理员不能删除自己、不能修改自己的角色（防锁死）；批量封禁/解封/删除操作在服务端逐条执行且自动跳过操作者自身。

### 1.1 认证模块 (`/auth`)
- `POST /auth/register`：用户注册。⭐
  - 请求：`{ email, password(8~64), nickname?(2~20), verificationCode?(6位), captchaToken?, captchaAnswer?, turnstileToken? }`；密码需满足系统设置的密码复杂度策略：长度满足动态 `passwordMinLength`，字符类别满足 `passwordRequire*` 开关（默认须含小写字母与数字，全部关闭时仅校验长度）；注册开关（SystemSetting `registrationEnabled`）关闭时返回 403，邮箱已存在统一返回 400 `注册信息无效`，并通过 `emailDomainMode` / `emailDomainList` 过滤。启用 `emailVerificationEnabled` 时必须提供已验证的 `REGISTER` 邮箱验证码；未启用邮箱验证但 `captchaMode` 非 `OFF` 时必须提交对应 CAPTCHA 凭据。注册成功且开启邮箱验证时自动标记 `emailVerifiedAt`。
  - 响应：`{ authenticated: true }`，并通过 `Set-Cookie` 建立 HttpOnly 会话（注册即登录）。新用户固定 `role=USER`，服务端分配全局唯一的 6 位数字 `uid`，昵称留空时回退为 `用户_<UID>`；初始余额发放 `defaultBalance`（分）；配置 `defaultPlanId` 时自动激活公开套餐并同步订阅镜像，未配置时新用户无默认有效订阅。
- `POST /auth/login`：登录并通过 HttpOnly Cookie 建立 JWT 会话，响应 `{ authenticated: true }`。⭐
- `POST /auth/logout`：递增当前用户 `sessionVersion` 使现有 JWT 立即失效，并清除认证 Cookie。⭐
- `POST /auth/reset-password`：找回/重置登录密码。⭐
  - 请求：`{ email, code(6位数字), newPassword(8~64) }`。
  - 邮箱不存在、验证码错误或过期时统一返回 400 `重置请求无效`；新密码需满足系统设置的密码复杂度策略（`passwordMinLength` 与 `passwordRequire*` 开关）；核验 `RESET_PASSWORD` 验证码后使用 bcrypt 加密更新密码，并递增 `sessionVersion` 使旧会话失效。
  - 存量或未核验邮箱的用户重置成功后，系统自动将其标记为已核验（`emailVerifiedAt = now()`），并向在线节点推送配置恢复其节点代理访问。
  - 响应：`{ success: true, message: '密码重置成功' }`。
- `GET /auth/me`：获取当前登录用户的详细信息、套餐、角色与邮箱核验状态 (`emailVerifiedAt`)；用户自身视图额外返回 `uid`、`nickname`、`balance`（分）和 `uuid`。⭐

### 1.2 用户面板 (`/user`)
- `GET /user/dashboard`：获取个人仪表盘数据（总配额、已用流量、剩余有效期、可用线路数及线路摘要）。⭐ **Deprecated**：前端已下线独立仪表盘并统一使用 `GET /user/subscription`；该接口仍保留以兼容外部脚本。
- `GET /user/nodes`：兼容路径，获取当前用户有权访问的线路列表（响应同时保留 `nodes` 镜像字段）。⭐
- 用户订阅页面使用 `/user/subscription` 数据展示当前套餐可用线路；用户侧不再提供独立线路页面。
- `POST /user/reset-sub`：重置用户的 `subscriptionToken`（防止订阅泄漏）。⭐ 响应 `{ subscriptionToken }`；旧链接立即失效（404）；若当前用户未绑定有效订阅返回 400。
- `POST /user/change-password`：修改当前登录密码。⭐ 请求 `{ oldPassword, newPassword }`；新密码需满足系统设置的密码复杂度策略（`passwordMinLength` 与 `passwordRequire*` 开关）；旧密码校验通过后使用 bcrypt 更新。
- `PATCH /user/profile`：修改当前用户昵称。⭐ 请求 `{ nickname }`，服务端清洗首尾空白并限制为 2~20 个字符；响应 `{ uid, nickname }`。
- `POST /user/verify-email`：核验当前账号邮箱所有权。⭐ 请求 `{ code }`（6 位数字验证码，需登录态）；核验 `VERIFY_CURRENT_EMAIL` 验证码成功后更新 `emailVerifiedAt = now()` 并向节点推送配置恢复订阅与节点连接，响应 `{ verified: true, emailVerifiedAt }`。
- `POST /user/change-email`：换绑当前账号邮箱。⭐ 请求 `{ newEmail, verificationCode, currentPassword }`；验证码必须是发往新邮箱且行为为 `CHANGE_EMAIL` 的有效 6 位验证码，当前密码使用 bcrypt 二次确认，邮箱唯一性检查与更新完成后标记 `emailVerifiedAt = now()` 并向节点推送配置，返回 `{ updated: true, email }`。
- `POST /user/reset-uuid`：重置当前用户代理凭据（底层为 UUID）。⭐ 响应 `{ uuid }`；更新后向在线 Agent 全量推送配置，旧代理凭据立即失效。
- `GET /user/wallet`：查询账户钱包摘要。⭐ 响应 `{ balance, totalIncome, totalExpense, transactionCount }`，金额单位均为分。
- `GET /user/wallet/transactions?page&pageSize`：查询当前用户余额流水。⭐ 返回统一分页结构，流水包含 `amount`、`balanceBefore`、`balanceAfter`、`type`、`description`、`createdAt`。
- `POST /user/wallet/redeem`：兑换卡密。⭐ 请求 `{ code }`；卡密核销、购买身份分类额度占用和余额入账/套餐订阅履约在同一 SQLite 事务内完成，并发兑换不得重复发奖或突破上限。卡密不区分大小写（服务端统一大写归一）；接口按用户限流（默认 5 次/分钟），超限返回 429。套餐卡遵守套餐购买限购；已有有效订阅时返回 409 且不核销，可稍后重试。软删除卡仍可兑换。
- `GET /plans/public`：公开套餐市场列表。⭐ 返回公开套餐及其价格、流量、有效期、`trafficResetMode`、节点匹配模式、`purchaseLimitPerUser`（`null` 不限购）、`allowRenewal` 与 `deviceLimit`（`0` 不限）。
- `GET /user/subscription`：查询当前用户唯一订阅、可用线路、套餐购买额度与在线设备策略。⭐ 无订阅时返回 `{ subscription: null, lines: [], nodes: [], planClaims: [], deviceManagement }`；有订阅时返回 `lines[]`、`planClaims[{ planId, used }]` 并保留 `nodes` 兼容镜像。订阅视图包含 `trafficResetMode`、`nextTrafficResetAt` 和 `extraLineIds`；线路为套餐匹配线路与用户额外授权线路的并集。`deviceManagement` 在设备管理服务不可用时为 `null`。
- `GET /user/subscription/devices`：查询当前用户设备策略及在线设备明细。⭐ 返回 `{ onlineDeviceCount, configuredDeviceLimit, effectiveDeviceLimit, deviceLimitSource, configuredDeviceLimitSource, deviceLimitEnabled, devices }`；每台设备按客户端 IP 聚合，含连接数、首次/最近上报时间及节点/线路明细。
- `DELETE /user/subscription/devices?ip=<IP>`：踢下线当前用户指定 IP；省略 `ip` 时踢下线所有当前在线设备。
- `POST /user/subscription/devices/kick-all`：踢下线当前用户全部在线设备。踢设备返回 `{ taskId, requested, notifiedNodes, kickedIps }`，只向当前报告了该用户设备的在线节点发送任务；设备管理服务未注入时返回 400。
- `POST /user/subscription`：订购公开套餐。⭐ 请求 `{ planId }`；已有有效订阅返回 409；达到该套餐每用户限购次数时返回 409；成功后写入购买台账并按套餐价格扣款、写入 `PLAN_BUY` 流水（0 元套餐不产生钱包流水），余额不足返回 400。
- `POST /user/subscription/renew`：续费当前套餐。⭐ 无请求体；`allowRenewal=false` 时返回 409；续费不消耗限购次数，按当前套餐价格扣款，顺延 `durationDays`、重置当期已用流量并写入 `PLAN_RENEW` 流水。
- `POST /user/subscription/upgrade`：即时升配。⭐ 请求 `{ planId }`；目标等于当前套餐、价格更低或达到目标套餐限购次数时返回 409；通过校验后消耗一次限购名额、写购买台账、全价扣款、切换套餐、重置已用流量并按新套餐重算周期，写入 `PLAN_UPGRADE` 流水。
- `POST /user/subscription/cancel`：取消当前订阅。⭐ 状态变为 `CANCELED`，到期前保留使用权。
- `POST /user/subscription/reset-token`：重置当前订阅 Token。⭐ 旧订阅链接立即失效，并同步兼容的 User 镜像字段；无订阅返回 400。

**直连代理池（v0.9.0，完整规约见 §5）**
- `GET /user/proxy-pool/keys`：列出当前账号的全部直连代理凭据。⭐ 响应 `{ keys[], limit }`。
- `POST /user/proxy-pool/keys`：创建直连代理凭据。⭐ 请求 `{ name, whitelistIps? }`；服务端生成 `pk_<24 位十六进制>` 用户名与 24 字节 base64url 密码。
- `PATCH /user/proxy-pool/keys/:id`：更新凭据名称、来源 IP 白名单或启停状态。⭐
- `DELETE /user/proxy-pool/keys/:id`：删除凭据并即时从节点配置中吊销。⭐
- `POST /user/proxy-pool/keys/:id/rotate-password`：轮换凭据密码（旧密码立即失效）。⭐
- `POST /user/proxy-pool/keys/:id/rotate-token`：轮换免登录拉取令牌。⭐
- `GET /user/proxy-pool/nodes?lineIds?`：列出可用的 Mixed 直连代理端点。⭐
- `GET /user/proxy-pool/export?format&protocol&keyId&lineIds&token`：多格式导出与免登录拉取。⭐ 支持 Cookie 登录态或 `?token=<exportToken>` 二选一。

### 1.2.1 帮助中心与使用文档 (`/help`)
- `GET /help/articles?platform&locale`：获取已发布的帮助文档列表。⭐ 支持按平台（`WINDOWS` / `MACOS` / `IOS` / `ANDROID` / `ROUTER` / `FAQ` / `GENERAL`）和语言（`zh-CN` / `en-US`）过滤，正文与摘要自动基于当前登录用户身份和站点配置完成动态变量插值（如 `{{subscription_url}}`、`{{clash_import_url}}`、`{{shadowrocket_import_url}}`、`{{site_name}}` 等）；响应按 `sortOrder` 升序排列。
- `GET /help/articles/:slug?locale`：根据别名查询单篇文档详情。⭐ 返回包含完整变量插值正文的文档对象；未发布或不存在返回 404。

### 1.3 管理员模块 (`/admin`)

#### 用户管理
- `GET /admin/users?page&pageSize&search&role&isActive&subscriptionStatus&planId`：分页查询。⭐ `search` 为 6 位 UID 精确匹配，或昵称/邮箱模糊匹配；支持角色、账号状态、订阅状态（支持 `ACTIVE`、`CANCELED`、`EXPIRED`、`REVOKED` 及 `NONE` 筛选无订阅）与套餐筛选（支持指定套餐 UUID 及 `NONE` 筛选无套餐用户）；响应为统一分页结构，列表项返回 `uid` 与 `nickname`，不含 `passwordHash`/`uuid`/`subscriptionToken`，并聚合返回 `subscription{ id, status, trafficLimitBytes, trafficUsedBytes, startedAt, expireAt, trafficResetMode, nextTrafficResetAt, extraLineIds, plan{id,name} }`；同时含 `onlineDeviceCount`、`configuredDeviceLimit`、`effectiveDeviceLimit`、`deviceLimitSource` 与 `configuredDeviceLimitSource`。
- `POST /admin/users`：创建用户。⭐ 请求 `{ email, password(8~64), role?, planId?(UUID|null), trafficLimitBytes?, expireAt?(ISO|null), deviceLimit?(0..1000|null) }`；`deviceLimit: null` 跟随订阅套餐，`0` 显式不限，正数为用户覆盖；密码需满足系统设置的密码复杂度策略（`passwordMinLength` 与 `passwordRequire*` 开关）；指定 `planId` 时在同一事务内创建唯一订阅，套餐配额与期限由所选套餐决定（可由服务端可选参数覆盖）；明确传 `planId: null` 或留空创建无套餐无订阅用户（配额为 0）；省略 `planId` 时自动绑定“体验套餐”（无该名称时取首个公开套餐）；邮箱冲突 409。
- `PATCH /admin/users/:id`：部分更新。⭐ 请求任意子集 `{ role?, trafficLimitBytes?(>0), expireAt?(ISO|null，null=永久), isActive?, password?(8~64，管理端重置), deviceLimit?(0..1000|null) }`；`deviceLimit: null` 跟随订阅套餐，`0` 显式不限，正数为用户覆盖；管理端设置新密码时同样需满足系统设置的密码复杂度策略（`passwordMinLength` 与 `passwordRequire*` 开关）。
- `GET /admin/users/:id/devices`：管理员查询目标用户设备策略与在线设备明细，响应结构同用户侧设备查询。⭐
- `DELETE /admin/users/:id/devices?ip=<IP>`：管理员踢下线指定 IP；省略 `ip` 时踢下线全部当前在线设备。
- `POST /admin/users/:id/devices/kick-all`：管理员踢下线目标用户全部在线设备。踢设备响应 `{ taskId, requested, notifiedNodes, kickedIps }`，仅投递给当前有该用户在线设备报告的节点。
- `POST /admin/users/:id/reset-subscription-token`：管理员重置用户订阅 Token。⭐ 同步更新订阅实例与兼容的用户镜像字段，旧链接立即失效；目标用户未绑定有效订阅时返回 400。
- `POST /admin/users/:id/adjust-balance`：管理员人工调账。⭐ 请求 `{ amount, description? }`，`amount` 为带符号分值；禁止调账后余额为负，并写入 `ADMIN_ADJUST` 流水。
- `DELETE /admin/users/:id`：删除用户（级联删除流量记录与余额流水）。⭐
- `POST /admin/subscriptions/users/:userId`：管理员为用户分配/绑定套餐。⭐ 请求 `{ planId, status?, trafficLimitBytes?, trafficUsedBytes?, expireAt?, addDays?, extraLineIds? }`；在同一事务内创建唯一订阅并同步 User 镜像字段。
- `PATCH /admin/subscriptions/:id`：管理员更新用户订阅或彻底取消订阅。⭐ 支持调整状态、配额、已用流量、到期时间与额外线路授权；传入 `planId: null` 时彻底取消订阅并删除订阅记录，同一事务内将用户镜像配额与已用流量置 0、到期时间置 null，并清空额外线路授权（`userLineGrant`），向边缘节点下发同步。
- `POST /admin/subscriptions/:id/reset-token`：管理员重置指定订阅的 Token。⭐

用户创建/更新/删除及订阅变更均会触发向全部在线 Agent 推送 `config_sync`（订阅资格变化实时生效）。

#### 流量统计
- `GET /admin/traffic/overview?range=today|24h|7d|30d`：管理员查询全站流量统计。⭐ `range` 省略时默认为 `today`；响应包含 `summary`（总上行、总下行、物理/计费流量、活跃线路/用户）、连续补零的 `timeSeries`、按计费流量降序排列的 `lineRankings`、按物理流量降序排列且最多返回 100 条的 `userRankings`，以及 `rate`/`rateSeries` 节点网络吞吐统计。`userRankings` 每项包含 `userId`、邮箱、角色、账号状态、当前套餐名称、周期上行/下行/物理总量、倍率折算计费量和占全站物理流量百分比；用户计费量按每条流水归属线路的倍率加权。速率统一为 `bytes/s`；`today`/`24h` 的速率按 5 分钟、`7d` 按 30 分钟、`30d` 按 1 小时输出。`rate` 的当前值只汇总在线且未超时节点，历史平均值按指标采样数计算，峰值为各节点桶峰值之和的近似全站峰值；速率不参与计费。
- `GET /admin/traffic/users/:userId?range=today|24h|7d|30d`：管理员查询指定用户的流量画像。⭐ 响应包含当前订阅/配额、选定周期 `summary`、补零时序和线路消耗清单；用户不存在返回 404，`userId` 必须为 UUID。

Agent 心跳写入 `TrafficLog` 时，Master 会优先关联该节点排序最靠前的 ACTIVE 入口线路；没有匹配线路时保留 `lineId=null`。聚合历史流水时会按节点首选 ACTIVE 入口线路回退归组，仍无法归属的数据标记为“未分配线路（节点直连）”。

#### 节点管理
- `GET /admin/nodes`：获取所有节点详情（不返回 AgentToken，包含遥测状态、承载线路摘要与派生端口）。返回字段包含网络可达性 `reachability`（`PUBLIC` | `NAT`）。启动 bootstrap 会自动创建 `isLocal=true` 的 `Master-Local` 系统节点；Docker/发行包默认由 Master 内置 Agent 自动上线。⭐
- `GET /admin/nodes/:id`：获取单个节点详情（含承载线路、入口/出口角色、派生端口、安装命令、Agent/内核版本画像与最近探针快照）。⭐ 响应节点对象包含加性字段 `pendingVersionConfirm`（可选，向后兼容）：升级任务完成但心跳上报的 `agentVersion` 尚未达到目标版本时的待确认信息 `{ taskId, expectedVersion, completedAt }`，用于提示“Agent 重启可能失败”；版本对账窗口为主控侧 15 分钟，确认或超时后字段回到 `null`。同时返回 `singboxLogMode`（`NORMAL`/`INFO`/`DEBUG`，已过期诊断会折算为 `NORMAL`）、`singboxLogModeUntil`、`supportsSingboxLogCapture` 与 `supportsAgentLogRotation`。WS 协议契约本身无变更。安装命令的公开地址优先使用系统设置 `publicBaseUrl`，其次使用 `RIRICLOUD_PUBLIC_URL`，最后使用当前请求的 `X-Forwarded-Proto` + `X-Forwarded-Host`/`Host` 自动匹配。
- `GET /admin/nodes/:id/offline-package?platform=<os-arch>`：管理员下载指定节点的完整 Agent 离线安装包（流式压缩包：Windows `.zip`，Linux/macOS `.tar.gz`）。⭐ 需管理员 JWT 鉴权；内嵌该节点预配置的 `config.yaml`、平台二进制与全自动化免交互安装/卸载脚本。
- `GET /admin/nodes/:id/install-script?platform=<os-arch>&format=bat|sh|ps1`：管理员下载指定节点的预编排免交互安装脚本（Windows 默认为 `.bat`，Linux/macOS 为 `.sh`）。⭐ 需管理员 JWT 鉴权；内嵌固化该节点的 AgentToken 与 MasterUrl，响应附加 `Content-Disposition: attachment` 供浏览器或脚本一键下载。
- `POST /admin/nodes`：创建节点基础信息（生成 AgentToken 与多目标安装命令）。⭐ 请求 `{ name?, serverHost?, reachability?: "PUBLIC"|"NAT", communicationMode?: "WS"|"HTTP" }`；`reachability` 默认为 `PUBLIC`，当为 `NAT` 时 `serverHost` 可选（默认回退为 `127.0.0.1`）；NAT 节点仅可作为中继落地出口节点，禁止作为直连入站或中继入口节点。线路通过 `/admin/lines` 独立管理，创建后响应 `{ node, agentToken, installCommand, installCommands, uninstallCommand, windowsUninstallCommand }`，其中 AgentToken 仅在本次创建响应中返回一次。命令中的下载 URL、HTTP 轮询地址和 WS/WSS 地址使用同一公开地址解析结果。`installCommands` 结构：`{ ws, http, dockerWs, dockerHttp, adminScriptUrl, native: { linux, macos, windows }, portable: { linux, macos, windows }, offline: { packageDownloadUrl, adminPackageUrl, windows, linux } }`（每项均为 `{ ws, http }` 命令对，`adminScriptUrl` 为专属免交互脚本下载路径）：`ws/http` 为兼容保留的 POSIX 原生安装键；`native.windows` 为 Windows CMD 与 PowerShell 跨终端通用的免交互安装命令（拉取并执行预编排自提权 `.bat` 批处理，支持直接双击运行）；`native.linux` / `native.macos` 为预编排免交互 shell 命令（`curl | sudo sh`）；`portable.*` 为免安装直接运行命令；`offline.*` 包含各操作系统终端一键 curl/unzip/install 离线部署命令。`windowsUninstallCommand` 为 Windows 管理员 PowerShell 卸载命令。
- `POST /admin/nodes/:id/rotate-token`：轮换远程节点 AgentToken。⭐ 管理员确认后立即使旧凭证失效、断开在线 Agent 并将节点标记为 `OFFLINE`；响应 `{ nodeId, agentToken, installCommand, installCommands, uninstallCommand, windowsUninstallCommand }`（`installCommands` 结构同创建节点），新 Token 仅在本次响应中返回一次，安装命令通过终端隐藏输入 Token，不在命令或 URL 中内嵌凭证。`isLocal=true` 的 `Master-Local` 返回 `409`，必须通过主控配置重置凭证。
- `PATCH /admin/nodes/:id`：部分更新。⭐ 请求任意子集 `{ name?, serverHost?, reachability?: "PUBLIC"|"NAT", configOverride?(string|null) }`；若节点被现有直连线路或中继入口引用，修改为 `NAT` 将返回 `409`；`configOverride` 为高级模式完整 sing-box 配置顶层覆盖 JSON（须为合法 JSON 对象，传 `null` 清除；合并语义见 `docs/DATA_MODELS.md` §3.2）；保存成功后若节点在线即向其推送 `config_sync`。
- `DELETE /admin/nodes/:id`：删除远程节点。⭐ 先断开该节点在线 Agent（close 4001），再硬删除；承载线路与 `TrafficLog` 级联删除；残留 Agent 重连时按无效 AgentToken 拒绝。`isLocal=true` 的 `Master-Local` 为系统保留节点，删除请求返回 `409`，只能通过禁用内置 Agent 或停止 Master 进程使其离线。
- `POST /admin/nodes/:id/reload`：向指定节点的 Agent 发送热重载指令。⭐
- `POST /admin/nodes/:id/log-diagnostics`：仅允许在线且能力包含 `singbox_log_capture` 的节点开启临时 Sing-box 诊断。⭐ 请求 `{ level: "INFO"|"DEBUG" }`，固定持续 30 分钟；开启会清理配置缓存并重启 Sing-box，响应 `{ nodeId, enabled: true, level, expiresAt, requested }`。诊断日志可能包含敏感连接信息，服务端仍执行脱敏。
- `DELETE /admin/nodes/:id/log-diagnostics`：停止指定节点诊断并恢复 `NORMAL`；清理配置缓存并触发 WS `config_sync` 或等待 HTTP 下一次 poll，响应 `{ nodeId, enabled: false, level: "NORMAL", expiresAt: null, requested }`。
- `POST /admin/nodes/:id/upgrade`：下发 Sing-box 或 Agent 远程升级任务。⭐ 请求 `{ target: "singbox"|"agent", version?, url?, sha256? }`；省略 `url/sha256` 时由 Master 按节点 `osArch` 自动选择内置版本并生成带 AgentToken 的内部下载地址，二者必须同时提供才能使用自定义来源。Agent 下载后校验 SHA-256，返回 `{ taskId, requested }`。
- `POST /admin/nodes/:id/probe`：下发网络探针任务。⭐ 请求 `{ probes: [{ type: "tcp"|"dns"|"icmp", target, port?, timeoutMs? }] }`，最多 8 项；返回 `{ taskId, requested }`。回执会持久化到节点 `lastProbeResult`。
- `POST /admin/nodes/:id/restart-agent`：请求 Agent 自身平滑重启。⭐ 返回 `{ taskId, requested }`，Agent 在回执后使用原始命令行参数重新启动。
- `GET /admin/nodes/:id/tasks`：分页查询该节点的升级分发任务（`page`/`pageSize`/`status`），行内含资源版本摘要与 `previousAssetId`；配合任务重试/回滚接口使用。⭐ 自定义 URL 升级（`POST /admin/nodes/:id/upgrade` 传 `url`+`sha256`）同样落库为任务行（`assetId`/`releaseId` 为空，版本摘要回退任务 payload 中的 `version`），获得部署历史、重试与回滚能力。
- `GET /admin/nodes/:id/tasks/:taskId`：查询探针/升级任务状态。⭐ 返回 `{ taskId, status: "PENDING"|"QUEUED"|"COMPLETED", success?, message? }`；任务结果由 Master 进程内短期保存，不引入外部队列。持久化的升级分发任务另见 §2.4 的重试 `POST /admin/nodes/:id/tasks/:taskId/retry`（FAILED/COMPLETED 可重试）与回滚 `POST /admin/nodes/:id/tasks/:taskId/rollback`（存在 `previousAssetId` 时按上一版本资源重新下发，`operation=ROLLBACK`）。
- `POST /admin/nodes/reality-keypair`：生成 X25519 Reality密钥对（32 字节裸密钥 base64url，等价 `sing-box generate reality-keypair`；不落库，供线路向导「生成密钥对」按钮使用）。⭐ 响应 `{ privateKey, publicKey }`。

#### 二进制分发中心
- `GET /downloads/agent`：公开返回 Agent 二进制流。⭐ 安装器通过 `User-Agent: riri-agent-installer/<os>-<arch>` 声明目标平台，并通过 `X-Agent-Token: <AGENT_TOKEN>` 鉴权；缺省目标为 `linux-amd64`。该端点无需 JWT，但必须提供 Header 凭据，不接受 query token；响应设置 `Cache-Control: no-store` 与 `Referrer-Policy: no-referrer`。
- `GET /downloads/agent-installer`：公开返回按平台渲染的 Agent 安装脚本。⭐ 支持通过 `User-Agent: riri-agent-installer/<os>-<arch>` 或查询参数 `?format=bat|sh|ps1` 声明目标平台；鉴权支持 `X-Agent-Token` 请求头或 `?token=<AGENT_TOKEN>` 查询参数；传 `?token=` 时直接生成内嵌固定 Token 与 MasterUrl 的预编排免交互安装脚本；支持 `?download=1` 附加 `Content-Disposition: attachment` 下载头。Windows 默认返回带管理员自提权检测与内嵌 PowerShell 引擎的自包含 `.bat` 批处理脚本（CRLF 换行，兼容 CMD 与 PowerShell，支持直接双击执行，亦可通过 `format=ps1` 返回纯 PowerShell 脚本），POSIX 平台返回 POSIX sh 脚本（`text/x-shellscript`），响应 `Cache-Control: no-store`。脚本内嵌：Agent 版本（主控捆绑 `AGENT_VERSION`）、目标系统架构（`RIRI_TARGET_ARCH`）、GitHub 仓库与加速镜像列表（系统设置 `githubRepoUrl`/`githubMirrorUrls`）、主控兜底下载地址与预期 SHA-256。脚本采用标准化 4 阶段执行模型：**[1/4] 环境检查**（Windows 智能唤起 UAC 提权窗口或在非交互环境友好阻断，Linux/macOS 自动通过 sudo 提权重新调用；校验系统与包目标架构一致性；检查基础工具）、**[2/4] 镜像测速与下载**（GitHub Release 直连/镜像 Range GET 测速择优，`curl --progress-bar` 可视化进度下载，全部失败回退主控内置二进制）、**[3/4] 二进制校验与部署**（`checksums.txt` / 主控嵌入 SHA-256 校验，热重装前平滑停止既有运行服务避免 Windows 进程文件锁冲突）、**[4/4] 服务注册与健康检查**（执行 `riri-agent install` 注册系统服务，等待 2~3 秒拉取服务运行状态，终端回显包含状态、配置路径、日志路径与 status/doctor/logs/restart 快捷命令的运维就绪卡片）。镜像经 `GITHUB_MIRRORS` 环境变量传递给 `riri-agent install`（旧版 Agent 二进制自动忽略）。
- `GET /downloads/agent-offline-package?platform=<os-arch>`：公开返回按目标节点预配的完整 Agent 离线安装包流（Windows 为 .zip，Linux/macOS 为 .tar.gz）。⭐ 仅接受 `X-Agent-Token: <AGENT_TOKEN>` 鉴权；服务端按 Token 匹配有效节点，自动打包内嵌 `config.yaml`（预置主控地址、通信模式与凭据）、适配目标架构的 Agent 与 Sing-box 二进制（缺失时服务端自动从 GitHub/加速镜像抓取并解压打包缓存）、以及零交互自动化安装/卸载脚本（Windows `install.bat` + `install.ps1`，Linux/macOS `install.sh` + `uninstall.sh`），实现目标机器零外网依赖的一键部署。
- `GET /admin/binaries/info`：管理员查询主控版本及各 OS/架构内置 Agent、Sing-box 二进制的版本、大小、SHA-256 和可用状态。⭐
- `POST /admin/binaries/import`：管理员把自定义 Sing-box URL 下载到主控托管目录。⭐ 请求 `{ target: "singbox-linux-amd64"|"singbox-linux-arm64"|"singbox-macos-amd64"|"singbox-macos-arm64"|"singbox-windows-amd64", version, url, sha256 }`；服务端限制 100 MiB，并在落盘前完成 SHA-256 校验。
- `GET /downloads/binaries/:target`：Agent 内部下载端点。⭐ 仅接受 `X-Agent-Token: <AGENT_TOKEN>` 且节点有效、未禁用的请求，响应为二进制流；禁止匿名访问，不接受 query token。

#### 节点线路承载视图
节点不再提供独立的 Inbound CRUD。节点详情只读返回当前作为线路入口/落地的角色、线路协议和派生监听端口（DIRECT/TRANSIT/LANDING）；新建或修改协议、参数、拓扑与端口统一通过线路 API 完成。

#### 线路管理
- `GET /admin/lines?page&pageSize&search&type&status&tag`：分页查询线路，可按名称/地址、类型、启停状态和标签筛选；响应包含 `tag`、`listen`、`protocolType`、脱敏后的 `params`、`certificateId`/`certificate` 简要关联、`targetLineId`/`targetLine` 目标摘要、`topology`（入口/落地节点与端口）、最终生效的 `serverHost/serverPort`、原始 `endpointOverrides` 以及测速快照（`lastLatencyMs`、`lastTestedAt`、`lastTestStatus`、`lastTestMessage`）。旧客户端仍可读取只读 `targetInbound` 摘要。⭐
- `GET /admin/lines/:id`：查询线路详情及入口/落地节点关联、协议参数、证书简要信息、端点解析结果与最新测速快照。⭐
- `POST /admin/lines`：创建线路。⭐ 请求 `{ name, tag?, listen?, type?, protocolType?, params?, relayMode?, targetLineId?, entryNodeId?, entryPort?, landingNodeId?, landingPort?, allowLanAccess?, certificateId?(UUID|null), endpointOverrideEnabled?, serverHost?, serverPort?, serverName?, host?, trafficRate?, tags?, level?, sortOrder?, isPublic?, status?, speedLimitMbps?, tcpFastOpen?, tcpMultiPath?, udpFragment?, udpTimeout?, proxyProtocol?, proxyProtocolAcceptNoHeader? }`；`proxyProtocol` 为布尔类型（开启时自动兼容解析 v1 与 v2 协议头），`proxyProtocolAcceptNoHeader` 控制是否允许无 PROXY 头的连接；`speedLimitMbps` 控制单端口限速；`certificateId` 只能用于标准 TLS，关联后无需在 `params.tls` 中填写本地证书/私钥路径，Master 会在配置同步时注入最新 PEM。`params` 按 `docs/DATA_MODELS.md` §3.1 归一化并在响应中脱敏，TLS `alpn` 使用字符串数组，可按协议/传输层从预设值多选。直连线路仅需指定入口节点与端口，落地字段保持为 null；普通中继线路必须指定入口、落地和机制，`TARGET_LINE` 必须指定其他节点上的 `DIRECT` 目标线路，落地节点与端口动态由目标线路解析。入口节点 `entryNodeId` 必须为公网可达节点（`reachability=PUBLIC`）；落地节点支持公网节点或 NAT 节点（`reachability=NAT`）。当落地为 NAT 节点时，系统自动编排反向 Yamux 多路复用隧道（`tunnelType=YAMUX`），复用或自动分配隧道端口（`tunnelPort`）与高熵密钥（`tunnelSecret`）；`allowLanAccess` 控制落地端是否放行家庭/私网局域网资源访问（布尔值，默认 `false` 严格拦截私网网段）。目标协议仅支持 `VLESS`、`VMESS`、`TROJAN`、`HYSTERIA2`、`TUIC`、`SHADOWSOCKS`、`NAIVE`。端口省略时由服务端在 `20000~65535` 范围随机分配五位端口。同节点同 TCP/UDP 传输层端口冲突返回 `409`，自定义 Tag 冲突返回 `409`，HYSTERIA2/TUIC 按 UDP 计算。
- `PATCH /admin/lines/:id`：部分更新线路，字段同创建请求。⭐ 保存后触发全量 Agent 配置推送防抖。
- `DELETE /admin/lines/:id`：删除线路。⭐ 被 `TARGET_LINE` 中继引用的线路会返回 `400`，必须先解除引用。
- `POST /admin/lines/:id/duplicate`（兼容别名 `/copy`）：复制线路，副本默认禁用；若端口冲突则为副本分配新的可用五位端口。⭐
- `POST /admin/lines/:id/test`：解析并返回最终对外端点、入口/落地节点与端口，不建立真实连接。⭐
- `POST /admin/lines/:id/speedtest`：对单条线路执行即时端到端测速（要求全链路 100% 跑通并经 Sing-box 代理收到目标 HTTP 204/200 响应才判定为测速成功；若任一阶段失败或超时，整体状态记为 `ERROR` 或 `TIMEOUT` 且延迟置为 `null`，不进行 TCP 握手降级误报；使用内部专用探针凭据且不计入账单），响应 `{ lineId, lineName, latencyMs, status, message, testedAt, mode, topology, stages }`，并持久化到 Line 最新快照；其中 `stages` 包含多阶段耗时与状态（`master_ready` 主控探针准备、`entry_handshake` 入口网络握手、`relay_transit` 中继转发准备、`target_http` 目标端到端 HTTP 204/200 探测），支持在管理前端以弹窗展示完整的链路测试流程与异常诊断。⭐
- `POST /admin/lines/speedtest-all`：受控并发（限制并发度 4）批量测试所有已启用的线路，响应 `{ total, success, failed }`。⭐
- `POST /admin/lines/batch-status`：批量启用/禁用线路。⭐ 请求 `{ ids: UUID[], status: "ACTIVE"|"DISABLED" }`。
- `PATCH /admin/lines/reorder`：批量调整排序。⭐ 请求 `{ items: [{ id, sortOrder }] }`。

#### 证书管理
- `GET /admin/certificates?page&pageSize&search`：分页查询证书，支持按名称、主题、签发者和 SAN 搜索；响应为 `{ data, total, page, pageSize }`，返回 SAN、签发者、有效期、状态（`VALID`/`EXPIRING`/`EXPIRED`/`NOT_YET_VALID`）和关联线路数，不返回 PEM 私钥。⭐
- `GET /admin/certificates/:id`：查询证书详情，除列表字段外返回 `certificatePem` 与 `privateKeyPem` 明文，必须由管理员鉴权。⭐
- `POST /admin/certificates/parse`：前端预解析 PEM 证书。请求 `{ certificatePem, privateKeyPem? }`；使用 Node.js 原生 `crypto.X509Certificate` 提取 subject、issuer、serialNumber、SAN、有效期，并在提供私钥时校验公私钥匹配。⭐
- `POST /admin/certificates`：创建证书。请求 `{ name, certificatePem, privateKeyPem }`；仅接受包含 SAN 的 X.509 叶子证书和未加密 PEM 私钥，证书与私钥不匹配返回 `400`。⭐
- `PATCH /admin/certificates/:id`：更新证书名称或 PEM 内容；省略 `privateKeyPem` 时保留现有私钥。保存后自动查找关联线路的入口/落地节点并推送 `config_sync`，响应附带 `affectedNodeIds` 与 `syncedNodeIds`。⭐
- `DELETE /admin/certificates/:id`：删除未被线路引用的证书；仍有关联线路时返回 `409`。⭐

#### 系统设置
- `GET /admin/settings`：读取全量设置。⭐ 响应包含 `docs/DATA_MODELS.md` §SystemSetting 列出的全部强类型字段（含 SMTP、邮箱验证、CAPTCHA、统一时区 `systemTimezone`、速率色彩阶梯 `speedLimitColorTiers` 与单位换算 `speedLimitUnitConversionEnabled`、存储日志策略、结构化公告列表 `siteAnnouncementsJson`、首页配置 `landingEnabled` / `landingHero*` / `landingShow*` / `landingCustom*Json`、多设备限制 `deviceLimitEnabled`（默认 `true`）与在线活跃窗口 `deviceOnlineWindowSecs`（默认 60 秒）等）；`smtpPass` 与 `turnstileSecretKey` 有值时均返回 `********`。存储日志策略包括 `trafficHourlyRetentionDays`（默认 90）、`nodeRateRetentionDays`（默认 30）、`logsRetentionDays`（默认 7）、`logsMaxCount`（默认 100000）、`logsMinIngestLevel`（默认 `INFO`）、`agentLogMaxSizeMb`（默认 50）和 `agentLogMaxFiles`（默认 5）。
- `GET /system/public-info`：公开系统设置端点（无需鉴权）。⭐ 返回前端公共消费字段（站点品牌、Logo、公告 `siteAnnouncement` 与结构化公告列表 `siteAnnouncementsJson`、客服、注册开关、密码复杂度策略、公共订阅与基准地址、短链接开关、时区、首页配置 `landingEnabled` / `landingHeroBadge` / `landingHeroTitle` / `landingHeroSubtitle` / `landingShowFeatures` / `landingShowPlans` / `landingShowFaq` / `landingCustomFeaturesJson` / `landingCustomFaqJson` 等）。
- `PUT /admin/settings`：部分更新。⭐ 请求任意子集，服务端校验范围、URL、邮箱、UUID、数组、速率阶梯色阶对象、探针对象、IANA 时区合法性以及 `deviceOnlineWindowSecs`（15~600 秒）；`deviceLimitEnabled` 控制自动上限执行，关闭时仍允许手动踢设备。敏感字段提交 `********` 表示保留当前密钥，响应返回更新后全量脱敏设置。保存 `siteAnnouncementsJson` 时自动保持向下兼容的 `siteAnnouncement` 字段同步。
- `POST /admin/settings/reset`：恢复默认设置。⭐ 请求 `{ keys?: string[] }`；省略 `keys` 时删除全部设置覆盖值，传入指定键时仅重置对应设置。
- `POST /admin/settings/smtp/test`：管理员测试 SMTP。⭐ 请求 `{ email }`；服务端先验证 SMTP 连接，再向目标邮箱发送测试邮件，成功响应 `{ success: true, messageId?, durationMs? }`，失败返回 400。

#### 卡密管理
- `GET /admin/redeem-codes/categories`：查询卡密分类及奖励、标签、购买身份累计上限、启用状态和卡片数量。默认上限为 1，`limitPerIdentity: null` 表示不限；标签不参与额度计算。
- `POST /admin/redeem-codes/categories`、`PATCH /admin/redeem-codes/categories/:id`：创建/编辑余额或套餐奖励分类；可设置标签、正整数额度或不限以及归档状态。归档分类禁止新生成，但不会影响已生成卡密的快照奖励与兑换。
- `GET /admin/redeem-codes?page&pageSize&search&status&categoryId&deletedOnly`：分页查询，支持四态筛选、卡密模糊搜索、分类筛选和已删除视图（`deletedOnly=true`）；默认排除软删除记录。列表项附带兑换人及分类信息。
- `GET /admin/redeem-codes/stats?categoryId&deletedOnly`：按分类/删除视图汇总；响应 `{ total, totalAmount, byStatus }`，状态四态互斥，过期态为读取时派生。
- `GET /admin/redeem-codes/export?format=csv|txt&status&search&categoryId&deletedOnly`：按对应筛选条件导出，默认排除软删除记录，单次最多 10000 条；CSV 为审计字段，TXT 为卡密行。
- `POST /admin/redeem-codes/batch`：批量生成高强度卡密，请求 `{ count, categoryId?, amount?, prefix?, expiresAt?, note? }`。新管理端必须选分类，卡密保存该时点余额或完整套餐权益快照；旧接口可不传分类并使用不限额历史分类，`amount` 为兼容旧调用的分单位金额。生成写入采用单事务 `createMany`。
- `POST /admin/redeem-codes/batch-revoke`：批量作废未使用卡密。请求 `{ ids[] }`（最多 500 个 UUID）；仅 `UNUSED` 状态会被作废，响应 `{ requested, revoked, skipped }`。
- `POST /admin/redeem-codes/batch-delete` 与 `DELETE /admin/redeem-codes/:id`：软删除/隐藏卡密，不改变卡密状态和兑换能力；批量请求 `{ ids[] }`，响应包含 requested/deleted/skipped。
- `POST /admin/redeem-codes/:id/restore`：恢复已软删除卡密到默认视图，不改变核销状态。
- `POST /admin/redeem-codes/cleanup`：软删除超过保留期（默认 30 天）的过期且未使用卡密，不做物理删除；响应 `{ deleted, retentionDays }`。
- `POST /admin/redeem-codes/:id/revoke`：作废未使用卡密。已兑换或已作废卡密返回 409。
- **审计与限流**：分类管理、批量生成、作废、软删除/恢复与清理均写系统日志（`module=REDEEM_CODE`，含操作者与必要 ID/计数，不含卡密明文）；用户兑换按用户限流（默认 5 次/分钟）。

#### 直连代理池管理（v0.9.0，完整规约见 §5）
- `GET /admin/proxy-pool/overview`：直连代理池总览。⭐ 响应 `{ totalKeys, activeKeys, disabledKeys, trafficUsedBytes, endpointCount, endpoints[] }`。
- `GET /admin/proxy-pool/keys?page&pageSize&search&userId&isActive&sortBy`：分页检索全部用户的直连代理凭据。⭐ 列表项附带 `user{ id, email, uid, isActive }`。
- `POST /admin/proxy-pool/keys/:id/active`：管理员启用/停用指定凭据。⭐ 请求 `{ isActive }`；变更后立即重下发在线节点配置。
- `DELETE /admin/proxy-pool/keys/:id`：强制删除指定凭据。⭐

#### 套餐管理
- `GET /admin/plans?page&pageSize&search&isPublic`：分页查询套餐。⭐
- `GET /admin/plans/:id`：查询套餐详情。⭐
- `GET /admin/plans/:id/nodes`：兼容路径，按套餐规则计算当前可用线路。⭐
- `GET /admin/plans/:id/lines`：按套餐规则计算当前可用公开线路。控制平面与数据平面解耦：订阅与套餐线路下发以线路自身的启用状态（status=ACTIVE）及中继目标状态为基准，不与节点 Agent 的心跳在线状态强绑定；线路实际可用性交由客户端本地测速（url-test/fallback）自适应决策。⭐
- `POST /admin/plans`：创建套餐。⭐ 请求 `{ name, description?, price?, durationDays, trafficLimitBytes, trafficResetMode?: "NONE"|"CALENDAR_MONTH"|"SUBSCRIPTION_CYCLE", lineMatchMode?, lineTags?, lineIds?, templateId?, isPublic?, sortOrder?, purchaseLimitPerUser?, allowRenewal?, deviceLimit?(0..1000，0=不限) }`；API 的 `price` 使用元且最多两位小数，服务端按分存储。`price=0` 且未显式配置时，默认每人限购 1 次且不可续费；付费套餐默认不限购且允许续费。
- `PATCH /admin/plans/:id`：部分更新套餐，`price` 使用元输入并转换为分保存，支持 `trafficResetMode`、`purchaseLimitPerUser`、`allowRenewal` 与 `deviceLimit`（0~1000，0=不限）。⭐ 改价为 0 且未显式覆盖时自动采用免费安全默认，改价为正数时恢复不限购且允许续费。
- `DELETE /admin/plans/:id`：删除未被订阅或购买台账使用的套餐；已有订阅或购买记录时应改为 `isPublic=false` 下架。⭐

#### 订阅模板管理
- 主控 JSON 与 URL-encoded 请求体上限为 `2 MiB`；超出上限在进入 Controller 前返回 HTTP `413 Payload Too Large`。订阅模板的策略组、规则集、DNS 与 YAML/JSON 覆写会合并在同一请求中，编辑大文本时应控制在该上限内。
- **DNS 配置契约与多服务器构建**：`dnsConfig` 采用语义化结构 `{ enable?, fakeIp?, ipv6?, directDns?: string[], proxyDns?: string[] }`。在 Clash Meta 构建中映射为 nameserver、fallback 与 fallback-filter；在 Sing-box 1.12+ 构建中对齐官方最新规范，通过智能协议识别将所有地址解析为强类型服务器（支持 UDP、DoH、DoT、DoQ、H3、local 并提取端口与 path），首位默认解析器为 `dns_direct`，Fake-IP 采用新型 `{ type: "fakeip", tag: "dns_fakeip", inet4_range, inet6_range }` 结构，并在 `route` 顶层配置中注入 `default_domain_resolver: "dns_direct"`，彻底杜绝备用 DNS 丢弃与内核兼容报错。
- **客户端顶层覆写**：`customInjectYaml` 与 `customInjectJson` 在服务端经 YAML/JSON 严格对象语法校验；在客户端订阅编译时分别与生成的 Clash YAML 及 Sing-box JSON 执行顶层深度合并 (deepMerge)。
- `GET /admin/subscription-templates`：查询模板列表及被套餐引用数量，包含 `isDefault` / `isBuiltin` 标记。⭐
- `GET /admin/subscription-templates/default`：查询全局默认模板。⭐
- `GET /admin/subscription-templates/:id`：查询模板详情。⭐
- `POST /admin/subscription-templates`：创建模板。⭐ 请求含 `proxyGroups?`（支持 `all` 动态节点展开、`DIRECT`/`REJECT` 与策略组引用）、`ruleSets?`、`dnsConfig?`、`customInjectYaml?`、`customInjectJson?`、`isDefault?`。
- `PATCH /admin/subscription-templates/:id`：部分更新模板；YAML/JSON 覆写在服务端校验语法。⭐
- `POST /admin/subscription-templates/preview`：渲染模板草稿。⭐ 请求 `{ format: "clash"|"singbox", template: { proxyGroups?, ruleSets?, dnsConfig?, customInjectYaml?, customInjectJson? } }`；优先使用当前可用线路，无可用线路时回退内置多协议 Mock 节点池。服务端会同时并发执行 Sing-box 与 Mihomo (Clash Meta) 双内核真实验证诊断，响应包含 `content`、`stats{totalNodes,matchedNodes,proxyGroupsCount,rulesCount}`、`warnings[]`、`singboxCheck{ executed, passed, message?, kernelVersion? }` 以及 `mihomoCheck{ executed, passed, message?, kernelVersion? }`。⭐
- `POST /admin/subscription-templates/:id/duplicate`：复制模板并命名为 `${name} (副本)`；副本重置 `isDefault=false` 与 `isBuiltin=false`。⭐
- `DELETE /admin/subscription-templates/:id`：删除非默认、非内嵌且未被套餐使用的模板；内嵌默认模板只能通过 `PATCH` 修改，删除返回 `409`。⭐

#### 订阅管控
- `GET /admin/subscriptions?page&pageSize&search&status&planId`：分页查询订阅。⭐ 保留为兼容接口；管理端主入口已融合至 `/admin/users`。
- `GET /admin/subscriptions/:id`：查询订阅详情。⭐
- `POST /admin/subscriptions/users/:userId`：为尚无订阅的用户绑定套餐。⭐ 请求字段同管理员订阅调整接口，必须提供 `planId`；已有订阅时按更新语义处理。管理员发放可突破用户限购上限，但每次变更套餐仍写入 `ADMIN` 来源购买台账。支持 `extraLineIds?: UUID[]` 全量设置用户额外线路授权，空数组表示清空。
- `PATCH /admin/subscriptions/:id`：管理员全量调整订阅。⭐ 支持 `planId`、`status`、`trafficLimitBytes`、`trafficUsedBytes`、`expireAt`、`addDays`、`extraLineIds`；变更套餐时管理员可破例但必须记录 `ADMIN` 购买台账；传 `planId: null` 会删除订阅实例，购买台账保留，用户回到无套餐状态并使旧订阅 Token 失效，但不会删除用户额外线路授权。
- `POST /admin/subscriptions/:id/reset-token`：重置指定用户订阅 Token。⭐

#### 帮助中心与文档管理 (`/admin/help/articles`)
- `GET /admin/help/articles?search&platform&locale&isPublished`：管理员获取全量帮助文档列表（包含未发布草稿）。⭐ 支持按标题/别名关键词模糊搜索、平台、语言和发布状态筛选；响应按 `sortOrder` 升序及 `createdAt` 降序返回。
- `GET /admin/help/articles/:id`：管理员获取单篇文档详情。⭐ 返回未经变量插值的原始 Markdown 内容，便于后台在线编辑。
- `POST /admin/help/articles`：创建帮助文档。⭐ 请求 `{ slug, title, platform, clientName?, icon?, summary?, content, sortOrder?, isPublished?, locale? }`；`slug` 全局唯一，冲突返回 409。
- `PATCH /admin/help/articles/:id`：修改帮助文档。⭐ 请求更新字段子集；若修改 `slug` 发生冲突返回 409。
- `DELETE /admin/help/articles/:id`：删除帮助文档。⭐
- `POST /admin/help/articles/reset-defaults`：一键重置为官方预置文档。⭐ 请求 `{ overwriteExisting?: boolean }`；默认仅增补缺失文档，`overwriteExisting=true` 时将官方预置文档的标题、正文、排序和平台全量覆盖恢复。

#### 系统日志管理 (`/logs`)
- `GET /logs?page&pageSize&level&source&nodeId&traceId&keyword&startTime&endTime`：管理员分页多维查询系统日志。⭐ 支持日志级别（DEBUG/INFO/WARN/ERROR）、来源端（SERVER/WEB/AGENT/SINGBOX）、关联 VPS 节点 UUID、全链路 TraceId 与关键词全文模糊检索；返回统一分页结构 `{ items: SystemLog[], total, page, pageSize, totalPages }`。服务端拦截器对常规的日志自查读取请求（状态码 `< 400`）静默放行，避免产生自循环 HTTP 访问日志。
- `GET /logs/metrics?hours=24`：管理员获取过去指定小时内日志大盘指标与趋势统计。⭐ 响应包含 `totalLogs`、`errorCount24h`、`warnCount24h`、`avgLatencyMs` 以及按小时聚合的分级时序柱状图数据 `trend`。
- `POST /logs/stream-ticket` 与 `GET /logs/stream-ticket`：管理员创建一次性、60 秒有效的 SSE 实时推流票据（双通道兼容）。⭐
- `GET /logs/stream?ticket=<ONE_TIME_TICKET>&level&source&nodeId&keyword`：SSE (Server-Sent Events) 实时推流通道（Live Tail）。⭐ 票据只允许消费一次且不得替代长期 JWT；支持动态按级别、来源端、节点和关键词实时推流最新日志事件。
- `POST /logs/frontend`：前端批量上报异常与关键操作日志。⭐ 无需管理员鉴权（`@Public()`）；请求 `{ logs: [{ level, module, message, traceId?, metadata? }] }`；服务端自动补齐 Client IP、User Agent 与当前登录用户 ID，深度脱敏后缓冲入库并广播至 SSE 监听端。
- `POST /admin/telemetry/cleanup/preview`：管理员预览历史观测数据清理。⭐ 请求 `{ targets: [{ kind: "trafficHourly"|"nodeRate"|"systemLog"|"legacyTraffic", mode: "retention"|"before"|"range"|"count"|"all", before?, from?, to?, keepLatest? }] }`；每类返回匹配数、估算字节、最早/最新时间、实际条件和当前策略，不执行删除。
- `POST /admin/telemetry/cleanup`：管理员执行历史观测数据清理。⭐ 必须提交固定确认短语 `{ confirmationPhrase: "CLEAR_HISTORY" }`，服务端按目标逐表执行并返回 `SUCCEEDED`、`PARTIAL` 或 `FAILED` 及每类匹配/删除数、耗时和错误；执行完毕后自动执行 WAL 截断与 `VACUUM` 物理收缩磁盘空间并返回 `vacuum` 释放详情；完成后追加不可被本次清空删除的 `TelemetryCleanup` 审计日志。清理只触及四类观测数据，不修改额度、订阅用量、流量游标、节点实时状态或计费数据。
- `GET /admin/telemetry/cleanup/database-stats`：管理员获取 SQLite 数据库物理文件尺寸。⭐ 返回主业务库（`riri.db`）与观测库（`telemetry.db`）的主文件、WAL 与 SHM 尺寸及合计占用 `{ databases: [{ target, path, size, walSize, shmSize, totalSize }], totalBytes }`。
- `POST /admin/telemetry/cleanup/vacuum`：管理员手动触发数据库碎片整理与空间收缩（VACUUM）。⭐ 可选指定 `{ targets?: ("main"|"telemetry")[] }`（默认全量）；依次执行 `PRAGMA wal_checkpoint(TRUNCATE)` 与 `VACUUM`，向操作系统归还物理磁盘空间；返回 `{ results: [{ target, path, bytesBefore, bytesAfter, reclaimedBytes }], totalReclaimedBytes, completedAt }`。
- `DELETE /logs?retentionDays&maxRecords`：旧版系统日志清理兼容接口。⭐ 新管理端统一使用上述遥测清理接口；后台每小时根据 `logsRetentionDays` 与 `logsMaxCount` 清理系统日志，手动清空使用 `mode=all`，不再用 `retentionDays=0` 表示清空。
- `GET /logs/export?format=json|csv&level&source&nodeId&traceId&keyword&startTime&endTime`：管理员按当前过滤条件导出日志文件。⭐ 单次最多导出 5000 条，支持导出为 JSON 或 CSV 文件。

#### HTTP 请求日志智能降噪与采集门槛
1. **高频探针与轮询降噪**：`HttpLoggingInterceptor` 对状态码 `< 400` 的常规成功请求静默跳过，不写入 `SystemLog`，包含：
   - 存活探针：`/health`、`/ping`、`/api/v1/health`、`/api/v1/ping`
   - Agent 轮询：`/api/v1/agent/poll`、`/agent/poll`
   - 客户端订阅拉取：`/sub/*`、`/api/v1/sub/*`
   - 线路测速探针：`/api/v1/admin/lines/speedtest*`、`/api/v1/lines/speedtest*`
   - 静态忽略端点：`/api/v1/logs/stream`、`/api/v1/logs/frontend`、`/api/docs`
   - 任何端点在状态码 `>= 400`（如 401 未鉴权、404 凭据失效、500 内部异常）时 100% 完整捕获入库供排查。
2. **动态采集门槛（`logsMinIngestLevel`）**：支持在系统设置中配置最低采集级别（`DEBUG` / `INFO` / `WARN` / `ERROR`，默认 `INFO`），低于门槛的日志在入口即被抛弃，避免不必要的 SQLite I/O 与内存开销。
3. **流量时序小时桶聚合与自动淘汰**：
   - Agent 心跳上报的秒级流量数据在网关内存中经 `TrafficHourlyMetricBuffer` 聚合为小时时序桶（`TrafficHourlyMetric`），每 10~15 秒微批 Upsert 入库，彻底消除秒级 raw `TrafficLog` 插入；
   - 核心计费与限额熔断保持 0 延迟实时生效（在心跳主事务中原子更新 `User`/`Subscription` 并实时吊销超额凭据）；
   - `TrafficCleanupService` 后台定时自动清理超期 90 天的小时桶时序记录与超期 7 天的旧 TrafficLog 记录。

### 1.4 系统模块 (`/system`)
- `GET /system/version`：返回主控版本、Agent 独立版本与推荐镜像（`{ version, agentVersion, agentImage }`，见 `docs/VERSIONING.md` §3）。⭐
- `GET /system/public-info`：站点公开信息。⭐ 响应 `{ siteName, siteDescription, logoUrl, faviconUrl, siteAnnouncement, siteAnnouncementsJson, footerCopyright, supportTelegramUrl, supportDiscordUrl, supportEmail, supportCustomUrl, registrationEnabled, passwordMinLength, passwordRequireLowercase, passwordRequireUppercase, passwordRequireDigit, passwordRequireSpecial, publicBaseUrl, subscriptionBaseUrl, subscriptionShortLinksEnabled, systemTimezone, customCss, customHeadHtml, emailVerificationEnabled, enforceEmailVerification, captchaMode, turnstileSiteKey }`；不包含 SMTP 凭据、Turnstile Secret、套餐、JWT、Agent、二进制和探针运维私密参数。`passwordMinLength` 与 `passwordRequire*` 构成公开的密码复杂度策略，供注册/改密等表单前端动态校验与占位提示。`customHeadHtml` 是管理员可信边界配置，可能读取当前面板 JWT；默认 CSP 禁止任意 inline script，管理员只应配置已审计资源。

### 1.5 邮箱验证码与人机验证
- `GET /captcha/local`：生成本地 SVG 图形/算术验证码。⭐ 响应 `{ svg, captchaToken, expiresAt }`；答案、令牌和绑定 IP 仅以 HMAC 保存于 SQLite，`captchaToken` 为不可解码的随机一次性凭据，默认 5 分钟过期，最多 5 次失败并绑定生成时客户端 IP。
- `POST /verification/send-code`：发送邮箱验证码。⭐ 请求 `{ email, action: "REGISTER"|"CHANGE_EMAIL"|"VERIFY_CURRENT_EMAIL"|"RESET_PASSWORD", captchaToken?, captchaAnswer?, turnstileToken? }`；
  - `REGISTER`：需要启用注册邮箱验证；若 CAPTCHA 模式非 `OFF` 须先通过人机验证，再以通用响应隐藏邮箱是否已占用；
  - `CHANGE_EMAIL`：需要用户登录且新邮箱未被其他账号占用；
  - `VERIFY_CURRENT_EMAIL`：需要用户登录且提交的邮箱与当前账号邮箱一致；
  - `RESET_PASSWORD`：未知邮箱也返回相同通用响应，若 CAPTCHA 模式非 `OFF` 须先通过人机验证；
  - 相同邮箱和行为 60 秒内不可重复发送，验证码有效期 5 分钟，错误尝试最多 5 次；验证码只保存带 JWT 密钥域隔离的 HMAC，不写入明文日志或响应。成功响应 `{ sent: true, cooldownSeconds: 60, message }`。

订阅调试：`GET /api/v1/sub/:token?templateId=<UUID>` 可临时指定模板进行渲染，显式 `templateId` 仅用于调试并优先于套餐模板；省略时按套餐模板、系统设置 `defaultTemplateId`、`isDefault=true` 模板的顺序回退。订阅、二进制和含凭据的响应统一设置 `Cache-Control: no-store`、`Pragma: no-cache` 与 `Referrer-Policy: no-referrer`。

认证审计：Master 会为登录、注册、密码重置/修改、注销、账号禁用、验证码发送/消费、CAPTCHA 校验和限流写入脱敏 `AUTH` 事件；事件使用邮箱 HMAC 摘要而非原始邮箱，且不得包含密码、验证码、JWT、Cookie 或完整 token。系统日志仍受统一消息长度、metadata 大小、缓冲区和保留周期约束；服务重启或 SQLite 写入失败时，内存队列中的尚未落库日志可能丢失。

---

## 2. Master-Agent WebSocket (WSS) 通信协议

Agent 与 Master 之间建立全双工长连接，连接地址为：
```
ws(s)://<master-host>/ws/agent
```

Agent 通过握手 Header `X-Agent-Token: <AGENT_TOKEN>` 鉴权；URL 不携带凭据，避免 Token 出现在访问日志、Referer 或浏览器历史中。

### 2.1 基础数据包格式 (JSON Frame)
```json
{
  "type": "MESSAGE_TYPE",
  "data": { ... }
}
```

当前 Master-Agent 协议版本为 **v2**。所有心跳和 HTTP 轮询请求必须携带 `protocolVersion: 2`；Master 拒绝 v1 或缺失版本字段，发布 v0.5.0 时必须先完成所有 Agent 的同步升级，不允许新旧协议混合运行。累计流量字段使用十进制字符串，避免 JavaScript `Number` 的安全整数限制。

### 2.2 消息类型枚举

#### 1. 认证与握手响应 (`auth_result`) —— Master -> Agent
```json
{
  "type": "auth_result",
  "data": {
    "success": true,
    "message": "Node authenticated successfully",
    "nodeId": "node-uuid-xxx",
    "protocolVersion": 2
  }
}
```

#### 2. 配置全量同步 (`config_sync`) —— Master -> Agent
当节点首次连接成功、或主控端发生用户/线路变动时，Master 向 Agent 实时推送最新的 Sing-box 运行配置。
`PROTOCOL_PROXY` 与 `TARGET_LINE` 的跨节点出站统一使用系统内部中继凭证，不借用任何普通用户凭证；对应出口入站仅注入该内部凭证（`TARGET_LINE` 追加到目标直连入站）。内部凭证固定为 `email=__riricloud_relay_transit__`、`uuid=00000000-0000-4000-8000-000000000002`、密码 `riricloud-internal-relay-transit-secret`，仅允许在 Master 生成的节点配置中使用。Master 在生成各协议入站时，普通用户的 `name` 字段编码为复合标签 `<email_or_uuid>::<lineId>`，使 Sing-box 的 V2Ray stats API 原生支持按线路精准切分用户流量统计；内部中继凭证保持固定不变。Agent 上报该复合凭证后，Master 端自动拆解用户与所属线路，精准落库 `TrafficLog` 并按线路倍率折算扣除套餐配额，彻底解决单节点多入站与中转线路归属问题。`experimental.v2ray_api.stats` 的 `users` 自动注册所有生成的复合标签，并下发 `inbounds` 入站 Tag 列表。
Agent 收到后原子落盘（临时文件 + rename），并与最近一次配置做字节比对：内容变化则优雅重启内核使配置生效（sing-box 无原生 reload，重启即热应用）；内容相同且内核存活则跳过，避免无谓重启。
```json
{
  "type": "config_sync",
  "data": {
    "version": 1,
    "userDeviceLimits": { "user@example.com": 2, "user-uuid-1": 2 },
    "singboxLogCaptureLevel": "WARN",
    "agentLogRotation": { "maxSizeMb": 50, "maxFiles": 5 },
    "portSpeedLimits": { "443": 100, "8443": 50 },
    "singboxConfig": {
      "log": { "level": "warn" },
      "inbounds": [
        {
          "type": "vless",
          "tag": "vless-in",
          "listen": "0.0.0.0",
          "listen_port": 443,
          "users": [
            { "uuid": "user-uuid-1", "flow": "xtls-rprx-vision", "name": "user1@domain.com" },
            { "uuid": "user-uuid-2", "flow": "xtls-rprx-vision", "name": "user2@domain.com" }
          ],
          "tls": {
            "enabled": true,
            "server_name": "www.apple.com",
            "reality": {
              "enabled": true,
              "handshake": { "server": "www.apple.com", "server_port": 443 },
              "private_key": "...",
              "short_id": ["0123456789abcdef"]
            }
          }
        },
        {
          "type": "hysteria2",
          "tag": "hy2-in",
          "listen": "0.0.0.0",
          "listen_port": 8443,
          "up_mbps": 100,
          "down_mbps": 500,
          "users": [{ "name": "user1@domain.com", "password": "..." }],
          "tls": { "enabled": true, "server_name": "hy.example.com", "alpn": ["h3"], "certificate_path": "/etc/riricloud/cert.pem", "key_path": "/etc/riricloud/key.pem" }
        },
        {
          "type": "tuic",
          "tag": "tuic-in",
          "listen": "0.0.0.0",
          "listen_port": 8443,
          "congestion_control": "bbr",
          "users": [{ "uuid": "user-uuid-1", "name": "user1@domain.com", "password": "..." }],
          "tls": { "enabled": true, "server_name": "tuic.example.com", "alpn": ["h3"], "certificate_path": "…", "key_path": "…" }
        },
        {
          "type": "shadowsocks",
          "tag": "ss-in",
          "listen": "0.0.0.0",
          "listen_port": 8388,
          "method": "2022-blake3-aes-128-gcm",
          "password": "..."
        }
      ],
      "outbounds": [{ "type": "direct" }]
    }
  }
}
```

> 日志采集策略：`NORMAL` 为默认模式，Master 生成 `log.level=warn` 且 Agent 仅上报真实 Sing-box `WARN/ERROR`；`INFO`/`DEBUG` 是固定 30 分钟的管理员诊断模式，只临时覆盖最终配置的 `log.level`，保留 `configOverride` 的其他日志字段。`singboxLogCaptureLevel` 是可选的独立采集门槛（`WARN`/`INFO`/`DEBUG`），旧 Agent 忽略时仍按安全的 WARN/ERROR 策略工作。连接、访问、dial、connection closed 等输出标记为 `ACCESS`，NORMAL 模式不上传；stderr 不再自动升级为 WARN，无法解析级别的 stderr 按 INFO 处理。

> Agent 本地日志轮转：`agentLogRotation` 是可选配置字段，`maxSizeMb` 范围为 1~1024，`maxFiles` 范围为 1~20 且包含当前日志文件。新 Agent 收到后动态应用；旧 Agent 忽略该字段并继续业务运行，Master 根据 `agent_log_rotation` 能力标记其需要升级。配置字段缺失时 Agent 使用本地 YAML/环境变量，最终回退到 50 MiB 与 5 个文件。

> 物理端口限速 (`portSpeedLimits`)：可选映射 `{ [port]: limitMbps }`。Linux 边缘 Agent 收到后调用 `trafficshaper` 模块，通过 Linux `tc`（HTB 根队列与子类、u32 双向匹配）实施对应物理端口的出入双向流量整形；非 Linux 或无权限环境平滑跳过记 Warn；线路未配置限速时自动清理对应类规则。同时，入站生成支持 `tcp_fast_open`、`tcp_multi_path`、`udp_fragment`、`udp_timeout`、`proxy_protocol`，以及 `multiplex`、`masquerade`、`udp_over_tcp` 等 Sing-box 原生调优项。
> 
> 多路复用 (Multiplex) 与 TCP Brutal 协议契约：入站与出站 `multiplex` 配置支持 `protocol`（`smux`/`yamux`/`h2mux`）、`maxConnections` 与 `maxStreams` 互斥约束、`minStreams` 与 `padding`；`brutal` 拥塞控制在开启时强制要求正整数 `upMbps` 与 `downMbps` 速率期望。服务端构建器与客户端订阅构建器均内置防御守卫：若 `upMbps` 或 `downMbps` 缺失或非正数，坚决不向 Sing-box 配置中输出 `brutal` 块，杜绝内核报错 `brutal: invalid upload speed`。
> 
> 线路参数更新语义：线路更新接口（`PUT /api/lines/:id`）对 `params` 采取以提交参数为准的全量替换策略，彻底解决取消勾选（如停用多路复用、清空流控混淆等）时旧参数因递归深合并残留的问题；对于 Reality 私钥、ShadowTLS 内层密码等敏感机密，若更新入参未提供则按需安全继承历史数据。

> 用户注入规则（与订阅输出一致，见 `docs/DATA_MODELS.md` §3.1）：vless/tuic 用 `User.uuid` 登录；hy2 密码取 `User.password ?? User.uuid`；ss 为入站共享密码不注入用户。各节点入站同时包含内部专用测速探针凭据（`INTERNAL_SPEEDTEST_UUID` / `INTERNAL_SPEEDTEST_SECRET`）。

> 中继与测速凭证流量规则：协议代理/异构桥接出站使用上述内部中继凭证，Master 测速探针使用内部测速凭据；各节点上的内部专用凭证流量仅维护 `TrafficCursor` 基线，不生成 `TrafficLog`，不扣减任何普通用户或订阅配额。

中继配置示例：盲转发线路在入口节点生成如下端口转发入站；协议代理线路生成与 Line 协议对应的入口入站、出口 outbound 以及 route rule；`TARGET_LINE` 则将 outbound 的协议、参数、目标地址和端口取自所引用的直连线路。
```json
{
  "type": "direct",
  "tag": "relay-line-uuid",
  "listen": "0.0.0.0",
  "listen_port": 8443,
  "override_address": "203.0.113.10",
  "override_port": 443
}
```
线路 CRUD、套餐/用户订阅变动均通过现有 250ms 防抖机制触发相关在线节点的 `config_sync`；目标线路或目标节点地址变更也会刷新桥接入口节点。节点上的配置来源始终是 Line 与节点级 `configOverride`。

##### 反向多路复用隧道编排与协同 (Yamux Reverse Tunnel)

当存在以 NAT 节点（`reachability=NAT`）作为落地出口的中继线路时，Master 会在 `config_sync` 数据包中为入口 VPS 节点和落地 NAT 节点注入 `tunnelConfigs` 数组：

```json
{
  "type": "config_sync",
  "data": {
    "version": 1,
    "singboxConfig": { ... },
    "tunnelConfigs": [
      {
        "id": "tunnel-39001",
        "role": "SERVER",
        "listenPort": 39001,
        "serverAddr": "entry.vps.example.com:39001",
        "secret": "high-entropy-tunnel-secret",
        "mappings": [
          { "lineId": "line-uuid", "localPort": 30001, "targetPort": 30001 }
        ]
      }
    ]
  }
}
```

- **拓扑聚合机制 (Node-to-Node Aggregated Mux)**：同一对 `(entryNode, landingNode)` 之间无论承载多少条中继线路，均复用单一底层 TLS 长连接与单一 `tunnelPort`。多条线路的端口映射在 `mappings` 中统一聚合分发，由底层 Yamux 虚拟 Stream 进行数据解复用，极大节省系统 Socket 与 NAT 连接池资源。
- **统一隧道鉴权标识与地址解析**：隧道标识在入口端与落地端统一采用 `tunnel-<port>`，握手时支持版本归一化校验；落地客户端拨号地址（`serverAddr`）优先读取线路开启的端点覆盖域名（`line.endpointOverrideEnabled && line.serverHost`），若未开启则回退使用入口节点的 `serverHost`，支持配置合法域名并携带 SNI 建立安全 TLS 1.3 连接。
- **角色协作机制**：
  - **入口节点 (`role: "SERVER"`)**：在 `targetPort` 上开启 TLS 监听服务；当收到落地 NAT 客户端的主动反向拨号并验证预共享密钥（`secret`）后，升级为 Yamux Session；同时在本地 `127.0.0.1:<remotePort>` 启动监听转发器，将进入该端口的流量通过 Yamux Stream 穿透转发给对端。
  - **落地 NAT 节点 (`role: "CLIENT"`)**：作为客户端主动向公网入口节点的 `targetHost:targetPort` 发起 TLS 拨号；握手并认证后保持 Yamux Session（集成 25s 心跳保活与指数退避断线重连，自愈家宽 PPPoE 重拨）；当对端发起新 Stream 时，主动连接落地主机本地的 `127.0.0.1:<localPort>`（落地 Sing-box 入站）。
- **监听收敛与流量重定向**：
  - 入口公网 VPS 节点的 Sing-box 中继出站目标（`override_address`）自动重定向为 `127.0.0.1`，直接将中继流量喂入本地的隧道转发端口；
  - 落地 NAT 节点上的 Sing-box 业务入站监听地址强制绑定至 `127.0.0.1`，避免在家庭/内网局域网中暴露端口。
- **落地局域网安全访问防护**：
  - 若中继线路的 `allowLanAccess` 为 `false`（默认策略），Master 在为落地 NAT 节点生成 Sing-box 配置时，会在 `route.rules` 首位自动注入局域网阻断规则，将私有网段（`geoip:private`，涵盖 `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, `::1/128`, `fc00::/7`, `fe80::/10` 等）路由至 `reject` 出站，杜绝外部翻墙流量穿透访问家庭 NAS、路由器管理面板等局域网资产；
  - 仅当管理员显式开启 `allowLanAccess: true` 时，私网拦截规则放行，允许通过代理访问落地内网设备。

#### 3. 遥测心跳与流量上报 (`heartbeat`) —— Agent -> Master (每 5~10 秒)
```json
{
  "type": "heartbeat",
  "data": {
    "protocolVersion": 2,
    "cpuUsage": 12.5,
    "memoryUsage": 38.2,
    "bandwidthRate": 1048576,
    "uploadRate": 262144,
    "downloadRate": 786432,
    "kernelRunning": true,
    "appliedConfigVersion": 3,
    "lastError": "",
    "capabilities": ["mirror_proxy", "singbox_log_capture", "agent_log_rotation", "device_tracking"],
    "onlineDevices": [
      { "userUuid": "user-uuid-1", "ip": "203.0.113.10", "lineId": "line-uuid", "connections": 2, "lastSeenAt": 1780000000 }
    ],
    "trafficSnapshots": [
      { "userUuid": "user-uuid-1", "uploadTotal": "52428800", "downloadTotal": "104857600" },
      { "userUuid": "user-uuid-2", "uploadTotal": "1024000", "downloadTotal": "2048000" }
    ]
  }
}
```

> **实现状态**：`cpuUsage` / `memoryUsage` / `bandwidthRate` / `uploadRate` / `downloadRate` / `trafficSnapshots` 均已实现 ⭐。Agent 通过 gopsutil 以 1 秒差分拆分网卡上行与下行速率，并保留 `bandwidthRate = uploadRate + downloadRate`；计数器回绕或采样异常时对应速率为 0。Agent 通过 Sing-box `experimental.v2ray_api` 的本地 gRPC `StatsService.QueryStats(reset=false)` 读取累计用户计数，Master 按节点与原始凭证维护 `TrafficCursor` 并计算增量，因此 Agent 不会因断线、重试或 Master 暂时不可用而清零统计数据。`uploadTotal` / `downloadTotal` 使用十进制字符串；统计用户名称当前使用入站配置中的邮箱，Master 同时兼容按 UUID 或邮箱回查用户。共享密码模式的 Shadowsocks 入站没有可区分的用户身份，不产生按用户记录。
>
> **落库约束**：Master 对同一节点的心跳按顺序处理，积压时仅保留最新遥测和累计快照；累计值相等不生成流水，计数器下降则按重启/重置处理并记录告警。未知凭证只建立游标基线，不计费。`TrafficLog.upload/download` 始终记录物理增量，用户与订阅配额按归属线路的 `trafficRate` 折算值批量扣减；没有归属线路时倍率按 `1.0` 处理。协议代理/异构桥接的内部凭证只更新 `TrafficCursor`，不生成流水或扣费。Master 写入流水时优先关联 ACTIVE 入口线路；没有入口线路时回退到 ACTIVE `RELAY + BLIND_FORWARD` 出口承载线路。`TrafficLog`、`Subscription.trafficUsedBytes`、`User.trafficUsedBytes` 与 `TrafficCursor` 在同一短事务内提交。节点遥测、速率聚合与流量账务分开落库，速率历史保留 30 天并由低频巡检清理。
>
> **内核与版本字段（v0.3.0，可选，向后兼容）**：`kernelRunning`（内核进程存活）、`appliedConfigVersion`（当前生效配置版本，对应 `config_sync.version`）、`lastError`（最近一次失败原因：check 失败/启动失败/异常退出采样 stderr 尾部 8KB；空串或省略表示无错误）、`agentVersion`、`osArch`、`kernelVersion`（内核未拉起或探测中可省略或上报空串，Master 网关自适应放行并保留最新有效值）。Master 落 `Node.kernelRunning` / `Node.configError` / `Node.agentVersion` / `Node.osArch` / `Node.kernelVersion`；旧版 Agent 不携带这些字段，对应列保持原值。
>
> **离线状态收敛机制**：当节点连接断开或因心跳超时被后台巡检标记为 `OFFLINE` 时，Master 自动将瞬态遥测字段清空（`kernelRunning = null`, `cpuUsage = null`, `memoryUsage = null`, `bandwidthRate = 0`, `uploadRate = 0`, `downloadRate = 0`），前端与管理 API 统一对离线节点的内核状态呈现为未确定状态破折号（`—`），杜绝失联节点历史内核存活状态遗留误导。

#### 在线设备上报与踢下线（可选，向后兼容）
Agent 可在 `heartbeat` 中附带 `onlineDevices[]`（无活跃连接时序列化为空数组 `[]`，不发送 `null`），单条包含 `{ userUuid, ip, lineId?, connections, lastSeenAt }`；仅声明 `device_tracking` 能力的节点参与设备追踪（内核二进制变更或自愈释放后动态重探测该能力）。Agent 每 2 秒查询本机 Sing-box loopback Clash API `/connections`（支持可选 `secret` Bearer 鉴权与 `configOverride` / `CLASH_API_LISTEN` 自定义回环端口），根据连接元数据汇总用户/IP/线路并执行节点本地限制；Agent 与 Master 均自动忽略 `127.0.0.1`、`::1`、`0.0.0.0`、`::` 等回环与未指定地址，避免反向隧道落地节点的本机转发流量被误判为客户端设备。Master 按用户与客户端 IP 跨节点去重，在进程内存保留最近报告，超过 `deviceOnlineWindowSecs`（15~600 秒，默认 60 秒）即视为过期，不持久化在线报告。上限超出时保留较早在线设备（阻断期内的设备不占用名额，活跃设备持续续期首次发现时间）并断开新设备连接，短连接可能在采样间隔内结束而未被观察到。

Master 在 `config_sync.data.userDeviceLimits` 下发有效的正数限制，使用邮箱和 UUID 两种凭证键；缺失键表示不限。配置优先级为用户覆盖（`null` 跟随套餐，`0` 显式不限）与订阅套餐（已保存套餐快照优先于当前套餐），全局开关关闭时不自动执行，但手动踢设备仍可用。

管理员或用户发起踢设备时，WS 下发 `kick_devices`（`{ taskId, items: [{ userUuid, ip?, blockDurationSecs? }] }`），Agent 回传 `kick_devices_result`（`{ taskId, success, message, kickedConnections }`）。HTTP 轮询兼容使用响应任务 `kick_devices_task` 与请求回执数组 `kickDevicesResults`；每个数组项沿用上述设备/回执字段。踢设备只投递到当前报告含目标用户设备的在线节点，空 `ip` 表示该用户全部设备；默认阻断 60 秒，且 Master 与 Agent 在下发/执行踢出时立即从内存设备报告中剔除对应条目。

#### 4. 配置应用回执 (`config_apply_result`) —— Agent -> Master (v0.3.0)
Agent 处理每条 `config_sync` 后回执结果，Master 落 `Node.configError`（成功清空、失败记原因，截断 8KB）：
```json
{ "type": "config_apply_result", "data": { "version": 3, "success": true, "message": "ok" } }
```
失败示例（预检拒绝，Agent 侧已回滚 lastGood 配置、内核继续使用旧配置）：
```json
{ "type": "config_apply_result", "data": { "version": 4, "success": false, "message": "sing-box check: ERROR: decode inbound ..." } }
```

#### 5. 远程升级回执 (`upgrade_result`) —— Agent -> Master (v0.3.0)
```json
{
  "type": "upgrade_result",
  "data": {
    "taskId": "task-uuid",
    "target": "singbox",
    "version": "1.11.0",
    "success": true,
    "message": "ok"
  }
}
```

Agent 对下载文件流式计算 SHA-256；Sing-box 升级还会使用当前配置预检、停止旧进程、原子替换并确认新进程启动。新进程启动失败时恢复 `.riri-old` 备份并重试旧版本。Agent 自身升级成功后保留原命令行参数平滑重启。

#### 6. 网络探针回执 (`probe_result`) —— Agent -> Master (v0.3.0)
```json
{
  "type": "probe_result",
  "data": {
    "taskId": "task-uuid",
    "success": true,
    "results": [
      { "type": "tcp", "target": "example.com", "success": true, "latencyMs": 32, "packetLossPercent": 0 },
      { "type": "dns", "target": "example.com", "success": true, "latencyMs": 8, "addresses": ["93.184.216.34"], "packetLossPercent": 0 }
    ]
  }
}
```

#### 7. 运行日志上报 (`log_report`) —— Agent -> Master (v0.6.12，v0.8.13 扩展)
Agent 在运行期通过有界环形缓冲区采集自身运行日志与托管的 Sing-box 日志并批量上报，交由 Master `SystemLogsService` 统一入库与实时推流：
- **真实级别解析**：Agent 去除 ANSI 控制字符，解析 Sing-box `DEBUG/TRACE -> DEBUG`、`INFO -> INFO`、`WARN -> WARN`、`ERROR/FATAL/PANIC -> ERROR`；stderr 仅作为 `metadata.stream` 元数据，不再自动升级为 WARN，未知级别默认按 INFO。进程异常退出、启动失败和配置预检失败由 Agent supervisor 生成结构化生命周期 WARN/ERROR。
- **分级过滤策略**：Agent 自身日志继续上报 `INFO` / `WARN` / `ERROR`；Sing-box 在 `NORMAL` 模式只上报真实 `WARN/ERROR`，并丢弃 `ACCESS` 高频连接日志；管理员开启 `INFO`/`DEBUG` 诊断后按下发门槛放行，固定 30 分钟后自动恢复。Master 会再次按节点有效诊断状态拦截旧 Agent 或异常客户端发送的 Sing-box INFO/DEBUG。
- **重复合并与安全**：相同节点、模块、标准化消息的 Sing-box WARN 在 60 秒内合并为一条并在 `metadata.repeatCount` 记录次数；ERROR 不合并。入库和实时推流沿用日志脱敏，并清洗域名、IP、Token、密码与密钥模式。系统日志不承担流量计费，流量仍来自 StatsService/heartbeat/小时桶。
- **上报触发机制**：WS 长连接下通过独立 goroutine 每 2 秒批量上报（单次至多 50 条），当捕获到 `ERROR` 级别日志时立即触发快速刷新上报；HTTP 轮询模式下随 `POST /api/v1/agent/poll` 请求体中的可选 `logs` 数组字段批量携带上报。
```json
{
  "type": "log_report",
  "data": {
    "logs": [
      {
        "level": "ERROR",
        "module": "Singbox",
        "source": "SINGBOX",
        "message": "inbound/vless[vless-in]: failed to listen: address already in use",
        "metadata": { "line": 42 }
      }
    ]
  }
}
```

Master 对 Agent 上行 JSON 做运行时结构校验：只接受 `heartbeat`、`config_apply_result`、`upgrade_result`、`probe_result`、`restart_agent_result`、`kick_devices_result` 与 `log_report` 上行消息，数值必须为有限/安全非负数，数组和文本字段有数量与长度上限；无效消息只记录脱敏告警，不进入业务服务。

## 2.4 二进制资源中心 API（v0.5.0，v0.9.x 扩展重构）

以下管理接口均需要管理员 JWT 与 `ADMIN` 角色（仅管理跨平台 `AGENT` 二进制资源，Sing-box 内核已内嵌于 Agent 中）：

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| `GET` | `/api/v1/admin/binary-resources` | 服务端分页查询 Agent 资源列表；支持 `page`、`pageSize`（≤100）、`search`（匹配版本号或备注）、`status`、`platform`（如 `linux-amd64`）参数；响应为 `{ data, total, page, pageSize, supportedTargets, summary }`，`supportedTargets` 固定为 5 个 Agent 架构目标（`agent-linux-amd64`、`agent-linux-arm64`、`agent-macos-amd64`、`agent-macos-arm64`、`agent-windows-amd64`）。`summary` 聚合全部匹配行的 `totalBytes` 与 `reclaimableBytes`。 |
| `GET` | `/api/v1/admin/binary-resources/github-releases` | 读取系统设置 `githubRepoUrl`（支持 `?repoUrl=` 临时覆盖）对应的 GitHub Releases 列表（支持 `githubMirrorUrls` 镜像与官方源自动回退），优先从匹配的 Agent 资产文件名中提取真实 Agent 版本号并按版本去重（优先保留 `agent-v*` 独立发布条目），同时校验本地磁盘物理文件完整性后标记是否已入库（`imported`），并返回当前默认下载源 `defaultSource`。 |
| `POST` | `/api/v1/admin/binary-resources/github-import` | 从项目 GitHub Release 一键拉取指定 `tagName` 的全部或指定 `targets` 架构资产；具备全有或全无（All-or-Nothing）强原子性（先全量流式下载并解压校验全部目标平台资产，任一平台超时/断流/失败或客户端断开请求时整体中止且不写入半成品记录），支持镜像流空闲超时（6s）熔断与自动回退至下一镜像及 GitHub 官方源。 |
| `POST` | `/api/v1/admin/binary-resources/github-mirrors/test` | 对配置的 `githubMirrorUrls`（或请求体传入的 `mirrorUrls`）与 GitHub 官方源（`https://github.com`）并发执行真实 Release 资产或仓库字节流采样测速（检测仅返回响应头但卡死 0 B/s 的假活镜像），返回各候选源的可用性、首字节延迟、流式耗时、估算速率与推荐最快源 `recommendedMirrorUrl`。 |
| `GET` | `/api/v1/admin/binary-resources/:id` | 查看资源详情、平台文件与最近分发任务。 |
| `PATCH` | `/api/v1/admin/binary-resources/:id` | 编辑资源 `notes` 与 `compatibility`（兼容性约束对象，字段白名单：`minAgentProtocolVersion`/`maxAgentProtocolVersion` 数字，`minAgentVersion`/`maxAgentVersion`/`cronetVersion` 字符串）。 |
| `DELETE` | `/api/v1/admin/binary-resources/:id` | 物理删除任意资源（不区分来源或状态，包含默认资源或有历史分发任务的资源均可直接删除）。删除时自动解除节点与部署任务外键引用、清理磁盘资产文件、在 `.seeded-releases.json` 标记防止重启复活，并在删除默认版本时自动将默认标记转移至最新 `ACTIVE` 资源。 |
| `POST` | `/api/v1/admin/binary-resources/batch` | 批量操作：`{ action: 'activate' \| 'disable' \| 'retire' \| 'delete', ids: string[] }`（≤100 项）；逐项执行并返回 `{ succeeded, failed, results: [{ id, ok, error? }] }`。 |
| `POST` | `/api/v1/admin/binary-resources/upload` | `multipart/form-data` 上传本地二进制或 `.tar.gz`/`.tgz`/`.zip` 归档包（上限 100 MiB）；自动解压、解析 ELF/Mach-O/PE 魔数头识别 `target`、提取内嵌 `RIRICLOUD_AGENT_VERSION:<ver>` 标记或文件名版本号、计算 SHA-256 并直接启用入库（`upstreamVersion`/`target`/`sha256` 均为可选覆盖项）。 |
| `POST` | `/api/v1/admin/binary-resources/import` | 仅需提供 `url`（HTTP/HTTPS 下载地址），服务端自动下载、解压、识别平台架构与版本号、计算 SHA-256 并启用入库。 |
| `POST` | `/api/v1/admin/binary-resources/:id/activate` | 启用资源。 |
| `POST` | `/api/v1/admin/binary-resources/:id/disable` | 停用资源并自动转移默认标记。 |
| `POST` | `/api/v1/admin/binary-resources/:id/retire` | 归档资源并自动转移默认标记。 |
| `POST` | `/api/v1/admin/binary-resources/:id/restore` | 将 `RETIRED` 归档资源恢复为 `DISABLED`。 |
| `POST` | `/api/v1/admin/binary-resources/:id/default` | 将 ACTIVE 资源设为默认版本。 |
| `GET` | `/api/v1/admin/binary-resources/:id/deployments` | 分页查询该资源的分发任务；支持 `page`、`pageSize`、`status` 参数，行内含节点摘要。 |
| `GET` | `/api/v1/admin/nodes/:id/tasks` | 分页查询该节点的升级分发任务；支持 `page`、`pageSize`、`status` 参数，行内含资源版本摘要与 `previousAssetId`（回滚依据）。 |

所有资源管理操作（上传、URL 导入、GitHub Release 拉取、编辑、启停、归档、恢复、切换默认、删除）均统一通过 `SystemLogsService.enqueue` 写入系统日志（`source='SERVER'`、`module='BinaryResource'`），不再提供独立的 `audit-logs` 端点。

节点升级 `POST /api/v1/admin/nodes/:id/upgrade` 支持可选 `resourceId`。服务端根据节点 OS/架构选择资源的 `assetId`，下发响应包含 `resourceId`、`assetId`、主文件 URL/SHA-256 与 `files[]`。兼容下载端点仍保留：`GET /api/v1/downloads/binaries/:target`、`GET /api/v1/downloads/binary-assets/:id` 与 `GET /api/v1/downloads/binary-files/:id`，均使用 AgentToken。

---

## 2.3 Master-Agent HTTP/HTTPS 轮询协议

HTTP 模式使用单一合一端点：
```
POST http(s)://<master-host>/api/v1/agent/poll
X-Agent-Token: <AGENT_TOKEN>
Content-Type: application/json
```

该端点通过 `@Public()` 绕过 JWT，但必须在 `X-Agent-Token` 中提供有效节点凭证；凭证无效、节点禁用或缺失时返回 `401`。HTTP 轮询与 WS 共用 `AgentService`，上行遥测、流量事务、配置回执和任务回执使用同一套业务规则。

### 2.3.1 Agent -> Master 请求体

```json
{
  "protocolVersion": 2,
  "cpuUsage": 12.5,
  "memoryUsage": 38.2,
  "bandwidthRate": 1048576,
  "uploadRate": 262144,
  "downloadRate": 786432,
  "kernelRunning": true,
  "appliedConfigVersion": 3,
  "lastError": "",
  "agentVersion": "0.3.0",
  "osArch": "linux/amd64",
  "kernelVersion": "1.11.0",
  "capabilities": ["mirror_proxy", "singbox_log_capture", "agent_log_rotation", "device_tracking"],
  "onlineDevices": [
    { "userUuid": "user-uuid-1", "ip": "203.0.113.10", "lineId": "line-uuid", "connections": 2, "lastSeenAt": 1780000000 }
  ],
  "trafficSnapshots": [],
  "kickDevicesResults": [],
  "configApplyResults": [
    { "version": 3, "success": true, "message": "ok" }
  ],
  "upgradeResults": [],
  "probeResults": [],
  "restartAgentResults": []
}
```

`onlineDevices` 与 `kickDevicesResults` 均为可选数组，分别最多 1024 项和 8 项；`configApplyResults`、`upgradeResults`、`probeResults`、`restartAgentResults` 每类最多 8 项。请求仍会先按心跳规则更新节点遥测与流量，再处理回执。节点遥测与流量账务分开落库，但流量日志和两处配额更新保持在同一短事务内。

### 2.3.2 Master -> Agent 响应体

```json
{
  "protocolVersion": 2,
  "needUpdate": true,
  "version": 4,
  "singboxLogCaptureLevel": "WARN",
  "singboxConfig": { "log": { "level": "warn" }, "inbounds": [], "outbounds": [{ "type": "direct", "tag": "direct" }] },
  "userDeviceLimits": { "user@example.com": 2, "user-uuid-1": 2 },
  "tasks": [
    { "type": "probe_task", "data": { "taskId": "task-uuid", "probes": [{ "type": "dns", "target": "example.com" }] } }
  ],
  "nextPollSecs": 15
}
```

当 `needUpdate=false` 时 `singboxConfig` 为 `null`；`tasks` 中的升级/探针/Agent 重启任务在 Agent 侧异步执行，并在下一次轮询的回执数组中提交。Master 会在回执到达前保留已投递任务，网络丢包后按 60 秒重试，回执成功后任务状态变为 `COMPLETED`。`nextPollSecs` 由节点配置给出，服务端限制在 5~300 秒。Master 返回的 `protocolVersion` 必须为 `2`，Agent 收到其他版本时拒绝继续通信并等待升级。

### 2.3.3 健康判定

- WS/WSS：最后上报超过 15 秒且没有新连接时标记 `OFFLINE`。
- HTTP/HTTPS：最后上报超过 `3 × pollIntervalSecs`（默认 45 秒）时标记 `OFFLINE`。
- 任一模式重新上报都会恢复 `ONLINE`，并把 `communicationMode` 更新为实际传输模式。
- Master 重启后的 60 秒内，订阅线路计算会对最近一次心跳仍处于上述健康窗口内的 `OFFLINE` 节点启用临时恢复宽限；超过宽限期或心跳已明显过期的节点仍会从订阅中移除，手动 `DISABLED` 节点不会被宽限放行。
- 离线扫描按扫描时读取的 `lastSeenAt` 做乐观并发校验；节点在扫描期间重新上报心跳时，旧扫描结果不会覆盖其在线状态。

---

## 3. 通用多格式订阅协议 (`/sub/:token`)

用户在各种客户端添加订阅链接：
```
http(s)://<master-host>/api/v1/sub/:token
```

### 3.0 Nginx 伪静态订阅地址

部署了 Nginx 示例配置后，可额外使用以下对外地址：

```text
GET https://<domain>/<UUID>
GET https://<domain>/<prefix>/<UUID>
```

这两个地址不是新的后端 API。Nginx 仅对严格匹配 UUID 的单段路径执行内部 rewrite：

```text
/<UUID>          -> /api/v1/sub/<UUID>
/<prefix>/<UUID> -> /api/v1/sub/<UUID>
```

rewrite 不覆盖原始查询字符串，因此 `?type=clash`、`?type=sing-box` 等参数会继续传给订阅接口；`User-Agent` 和订阅响应头也由 Nginx 原样转发。`/login`、`/admin`、`/api/**`、`/ws/agent` 等非 UUID 路径继续交给 Master，WebSocket 路径单独配置 Upgrade/Connection 头。无效 Token、过期订阅、禁用账号以及在开启强制邮箱验证（`enforceEmailVerification=true`）时未核验邮箱的普通用户（管理员豁免）继续沿用后端统一的 404/403 语义（返回明确错误提示）。

前端系统设置 `subscriptionShortLinksEnabled` 默认关闭，只控制用户界面展示的链接形式，不检测 Nginx 是否已配置。`subscriptionBaseUrl` 可包含 pathname，例如 `https://domain.com/panel` 会生成 `https://domain.com/panel/<UUID>`；Nginx 的 location/rewrite 前缀必须与其保持一致。完整配置见 `scripts/nginx/riricloud.conf.example`。

> **实现状态（v0.4.0）**：三种格式、自动协商与全协议线路输出均已实现 ⭐。订阅引擎统一通过 `LinesService` 获取线路视图，不再回退到旧 Node 入站查询；订阅按**线路**逐条生成：仅含公开、启用且入口/出口节点均在线的线路，Master 重启后的短暂恢复宽限期内例外保留最近心跳仍有效的离线节点线路；线路输出使用其最终对外地址/端口，启用 `endpointOverrideEnabled` 时三种格式的 `server`/`server_port`（或 URI 主机/端口）均使用 `serverHost/serverPort` 覆盖值，并应用线路 SNI/Host 覆盖，否则回退到 Line 自身的 TLS/Transport 参数。单条线路对应一个 `protocolType` + `params`，重名全局去重；`nodes` 字段仅作为旧客户端兼容镜像。

### 3.1 客户端请求头自动识别与参数适配
- 格式协商优先级：显式 `?type=` 参数 > User-Agent 嗅探 > 默认 Base64。
- `?type=clash` 或 User-Agent 包含 `Clash` / `meta` / `Mihomo`：输出 **Clash Meta YAML**（`Content-Type: text/yaml`）。⭐ 完整最小可用配置：`mixed-port`/`mode`/`log-level` 基础段 + `proxies[]` + `节点选择` select 策略组 + `MATCH` 兜底规则。支持 VLESS、VMess、Trojan、Hysteria 2、TUIC、Shadowsocks 等主流协议代理（含 `ws-opts`、`grpc-opts`、`httpupgrade-opts`、`reality-opts`）。
- `?type=sing-box` 或 User-Agent 包含 `sing-box`：输出 **Sing-box Client JSON**（`Content-Type: application/json`）。⭐ `outbounds[]`（全协议出站，解耦 `transport` 与 `tls` 配置）+ `direct` 兜底出站，tag 同样去重。
- 默认输出经过 Base64 编码的标准 URI 列表（适配 Shadowrocket、v2rayN、v2rayNG、NekoBox 等）：⭐
  ```
  vless://<UUID>@<IP>:<PORT>?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.apple.com&fp=chrome&pbk=<PUBLIC_KEY>&sid=<SHORT_ID>&type=tcp#东京线路%20[1.5x]
  vmess://<BASE64_JSON>#东京线路
  trojan://<PASSWORD>@<IP>:<PORT>?sni=trojan.example.com&type=ws&path=/ws#东京线路
  hy2://<PASSWORD>@<IP>:<PORT>?sni=hy.example.com&alpn=h3&insecure=1&upmbps=100&downmbps=500#东京线路
  tuic://<UUID>:<PASSWORD>@<IP>:<PORT>?congestion_control=bbr&alpn=h3&sni=…&udp_relay_mode=native#东京线路
  ss://<BASE64URL(method:password)>@<IP>:<PORT>#东京线路   (SIP002)
  naive+https://<USERNAME>:<PASSWORD>@<IP>:<PORT>#东京线路
  ```
  凭证：hy2/trojan/tuic/naive 密码取 `User.password ?? User.uuid`；SS 共享模式使用入站密钥，多用户 SS2022 使用 `server_password:user_password`；vless/vmess/tuic 用户名为 `User.uuid`。

> **协议兼容约束**：VMess 入站用户字段使用 `alterId`，Sing-box VMess 出站仍使用 `alter_id`；ShadowTLS 仅支持 v3，必须配置 SS2022 内层，服务端生成 `shadowtls` 外层入站与 `127.0.0.1:0` 的回环 SS 入站并通过 `detour` 串联，不再接受 v2 或独立 ShadowTLS 密码；SS2022 在共享模式、多用户模式和 ShadowTLS 内层均输出算法要求长度的 Base64 密钥。WebSocket 的 `host` 会转换为 `headers.Host`，不会写入 sing-box transport 顶层；标准 TLS 的 ALPN 由线路 `params.tls.alpn` 数组透传，Reality 不携带 ALPN；TUIC `zero_rtt_handshake` 默认关闭。协议代理中继仅允许目标为 VLESS、VMess、Trojan、Hysteria2、TUIC、Shadowsocks 或 NaiveProxy，避免生成无法工作的本地代理出站。

### 3.2 流量与有效期标准响应头 (UserInfo Header)
订阅接口返回标准响应头，主流客户端会自动在首页显示流量条与过期日；`Profile-Update-Interval` 的值由 `subscriptionUpdateIntervalHours` 动态读取，`includeUsageHeaders=false` 时不返回用量头：
```http
Subscription-Userinfo: upload=524288000; download=2147483648; total=107374182400; expire=1789123456
Profile-Update-Interval: 24
```

### 3.3 订阅分流规则与策略组编译规范

Master 订阅编译引擎（`builders.ts`）支持通过 `SubscriptionTemplate` 定义策略组、分流规则集与 DNS 配置：
- **策略组编译 (`proxyGroupsJson`)**：支持 `select`、`url-test`、`fallback`、`load-balance` 等类型。在 Clash 编译为对应 `proxy-groups`，在 Sing-box 编译为 `selector` 或带探针属性的 `urltest` 出站；策略组中的 `all`/`$all`/`$nodes` 宏自动替换为可用线路列表，并保留 `DIRECT`（Sing-box 映射为 `direct`）、`REJECT`（Sing-box 映射为 `block`）与策略组之间的层级嵌套引用。
- **规则类型与双端映射 (`ruleSetsJson`)**：
  - `remote-rule-set`（兼容 `rule-set` 别名）：Clash 编译为 `rule-providers` (HTTP yaml/mrs，默认行为 `behavior: classical` 并自动分配本地缓存 `path: ./ruleset/<name>.yaml`，完美兼容含 DOMAIN/DOMAIN-SUFFIX/IP-CIDR 等各大主流规则集格式) 与 `RULE-SET` 引用；同时若配置了 `rules` 列表，双端自动优先输出内联 `DOMAIN-SUFFIX`（Sing-box `domain_suffix`），提供零延迟极速冷启动与下载失败回退保护；Sing-box 编译为 `route.rule_set` (remote srs 二进制或 json source) 与 `route.rules` 中的 `rule_set` 匹配。
  - `geoip`：Clash 编译为 `GEOIP,<CODE>,<TARGET>`（不追加 `,no-resolve`，确保 Fake-IP 模式下域名流量能正确触发本地 DNS 解析并命中 GeoIP 直连，防止非直连域名直坠 MATCH 漏网之鱼）；Sing-box 编译为 `{ geoip: [<code>], outbound: <target> }`。
  - `process-name`：Clash 编译为 `PROCESS-NAME,<NAME>,<TARGET>`；Sing-box 编译为 `{ process_name: [<name>], outbound: <target> }`。
  - `ip-cidr`（兼容 `ip-cidr6`）：Clash 编译为 `IP-CIDR`，Sing-box 编译为 `ip_cidr`。
  - `domain` / `domain-suffix` / `domain-keyword` / `geosite`：按各内核原生路由键双端精准对齐。
  - `match` / `final`：编译为末尾兜底规则（Clash `MATCH` / Sing-box `action: route`）。
  - **目标出站名净化**：引擎自动净化目标字符串中携带的 `,no-resolve` 后缀（如 `🎯 全球直连,no-resolve`），提取纯净策略组名作为出站 tag，并在 Clash IP-CIDR 规则中保留该修饰符，同时防止 `,no-resolve` 污染 GEOIP 规则导致 Fake-IP 域名分流击穿为漏网之鱼。
- **语义化 DNS 与防污染编译 (`dnsConfigJson`)**：
  - 支持语义化 DNS 配置（`enable`、`fakeIp`、`directDns`、`proxyDns`、`ipv6`）及经典 Clash DNS 格式自动归一化。
  - 当 `fakeIp: true` 时，Clash 输出 `enhanced-mode: fake-ip` 与 `fake-ip-range`；Sing-box 输出 `dns_fakeip` 服务器定义、`fakeip` 范围（`198.18.0.0/15`）及 A/AAAA 查询劫持规则；国内 DoH DNS 直连，国外 DNS 走代理节点解析，根除 DNS 污染。

## 4. 实时节点镜像协议

### 4.1 Master REST 与访问路由

管理员接口统一挂在 `/api/v1/admin/mirrors`：

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| `GET` | `/api/v1/admin/mirrors` | 查询镜像站及节点能力摘要 |
| `GET` | `/api/v1/admin/mirrors/:id` | 查看镜像站详情 |
| `POST` | `/api/v1/admin/mirrors` | 创建镜像站；`SHARE` 模式仅在响应中返回一次明文 Token |
| `PATCH` | `/api/v1/admin/mirrors/:id` | 更新镜像配置 |
| `DELETE` | `/api/v1/admin/mirrors/:id` | 删除并撤销镜像站 |
| `POST` | `/api/v1/admin/mirrors/:id/rotate-share-token` | 轮换分享 Token，旧 Token 立即失效 |
| `POST` | `/api/v1/admin/mirrors/:id/test` | 通过指定节点执行受限 HEAD 测试 |

实时访问路由不使用 API 前缀，避免被 SPA fallback 接管：`GET/HEAD /mirror/:slug/*path` 由镜像配置决定 `ADMIN`、`SHARE` 或 `PUBLIC` 鉴权；分享地址为 `GET/HEAD /mirror/share/:token/*path`。目标 URL 由服务端保存的基址、路径和原始查询参数拼接，客户端不能覆盖 scheme 或 host。第一版仅允许 GET/HEAD，请求头只允许 `Range`、条件请求、`Accept` 和 `Accept-Encoding`；响应只转发内容类型、长度/范围、缓存协商、ETag、Last-Modified、Vary 和 Content-Encoding 等安全字段，不转发 Cookie、Authorization、Set-Cookie 或 hop-by-hop headers。

### 4.2 Master-Agent WS 消息

Agent 心跳可携带 `capabilities: string[]`；能力包含 `mirror_proxy` 的在线 WS 节点可承载镜像任务，能力包含 `singbox_log_capture` 的在线节点才允许管理员开启临时 Sing-box 诊断，能力包含 `agent_log_rotation` 的节点支持 Master 下发本地日志轮转策略。旧 Agent 缺少该能力时仍可继续通信和承载业务，但管理端应提示升级：

```json
{ "type": "mirror_request", "data": { "taskId": "...", "method": "GET", "url": "https://github.com/...", "allowedHosts": ["github.com", "objects.githubusercontent.com"], "requestHeaders": {}, "timeoutMs": 600000, "maxBytes": 268435456 } }
{ "type": "mirror_cancel", "data": { "taskId": "..." } }
{ "type": "mirror_response_headers", "data": { "taskId": "...", "statusCode": 200, "headers": {}, "contentLength": 123, "finalHost": "github.com" } }
{ "type": "mirror_response_end", "data": { "taskId": "...", "bytes": 123, "success": true } }
{ "type": "mirror_error", "data": { "taskId": "...", "code": "REDIRECT_BLOCKED", "message": "safe error" } }
```

响应体使用 WS 二进制帧，不做 Base64：前 2 字节为大端序 `taskId` 长度，随后是 UTF-8 `taskId`，剩余内容为 body chunk。所有 Agent 写操作复用连接写锁；Master 对每个 taskId 维护会话，浏览器断开、超时或节点断线都会发送 `mirror_cancel` 并清理会话。

### 4.3 限额与错误码

Agent 默认单请求超时 10 分钟、响应上限 256 MiB、单节点镜像并发上限 4、最多跟随 5 次重定向。目标 URL 和每次重定向都必须通过 HTTP/HTTPS、允许域名、公网 DNS/IP 与无凭据校验；拒绝 loopback、私网、链路本地、保留地址、IPv4-mapped 私网和云 metadata 地址。稳定错误码包括 `INVALID_URL`、`PRIVATE_ADDRESS`、`DNS_ERROR`、`REDIRECT_BLOCKED`、`REDIRECT_LIMIT`、`RESPONSE_TOO_LARGE`、`TIMEOUT`、`CANCELED`、`NODE_DISCONNECTED` 和 `UPSTREAM_ERROR`。

---

## 5. 直连代理池协议 (Proxy Pool, v0.9.0)

面向爬虫、指纹浏览器与脚本工具的**标准直连代理**能力，与面向客户端翻墙的订阅体系完全解耦：不暴露账号密码、UUID 与订阅 Token，使用独立 `ProxyKey` 凭据，流量统一计入主账户配额。

### 5.1 端点模型与凭据注入

- **端点来源**：`Line` 中 `protocolType = "MIXED"`、`type = "DIRECT"`、`status = "ACTIVE"`、`isPublic = true` 且入口节点未禁用的线路即为一个直连代理端点。同一 `mixed` 入站在**单端口**上同时承接 SOCKS5 与 HTTP CONNECT。
- **对外地址解析**：`endpointOverrideEnabled` 为真且配置了 `serverHost`/`serverPort` 时使用覆盖值，否则回退为入口节点 `serverHost` 与线路 `entryPort`。
- **强制鉴权**：`mixed`/`socks`/`http` 入站在生成节点配置时**一律强制启用用户认证**。Sing-box 中 `users` 为空的这三类入站等价于开放代理，属于安全红线，因此不接受 `params.usersEnabled = false`。
- **明文优先、TLS 按需**：默认标准 TCP 明文监听以保证原生工具 100% 兼容；`params.tls` 支持按需挂载系统证书中心的一键 TLS（`mode = tls` 关联 `certificateId`，或 `mode = acme`），也支持节点本地证书路径。这三类协议的 TLS 选项仅提供「关闭 / 标准 TLS / ACME」，不提供 Reality。
- **凭据注入**：`buildConfigSync` 将当前**仍具备订阅资格**的用户的有效 `ProxyKey` 注入 `inbounds[].users`，形态为 `{ "username": "pk_<24 位十六进制>", "password": "<独立密码>" }`，单节点上限 512 条。
- **用户名必须冒号安全（重要实现约定）**：Sing-box 的 HTTP CONNECT 认证走 Go `net/http.parseBasicAuth`，按**首个 `:`** 切分用户名与密码；同时用户在 `socks5://user:pass@host` 与 `http://user:pass@host` 中也是按首个 `:` 解析 userinfo（curl 等通用客户端行为一致）。因此代理池凭据用户名统一使用**裸 `pk_xxxx`**，不追加 `::lineId` 复合后缀 —— 否则 `http://` 与 `socks5://` 两种形态都会认证失败。线路归属改由节点级回退解析（取该节点上 `status = ACTIVE` 的首条线路）确定，符合“单节点单 Mixed 端点”的产品设计。
  - `parseTrafficCredential` 仍保留 `::lineId` 复合解析能力，一旦出现复合凭证也能正确映射回归属用户，便于后续扩展。
- **来源 IP 白名单**：配置了 `whitelistIps` 的凭据会在 `route.rules` 中生成一条逻辑规则，语义为「命中该入站 + 命中该凭据 + 来源不在白名单」→ `reject`：

```json
{
  "route": {
    "rules": [
      {
        "type": "logical",
        "mode": "and",
        "rules": [
          { "inbound": ["line-<lineId>"] },
          { "auth_user": ["pk_0123456789abcdef01234567"] },
          { "source_ip_cidr": ["203.0.113.10", "198.51.100.0/24"], "invert": true }
        ],
        "action": "reject"
      }
    ]
  }
}
```

> ⚠️ `invert` **必须**放在内层子规则上。若放在顶层规则，`NOT(inbound && auth_user && source_ok)` 会把其他凭据与订阅用户的流量一并反转命中，导致整条入站被误拒绝。相同白名单的多个凭据会合并进同一条规则的 `auth_user` 数组。

### 5.2 流量账务与熔断

- Agent 心跳上报的 v2ray stats 累计快照中，`pk_` 前缀凭据会经 `ProxyKey.username` 映射回 `userId`，在**同一事务**内：
  1. 写入 `TrafficLog`（同时落 `lineId` 与 `proxyKeyId`）；
  2. 按线路倍率折算后累加 `User.trafficUsedBytes` 与 `Subscription.trafficUsedBytes`；
  3. 累加 `ProxyKey.trafficUsedBytes` 并刷新 `lastUsedAt`。
- **超额熔断**：本批次入账后触及配额的账号会触发一次全局 `config_sync` 重下发，`buildConfigSync` 的资格过滤会把该账号的 `ProxyKey` 与订阅凭证同时剔除，凭据在数秒内失效。账号停用、订阅过期等场景复用同一过滤链路。

### 5.3 管理与导出接口

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| `GET` | `/api/v1/user/proxy-pool/keys` | 列出凭据，返回 `{ keys[], limit }`（`limit` 为单账号上限 20） |
| `POST` | `/api/v1/user/proxy-pool/keys` | 创建凭据，请求 `{ name, whitelistIps? }` |
| `PATCH` | `/api/v1/user/proxy-pool/keys/:id` | 更新 `{ name?, whitelistIps?, isActive? }` |
| `DELETE` | `/api/v1/user/proxy-pool/keys/:id` | 删除凭据（节点配置即时吊销） |
| `POST` | `/api/v1/user/proxy-pool/keys/:id/rotate-password` | 轮换密码 |
| `POST` | `/api/v1/user/proxy-pool/keys/:id/rotate-token` | 轮换免登录拉取令牌 |
| `GET` | `/api/v1/user/proxy-pool/nodes?lineIds?` | 可用 Mixed 端点列表（含在线状态与延迟快照） |
| `GET` | `/api/v1/user/proxy-pool/export` | 多格式导出（见下） |
| `GET` | `/api/v1/admin/proxy-pool/overview` | 管理端总览 |
| `GET` | `/api/v1/admin/proxy-pool/keys` | 管理端分页检索全部凭据 |
| `POST` | `/api/v1/admin/proxy-pool/keys/:id/active` | 管理端启停凭据 |
| `DELETE` | `/api/v1/admin/proxy-pool/keys/:id` | 管理端删除凭据 |

**导出接口 `GET /api/v1/user/proxy-pool/export`**

| 参数 | 取值 | 说明 |
| :--- | :--- | :--- |
| `format` | `text`（默认）/ `uri` / `json` | 导出格式 |
| `protocol` | `socks5`（默认）/ `http` | 仅影响 `uri` 前缀 |
| `keyId` | UUID | 指定凭据；省略时使用账号下最近创建的有效凭据 |
| `lineIds` | 逗号分隔 UUID | 按端点过滤；省略时导出全部可用端点 |
| `token` | 字符串 | 免登录拉取令牌（`ProxyKey.exportToken`） |

鉴权：该路由同时声明 `@Public()` 与 `@OptionalAuth()`，因此 **Cookie/Authorization 登录态与 `?token=` 二选一** 即可；两者都缺失返回 401。响应体：

- `format=text`（`Content-Type: text/plain; charset=utf-8`）：每行 `IP:Port:User:Pass`，可直接粘贴进 AdsPower / Hubstudio 等指纹浏览器批量导入框。
- `format=uri`（`text/plain`）：每行 `socks5://user:pass@host:port` 或 `http://user:pass@host:port`。
- `format=json`（`application/json`）：`{ version, generatedAt, key, proxies[] }`，`proxies[]` 含 `name`、`region`、`tags`、`node`、`nodeId`、`lineId`、`protocol`、`host`、`port`、`username`、`password`、`latencyMs`、`lastTestStatus`。

所有导出响应均带 `Cache-Control: no-store`。免登录拉取令牌可通过 `rotate-token` 随时轮换，旧令牌立即失效；凭据停用或归属账号停用时令牌同样失效（401）。
