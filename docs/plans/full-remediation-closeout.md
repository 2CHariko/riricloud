---
title: "全量安全整改与工程收尾"
type: plan
status: active
target_version: "Unreleased"
created_at: "2026-11-17"
author: "Codex & Maintainers"
---

# 全量安全整改与工程收尾

## 已确认的交付边界

完成线路凭据安全整改、镜像回归、CI与真实内核验证、维护备份恢复、规范与多语言。用户确认保留 Master/Mihomo 专用合法订阅拨测；中继维护式轮换；只做代码与隔离环境验收，不操作生产、不正式发版。Webhook、规则更新、支付与 WireGuard 不在实施范围。

测速账号通过管理员设置 lineSpeedtestUserId 指定，按普通授权和配额计量；禁止自动借用账号。中继采用按源线路隔离的 AES-GCM 随机凭据与持久化轮换：停止入口→确认停用→更新落地→确认运行→恢复入口→完成，阶段预算120秒，失败维持停用并允许幂等重试。运行确认必须匹配实际配置版本及内核状态，不用发送/接收回执冒充运行成功。

## 实施清单

### 安全链路
- [x] 固定测速与中继凭据复现测试先失败。
- [x] 专用订阅拨测设置、正常资格/配额/线路授权及快照失效。
- [x] 追加线路凭据与轮换数据模型、迁移和密文/统计身份映射。
- [x] 移除公开入站的固定测速身份，中继按源线路隔离。
- [x] 维护式轮换及跨重启、离线、迟到回执、超时和并发保护。
- [x] 管理端轮换/状态/重试交互与脱敏API。
- [x] 脱敏、旧凭据拒绝、跨目标隔离与计费回归。

### 镜像与测试治理
- [x] 镜像三种访问策略与Token生命周期回归。
- [x] 流式协议、地址/重定向/请求头边界与取消清理。
- [x] 慢客户端每流1MiB待发送上限，SLOW_CONSUMER取消。
- [x] Web全部测试自动发现，修复现有7项夹具/契约失败。
- [x] CI接入i18n和既有脚本测试。
- [x] 固定资产五平台真实内核CI矩阵。

### 备份恢复
- [x] backup:create/verify/restore维护CLI及源码/包/Docker接线。
- [x] 停服冷备与Master/维护命令互斥锁。
- [x] 双库、WAL/SHM及运行态资源流式备份和完整性清单。
- [x] 哈希、SQLite、版本/迁移、密钥及路径安全校验。
- [x] 只恢复新空目录并隔离外部邮件和生产Agent。
- [x] 成功恢复、非空WAL、坏备份、错密钥和失败清理测试。

### 文档、多语言与交付
- [x] 现行双轨版本、Unreleased与六门禁规范统一并增加针对性检查。
- [x] 英文全词条、插值与新增文案对齐。
- [x] 日文全词条、插值与新增文案对齐。
- [x] 更新数据/API/架构/部署/UI台账与两端Unreleased的本轮增量，版本/文档门禁通过；全文一致性遗留另列。
- [x] 清理并核对文档遗留冲突：DATA_MODELS.md统计凭据、API的固定transit/测速注入/免计费旧段落及ARCHITECTURE.md镜像全局配额已与现行隔离凭据、合法拨测和16任务/16MiB限制对齐。
- [x] 拆分NAT未来WireGuard并逐项复核主线；撤回无证据的历史勾选，保留未完成生产验收记录。
- [x] 本地完整门禁、脚本回归、维护测试及隔离恢复验收；以gate-submission与维护报告为准。
- [x] 本轮既定安全门禁通过：pnpm audit high已通过（主代理确认），Go 1.26.11的Windows amd64及Linux amd64/arm64源码可达性扫描均无可达漏洞、exit 0。二进制3项保守告警保留为明确边界，不等同本次门禁失败，不追加全部第三方advisory清零或范围外依赖升级要求。
- [x] Node 22.23.5全量隔离smoke复跑通过：14阶段全通过、总测试15/15；普通详情/list无Token，轮换一次性新Token及旧401/新201、日志脱敏与停机解锁均通过。
- [ ] 五平台真实执行证据与CI全绿。
- [ ] 原子提交、PR、自查及合并；完成后机械归档本计划。

## 验收记录

- 起点：main 63e3c05，Master v0.9.19 / Agent v0.8.7。
- 规划阶段：版本/文档/i18n检查通过；Web展开13文件102用例，95通过7失败。失败指向Zod适配器测试导入、设置工具依赖及代理池脆弱源码断言。
- 生产流量账务观察、真实外部节点出口及WireGuard未来扩展保持独立未完成，不以隔离模拟或交叉编译替代。

## 并行写入分工

