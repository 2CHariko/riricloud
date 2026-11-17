---
title: "实时节点镜像站与 Agent 流式代理"
type: plan
status: completed
target_version: Unreleased
updated_at: "2026-11-17"
created_at: "2026-09-09"
author: "Codex & Maintainers"
archived_at: "2026-11-17"
---
# 实时节点镜像站与 Agent 流式代理

## 2026-11-17 复核口径

本轮以实际源码、受控测试及本地工件更新勾选，不沿用原 93/123 直接推定完成。已实现/已有隔离测试与真实外部验收分别记录；下文历史门禁只描述其原阶段。真实节点出口、GitHub 现网、上线权限/监控和回滚统一转入 [镜像部署验收计划](../node-mirror-deployment-acceptance.md)，保持未完成。本轮不部署、不启用生产 PUBLIC，也不执行视觉测试。

## 目标与背景

RiriCloud 需要提供类似 GitHub 镜像的能力：管理员创建可复用的镜像站，指定一个上游网站和一个边缘节点；用户访问镜像地址时，由指定节点真实出网请求上游，再由 Master 将响应流式返回。

本规划记录第一版的完整实施范围和不可擅自改变的边界。第一版是实时反向代理，不保存静态快照、不做响应缓存，不把 Master 变成通用开放代理。

典型验收场景：

- 通过指定节点访问 GitHub Raw 文件、GitHub API 和 Release 下载。
- GitHub Release 的有限跨域重定向在配置白名单内自动跟随。
- 客户端可以使用 `GET`、`HEAD`、`Range` 和条件请求头完成文件读取与断点续传。
- 节点实际出网，Master 只负责鉴权、任务编排和响应转发。

## 已冻结的产品决策

### 功能形态

- [x] 镜像对象采用可复用镜像站，而不是每次提交完整 URL 的一次性转发。
- [x] 镜像站保存上游基址、允许的上游域名、指定节点、启用状态和访问策略。
- [x] 镜像访问只允许 `GET` 和 `HEAD`；第一版不支持 POST、PUT、DELETE、上传、Git Push 或 Git Clone 写入链路。
- [x] 第一版不承诺完整网站浏览，不重写 HTML 内链、Cookie 会话、表单地址或 WebSocket。
- [x] 第一版不保存响应体，不提供静态镜像、定时抓取和缓存命中策略。

### 访问策略

- [x] `ADMIN`：要求管理员会话，供管理面板和运维使用。
- [x] `SHARE`：使用随机分享 Token，支持过期、撤销和轮换；数据库只保存 Token 哈希。
- [x] `PUBLIC`：公开访问镜像 slug；必须经过严格上游白名单、限速、并发限制和审计。
- [x] 分享地址轮换后，旧地址立即失效；禁止在日志、普通 API 响应或前端状态中长期保存明文 Token。

### 上游与节点边界

- [x] 第一版只支持公开 HTTP/HTTPS 上游，不保存 GitHub PAT、Cookie、Authorization 或通用自定义请求头。
- [x] 生产环境强制 HTTPS；禁止上游 URL 携带用户名、密码或其他内嵌凭据。
- [x] 重定向只能进入镜像站配置的允许域名集合，最多跟随固定次数；每次跳转重新执行公网地址检查。
- [x] “任意节点”定义为任意已升级、宣告 `mirror_proxy` 能力且通过 WS/WSS 在线的节点。
- [x] HTTP 轮询节点第一版不承载实时镜像，管理端必须展示明确的不可用原因。

## 系统设计

### 请求链路

```text
Browser
  -> Master mirror route
  -> access policy and MirrorSite lookup
  -> selected WS/WSS Agent mirror_request
  -> Agent validates origin and performs HTTPS request
  -> Agent sends response headers and binary chunks
  -> Master streams status/headers/body to Browser
```

- [x] Master 接收镜像请求后，只根据镜像站基址和客户端路径生成目标 URL，不接受请求参数覆盖目标主机或协议。
- [x] Master 将 `Range`、`If-None-Match`、`If-Modified-Since` 等安全请求头按白名单转发；不转发 Cookie、Authorization、代理认证和任意客户端头。
- [x] Agent 负责真实 DNS 解析、目标地址校验、上游请求、重定向跟随和响应流读取。
- [x] Agent 回传最终状态码、允许的响应头和二进制分片；Master 不等待完整响应体后再返回。
- [x] 浏览器断开、超时、节点断线或上游失败时，Master 向 Agent 发送取消信号并释放会话。

