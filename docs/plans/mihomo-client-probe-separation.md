---
title: "双内核职责解耦与统一端到端拨测"
type: plan
status: active
target_version: "下一次 MINOR 发布"
created_at: "2026-10-01"
author: "Maintainers & PI-Desktop"
---

# Mihomo 主客户端与端到端拨测

## 批准范围

Sing-box 保持服务端入站、鉴权、统计与中继出口。Mihomo 默认用于主要客户端编译、验证和真实拨测；Sing-box 客户端只进行能力白名单限定的兼容回退，不能因超时、鉴权失败或环境缺失静默回退。保留现有 URI/Base64/Sing-box JSON 辅助格式。拨测改为异步任务，不保留 TCP 成功或旧同步批量响应语义。

任务全局 4 连接、2 进程，批次最多 32；排队最多 20、单管理员最多 2 活跃任务、单任务最多 10000 资源和 30 分钟期限，完成状态内存保留 15 分钟。端到端快照条件写回防旧结果覆盖，配置变更/失效/删除后标 STALE。只新增安全测量元信息并失效旧派生延迟，不清业务资源/账务，不新增 Agent 协议/外部服务。不自动提交、推送或发布。

## 执行清单

- [x] 固定版本 Mihomo API/目标状态/证书/取消语义实验与能力矩阵
- [x] 共享连接编译与内核能力解耦
- [x] 内核定位、进程生命周期、验证与严格 Mihomo 执行器
- [x] 异步任务、全局限额、资源快照与条件结果写回
- [x] 线路/上游接口、调度、测量元信息迁移与回退设置
- [x] 前端异步进度/取消/分页、内核画像与模板验证新契约
- [x] Docker/发行包/本地/E2E 内核资源交付代码与五平台资产验证
- [x] 架构/技术/接口/数据/部署/UI 文档及 Unreleased
- [x] Windows 单元、HTTP/隔离数据库、真实内核、隔离全应用 E2E 与六门禁
- [x] 本机 WSL 补验 Master/Agent 镜像构建/容器运行、离线导出/校验/重载与 Linux Master 发行包
- [x] Linux amd64 原生执行及 Naive/Cronet HTTP/2 可用环境真实链路补验
- [ ] macOS/其他架构原生执行补验（本机 WSL 不提供该环境，不以 amd64 结果替代）

## 固定版本实验

本机 Mihomo v1.19.30 已确认：HTTP 出站使用 CONNECT。正确鉴权的 /delay 对 HTTP 204、200、500、302 都返回 delay，`expected=204` 未使其拒绝非预期状态；错误代理密码返回 503。因此使用独立 Mihomo 客户端和明确回环路由的标准 HTTP 请求进行严格状态/证书验证，不以 delay 数字冒充符合目标响应契约的成功。

## 验收记录

实现、Windows 本机及 WSL Linux/Docker/发行包验收已完成；macOS/其他架构原生验收受环境限制，保留进行中计划，不将其伪记完成或归档。

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
