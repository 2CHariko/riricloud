---
title: "节点管理批量 Agent 升级"
type: plan
status: completed
target_version: 0.10.0
created_at: "2026-09-29"
author: "RiriCloud Maintainers"
archived_at: "2026-09-29"
---
# 节点管理批量 Agent 升级

## 目标与范围

在管理员节点列表多选节点，批量下发主控托管的 Agent 资源版本。复用单节点升级、资源按每个节点架构解析、持久化任务历史以及 WS/HTTP Agent 投递，不新增数据库模型、外部依赖或 Agent/WS 协议。

批量接口最多接受 100 个唯一节点 UUID，可选指定 ACTIVE Agent 资源；自定义 URL 不适用于异构平台批量升级。WS 在线任务标记已下发，HTTP/离线任务按既有持久任务语义排队，禁用节点跳过。逐节点失败与成功互不影响并在响应中报告。Master-Local 可按与其他节点相同方式参与。

## 里程碑与任务清单

### 里程碑 1：后端接口与逐节点升级编排
- [x] 新增 DTO、UUID/去重/数量上限校验和管理员批量升级端点。
- [x] 每节点复用单节点资源解析与升级任务持久化；按 4 个并发分批执行，逐节点返回 DISPATCHED / QUEUED / FAILED。
- [x] 禁用、缺失节点、资源架构不匹配及单项错误独立处理；错误文本不返回 URL 或 SHA-256。
- [x] 增加服务层混架构、投递状态、禁用/缺失/平台不匹配的混合结果、并发上限及 DTO 校验测试。

### 里程碑 2：管理端多选与结果反馈
- [x] 节点列表按行选择/当前筛选结果全选，支持保留其他筛选已选项、清空、100 节点限制及删除节点后的陈旧选择清理。
- [x] 新增批量确认与逐节点结果弹窗；仅列出对所有选中架构都可用的 ACTIVE 托管资源，未知架构匹配主控默认 linux/amd64 fallback。
- [x] 成功/部分失败 Toast、服务端查询缓存失效和 zh-CN 新词条。
- [x] E2E 评估：`scripts/dev-e2e.sh` 仅启动一个 Agent，并不包含批量投递/回执 harness；无需修改启动流程或 fixture，混合结果与部分失败由 NodesService 单测覆盖。

### 里程碑 3：文档、质量门禁与归档
- [x] 同步 API、架构、UI 指南/视觉索引、README 和 CHANGELOG。
- [x] 运行完整 `pnpm gate`，所有质量门禁通过；版本门禁确认 `[Unreleased]` 已维护，因此无需提前 bump。
- [x] 保存 E2E 自查结论与视觉走查状态，并按规范准备归档。

## 验收记录

- [x] 后端定向单测：2 suites / 24 tests passed。
- [x] `pnpm --filter @riricloud/web exec tsc --noEmit`：通过。
- [x] `pnpm gate`：version、docs、i18n、server（71 suites / 615 tests）、web（lint/build）及 agent 全部通过。
- [x] E2E 评估：当前 `scripts/dev-e2e.sh` 仅编排单个 Agent，不具备异构节点批量任务回执测试 harness；未改脚本/fixture，由服务层逐节点混合成功/失败回归测试覆盖。
- [x] UI 视觉走查已评估并登记：本会话未在 Antigravity 环境执行，后续如需验收应在 Antigravity 中按 Light/Dark、桌面及 `375x812` / `768x1024` 视口走查；未接入 CI/Git Hook。
- [x] 无 Prisma schema/迁移、Agent 协议或依赖变更；单节点升级契约保持不变。