### 数据模型

- [x] 新增 `MirrorSite` 模型，至少包含：
  - [x] `id`、`name`、唯一 `slug`、`enabled`、`createdAt`、`updatedAt`。
  - [x] `upstreamBaseUrl`，保存规范化后的公开 HTTP/HTTPS 基址。
  - [x] `allowedOriginsJson`，保存规范化后的允许上游域名集合。
  - [x] `nodeId`，关联指定出网节点并配置级联删除策略。
  - [x] `accessMode`：`ADMIN`、`SHARE`、`PUBLIC`。
  - [x] `shareTokenHash`、`shareExpiresAt`、`shareRotatedAt` 等分享凭据生命周期字段。
- [x] 为 `MirrorSite.nodeId`、`slug`、启用状态和创建时间增加必要索引/唯一约束。
- [x] 不在 SQLite 保存响应 BLOB；不新增外部数据库、Redis、消息队列或对象存储。
- [x] 在 `Node` 增加 Agent 能力字段或等价脱敏响应，至少能区分 `mirror_proxy` 能力是否已宣告。
- [x] 为敏感字段定义迁移、备份、轮换和脱敏规则；任何查询接口都不得返回 Token 哈希或明文凭据。

### Master 管理 API

- [x] `GET /api/v1/admin/mirrors`：分页查询镜像站，返回节点摘要、访问模式、启用状态和最近错误摘要。
- [x] `GET /api/v1/admin/mirrors/:id`：返回镜像站详情、允许域名、节点状态和可用访问地址。
- [x] `POST /api/v1/admin/mirrors`：创建镜像站，校验名称、slug、上游 URL、允许域名、节点和访问策略。
- [x] `PATCH /api/v1/admin/mirrors/:id`：更新配置；上游或节点变化后使旧运行会话按取消流程结束。
- [x] `DELETE /api/v1/admin/mirrors/:id`：删除镜像站并立即撤销分享地址。
- [x] `POST /api/v1/admin/mirrors/:id/rotate-share-token`：生成一次性明文分享地址，只在响应中展示一次。
- [x] `POST /api/v1/admin/mirrors/:id/test`：通过指定节点执行受限 HEAD/GET 测试，返回状态、延迟、最终域名和失败原因，不返回大响应体。
- [x] 所有管理 Controller 只做参数/身份/响应适配，Prisma 访问和业务判断集中在 MirrorService。

### 镜像访问地址

- [x] 管理员/公开模式使用 `/mirror/:slug/*path`，鉴权策略由镜像站配置决定。
- [x] 分享模式使用 `/mirror/share/:token/*path`，Token 映射到对应镜像站并校验过期/撤销状态。
- [x] 路径拼接必须保留合法查询字符串，拒绝协议切换、主机切换、路径越界和嵌入凭据。
- [x] 公开路由不得被 SPA fallback 错误接管；失败时返回明确的 404、403、409 或 502 语义。
- [x] 响应头只转发安全白名单和必要缓存/范围字段；过滤 hop-by-hop、Set-Cookie、上游鉴权和可能泄露拓扑的头。

## Agent 流式协议

### 能力与任务

- [x] Agent 心跳增加可选 `capabilities` 数组，新增 Agent 宣告 `mirror_proxy`。
- [x] Master 只有在节点状态为 ONLINE、通信模式为 WS 且能力存在时，才创建镜像流。
- [x] 新增 Master -> Agent `mirror_request`：`taskId`、HTTP method、目标 URL、允许域名、白名单请求头、超时、最大响应字节数。
- [x] 新增 Master -> Agent `mirror_cancel`：`taskId`，用于浏览器断开、超时和服务端异常。
- [x] 新增 Agent -> Master `mirror_response_headers`：`taskId`、状态码、内容长度、响应头和最终目标域名。
- [x] 新增 Agent -> Master `mirror_response_end`：`taskId`、已传输字节数和成功/失败状态。
- [x] 新增 Agent -> Master `mirror_error`：`taskId`、稳定错误码和脱敏错误消息。
- [x] 响应体使用 WebSocket 二进制帧；每帧以前缀标识 `taskId`，后续为 body chunk，避免完整响应 Base64 编码。
- [x] 所有 WS 发送复用现有写锁/发送串行机制；禁止多个 goroutine 并发写同一连接。
- [x] 协议扩展保持现有协议版本兼容；旧 Agent 不宣告能力时不得收到镜像任务。

