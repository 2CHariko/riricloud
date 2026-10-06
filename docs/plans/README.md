# 规划与任务台账 (Plans & Archival Ledger)

本文档是 **RiriCloud** 项目全部中短期任务规划、架构改造清单与历史实施记录的总台账。

---

## 📌 规划管理生命周期与机械约束

1. **新建规划**：通过 `pnpm plan:new <name>` 在 `docs/plans/` 下创建标准模板，并在本文档进行中表格登记。
2. **执行推进**：在对应 `docs/plans/<name>.md` 中维护任务勾选框（`- [ ]` -> `- [x]`）。
3. **完成归档（机械硬约束）**：
   - 门禁脚本 `pnpm gate:docs` 将扫描进行中文档：**若某文档内所有任务项均已勾选（100% `[x]` 且无 `[ ]`），门禁将直接阻断报错**，强制要求归档。
   - 执行 `pnpm plan:archive <filename>` 一键自动打上归档时间戳、更改状态为 `completed`、追加 `YYYY-MM-DD-` 前缀移入 `docs/plans/archive/`，并自动刷新本文档台账。
4. **根目录保护**：禁止在 `docs/` 根目录随意堆放散乱的 TODO / 计划文件，所有计划类文档必须收敛至本目录。

---

## 🚀 进行中规划 (Active Plans)

| 规划名称 | 目标版本 | 创建日期 | 任务进度 |
| :--- | :--- | :--- | :--- |
| [手动证书管理完善](./certificate-management.md) | `Unreleased` | 2026-10-06 | 5/6 (83%) |
| [双内核职责解耦与统一端到端拨测](./mihomo-client-probe-separation.md) | `下一次 MINOR 发布` | 2026-10-01 | 11/12 (92%) |
| [无公网 IP 主机（NAT/家宽）作为落地节点与反向穿透隧道全链路实现](./nat-landing-node-reverse-tunnel.md) | `v0.10.0` | 2026-09-13 | 34/36 (94%) |
| [实时节点镜像站与 Agent 流式代理](./node-mirror-site-proxy.md) | `v0.7.2+` | 2026-09-09 | 93/123 (76%) |
| [公开线路与中继落地凭据安全整改 TODO（2026-09-08）](./security-audit-public-relay-credentials.md) | `v0.7.2+` | 2026-09-08 | 0/58 (0%) |
| [流量账务与 SQLite 写入链路优化](./traffic-accounting-sqlite-optimization.md) | `0.5.0` | 2026-09-03 | 19/20 (95%) |

---

## 📦 历史归档规划 (Archived Plans)

