---
title: 统一延迟测试入口并保留严格调试能力
type: plan
status: completed
target_version: Unreleased
created_at: "2026-10-03"
author: "Maintainers & PI-Desktop"
archived_at: "2026-10-03"
---
# 统一延迟测试入口并保留严格调试能力

## 批准范围

前端线路、上游及相关延迟展示统一为「延迟测试」，不展示内核名称、版本、策略或基础/高级切换。默认测量计划采用固定 Mihomo 1.19.30 内部 URLTest、开启 unified-delay；原严格 CONNECT/TLS/HTTP GET 实现保留后端，供未来高级调试使用，本次不建设高级调试入口。

复用异步任务、短配置快照、受管临时内核、回环控制 Secret、就绪屏障、32 资源批次与全局 4 连接/2 进程限制。不同测量快照不得互相覆盖或改写旧结果口径；旧严格快照保留至 lastDebugProbeJson，现有字段服务新延迟展示。线路定时任务跟随新路径，上游不新增定时任务。Agent 网络探针、下载源带宽测试、模板校验及业务权限/启停不改变。

## 当前状态：普通语义获批，已完成验收

初始计划要求固定实际目标 IP，原生补验证明直接 URLTest 不满足该承诺，故先暂停默认切换。维护者随后明确批准「普通延迟测试即可，继续完成剩余任务」：日常允许代理侧解析目标域名，不再要求远端目标 IP 固定或严格 HTTP 状态；仍保留目标公网前检、节点端点策略和 HTTPS 证书校验，不替换 HTTPS 域名或静默回退。

当前分支 feat/probe-latency-test 已完成 schema2 / MIHOMO_URL_TEST 普通路径、历史严格快照迁移/序列隔离与前端统一；schema1 / PROXY_HTTP_DELAY 严格方法仅内部保留，无高级入口。E2E 库在一致性备份后完成迁移并保留原订阅/节点/线路配置；六项门禁通过，不提交/推送/升版。

## 执行清单

- [x] 固定版本原生验证、目标地址对照和限制记录
- [x] 维护者批准普通目标解析边界，并通过 HTTP/HTTPS 原生语义验收
- [x] 默认 URLTest 执行路径、公开入口与线路定时调度；保留严格内部能力
- [x] 新旧测量结果安全解析、快照迁移、序列隔离和消费方联动
- [x] 前端统一语义、去掉内核/回退信息及隐藏设置防配置覆盖
- [x] 同步 API/架构/约束/数据模型/UI 索引及 E2E 消费者
- [x] 原生、迁移、任务/前端契约与全量门禁验收后归档

## 原生证据

复现：`apps/server/src/probe/executors/mihomo-urltest.native.spec.ts`，显式 `RUN_NATIVE_CLIENT_TESTS=1` 才运行。

实验全部使用隔离本地夹具。`original.example` 的 hosts 固定为 `127.0.0.1`；代理在收到原域名时模拟另一解析结果 `127.0.0.2`，两地址目标端口一致。此处回环地址仅为测试夹具，不表示生产目标允许私网。

1. DNS 启用和禁用两种配置均已在官方 Mihomo v1.19.30 Windows amd64 二进制复现。
2. URLTest 仍发出 `CONNECT original.example:<port>`，未发出已固定 IP；两次 HEAD 均到达替代地址。固定 hosts 与一次 Master DNS 公网预检不能保证代理侧实际目标地址。
3. `expected=204` 下替代目标返回 HTTP 500，delay API 仍返回 HTTP 200 和 delay。该限制属于日常 URLTest 的已知语义，不可视为严格目标验证通过。
4. 控制组使用现有 `proxyHttpDelay` 发出 `CONNECT 127.0.0.1:<port>`，保留原域名 Host，只命中已固定目标。
5. 源码对照：`adapter/adapter.go` 的 URLTest 直接调用 `p.DialContext`；HTTP outbound 根据原 metadata 构造 CONNECT，普通 hosts/路由解析并未把该目标替换为已校验 IP。

这不是生产漏洞修复，也不能推出 URLTest 本身不可用；它证明按当前临时配置直接替换会丢失原目标地址固定的承诺。HTTPS 证书验证也不能替代实际目标 IP 控制。

## 已批准的后续决策

采用普通 Proxy.URLTest 语义、unified-delay=true、固定 Mihomo 1.19.30；目标保持原域名/TLS，允许代理侧解析，前检不能证明远端 IP 固定。该差异明示于 PROJECT_CONSTRAINTS、TECH_STACK、API_AND_PROTOCOLS，不把 URLTest 成功冒充严格访问验证。