### Agent HTTP 执行器

- [x] 新增独立 `internal/mirror` 包，避免把镜像逻辑塞入升级或探针包。
- [x] 仅接受 GET/HEAD；请求头按固定白名单复制，并统一设置受控 User-Agent。
- [x] 使用 context 控制单请求生命周期，确保节点断线、取消和超时都能终止 HTTP body 读取。
- [x] 最多跟随 5 次重定向；目标 host 必须匹配允许域名；每次跳转都重新校验 IP。
- [x] 拒绝 loopback、私网、链路本地、保留地址和云 metadata 地址，防止节点被利用执行 SSRF。
- [x] 默认单请求最多 10 分钟、响应最多 256 MiB、每节点最多 4 个并发镜像会话；常量集中管理并可测试。
- [x] 仅转发最终安全响应头，不向 Master 或日志暴露 Cookie、Authorization、完整 Token 或敏感查询参数。
- [x] 上游错误、响应超限、重定向越界、DNS 失败和取消都返回稳定错误码，便于前端展示和审计统计。

### Master 流会话管理

- [x] `MirrorService` / `MirrorTask` / `MirrorResponseStream` 与网关会话表共同管理 `taskId` 生命周期；Agent 入口限制每节点 4 个活动任务并返回 `BUSY`；Master 统一限制全局 16 任务、每节点 4 任务，按每流 1 MiB 预留正文缓冲，总 16 MiB。
- [x] 将 Agent 头部帧映射为 HTTP status/header，再将二进制帧写入 Express response。
- [x] 客户端断开时可靠触发 `mirror_cancel`，并在 finally 中删除会话、释放计数和清理定时器。
- [x] Master 会话只存于内存且不跨进程恢复，正常模块关闭会取消任务；异常退出依赖 WS 断开回收，客户端可能收到断流，不能保证始终返回 502/503。真实进程重启验收见未完成测试项。
- [x] 日志只记录镜像站 ID、节点 ID、目标 host、状态码、字节数、耗时和稳定错误码。

## 前端实施

- [x] 新增管理员路由和页面，例如 `/admin/mirrors`，纳入管理员导航。
- [x] 新增镜像站列表：名称、上游域名、指定节点、WS 能力、访问模式、启用状态、最近请求结果和操作入口。
- [x] 新增创建/编辑表单：名称、slug、上游基址、允许重定向域名、节点选择、访问策略、分享有效期和启用开关。
- [x] 节点选择只允许具备 `mirror_proxy` 的 WS/WSS 节点；离线节点可显示但不能提交或测试。
- [x] 新增分享 Token 一次性展示、复制、轮换确认和撤销后的状态提示。
- [x] 新增测试结果抽屉/对话框，展示最终状态码、耗时、节点、目标 host 和脱敏错误。
- [x] 遵循 shadcn/ui 和现有页面布局，使用统一 API 客户端，不直接调用 `fetch`。
- [x] 已维护 `docs/VISUAL_VERIFICATION.md` 的镜像页面索引；视觉验证按需且仅限 Antigravity，本轮未执行，不作为已通过记录。

## 安全与滥用控制

- [x] 镜像站固定上游，禁止把用户输入直接当成代理 URL。
- [x] 保存时和 Agent 执行时双重校验 URL、scheme、host、重定向和解析地址，不能只依赖 Master 的 DNS 检查。
- [x] 公开模式启用按 IP/镜像站限速、并发限制和失败请求审计；不得默认提供无限制匿名带宽。
- [x] 管理员模式使用现有管理员鉴权；分享模式使用高熵随机 Token、过期和轮换；公开模式只能访问固定白名单上游。
- [x] 过滤请求/响应 hop-by-hop headers、Cookie、Authorization、代理连接头和内部错误堆栈。
- [x] 全局并发/内存配额：Master全局16任务、每节点4任务，每任务预留1MiB正文缓冲，总16MiB，无等待队列；启动未返回/等待drain继续占槽，配额测试通过。
- [x] 增加受控安全测试：内网/metadata、混合 DNS 答案及重绑定、跨域/降级重定向、路径逃逸、Token 猜测与单流/单节点资源耗尽；证据见后文。
- [x] 不把镜像站作为用户订阅线路，不纳入现有代理流量账务；如未来纳入用户套餐，另立规划调整权限/计费模型。

