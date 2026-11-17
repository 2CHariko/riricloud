---
title: 双内核职责解耦与统一端到端拨测
type: plan
status: completed
pr: "#269"
target_version: Unreleased
updated_at: "2026-11-17"
created_at: "2026-10-01"
author: "Maintainers & PI-Desktop"
archived_at: "2026-11-17"
---
# Mihomo 主客户端与端到端拨测

## 2026-11-17 本轮边界

日常 PR 不据本计划自动递增 MINOR；版本由后续 Release PR 按真实变更判定。最终集成提交0360c9e已完成五平台真实内核CI，以下区分最终证据与历史阶段记录。本轮专用订阅拨测与维护式轮换以[凭据安全计划](./2026-11-17-security-audit-public-relay-credentials.md)为准。

当前日常线路延迟测试采用 `MASTER / MIHOMO_URL_TEST`，自建线路使用管理员明确选择且有合法订阅权益的账号，正常计量。严格 CONNECT/TLS/HTTP 状态验证路径保留用于其明确用途，不能将历史严格探针实验结论套到普通 URLTest 的成功结果上。

## 批准范围

Sing-box 保持服务端入站、鉴权、统计与中继出口。Mihomo 默认用于主要客户端编译、验证和真实拨测；Sing-box 客户端只进行能力白名单限定的兼容回退，不能因超时、鉴权失败或环境缺失静默回退。保留现有 URI/Base64/Sing-box JSON 辅助格式。拨测改为异步任务，不保留 TCP 成功或旧同步批量响应语义。

任务全局 4 连接、2 进程，批次最多 32；排队最多 20、单管理员最多 2 活跃任务、单任务最多 10000 资源和 30 分钟期限，完成状态内存保留 15 分钟。端到端快照条件写回防旧结果覆盖，配置变更/失效/删除后标 STALE。只新增安全测量元信息并失效旧派生延迟，不清业务资源/账务，不新增 Agent 协议/外部服务。按本轮用户授权执行提交、PR与合并；生产部署和正式发版留待独立授权。

## 执行清单

- [x] 固定版本 Mihomo API/目标状态/证书/取消语义实验与能力矩阵
- [x] 共享连接编译与内核能力解耦
- [x] 内核定位、进程生命周期、验证与严格 Mihomo 执行器
- [x] 异步任务、全局限额、资源快照与条件结果写回
- [x] 线路/上游接口、调度、测量元信息迁移与回退设置
- [x] 前端异步进度/取消/分页、内核画像与模板验证新契约
- [x] Docker/发行包/本地/E2E 内核资源交付代码与五平台资产验证
- [x] 架构/技术/接口/数据/部署/UI 文档及 Unreleased
- [x] 历史 Windows 单元、HTTP/隔离数据库、真实内核、隔离全应用 E2E 与六门禁记录（本轮增量证据另列）
- [x] 历史本机 WSL 补验 Master/Agent 镜像构建/容器运行、离线导出/校验/重载与 Linux Master 发行包
- [x] 历史 Linux amd64 原生执行及 Naive/Cronet HTTP/2 可用环境真实链路补验（不替代当前 CI）
- [x] 五平台原生 CI 入口与固定资源准备脚本已加入 `.github/workflows/ci.yml`；实现不等于执行通过。
- [x] Windows amd64 本轮阶段性原生报告：8 套件/53 项 Jest、7 项脚本全部通过，报告时间见下表。
- [x] Windows amd64 新增中继认证原生报告：`artifacts/native/windows-amd64/relay-credentials/summary.json` 与 `windows-jest.json` 记录 37 项通过、0 跳过、0 openHandles。
- [x] 最终提交0360c9e五平台原生CI全部通过，包含新增凭据/订阅计量/真实两跳及临时端口清理回归。
- [x] 同一提交五平台workflow/job、内核清单及结果已核对，常规门禁与既定安全门禁通过；PR #269实际合并后机械归档。