不新增批次转接、外部服务或常驻进程，不升级/自编内核；普通不回退，内部分别保留严格能力。新安装默认 HTTPS generate_204 和 10000 ms，已有显式值保留；前端隐藏回退设置且不提交其值。

下方首次验证与真实对照是批准普通语义前的历史证据；其「暂停/未改生产」描述仅代表当时阶段，不代表当前实现状态。

## 首次阶段验证记录（历史）

- Windows 原生边界用例：2/2 通过，分别为 DNS 开/关；含 HEAD 次数、实际 CONNECT/目标、非 204 返回 delay 和严格路径对照。
- 现有严格 Mihomo 原生回归：5 项通过，覆盖正确/错误鉴权、十次冷启动、200/302/500 拒绝、超时/取消和不可信 TLS 证书拒绝。Sing-box 对照用例未执行，本次无 Sing-box 代码变更。
- 后端 `tsc --noEmit` 和新原生测试文件 ESLint 通过。
- 二进制下载至会话 scratch，准备脚本校验固定版本资产；夹具不使用默认数据库或公网业务节点，受管子进程与监听在 finally 回收。
- `scripts/dev-e2e.sh` 未消费同步测速结果，本次没有 API/启动契约变更，故不修改 E2E 启动脚本；正式默认切换阶段仍需评估任务集成及 fixture。
- 没有前端改动，未执行视觉走查；未提交、推送、升版或发版。
- `pnpm gate` 六项门禁全部通过（version/docs/i18n/server/web/agent），`git diff --check` 通过；普通门禁默认跳过 opt-in 原生用例，以上 2 项新证据及 5 项严格回归已单独显式运行。前端构建仍有既有大 chunk 非阻断警告。门禁通过不代表 URLTest 默认切换的目标安全验收通过。

### 切换前 E2E 真实订阅对照（历史，用户授权）

使用当前运行实例标记对应的 `apps/server/prisma/dev-e2e.db`，通过 SQLite 只读连接读取已导入快照，不重新拉取订阅、不调用会写回测速结果的业务接口。共 1 个启用订阅、48 个启用且 PRESENT 的 VMess 节点；复用正式连接解密/结构校验、目标与端点公网校验及连接地址固定，未放宽 DNS 或证书策略。

- 固定 Mihomo 1.19.30；原生对照开启 unified-delay、关闭内置 DNS，并配置目标 hosts。严格组复用现有 MihomoExecutor。两组共用本次解析并校验的 HTTPS 目标 `https://cp.cloudflare.com/generate_204`（预期 204），同一节点端点地址；每批不超过 32、至多 4 个并发请求，两种执行顺序先原生后严格，不代表统计性能基准。
- 3 个节点在端点 DNS 准备阶段失败；复查均为 ENOTFOUND，未请求其代理端点。其余 45 个节点实际执行两种方法。
- 当前默认 3000 ms：原生与严格组均成功 16/45，成功节点集合一致，未出现仅原生成功或仅严格成功。原生成功延迟 279–474 ms，中位数 386.5 ms；严格成功延迟 1122–1845 ms，中位数 1591.5 ms。原生按预热后的 HEAD 口径返回，严格按 CONNECT/TLS/GET 全链路计时，不能把差值解释为线路性能提升。
- 其余 29 个节点：原生 delay API 均失败；严格组 28 个 NETWORK_TIMEOUT、1 个 DIAL_FAILED。仅对此 29 个节点延长至 10000 ms 复测，两组仍全部失败，严格组均为 DIAL_FAILED；仅凭该现象不能定位为软路由、节点失效或代理协议故障。
- 订阅、节点和系统设置完整内容的测试前后摘要一致；未写回延迟、快照或设置，临时内核在 finally 中停止并清理，scratch 无残留 riri-client 临时目录。临时脚本与脱敏 JSON 报告仅在会话 scratch 保存，不包含订阅 URL、节点名称/地址或凭据。初次准备脚本未解密参数导致 48 项解析失败、未发业务请求，改为正式 readUpstreamConnection 并加载已有 E2E 密钥后完成以上有效对照。
- 当前宿主网络（含用户所述上游软路由）允许至少上述 16 个节点完成请求；未做软路由旁路 A/B，不能判断它是否影响其余节点或延迟。节点 DNS 前置失败没有出现 ADDRESS_POLICY_REJECTED，不能据此声称检测到 Fake-IP。
- 此结果是实际连通性/计时口径对照，不是目标地址边界验收：没有观测 VMess 远端出口实际连接的目标 IP，配置 hosts 不等于验证固定成功；当前全部为 VMess 也不覆盖原 HTTP 出站限制。默认切换仍暂停，不改变原生隔离夹具的证据结论。
- 本轮没有修改生产代码、前端或 API，故不重复全量代码门禁；新增测试记录后复跑文档门禁与 diff 空白检查。