## 测试清单

### Server 单元与集成测试

- [x] MirrorSite创建/更新完整回归：字段边界、合法创建编辑、重复slug与并发唯一约束均通过真实隔离SQLite迁移验证。
- [x] 管理员、分享 Token、公开访问三种模式的正向与负向鉴权。
- [x] 路径、查询参数、Range、HEAD、条件请求和上游状态码透传。
- [x] 重定向白名单、次数、非白名单和私网拒绝由 Agent 受控 HTTP/TLS/DNS 测试覆盖；Server 校验初始目标并传递允许域名，不能称为单独的 Server 重定向实现。
- [x] 节点离线、HTTP 节点、能力缺失、WS 断开、响应超限和客户端取消。
- [x] 分享 Token 过期、撤销、轮换和旧地址立即失效。
- [x] 三个隔离子进程验证正常关闭自然退出、异常终止后新PID重启、会话/容量/限频重建、旧taskId隔离及Agent断线清理；Service/Gateway真实，数据库与Agent使用受控夹具。

### Agent Go 测试

- [x] GET/HEAD 请求构造和请求头过滤。
- [x] IP 地址安全校验覆盖 loopback、私网、链路本地、metadata、IPv4-mapped IPv6 和公网地址。
- [x] 允许域名重定向、重定向循环、超时和 DNS 失败。
- [x] 响应头上限、响应体上限、单请求超时和 context 取消。
- [x] 二进制 chunk 帧 task ID 编码、损坏帧、未知 task、并发流和顺序保证。
- [x] Agent 连接关闭时所有镜像 goroutine 均可退出，满足 Go goroutine 生命周期约束。

### 本轮新增流控与清理回归

- [x] 写缓冲与排队分片合计 1 MiB、`drain` 恢复、慢客户端超限 `SLOW_CONSUMER`，不阻塞其他流与控制帧。
- [x] 结束/错误/超时/关闭/撤销统一收尾一次，迟到启动句柄立即清理；Token 提交失败不提前撤销，成功撤销后活动流停止。
- [x] 分享路由优先于 slug 通配路由；真实 Nest 路由用例覆盖 GET/HEAD 和通配路径数组。
- [x] 本轮完整本地 `pnpm gate` 已退出 0，证据为 `artifacts/verification/gate-submission.log`；镜像输入、容量、进程及网关套件均 PASS，Agent 与脚本回归通过。
- [x] 本轮镜像输出已绑定主实现38b1d6f与最终生产修复82c163e；镜像6套件173项、本地gate-final-ready及Agent/脚本通过，代码文档契约一致；外部部署验收保持独立未完成。本代码计划可按机械命令归档。

### 外部端到端验收（独立承接）

原“不同节点出口 IP”“GitHub Raw/API/Release/Range”“Release 重定向仍走指定节点”“HTML/Cookie/内链能力边界”四项迁至 [部署验收 A2—A5](../node-mirror-deployment-acceptance.md)，均未完成；测试站点应受维护者控制。隔离夹具不能替代公网实测。

原已勾选门禁为历史记录；本轮完整本地gate、最终集成提交绑定与文档一致性核对均已通过，外部验收仍由独立计划承接。

## 文档与版本同步

- [x] 更新 `docs/DATA_MODELS.md`：MirrorSite 字段、索引、分享 Token、节点能力和备份规则。
- [x] 更新 `docs/API_AND_PROTOCOLS.md`：管理 API、镜像路由、访问策略、Agent 消息帧、二进制分片、限额和错误码。
- [x] 更新并核对 `docs/ARCHITECTURE.md`：Master-Mirror-Agent 数据流、断开/取消、WS-only 及全局 16 任务/16 MiB、每节点 4 任务配额与 API 文档、实现一致。
- [x] 更新 `docs/DEPLOYMENT_GUIDE.md`：生产 HTTPS/WSS、公开模式限速、上游域名配置和日志隐私要求。
- [x] 更新前端规范/视觉验证台账，记录镜像站页面与验证范围。
- [x] 更新根 `CHANGELOG.md` 和必要的 `apps/agent/CHANGELOG.md` 的 `[Unreleased]`。
- [x] 不在日常特性 PR 中修改版本号；发版时按版本治理流程固化版本。
本代码计划未完成项清零、证据与最终提交匹配后，由主代理执行 `pnpm plan:archive node-mirror-site-proxy.md` 并刷新索引。部署验收计划独立保持未完成，不能同时归档。

