---
title: 代理池统一授权与受控上游中继接入
type: plan
status: completed
target_version: "下一次 MINOR 发布"
created_at: "2026-10-01"
author: "Maintainers & PI-Desktop"
archived_at: "2026-10-01"
---
# 代理池直连完善与 MIXED 上游中继接入

## 批准目标

列表、导出、Agent 下发使用同一用户资格、套餐快照/额外线路授权、资源可用性与容量分配。新增 Line.proxyPoolEnabled，仅支持 DIRECT/MIXED、RELAY/UPSTREAM_NODE/MIXED；上游入口必须开启用户鉴权。Key 独立于订阅凭据，配额共享但权限不共享。

所有端点使用冒号安全的 pk_line_ 线路专属登录名，旧裸 pk_ 新连接停止支持，必须重新导出；Key ID/原始标识/密码/Token/账务不变。新统计精确到 Key+lineId，不回退节点第一条线路；旧快照游标保留避免重复计费。JSON 导出 v2，每端点实际凭据为代码示例 SSOT。

每用户20Key，每节点512个Key-Line绑定；先过滤资格，按Key创建时间/ID、线路创建时间/ID稳定分配，不受UI排序影响。容量排除明确呈现、导出不能伪称可用。白名单拒绝优先于中继转发。新开关默认关闭，只回填旧公开启用、真实入口DIRECT/MIXED，不自动开放中继。

不接入EXTERNAL、其他中继或单HTTP/SOCKS协议，不新增外部服务、Agent消息/内核补丁、设备限制或套餐用户速率承诺。不清现有数据库、改历史迁移、重写旧账单，不提交/推送/发版。旧客户端权限可能收紧、登录名需重新导出，升级前备份并停旧Master。

## 实施清单

- [x] 模型开关、非破坏迁移及线路DTO/组合校验/复制与回归
- [x] 独立共享资格/资源/绑定解析模块、规范派生登录名、512容量回归
- [x] 端点/导出/Token/API DTO、JSONv2协议能力与安全摘要
- [x] Agent按线路凭据下发、安全拒绝优先、配置失效/撤销、统计注册
- [x] 新凭据精确账务与游标回归，旧快照迟到/删除/归零不重复计费
- [x] 前端开关、逐Key端点、容量反馈、逐端点导出/代码示例/i18n
- [x] 文档/Unreleased/升级兼容说明、E2E消费者评估与UI索引
- [x] Windows/WSL真实HTTP/SOCKS、白名单/授权/上游失效、gRPC与账务集成
- [x] 六门禁及最终检查，测试资源回收，完成后归档

## 验收条件

两用户不同套餐不得越权；私有线路额外授权准确；同节点两线路同Key不同倍率且含排序靠前VLESS干扰仍精确归属；重复/归零/迟到累计和迁移游标不重复扣费。0/512/513绑定边界、稳定排序、排除提示、列表/导出/下发一致。HTTP CONNECT/SOCKS5真请求正确密码成功、错误/旧裸用户名/越权拒绝；白名单真请求allow/deny不绕过路由；来源禁用/缺失/到期/耗尽无DIRECT回退；Key启停/密码轮换/用户超额到期重下发与重连核对。TLS SOCKS不能错误导出，IPv6格式正确，响应日志不漏秘密。资格使用有效套餐快照，Agent原协议不变，设备追踪仍忽略pk_。

采用正式schema生成Prisma、临时绝对SQLiteURL与隔离fixture，不操作现有业务库。视觉验证按需仅Antigravity，不挂CI/hook。网络分区不宣称即时撤销，明确配置期望/应用状态，长连接撤销受既有内核应用行为限制。相关doc映射全量同步，未知限制如实记录。

## 完成与验收记录

基线57d2670，分支feat/proxy-pool-unified-access。代码未提交/推送/发布、版本不变；新迁移未应用到现有业务或默认联调库。批准范围实现与本轮可执行验收完成，按规范归档。

- 最终 `pnpm gate` 六门禁全绿：后端91套件/812测试通过，5套件/34个opt-in原生测试在常规门禁跳过；前端类型/ESLint/Vite构建、i18n、Agent vet/格式/测试/构建通过。Vite大chunk/非基准语言待译为非阻断提示。
- 16项独立迁移/前端契约回归通过：原用户/Key/密码/Token/金额/统计游标保留，只回填旧有效公开直连MIXED；200选择、容量变化不重选、v2逐端点凭据SSOT、TLS SOCKS/TXT拒绝、IPv6及空选择边界。
- Windows真实 `scripts/proxy-pool-integration.cjs` 完整通过：两用户不同套餐、私有额外授权、HTTP CONNECT/SOCKS5直出与上游中继、旧裸Key/错误密码/越权拒绝；读取实际Sing-box gRPC累计计数，经真实SQLite心跳事务核对同Key两线路倍率与User/Subscription/ProxyKey用量，排序靠前VLESS无干扰，重复累计不重复扣。
- 真实来源IP允许/拒绝先于中继路由，Key密码/Token轮换、启停、额外授权撤销、上游源/节点启停/PRESENT/到期/耗尽、用户到期/配额、全局开关过滤通过。实际WS配置帧刷新、HTTP poll缓存失效与版本变化、累计增量触发超额配置撤销及新连接拒绝通过；未宣称网络分区/旧长连接即时断开。
- WSL2 Debian Linux amd64隔离副本正式schema生成Prisma、绝对临时SQLiteURL、Node22测试容器相同真链路与迁移完整通过，容器exitCode=0。系统工具未安装/升级；Windows正式Prisma生成曾因用户开发服务占用DLL重命名失败，类型已更新，WSL正式生成成功，未终止该服务或复制临时客户端到工作区。
- WSL编译完整生产Master并在新双库迁移/管理员引导后独立启动，Nest模块依赖无循环/注入错误，真实Cookie ADMIN容量接口、匿名401、无权益403 fail closed通过；本次进程回收。部署入口/Agent协议未改，不重复无关全平台镜像构建。
- 既有 `scripts/upstream-integration.cjs` Windows真实EXTERNAL/VLESS/HTTP/MIXED订阅中继及Mihomo检查未回归。已检索 `scripts/dev-e2e*`：当前脚本仅启动与消费VLESS线路/原Agent接口，不使用旧代理池导出，无需变更启动契约；新增隔离代理池脚本覆盖本轮API/E2E。
- 一轮限定只读复核发现有效落地覆盖校验不一致、前端全选超200两项；先写复现后最小修复，保存/分配/Agent共用有效连接、前端限额提示与自动URL保护，相关及最终测试通过，不启动额外审查。
- 测试容器/内核/烟测Master回收，git diff --check通过，秘密仅临时配置/fixture，未写现有数据库。视觉验证按需仅Antigravity，本环境未执行；macOS/其他架构不属于本轮新证明。
