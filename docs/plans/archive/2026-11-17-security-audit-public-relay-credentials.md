---
title: 公开线路与中继落地凭据安全整改
type: plan
status: completed
pr: "#269"
target_version: Unreleased
created_at: "2026-09-08"
updated_at: "2026-11-17"
author: "Codex Security & Maintainers"
archived_at: "2026-11-17"
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
- [x] 2.7 最终0360c9e、run44055792504五平台均实际执行专用订阅账务4/4，普通延迟/strict/超时/取消套件同时通过。共享SS不可逐用户计量时在拨号前拒绝，SS2022 multi-user正例保留；整轮11项CI全部成功。

## 里程碑 3：中继隔离与维护式轮换

- [x] 3.1 生产固定中继常量和按旧内部名称的账务特判已移除；旧名负例证明不能免计费。
- [x] 3.2 网关按源线路材料生成协议出站；VLESS/VMess/Trojan/Hysteria2/TUIC/Naive/SS 采用对应编译器凭据映射。
- [x] 3.3 独立落地仅接受当前源线路身份；TARGET_LINE 只增加实际关联的中继身份，共享目标 SS 不支持逐用户时拒绝。
- [x] 3.4 停入口、确认停止、应用落地、确认运行、恢复入口、最终确认的持久状态机已实现；最终配置证明、原拓扑撤销、失败保持停用与幂等重试均有 SQLite 用例。
- [x] 3.5 五平台真实内核证明VLESS/VMess/Trojan/Hysteria2/TUIC共37项认证，Linux两架构另含9项Naive；旧固定值、错身份、跨线路及轮换旧值拒绝通过，最终提交绑定见5.5/5.7。
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
- [x] 5.3 最终原生套件验证合法/错误身份、旧固定值、跨线、旧版本及缺失材料；无订阅/撤权/配额等业务资格由授权单测与完整Master smoke验证。普通gate的native跳过不计作原生成功，独立五平台结果见下表。
- [x] 5.4 本轮重启、并发轮换、迟到回执、超时、拓扑变更与隔离备份恢复回归通过；最终Node22完整smoke15阶段、16/16，含运行版本/内核状态门槛、中途重启、幂等重试、脱敏及优雅解锁。
- [x] 5.4a 本地报告绑定生产实现82c163e及最终测试提交0360c9e，最终CI run44055792504全部成功；PR #269合并98dcf4a，文件内容与通过CI提交一致。
- [x] 5.5 VLESS/VMess/Trojan/Hysteria2/TUIC及Linux Naive真实落地认证/错误场景通过；VMess生产配置的PROTOCOL_PROXY与TARGET_LINE真实两跳各4项、五平台各8/8。两跳证据以VMess为代表，不扩展为每种协议/参数组合均实测。
- [x] 5.6 完整本地gate-final-ready.log退出0；最终CI新增清理回归后Server126套件1775项、Web145、脚本107、维护33及Agent通过。普通Server门禁跳过12套件113项native，实际原生结果由独立五平台任务证明；迁移由维护及smoke证明。
- [x] 5.6a 本轮既定安全门禁通过：pnpm audit high（主代理确认）及 Go 1.26.11 的 Windows amd64/Linux amd64/arm64 源码可达性扫描均通过。二进制 3 项保守告警、exit 3 继续留档，不等同本次门禁失败，不追加全部第三方 advisory 清零或范围外依赖升级要求。
- [x] 5.7 五平台CI绑定同一最终提交0360c9e，逐平台workflow/job、资产及结果已核对，11项检查全部成功；PR #269已合并，不使用--no-verify或过滤失败用例。全部清单闭合后机械归档。
- [x] 5.8 等价人工静态审查已完成并保留security-review-final.md/json，两个原始固定身份发现关闭；发现并修复安装器URL Token、节点关系原始paramsJson泄漏，明确共享SS拨测计量能力边界。记录已审文件hash、覆盖及未覆盖范围；未宣称运行Codex Security产品。父线补充冻结旧源码/修复源码对照及最终源码指纹。

## 最终证据映射（2026-11-17）