主代理负责凭据数据/网关/轮换与总集成。第一批代理分别处理专用账号拨测、镜像、备份CLI、CI/native、Web测试入口、英文；随后补日语、规范、UI与专项审查。共享package、基准语言、CHANGELOG、总计划由主代理统一集成，避免覆盖。

- 实施复现：网关定向Jest两项均按预期失败，分别证明空订阅隐藏身份与跨中继共享身份。

- 安全审查先复现5项失败，已修复：落地版本持久化防重试旧密钥复活；按配置版本保存有界诊断秘密、未知版本安全摘要；失败CAS未发生不重发。独立审查10项与凭据helper67项全部通过。实际Prisma+网关配置贯通、并发/重启/超时回归15项通过；真实JWT Cookie ADMIN维护API5项通过。
- Windows原生新增中继凭据37项通过，覆盖VLESS/VMess/Trojan/Hysteria2/TUIC；Linux Naive9项已接入矩阵但仍待实际执行。专用订阅原生账务4项通过（真实Mihomo+受控HTTP代理+生产账务事务，不伪称Go Agent链路）。
- 提交前最终完整本地gate已退出0（主代理确认，日志artifacts/verification/gate-submission.log）：Server 124套件/1597项通过，另11套件/105项native跳过；Web 144项通过；脚本106项通过/4项默认跳过；维护33项通过。英日各4245/4245覆盖。早期discovery/E2E storage失败已由本次成功日志取代；跳过不计作原生验收。
- 实际Go工具链与正式构建基线为1.26.11，工具链提交f982646已存在；其余集成仍未提交。artifacts/verification/go1.26.11-audit/summary.json记录Windows amd64及Linux amd64/arm64条件源码扫描无可达漏洞，Linux构建为交叉编译；源码可达性门禁通过；二进制保留grpc/x/net三项保守告警、exit 3，属于记录的分析边界，不等同本轮既定安全门禁失败。
- Node 22.23.5维护基线：artifacts/maintenance-node22/result.json与test.log记录21项通过、exit 0；最新gate维护33项通过。artifacts/maintenance-review/run-9dlnWM/report.json为ok:true，包含发行包真实迁移/引导/HTTP 200、运行中拒绝冷备、停机解锁、BACKUP_CREATED→BACKUP_VERIFIED→RESTORE_READY、恢复启动迁移前拒绝及无外网尝试。源码/包/Docker接线由维护回归覆盖，不等于Linux发行包或Docker镜像实际启动通过。
- artifacts/verification/remediation-smoke.json最新PASSED：Node 22.23.5，2026-11-17 12:37:17—12:37:49（北京时间），13阶段全通过；remediation-smoke-test.log记录总测试14/14。真实AppModule/双库迁移、Cookie、WS/HTTP、维护轮换与中途重启、普通详情/list无Token、轮换一次性返回新Token与旧Token 401/新Token 201通过；71条日志脱敏检查通过，优雅退出释放全部存储锁。Agent为模拟端、网络限制回环、未触及生产，不替代原生认证。旧12/13失败保留于remediation-smoke-red.json，node-token-red.log的2失败/22通过与green日志24/24共同保留复现链。
- 本轮增量文档与两端Unreleased已维护，gate:docs通过；随后复核并确认主代理已修正文档遗留：DATA_MODELS.md统计凭据、API的固定transit/测速注入/免计费段落及ARCHITECTURE.md全局配额。CI入口专项脚本另有Node 22测试10/10通过（主代理确认），不替代远程CI。五平台远程CI、最终集成提交、PR与合并均未完成，本计划不归档。

- 提交进展：工具链 f982646、主实现38b1d6f已通过钩子提交并推送草稿PR #269。首次CI治理/Web/Agent/安全/脚本及linux-amd64 native成功；Server鉴权夹具依赖本地JWT密钥已复现修复，其余平台原生就绪与macOS回环地址失败正在修正，不以首次失败计完成。新增拒绝计数定向161项及Node22完整Master smoke14阶段/15测试通过。

- 安全增量最终本地gate-closeout.log退出0：Server126套件1757项通过（另11套件105项native单独执行），Web144、脚本107/默认跳过4、维护33全部通过。安装器Header-only回归先7项失败后37/37通过，完整Master smoke真实验证Header下载200与Query/混合凭据401。

- 最终本地集成gate-final-ready.log退出0：Server126套件1766项通过，12套件113项native独立执行；Web145、脚本107/默认跳过4、维护33全部通过。英日各4246/4246。此前gate-final-integration的一次端口/子进程启动失败如实保留，不计通过；当前原样完整重跑已通过。最终Master smoke15阶段16/16；节点原始paramsJson泄漏、Header-only安装器、共享SS不可计量、落地拒绝计数均覆盖。
