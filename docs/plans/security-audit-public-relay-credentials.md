---
title: "公开线路与中继落地凭据安全整改"
type: plan
status: active
target_version: "Unreleased"
created_at: "2026-09-08"
updated_at: "2026-11-17"
author: "Codex Security & Maintainers"
---

# 公开线路与中继落地凭据安全整改

## 背景、批准设计与证据口径

本计划承接 2026-09-08 的两条原始发现：固定测速身份在订阅过滤后被追加到公开入站；协议代理中继入口/落地使用全局固定身份。本轮复核不继续引用已漂移的旧行号，不将新增源码或子任务口头完成报告当成整体验收通过。

维护者已明确变更旧计划设计，以下是当前终态，不再等待“Agent 本地探针还是临时账号”的选择：

1. **测速使用合法订阅身份，由 Master/Mihomo 执行完整线路路径。** 管理员设置 `lineSpeedtestUserId: string | null`；自建线路只使用所选账号的真实 UUID/credential。每次手动/定时任务重验账号启用、邮箱策略、订阅状态/期限、配额、套餐及额外线路授权，正常计费。未配置/不可用/无线路权限时返回固定错误码，不自动借用账号、不创建隐藏用户、不授予额外权益。外部/上游资源仍使用原有凭据。
2. **保留异步拨测契约。** `202` 任务与 `MASTER / MIHOMO_URL_TEST` 语义不变；排队快照绑定身份，写回事务重验权益及凭据指纹，换账号/撤权/换凭据后旧成功结果不能覆盖新状态。普通流量增长本身不使快照失效。
3. **中继按源线路隔离。** `PROTOCOL_PROXY` 与 `TARGET_LINE` 各自取得随机凭据，AES-GCM 保存；目标直连入站只增加实际引用它的源线路身份。独立共享 SS 可逐线随机密码，共享目标 SS 必须支持多用户，不共享全局 transit 身份。
4. **维护式轮换，允许停线。** `STOPPING_ENTRY → APPLYING_LANDING → RESTORING_ENTRY → CONFIRMED`；迁移节点/Tag 时先 `STOPPING_PREVIOUS_ENTRY → RETIRING_PREVIOUS_LANDING`。每阶段 120 秒，同线只一项任务。回执仅表示接受，实际下发配置证明、配置版本匹配的心跳及内核运行共同确认阶段。失败保持期望停用，重试沿用候选版本；不自动恢复旧固定值，不声称断网节点已立即停机。
5. **边界与计量。** 公网中继要求认证加密：VMess 固定协议加密、SS 认证加密算法，其他相关协议要求有效 TLS，显式 insecure 拒绝；不假设有私网。内部统计指纹必须绑定实际落地节点与入站线路，不能用名称前缀免计费。撤销认证密文后保留历史统计指纹不代表旧凭据仍可认证。
6. **本轮只做代码/CI/隔离验收。** 不部署生产、不正式发版，不加入 Webhook、规则更新、支付或 WireGuard；不新增 Agent 本地测速协议/临时测速身份、外部数据库、Redis、MQ。

以下编号延续旧清单便于追溯；涉及旧 Agent 本地/临时测速策略的 0.4、2.3—2.6 和原子无停机轮换 3.4 已由上述批准设计替代。已勾项表示对应实现或已获得的限定证据，末尾全量/native/安全复扫仍须单独完成。计划保持 active，当前不得归档。

## 里程碑 0：复现与设计

- [x] 0.1 固定身份回归用例已建立：`agent-gateway.service.spec.ts` 的两项 credential regression 分别禁止空订阅公开入站隐藏身份和不同落地入站共用身份。先失败记录由总计划保留，当前实现不再注入固定值。
- [x] 0.2 测速入口已迁为 `ProbeResourceService / ProbeTaskService` 的所选订阅身份，手动及定时共用检查；自建/上游/EXTERNAL 分支有回归。
- [x] 0.3 节点/目标关系、实际回源地址、NAT 隧道适用范围、公开加密边界及 config_apply_result/heartbeat 字段已在 topology helper 与用例中明确。
- [x] 0.4 冻结合法订阅 Master/Mihomo、逐源线路 AES-GCM、维护式轮换方案；`LineCredential` 与 `LineCredentialRotation` 采用追加迁移。
- [x] 0.5 无固定凭据兼容分支；首次初始化与轮换失败期望停用入口，运行确认后撤销旧版本密文，失败重试复用候选版本。