## 固定版本实验

本机 Mihomo v1.19.30 已确认：HTTP 出站使用 CONNECT。正确鉴权的 /delay 对 HTTP 204、200、500、302 都返回 delay，`expected=204` 未使其拒绝非预期状态；错误代理密码返回 503。该实验支持内部严格 HTTP 请求路径的状态/证书检查。当前普通 URLTest 仅承诺内核延迟结果；严格路径与普通延迟结果分开解释，不把 delay 数字当成严格状态校验通过。

## 本轮最终原生证据（2026-11-17）

最终工作流为[run 44055792504](https://github.com/2CHariko/riricloud/actions/runs/44055792504)，head为`0360c9ebebfd86bcef5a9f010f693a15d285cdb5`，11项检查全部成功。各平台在对应宿主串行执行真实内核，无非许可skip/todo。PR #269于北京时间2026-11-17 17:38:17合并为`98dcf4a1b66569127166ef9b65f96a1413dcb610`，与CI提交文件内容一致。

| 平台 / runner | Job ID | Node | Jest套件/测试 | 原生脚本 |
| :--- | :--- | :--- | :--- | :--- |
| linux-amd64 / ubuntu-24.04 | 133944706675 | 22.23.4 | 13 / 117 | 7通过 |
| linux-arm64 / ubuntu-24.04-arm | 133944706821 | 22.23.4 | 13 / 117 | 7通过 |
| windows-amd64 / windows-2022 | 133944706826 | 22.23.4 | 11 / 102 | 7通过 |
| darwin-amd64 / macos-15-intel | 133944706884 | 22.23.2 | 11 / 102 | 7通过 |
| darwin-arm64 / macos-15 | 133944706782 | 22.23.4 | 11 / 102 | 7通过 |

每个平台保存`native-evidence-<target>`，包含`summary.json`、`jest-results.json`、`native-scripts.tap`和`resources.json`。本地副本位于`artifacts/verification/ci/run-44055792504/`；本仓构建的Sing-box为1.14.0-r2、Go工具链1.26.11，Mihomo固定1.19.30，Agent版本0.8.7；资源报告记录平台、来源及二进制SHA256。Windows/macOS仅排除两份明确Linux专属的Naive/Cronet套件，Linux两种架构全部执行。

五平台均执行VLESS/VMess/Trojan/Hysteria2/TUIC共37项落地认证，Linux另有9项Naive认证；旧固定值、错身份、跨线及轮换旧值拒绝通过。生产配置生成的VMess真实两跳在`PROTOCOL_PROXY`与`TARGET_LINE`各4项、每平台8/8通过；专用订阅真实账务每平台4/4通过。该证据不扩展为每种协议/传输/参数组合的多节点生产验收。

同一CI的Server为126套件1775项通过，普通gate按设计跳过12套件113项native，其执行结果由上表独立证明；Web145项，工程脚本107项通过（4项条件跳过），维护33项通过，Agent vet/gofmt/test/build及既定安全门禁通过。英日各4246/4246词条。Go源码可达性扫描通过；独立二进制扫描仍有3项保守第三方告警、exit3，未新增忽略。

Node22.23.5完整Master隔离smoke为15阶段/16项通过，含真实AppModule/双库迁移、HTTP/WS/Cookie、维护重启/重试、Header-only安装鉴权、节点关系脱敏、拒绝计数及共享SS拨号前拒绝；该smoke的Agent内核端为模拟，真实内核由上表证明。证据为`artifacts/verification/remediation-smoke.json`与`remediation-smoke-test.log`。

早期Windows53项报告与候选run44048133049只保留为历史；后者Linux amd64临时端口清理失败没有计作整轮通过。最终夹具以实际rebind为先，仅Linux TCP在可读/proc表证明同端口只有TIME_WAIT且无LISTEN时接受清理；活动监听与未知错误仍失败。确定性旧失败/新通过、IPv4/IPv6/UDP负例及最终五平台复跑已覆盖。

## 历史验收记录（原阶段，非本轮最终验收）

以下记录形成时macOS/其他架构尚无实测；该历史限制已由上方最终五平台CI补齐，原阶段记录保留原有实验环境与结论。

- 最终 `pnpm gate` 六门禁全绿：后端 86 套件、760 项通过，34 项 opt-in 原生测试在普通门禁跳过；前端类型/ESLint/构建、Agent vet/格式/测试/构建通过。Vite 大 chunk 与非基准语言待翻译为非阻断警告。
- WSL Linux Node22 `RUN_NATIVE_CLIENT_TESTS=1` 最终 13 套件/83 项全部通过：HTTP、VLESS/WS、SS、Hy2、TUIC、严格状态/TLS、取消、冷启动，以及各编译格式；包含 SOCKS4/4a、自定义证书和 Naive/Cronet HTTP/2 padding/鉴权真实 Sing-box 回退。MIHOMO_ONLY 拒绝兼容项，主客户端失败不换内核；监听器回归归零。
- `scripts/client-probe-integration.cjs`：真实 Mihomo 204、非预期 200/500/302、错误密码、超时/取消、可信 HTTPS、证书主机名错误、JWT/RBAC、202、分页脱敏、STALE 条件写回通过。
- `scripts/upstream-integration.cjs`：真实 EXTERNAL、VLESS 中继、HTTP 鉴权中继的 Mihomo 请求及原 Sing-box 端到端通过。
- 15 项资源/迁移/前端契约回归通过。迁移只失效旧派生元信息并保留业务/金额。五平台官方 Release digest 对照、下载/hash/PE/ELF/Mach-O 检查通过。
- 隔离 `scripts/dev-e2e.sh` 使用全新 scratch 绝对主库/观测库，迁移/种子、完整 Master、真实 Agent/Sing-box、资源同步、Cookie、内核画像、异步 202/取消通过；本次进程回收。未迁移、删除或重置现有业务/默认联调库。
- 已核对 `scripts/dev-e2e*`：启动脚本需要准备/导出 Mihomo，已联动；旧脚本没有消费旧同步 probe 响应，新增隔离任务集成覆盖新契约。UI 索引维护完成，PI 环境按规范不执行视觉走查。
- 本机 WSL2 Debian 13 amd64 提供系统 Node20/pnpm9/Go1.27 与 Docker29，未安装/升级系统工具；Node22 集成只在独立测试镜像运行。实际交付 Sing-box1.14.0/libcronet/Mihomo1.19.30 已原生执行。Docker Master/Agent 正式构建、双标签导出/hash/重载和 Linux Master 归档独立启动通过（生产引导、全新双库、Cookie、真实 Agent/内核、画像、202/取消、对应模板验证）。Linux HTTP/中继/3项迁移资产回归合并运行容器 exitCode=0，临时容器/进程回收。macOS/arm64 未原生实测，Naive HTTP/3 不在本轮证据中。未提交、推送、发版或递增版本。
- 一轮只读复核发现 4 类问题，已先复现再修复：TLS 静默握手超时/取消 HANG、同 ID 与 TARGET_LINE 证书更新版本缺失、显式禁用 uTLS 被残留指纹重启、取消/截止任务前序已应用结果未刷新缓存。13 项相关后端/12 项前端契约测试、最终六门禁/原生/两套集成及全应用隔离 E2E 再次通过；未启动额外审查。
- WSL 补验先复现并修复正式导出脚本未定义 HOST_UNAME、Mihomo listener 早于 tunnel Running 造成首请求 ECONNRESET、端口就绪轮询遗留 abort listeners；冷启动/监听器/导出回归通过。就绪屏障只访问回环随机令牌自检，不计测速、业务 listener 不 DIRECT 兜底；未扩大回退或放宽 TLS/状态契约。Naive fixture 无新增依赖，错密码/不可信证书/错 SNI/500 均拒绝。