## 发布、回滚与运维交接

原发布前备份、Master/Agent 滚动升级、旧 Agent 能力拒绝、先 ADMIN/SHARE 后 PUBLIC、运行监控、滥用处置和回滚七项已迁至 [部署验收 A6—A12](../node-mirror-deployment-acceptance.md)。其中代码已有能力拒绝、默认 disabled、撤销和清理回归，但部署行为本身没有执行证明；不得仅因代码通过而勾选生产项。

## 验收记录（区分历史与本轮）

- [x] 历史数据模型与迁移记录：已生成并部署 `20260909090000_mirror_sites`，包含 `Node.capabilitiesJson`、`MirrorSite`、唯一 slug、索引和级联关系。
- [x] 历史 Server API/流式代理测试记录：新增镜像安全单测；全量 Server 门禁 54 个测试套件、371 个测试通过；运行态未知 `/mirror` 路由返回 404，管理 API 未登录返回 401。
- [x] 历史 Agent 协议与 Go 测试记录：`go test ./...`、`go vet`、gofmt 和 Linux amd64 构建通过；新增 SSRF、映射地址和方法限制测试。
GitHub Raw/API/Release 联调结果：待部署验收 A3，尚未取得外部证据。
- [x] 本轮隔离安全与滥用回归已添加；Master 定向日志 3 套件/66 项通过，测试范围及最新 Go 门禁证据见下表。
前端视觉验证结果：本轮未执行；不将其作为 CI 或本轮必需项，按需在 Antigravity 中另行记录。
- [x] 历史五合一门禁记录：`pnpm gate` 全绿；Web 构建仅保留既有 chunk size warning。
生产灰度与回滚演练：待部署验收 A6—A12，本轮未操作生产。


### 本轮完成证据映射

| 行为 | 实现与用例 | 已取得的证据/局限 |
| :--- | :--- | :--- |
| ADMIN/SHARE/PUBLIC、过期/撤销/轮换、地址/请求头/响应状态 | `apps/server/src/mirrors/mirror.service.spec.ts` | `.cache/mirror-server-final.log`：3 套件/66 项 PASS；最新 `artifacts/verification/gate-submission.log` 的镜像套件均 PASS |
| 流控、单次结算、迟到回调、模块关闭 | `mirror-stream.ts` 与上述服务测试 | 1 MiB、drain、声明/实际正文超限、模块销毁、Token 并发变更已有断言；不证明全局配额或真实进程重启 |
| Nest 路由、未知/损坏/跨节点帧 | `mirror-public.controller.spec.ts`、`mirror-gateway.spec.ts` | 包含在上述 66 项定向输出；路径及帧顺序回归通过 |
| Agent 目标与流式执行 | `apps/agent/internal/mirror/network_test.go`、`stream_test.go`、`mirror_test.go` | 已核对重绑定、固定拨号 IP、64 KiB 响应头、HEAD 大长度元信息、压缩字节、重定向、取消与超时测试；最新 `artifacts/verification/gate-submission.log` 已记录 mirror/ws/poll 包通过及 Agent 门禁通过；不证明外部节点出口 |
| Agent 接入与退出 | `apps/agent/internal/ws/client_test.go` | 已有立即取消、4 任务 admission、并发分片/控制帧、panic 和读循环等待退出用例；不宣称现网压测通过 |
| 完整本地工程状态 | `artifacts/verification/gate-submission.log` | 完整 gate 退出 0；Server 124 套件/1597 项通过，另 11 套件/105 项 native 跳过；Web 144 项、脚本 106 项、维护 33 项通过，脚本另 4 项默认跳过；Agent 通过。旧 discovery/E2E storage 失败日志只作历史记录 |

### 主代理待收口

创建/更新与唯一约束、Master 全局配额、真实隔离进程重启/断线、完整本地 gate 及架构/API 文档一致性均已有本轮证据，旧缺口描述撤回。代码与隔离验收已满足本地完成条件，仅余最终集成提交绑定和主代理机械归档决定；本次只写计划、不提交，不因缺提交号提前归档。外部出口和部署 A1—A12 全部保持未完成。

- 追加验收：镜像域6套件173项通过，原66项保留；scope ESLint、独立fixture语法检查通过，记录位于本地.cache/mirror-phase2-final.log。