## 里程碑 1：受保护的凭据与协调服务

- [x] 1.1 `LineCredentialsService` 集中提供准备、读取、轮换、阶段对账与状态接口；Controller 复用服务。
- [x] 1.2 `line-credential.types.ts` 使用随机 UUID/名称/密码与现有 AES-GCM；密文信封、指纹、随机性及解析失败脱敏有测试。
- [x] 1.3 用途限定中继，绑定源线路、版本与当前/原拓扑；不新增 SPEEDTEST 系统身份，合法拨测直接用用户凭据。
- [x] 1.4 数据表/唯一约束保存密文、名称/UUID 哈希、候选/激活/撤销版本、operationId 与目标配置版本；迁移本身不植入秘密。
- [x] 1.5 同线并发创建/轮换去重，状态更新匹配读取时阶段、节点、配置版本及期限；旧失败回执和旧超时扫描不能覆盖新登记/重试，相关 SQLite 用例已存在。
- [x] 1.6 本轮本地脱敏回归与隔离 smoke 通过：节点详情/list 不重放 Token，轮换仅一次性返回新 Token，旧 Token 401/新 Token 201；失败摘要及 71 条日志无秘密。定向 red 2 项后 green 24/24；Node 22 完整 smoke 13 阶段/14 项通过，证据见下表。
- [x] 1.6a 已完成最终输出面复核：等价静态审查覆盖HTTP/订阅/错误/日志/SSE调用链，节点Token与原始paramsJson泄漏均有真实Master复现与修复；不把模拟Agent日志外推为生产全量日志采集。原始源码2ddf895的关联参数泄漏与82c163e修复由node-relation-red-green.json对照证明，smoke15阶段16/16及Nodes51/51通过。

## 里程碑 2：公开线路与合法订阅拨测

- [x] 2.1 删除生产常量中的固定测速身份；本轮源码检索未见 `INTERNAL_SPEEDTEST_*` 生产引用。旧值仅允许在明确认证拒绝测试夹具中存在。
- [x] 2.2 网关公开用户筛选复用 `evaluateSubscriptionEntitlement`，空订阅不生成隐藏入站用户，普通入站均携带实际 lineId。
- [x] 2.3 替代旧 Agent 本地任务：管理员专用账号选择、保存时资格校验和执行时重验已接入；未配置默认 null，只向管理端返回。
- [x] 2.4 自建直连、中继仍从 Master 侧按完整线路连接拨测，不新增公网测速身份；EXTERNAL/上游身份保持原契约。
- [x] 2.5 替代旧临时身份过渡：不生成临时测速用户、不回退固定账号；四个安全错误码与共享结果提示已对接，不展示任意底层异常。
- [x] 2.6 身份快照与事务内重验已实现，覆盖禁用、未验证邮箱、到期、配额耗尽、无授权、换账号及换凭据；正常入账增量不使任务无效。
- [x] 2.7 82c163e五平台原生任务均已实际执行专用订阅账务4项，逐断言PASS，普通延迟/strict/超时/取消现有套件随本轮运行。共享SS不可逐用户计量时明确在拨号前拒绝，SS2022 multi-user身份正例保留。整轮CI仍待单独的Linuxamd64临时端口清理修复，不把局部PASS等同整轮成功。

## 里程碑 3：中继隔离与维护式轮换