## 最终实施与验收记录

- 普通路径复用受管 Mihomo 执行器，经回环鉴权控制 API 请求指定 proxy 的 URLTest；unified-delay=true，原目标 URL/HTTPS 不改写，TLS 校验未关闭。响应只接受有界正整数 delay，16 KiB 响应上限，外部取消/控制端超时/内核退出均失败并清理；保留全局 4 连接/2 进程、32 批次及就绪屏障。控制请求额外 500 ms 收尾预算计入批次进程看门狗。
- schema2 普通、schema1 严格分别读写与去重/序列隔离。快照迁移不删除业务数据；写回显式保留配置 updatedAt，普通不覆盖严格历史，严格不覆盖当前摘要。用户/代理池/线路/节点关联只消费普通安全结果并剥离严格历史，不使用旧数字回退。
- 前端单一延迟入口，不展示内核/版本/兼容/回退/模式选择，原始技术错误也不回显。中文新词条由 t 引用，英日缺新词条按基准回退。隐藏回退设置不提交，显式旧超时保留，新默认十秒。Agent 探针、下载源测速、模板校验与业务启停未改变。
- `pnpm gate` 六项全部通过：后端 101 套件、919 项通过，opt-in 原生等 8 套件/55 项默认跳过；Web 构建有既有大 chunk 非阻断警告。另显式运行本次 Mihomo 普通 5 项、边界 2 项、严格关键 5 项原生回归，共 12 项通过，Sing-box 对照项未运行。
- 前端 `node --test apps/web/src/lib/*.test.mjs` 37/37 通过；其中普通快照拒绝 schema1/TCP/fallback/异常 delay、策略不提交、隐藏设置不提交、任务关闭重开/取消/全局互斥/终态失效与安全错误回归通过。额外代理池页面静态断言有一个既有无关失败：期望 disabled 的字面表达式与未改文件使用的等价 isAvailable 表达式不同，未越界修改；不影响上述门禁/延迟契约。
- 迁移回归 2/2 通过，夹具仅 session scratch；`scripts/client-probe-integration.cjs` 使用临时库完成真实 JWT/RBAC、202 任务、普通 schema2 写回、STALE 和取消，以及内部严格状态/TLS方法保留。该脚本的额外受信 HTTPS PEM 夹具缺失而跳过，不把它计为执行；本次原生已验证普通/严格不可信 TLS 拒绝，真实订阅验证公网 HTTPS 成功。`scripts/dev-e2e*` 无测速结果消费，启动协议无需改。
- 一次限定只读检查发现后端快照对小数/超 uint16 延迟的校验与前端不一致；新增两项用例先复现失败，随后修复并重跑 45 项相关回归与全量门禁，保持严格零延迟历史契约；未再启动宽泛审查。
- 当前 E2E 库：先使用 SQLite backup API 保存包含 WAL 的一致性备份至会话 scratch `e2e-before-latency-migration.db`，确认仅本次迁移待执行后应用。核对 1 订阅、48 节点、4 线路的配置字段不变，旧 lastProbeJson 原样归档、当前摘要清空，设置不变，integrity/foreign_key_check 正常；未迁移默认 dev.db。
- 最终真实订阅：只读 E2E 快照直接调用生产 ProbeService.executeBatch，默认 10000 ms、48 项均为 schema2 / MIHOMO_URL_TEST，无回退；16 项成功，254–425 ms、中位数 384 ms；3 项 ENDPOINT_DNS_FAILED、29 项 URLTEST_FAILED。运行前后订阅/节点/设置摘要不变，未写回测试结果。失败不自动禁用节点，不据此定位软路由故障。
- Windows 首次 prisma generate 因运行实例锁 DLL 报 EPERM；类型文件已更新且类型检查通过，随后实例退出后完整 generate 成功。迁移前旧实例曾因新增列缺失报 P2022；迁移后恢复 Master/Web，使用原库/原密钥和项目固定内核缓存，未重新启用线路/重建 Agent。启动命令子进程曾被工具环境回收，改为独立本地开发进程后跨命令确认管理员登录 200、上游列表 48/线路列表 4 且无严格历史泄露、Web 代理 200，临时内核目录无残留。
- 未执行视觉走查（仅用户请求后的 Antigravity 环境允许），已维护 VISUAL_VERIFICATION 台账；无提交/推送/升版/发版，版本保持 0.9.12，普通解析边界调整及结果契约变化在 Unreleased 与规范明确记录。