| 归档规划名称 | 达成版本 | 归档日期 | 关联 PR / 提交 |
| :--- | :--- | :--- | :--- |
| [订阅模板可配置机械诊断与安全修复](./archive/2026-10-05-template-validation.md) | `Unreleased` | 2026-10-05 | — |
| [日志可信度与无重启诊断全链路优化](./archive/2026-10-04-logs-diagnostics-overhaul.md) | `Unreleased` | 2026-10-04 | — |
| [系统日志页紧凑布局恢复](./archive/2026-10-04-logs-compact-ui.md) | `Unreleased` | 2026-10-04 | — |
| [日志详情抽屉视觉重构与极客美学恢复](./archive/2026-10-04-log-detail-redesign.md) | `Unreleased` | 2026-10-04 | — |
| [日志详情信息卡片化与元数据降噪](./archive/2026-10-04-log-detail-cards.md) | `Unreleased` | 2026-10-04 | — |
| [订阅预览原生校验与外部资源诊断](./archive/2026-10-03-template-kernel-validation.md) | `Unreleased` | 2026-10-03 | — |
| [统一延迟测试入口并保留严格调试能力](./archive/2026-10-03-probe-latency-test.md) | `Unreleased` | 2026-10-03 | — |
| [线路最终落地 HTTP/SOCKS5 出站](./archive/2026-10-02-line-egress-proxy.md) | `下一次 MINOR 发布` | 2026-10-02 | — |
| [代理池统一授权与受控上游中继接入](./archive/2026-10-01-proxy-pool-unified-access.md) | `下一次 MINOR 发布` | 2026-10-01 | — |
| [上游订阅导入与多模式融合功能方案 (Upstream Subscriptions & Proxy Relay)](./archive/2026-09-30-upstream-subscriptions-proxy-relay.md) | `v0.10.0` | 2026-09-30 | — |
| [上游订阅破坏性重构：统一线路授权与可靠同步](./archive/2026-09-30-upstream-subscription-breaking-refactor.md) | `下一次 MINOR 发布` | 2026-09-30 | — |
| [节点管理批量 Agent 升级](./archive/2026-09-29-agent-batch-upgrade.md) | `0.10.0` | 2026-09-29 | — |
| [docker-dockerhub-publish](./archive/2026-09-28-docker-dockerhub-publish.md) | `v0.9.5` | 2026-09-28 | — |
| [default-docker-hub-images](./archive/2026-09-28-default-docker-hub-images.md) | `v0.9.5` | 2026-09-28 | — |
| [release-and-ghcr-governance](./archive/2026-09-26-release-and-ghcr-governance.md) | `v0.9.0` | 2026-09-26 | — |
| [多设备同时在线限制与实时设备管理全链路实现](./archive/2026-09-25-multi-device-limit-and-management.md) | `v0.9.0` | 2026-09-25 | — |
| [完善卡密：分类、奖励类型、兑换限额与软删除](./archive/2026-09-23-redeem-code-enhancement.md) | `v0.9.0` | 2026-09-23 | — |
| [首屏落地页（Landing Page）与可配置化设计落地](./archive/2026-09-20-landing-page.md) | `v0.8.20` | 2026-09-20 | — |
| [fix-docker-entrypoint-autoseed](./archive/2026-09-20-fix-docker-entrypoint-autoseed.md) | `v0.8.23` | 2026-09-20 | — |
| [docker-startup-diagnostics](./archive/2026-09-20-docker-startup-diagnostics.md) | `v0.8.22` | 2026-09-20 | — |
| [docker-ghcr-publish](./archive/2026-09-20-docker-ghcr-publish.md) | `v0.8.21` | 2026-09-20 | — |
| [用户侧帮助中心与使用文档系统实现](./archive/2026-09-19-help-center-docs.md) | `v0.8.19` | 2026-09-19 | — |
| [线路多路复用 (Multiplex) 与 TCP Brutal 强力拥塞控制及线路参数更新优化](./archive/2026-09-18-line-multiplex-brutal-and-params-update.md) | `v0.8.18` | 2026-09-18 | — |
| [线路管理配置项扩充与分层限速机制](./archive/2026-09-18-line-config-enhancement-and-speed-limiting.md) | `v0.9.0` | 2026-09-18 | — |
| [流量与系统日志存储治理（时序小时桶聚合、自动淘汰与物理分库）](./archive/2026-09-17-traffic-and-log-storage-governance.md) | `v0.9.1` | 2026-09-17 | — |
| [时序遥测与日志物理分库隔离（Phase 2 架构演进）](./archive/2026-09-17-telemetry-db-physical-separation.md) | `v0.9.2` | 2026-09-17 | — |
| [Sing-box 日志采集与系统日志降噪优化](./archive/2026-09-17-singbox-log-governance.md) | `v0.8.15+` | 2026-09-17 | — |
| [binary-distribution-optimization](./archive/2026-09-14-binary-distribution-optimization.md) | `v0.8.12` | 2026-09-14 | — |
| [agent-upgrade-version-reconcile](./archive/2026-09-14-agent-upgrade-version-reconcile.md) | `v0.9.0` | 2026-09-14 | — |
| [agent-embedded-singbox](./archive/2026-09-14-agent-embedded-singbox.md) | `v0.8.12` | 2026-09-14 | — |
| [卡密管理功能优化（统计/搜索分页/批量操作/安全审计/数据治理）](./archive/2026-09-13-redeem-code-management-optimization.md) | `0.9.0` | 2026-09-13 | — |
| [免费套餐重复购买限制与购买台账](./archive/2026-09-13-free-plan-purchase-limit.md) | `v0.9.0` | 2026-09-13 | — |
| [内置二进制资源生命周期完全优化](./archive/2026-09-13-binary-resource-lifecycle-optimization.md) | `v0.8.9` | 2026-09-13 | — |
| [binary-resource-center-enhancement](./archive/2026-09-13-binary-resource-center-enhancement.md) | `v0.8.8` | 2026-09-13 | — |
| [agent-windows-portable-install](./archive/2026-09-13-agent-windows-portable-install.md) | `v0.8.9` | 2026-09-13 | — |
| [独立 Mixed (SOCKS5/HTTP) 直连代理池机制](./archive/2026-09-11-standalone-mixed-proxy-pool.md) | `v0.9.0` | 2026-09-11 | — |
| [web-form-init-clobber](./archive/2026-09-10-web-form-init-clobber.md) | `v0.8.2` | 2026-09-10 | — |
| [swagger-security-hardening](./archive/2026-09-10-swagger-security-hardening.md) | `v0.8.1` | 2026-09-10 | — |
| [用户登录注册系统全量安全审计整改 TODO（2026-09-07）](./archive/2026-09-07-auth-registration-security-audit.md) | `v0.6.13+` | 2026-09-07 | — |
| [arch-decouple-master-agent](./archive/2026-09-07-arch-decouple-master-agent.md) | `v0.6.15` | 2026-09-07 | — |
| [全栈可视化日志管理系统 (System Log Management)](./archive/2026-09-06-system-log-management.md) | `v0.6.11` | 2026-09-06 | — |
| [安全审计整改 TODO（2026-09-06）](./archive/2026-09-06-security-audit-remediation-2026-09-06.md) | `v0.6.13+` | 2026-09-06 | — |
| [强制邮箱验证、未验证禁用订阅与找回密码全链路](./archive/2026-09-06-email-verification-and-password-reset.md) | `v0.6.12` | 2026-09-06 | — |
| [用户系统完善：随机数字 UID、自定义昵称、换绑邮箱、SMTP 邮箱验证与双模式人机验证](./archive/2026-09-05-user-system-enhancement.md) | `v0.6.11` | 2026-09-05 | — |
| [系统设置梳理与全链路统一时区支持](./archive/2026-09-05-system-settings-timezone.md) | `v0.6.8` | 2026-09-05 | — |
| [中转线路与单节点多线路流量统计归属根除修复](./archive/2026-09-05-root-cause-relay-and-multi-line-traffic-fix.md) | `0.6.6` | 2026-09-05 | — |
| [重构线路端点拓扑：引入 Entry-Landing 架构并废除 exitPort](./archive/2026-09-05-line-topology-landing-refactor.md) | `v0.5.0` | 2026-09-05 | — |
| [线路测速功能（端到端测速、自动定时检测与延迟 Chip 标签展示）](./archive/2026-09-05-line-speedtest.md) | `0.5.0` | 2026-09-05 | — |
| [管理端流量统计大盘新增用户侧统计与排行](./archive/2026-09-05-admin-traffic-user-statistics.md) | `v0.6.10` | 2026-09-05 | — |
| [订阅流量周期重置与用户额外线路](./archive/2026-09-04-subscription-traffic-reset-extra-lines.md) | `0.5.0` | 2026-09-04 | — |
| [订阅模板全链路闭环优化与现代化工作台](./archive/2026-09-04-subscription-template-full-refactor.md) | `0.6.2` | 2026-09-04 | — |
| [中转线路流量统计归属与倍率计费重构](./archive/2026-09-04-relay-traffic-accounting.md) | `0.6.2` | 2026-09-04 | — |
| [中继线路复用已有落地线路（异构协议桥接）](./archive/2026-09-04-relay-target-line-bridge.md) | `0.5.0` | 2026-09-04 | — |
| [用户系统完善：货币系统、个人中心、卡密充值与订阅交易闭环](./archive/2026-09-03-user-currency-and-profile.md) | `v0.4.20` | 2026-09-03 | — |
| [下线仪表盘并将能力全量合并至我的订阅](./archive/2026-09-03-merge-dashboard-into-subscription.md) | `v0.4.x` | 2026-09-03 | — |
| [二进制资源中心与 Sing-box 版本解耦](./archive/2026-09-03-binary-resource-center.md) | `v0.5.0` | 2026-09-03 | — |
| [RiriCloud 全站移动端适配](./archive/2026-09-02-web-mobile-adaptation.md) | `v0.4.15` | 2026-09-01 | — |
| [Nginx 反向代理与订阅伪静态链接](./archive/2026-09-02-nginx-subscription-short-link.md) | `0.4.x` | 2026-09-02 | — |
| [管理端线路流量大盘与单用户流量统计](./archive/2026-09-02-admin-traffic-dashboard-and-user-statistics.md) | `v0.4.16` | 2026-09-02 | — |
| [系统设置全参数可配置化与现代化管理面板](./archive/2026-09-01-system-settings-full-config.md) | `v0.4.8` | 2026-09-01 | — |
| [开发脚本整理与 Docker WSL 约束](./archive/2026-09-01-dev-scripts.md) | `脚本治理` | 2026-09-01 | — |
| [证书管理中心与 Docker 本地持久化路径改造](./archive/2026-09-01-certificate-management-and-docker-persistence.md) | `v0.4.15` | 2026-09-01 | — |
| [Agent 现代化交互式 CLI 与全生命周期管理架构（破坏性重构）](./archive/2026-09-01-agent-interactive-cli-architecture.md) | `v0.4.1` | 2026-09-01 | — |
| [v0.3.0 订阅架构与极简 Agent 远程升级重构](./archive/2026-08-31-v0.3.0-architecture-refactor.md) | `v0.3.0` | 2026-08-31 | PR #3 (squash commit 2c87b14) |
| [部署打包实施方案（Release 二进制分发 + 本地 Docker 分发）](./archive/2026-08-31-packaging-and-deployment.md) | `v0.4.0` | 2026-08-31 | — |
| [节点与线路解耦、链式代理中继与主控本机节点架构重构](./archive/2026-08-31-node-line-separation-and-relay.md) | `v0.4.0` | 2026-08-31 | — |
| [node-detail-ops-and-master-upgrades](./archive/2026-08-31-node-detail-ops-and-master-upgrades.md) | `v0.3.0` | 2026-08-31 | — |
| [Master 内置本机 Agent](./archive/2026-08-31-master-embedded-agent.md) | `v0.4.0` | 2026-08-31 | — |
| [恢复线路管理完整可视化编辑](./archive/2026-08-31-line-visual-editor-restoration.md) | `v0.4.0` | 2026-08-31 | — |
| [线路顶层编排与出入站生命周期重构 (Line-Centric Pipeline Architecture)](./archive/2026-08-31-line-centric-pipeline.md) | `v0.4.0` | 2026-08-31 | — |
| [agent-dual-mode-communication](./archive/2026-08-31-agent-dual-mode-communication.md) | `v0.3.0` | 2026-08-31 | — |
| [完善 Master 管理员初始化流程](./archive/2026-08-31-admin-bootstrap.md) | `—` | 2026-08-31 | — |