- [x] 3.1 生产固定中继常量和按旧内部名称的账务特判已移除；旧名负例证明不能免计费。
- [x] 3.2 网关按源线路材料生成协议出站；VLESS/VMess/Trojan/Hysteria2/TUIC/Naive/SS 采用对应编译器凭据映射。
- [x] 3.3 独立落地仅接受当前源线路身份；TARGET_LINE 只增加实际关联的中继身份，共享目标 SS 不支持逐用户时拒绝。
- [x] 3.4 停入口、确认停止、应用落地、确认运行、恢复入口、最终确认的持久状态机已实现；最终配置证明、原拓扑撤销、失败保持停用与幂等重试均有 SQLite 用例。
- [x] 3.5 Windows 真实内核已证明 VLESS/VMess/Trojan/Hysteria2/TUIC 的跨线路、旧固定值、未登记身份和轮换旧值拒绝（37 项）。Linux Naive 与五平台最终集成仍由 5.5/5.7 保持未完成。
- [x] 3.6 topology helper 依实际路径区分公网/私网/NAT，拒绝危险配置覆盖和 TLS insecure；维护中的节点/线路危险编辑在事务内检查冲突，最终下发配置另作证明。
- [x] 3.7 已接入配置/节点/入站匹配的落地拒绝计数与线路维度脱敏告警，短窗事件去重、30秒增量聚合、有界容量及停机刷出；4套件161项通过，完整Master smoke通过HTTP通道验证3次报告只计2个事件。只统计可识别的已上报拒绝；Hysteria2静默分支与日志丢失不假称零，边界见API §6.4。

## 里程碑 4：数据、接口、文档与升级说明

- [x] 4.1 追加 `20261117040000_line_credentials`，已有历史 migration 未修改；初始化由应用短事务生成随机材料，删除关系与唯一索引已声明。
- [x] 4.2 数据文档的新表、订阅拨测设置及统计归属已核对；原固定内部中继凭证表述已替换为按源线路/版本隔离的随机身份与节点/实际入站/哈希作用域。API 固定 transit、固定测速注入及免计费旧段落一并清理；备份/恢复语义由维护文档、33项回归及隔离发行包报告交叉验证。
- [x] 4.3 已新增 ADMIN 的 `POST /admin/lines/:id/credentials/rotate`（202）与 `GET .../status`；状态只返回白名单。复用原 Agent config_sync/回执/心跳，无新增本地探针消息。
- [x] 4.4 部署/API/架构已补维护轮换、运行确认、TLS/实际拓扑与脱敏说明；这是文档交付，不表示生产操作完成。
- [x] 4.5 合法订阅拨测、禁止隐藏身份及按源线路中继隔离已有专项可复跑回归：订阅/网关/凭据套件及 `scripts/credential-governance.test.mjs` 在 `gate-submission.log` 中通过；完整静态安全审查另由 5.8 跟踪。
- [x] 4.6 Master/Agent 的本轮 Unreleased 已更新，日常两条版本保持不变；本轮 `gate-submission.log` 已记录版本与文档门禁通过；4.2 所列文档遗留冲突也已复核清理。
- [x] 4.7 升级按备份、迁移、初始化、维护下发、运行确认设计；无长期固定值兼容。实际部署须另行授权，不能在本计划收尾中执行。

## 里程碑 5：最终验证与合并门禁