最终提交`0360c9ebebfd86bcef5a9f010f693a15d285cdb5`的[CI run 44055792504](https://github.com/2CHariko/riricloud/actions/runs/44055792504)共11项检查全部成功。PR #269于2026-11-17T09:38:17Z合并，merge commit为`98dcf4a1b66569127166ef9b65f96a1413dcb610`；文件内容与通过CI的提交一致。逐平台job、Node/内核版本与结果见[双内核验收记录](./2026-11-17-mihomo-client-probe-separation.md)。

| 范围 | 可复核证据 | 结论与边界 |
| :--- | :--- | :--- |
| 公开授权、固定身份负例 | Gateway授权、inbound、订阅权益与credential-governance套件；最终CI Server/脚本日志 | 未登记/撤权/禁用/过期/超额/无线路权限均拒绝；无隐藏测速身份或全局transit身份 |
| 合法订阅拨测 | probe-subscription、settings-speedtest及probe-subscription-accounting.native | 专用账号资格与快照失效通过；真实账务五平台各4/4。共享SS拨号前UNSUPPORTED，SS2022 multi-user正例通过 |
| 密文、拓扑与维护状态机 | line-credential类型/拓扑/SQLite/diagnostics及完整Master smoke | 密文/统计身份、运行确认、旧拓扑撤销、重启/超时/迟到/并发回归通过；生产实现82c163e，后续仅测试/文档增量 |
| 真实认证与两跳 | run44055792504的native-evidence-<target> | Linux两平台各13套件117项，Windows/macOS三平台各11套件102项，每平台7项脚本；37项通用落地认证与Linux9项Naive，VMess两跳各8/8。Naive/Cronet仅Linux执行，无非许可跳过 |
| 隔离备份恢复 | 最终CI维护33项；artifacts/maintenance-review/run-9dlnWM/report.json | 双库/WAL/SHM、哈希/路径/版本/密钥及锁回归通过，实际发行包迁移、HTTP200、创建→校验→隔离恢复ok:true；不声称生产恢复或本轮Docker实际启动 |
| 完整隔离smoke | artifacts/verification/remediation-smoke.json、remediation-smoke-test.log | Node22.23.5，15阶段16/16；真实Master/迁移/HTTP/WS/Cookie、维护重启/重试、Header200/Query401、节点关系无秘密、拒绝计数去重及停机解锁；Agent内核端为模拟 |
| 新增问题复现与修复 | node-relation-red-green.json、probe-metering-red.log、probe-metering-green.log、probe-metering-strict-green.log | 旧源码关系参数泄漏/新源码脱敏；计量红例7失败→59通过，普通/strict不执行断言47通过，节点关系单测51通过 |
| 静态安全复核 | artifacts/verification/security-review-final.md及.json | 等价人工审查覆盖生产调用链、文件指纹及未覆盖范围；两项原始发现关闭，安装器URL Token与节点关系paramsJson泄漏已修复，未宣称调用Codex Security产品 |
| 常规与安全门禁 | run44055792504；gate-final-ready.log；go1.26.11-audit | CI Server1775/Web145/脚本107/维护33及Agent通过，英日各4246/4246；pnpm high及Go1.26.11源码可达性通过。二进制3项保守第三方告警、exit3仍保留，未新增忽略 |
| 外部/生产 | 无本轮授权与工件 | 未操作现网数据库、Agent配置或生产入口；部署/真实外部出口及账务观察继续由独立计划跟踪 |

## 发布、回滚与归档交接

发布前由维护者另行授权维护窗口，按部署指南冷备业务/观测双库、WAL/SHM 和运行资源，并验证加密密钥与恢复路径。升级迁移后须逐线确认入口停止、落地新配置运行及入口恢复；离线节点继续显示未确认，不能以 Master 期望配置当作远端已经执行。

旧配置含固定身份的节点需要在维护窗口中实际重载或隔离；本轮代码修复不会追溯删除远端旧文件。回滚只使用仍支持隔离凭据的相容版本，禁止恢复固定身份以换取可用性。故障状态显式重试，日志只含脱敏阶段、版本与错误码。

本计划代码、隔离验收、五平台CI、等价静态复核及PR合并已完成，随后使用`pnpm plan:archive security-audit-public-relay-credentials.md`机械归档。生产部署不属于本计划完成条件，仍按上方维护窗口和运行确认要求独立执行。

早期Windows53项报告、13阶段14项smoke及候选run44048133049为历史中间结果；最终验收以本节证据为准。候选Linux amd64在临时端口清理失败的整轮未计成功；0360c9e补确定性TIME_WAIT/活动监听负例后，最终五平台全部通过。
