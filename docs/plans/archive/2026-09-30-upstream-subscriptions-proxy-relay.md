---
title: "上游订阅导入与多模式融合功能方案 (Upstream Subscriptions & Proxy Relay)"
type: plan
status: completed
created_at: 2026-09-30
archived_at: 2026-09-30
target_version: "v0.10.0"
---

# 上游订阅导入与多模式融合功能方案 (Upstream Subscriptions & Proxy Relay)

---

## 任务执行清单

- [x] 数据模型扩展 (`apps/server/prisma/schema.prisma`)：新增 `UpstreamSubscription` 与 `UpstreamNode`，扩展 `Line` 关联 `upstreamNodeId`
- [x] 数据模型设计规范文档更新 (`docs/DATA_MODELS.md`)：登记新增模型与字段字典
- [x] 后端上游订阅解析引擎 (`apps/server/src/upstream/upstream-parser.service.ts`)：支持 Mihomo (Clash Meta) YAML、Sing-box JSON、标准 URI 列表（Base64 / 纯文本）自动探测与协议归一化
- [x] 解析引擎单元测试 (`apps/server/src/upstream/upstream-parser.service.spec.ts`)：全面覆盖协议、流量头解析与指纹计算
- [x] 上游管理服务 (`apps/server/src/upstream/upstream.service.ts`)：支持订阅源 CRUD、定时/手动同步、指纹差异比对、失效节点自动停用关联线路、TCP 握手连通性测速与 URI 快速导出
- [x] 上游 API 控制器与 DTOs (`apps/server/src/upstream/upstream.controller.ts`)：管理端 REST 接口完备落地
- [x] 接口与协议规范文档同步更新 (`docs/API_AND_PROTOCOLS.md`)
- [x] 边缘 Agent 网关配置同步联动 (`apps/server/src/agent-gateway/agent-gateway.service.ts`)：支持 `UPSTREAM_NODE` 模式下的 Sing-box Outbound 组装与 Inbound 路由计费
- [x] 通用客户端订阅生成引擎联动 (`apps/server/src/subscription/subscription.service.ts` & `builders.ts`)：支持 `isDirectSub` 外部节点合并下发
- [x] 前端 API 客户端与数据类型扩展 (`apps/web/src/lib/api.ts`)
- [x] 前端多语言字典更新 (`apps/web/src/locales/zh-CN/admin.ts` & `common.ts`)
- [x] 前端侧边导航与路由挂载 (`apps/web/src/components/layout/app-sidebar.tsx` & `router/index.tsx`)
- [x] 线路表单级联组件改造 (`apps/web/src/pages/admin/lines/`)：支持选择上游节点落地与一键创建中转
- [x] 上游订阅管理前端页面落地 (`apps/web/src/pages/admin/upstream/`)：卡片列表、指标概览、立即同步、节点抽屉、批量测速与导出
- [x] 更新日志登记 (`CHANGELOG.md`)