- [x] 5.1 `scripts/credential-governance.test.mjs` 递归扫描生产 Server TypeScript，拒绝旧固定测速/中继名称与值，明确排除 spec/test/native-fixture；`gate-submission.log` 记录该脚本检查通过。
- [x] 5.2 授权集合、同节点跨线/跨节点/无后缀身份不得免计费、实际落地统计作用域已有网关回归；最终配置证明拒绝空落地/错身份。
- [ ] 5.3 最终原生认证验证覆盖无订阅、无效身份、旧固定身份、其他线路、撤销/旧版本及缺失材料；不得因普通 gate 跳过 native 而勾选。
- [x] 5.4 本轮本地重启、并发轮换、迟到回执、超时、拓扑变更与隔离备份恢复专项回归通过；Node 22 完整 smoke 13 阶段通过、总测试 14/14，运行版本/内核状态门槛、中途重启、幂等重试、脱敏和优雅解锁均有实测。
- [ ] 5.4a 将上述本地证据绑定最终集成提交；当前只有工具链提交 `f982646`，其余集成尚未提交，五平台 CI/PR/合并另行完成。
- [ ] 5.5 VLESS、VMess、Trojan、Hysteria2、TUIC 及 Linux Naive 真实认证、中继路径与错误场景通过；新增 native fixture 不能视为执行证据。
- [x] 5.6 本轮完整本地 `pnpm gate` 退出 0，六类基础门禁、脚本及维护测试通过；真实双库迁移由维护报告及 smoke 迁移阶段证明。Server 11 套件/105 项 native 与脚本 4 项默认跳过不计作原生成功，最终提交绑定继续由 5.4/5.7 跟踪。
- [x] 5.6a 本轮既定安全门禁通过：pnpm audit high（主代理确认）及 Go 1.26.11 的 Windows amd64/Linux amd64/arm64 源码可达性扫描均通过。二进制 3 项保守告警、exit 3 继续留档，不等同本次门禁失败，不追加全部第三方 advisory 清零或范围外依赖升级要求。
- [ ] 5.7 五平台 CI 绑定同一最终提交，记录 workflow/job 与产物；计划仍有未完成项时不归档，不使用 --no-verify 或过滤失败用例。
- [x] 5.8 等价人工静态审查已完成并保留security-review-final.md/json，两个原始固定身份发现关闭；发现并修复安装器URL Token、节点关系原始paramsJson泄漏，明确共享SS拨测计量能力边界。记录已审文件hash、覆盖及未覆盖范围；未宣称运行Codex Security产品。父线补充冻结旧源码/修复源码对照及最终源码指纹。

## 当前证据映射（2026-11-17）

| 范围 | 代码/工件 | 能支持的结论 |
| :--- | :--- | :--- |
| 公开授权、固定身份配置负例 | `agent-gateway.service.spec.ts`、`agent-gateway.authorization.spec.ts`、`common/inbound.spec.ts`；`artifacts/verification/gate-submission.log` | 本轮完整本地 gate 中对应套件已通过；节点 Token 修复后的 Node 22 完整 smoke 亦通过 |
| 合法订阅拨测 | `common/subscription-entitlement.spec.ts`、`probe-subscription.spec.ts`、`settings-speedtest.spec.ts` | `gate-submission.log` 相应套件 PASS；实测计费 native 不在该普通 gate 执行范围 |
| 密文、拓扑、维护状态机 | `line-credential.types.spec.ts`、`line-credential-topology.spec.ts`、`line-credentials.sqlite.spec.ts`、`line-credential-diagnostics.spec.ts` | `gate-submission.log` 中凭据 SQLite、Controller、节点维护冲突与安全复核套件 PASS；最终集成提交尚未绑定 |
| 隔离备份恢复 | `artifacts/maintenance-node22/result.json`、`test.log`；`artifacts/maintenance-review/run-9dlnWM/report.json`；`artifacts/verification/gate-submission.log` | Node 22.23.5 基线 21 项通过、exit 0；发行包真实迁移/HTTP 200及创建→校验→隔离恢复报告 `ok:true`；最新维护 33 项通过。不证明 Linux/Docker 实际启动、生产恢复或全部中继重新上线 |
| Windows 既有内核原生 | `artifacts/native/windows-amd64/summary.json`、`jest-results.json` | 2026-11-17 04:45（北京时间）阶段性 8 套件/53 项 + 7 脚本 PASS；不包含专用账号计量套件 |
| Windows 新增中继认证 | `artifacts/native/windows-amd64/relay-credentials/summary.json`、`windows-jest.json` | 2026-11-17 10:03（北京时间）、37 项 PASS、0 跳过/0 openHandles；五协议合法请求/旧固定值/错认证/跨线/轮换拒绝真实通过，不覆盖 Linux Naive 或多节点状态机完整部署 |
| 完整本地门禁 | `artifacts/verification/gate-submission.log` | 已退出 0：Server 124 套件/1597 项、Web 144 项、脚本 106 项、维护 33 项通过，Agent 通过；Server 11 套件/105 项 native 及脚本 4 项默认跳过。早期 discovery/E2E storage 失败被成功复跑取代，不替代远程 CI |
| 完整隔离 smoke 与 Token 修复 | `artifacts/verification/remediation-smoke.json`、`remediation-smoke-test.log`、`remediation-smoke-red.json`、`node-token-red.log`、`node-token-green.log` | 最新 Node 22.23.5 smoke `PASSED`，13 阶段/总测试 14 项通过，约 33 秒；普通详情/list 无 Token，轮换一次性新 Token 与旧 401/新 201、71 条日志脱敏、临时双库及优雅解锁均通过。旧 12/13 red 保留，Agent 为回环模拟端，不替代原生认证/生产审查 |
| 工具链与安全审计 | `artifacts/verification/go1.26.11-audit/summary.json`、`DEPENDENCY-RISK.md`；主代理确认的 pnpm audit high 结果 | 实际 Go 1.26.11，工具链提交 `f982646`；pnpm audit high 与 Windows amd64/Linux amd64/arm64 源码可达性门禁通过。二进制 3 项保守告警/exit 3 保留为明确边界，不等同本次门禁失败，旧审计 metadata 不替代本轮结论 |
| 外部/生产 | 无本轮授权与工件 | 不操作真实数据库、Agent 配置或生产入口，不记录现网已整改 |

## 发布、回滚与归档交接

发布前由维护者另行授权维护窗口，按部署指南冷备业务/观测双库、WAL/SHM 和运行资源，并验证加密密钥与恢复路径。升级迁移后须逐线确认入口停止、落地新配置运行及入口恢复；离线节点继续显示未确认，不能以 Master 期望配置当作远端已经执行。

旧配置含固定身份的节点需要在维护窗口中实际重载或隔离；本轮代码修复不会追溯删除远端旧文件。回滚只使用仍支持隔离凭据的相容版本，禁止恢复固定身份以换取可用性。故障状态显式重试，日志只含脱敏阶段、版本与错误码。

本计划仍有代码证据缺口、原生/CI 和安全审查未闭合，**当前不在可直接归档清单中**。主代理完成所有本轮验收并记录最终提交后，才能执行 `pnpm plan:archive security-audit-public-relay-credentials.md`；本次不触碰总计划或索引。

- 追加验证：拒绝计数纯helper138项、Gateway/SQLite集成11项、日志mask7项、Cookie管理员API5项共161项通过。Node22完整Master smoke扩为14阶段、总测试15/15，持久化拒绝增量2且日志无秘密、优雅解锁。安装器Query Token红线正在补Header-only修复，最终静态复审及CI仍待闭合。

- 最终增量：等价静态复审识别共享SS拨测的逐账号计量能力限制，现拨号前返回UNSUPPORTED/SPEEDTEST_LINE_UNMETERED；SS2022 multi-user正常，HTTP/SOCKS/MIXED与网关强制认证一致。复现7失败后59/59通过。真实Master smoke再发现节点关联paramsJson泄漏，已移除入口/落地/目标原始参数并补51/51单测；最终smoke15阶段16/16，含共享SS真实API无执行/无伪计费。新VMess生产配置两跳native在Windows两模式8/8通过，最终五平台仍等待新提交CI。

- 82c163e候选CI run44048133049逐断言结果：五平台真实两跳各8/8、专用订阅账务各4/4通过；Linux arm64原生117项、Windows/macOS各102项全通过。Linuxamd64业务与认证断言通过，Trojan用例退出后一次临时端口重绑定检查失败，当前保留失败并修复，不将整轮标绿。
