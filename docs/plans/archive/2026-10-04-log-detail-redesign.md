---
title: 日志详情抽屉视觉重构与极客美学恢复
type: plan
status: completed
target_version: Unreleased
created_at: "2026-10-04"
author: "PI-Desktop & Maintainers"
archived_at: "2026-10-04"
---
# 日志详情抽屉视觉重构与极客美学恢复

## 🎯 目标与背景

恢复图一的高密度、高对比度极客排版与即开即阅体验，同时优雅收纳图二新增的时钟可信度、时序与采集诊断能力。
解决过度卡片化（Card Fatigue）、信息碎片化、Trace ID 挤压折行、JSON 强制折叠等视觉痛点。

### 核心设计原则
1. **Header 整合时间与时钟质量**：副标题直接展示本地毫秒时间 + 时区 + 序列号；时钟质量（若有时钟回退异常则告警 Badge）紧凑呈现，干掉冗余空卡片。
2. **Trace ID 专属高光条**：恢复全宽独立横幅栏，UUID 单行等宽展示，保留快速复制与“按此链路过滤”操作。
3. **轻量扁平上下文栅格**：去除厚重 Card 边框与阴影，采用紧凑、高密度的信息元组（来源、模块、用户、关联节点）。
4. **日志描述与错误堆栈**：独立高亮区块，错误堆栈以醒目警告样式置顶展示。
5. **结构化 JSON 元数据直接呈现**：恢复深色终端高光代码块（`bg-zinc-950`），取消手风琴折叠，直接展示，设置最大高度与内部滚动。
6. **诊断统计降噪收拢**：实例 ID 与采集健康度（collectorStats）收纳至底部紧凑诊断区，仅在有异常数据时高亮。

---

## 📋 里程碑与任务清单

### 里程碑 1：展示层与组件重构
- [x] 任务 1.1: 重构 `LogDetailDrawer` 结构布局（恢复 Header 时间、全宽 Trace 栏、深色代码块）
- [x] 任务 1.2: 轻量化 `LogContextCards`（扁平微底色栅格，去 Card 化）
- [x] 任务 1.3: 重构 `LogMetadataSection`（深色终端直出，取消强制 Accordion，带独立复制）
- [x] 任务 1.4: 优化 `LogCorrelation` 与 `LogCollectorStats`（紧凑微型徽标与状态栏，降噪排版）

### 里程碑 2：多语言词条与测试校验
- [x] 任务 2.1: 核对 `apps/web/src/locales/zh-CN/admin.ts` 词条
- [x] 任务 2.2: 运行并修复展示层测试（`apps/web/src/lib/log-detail-presentation.test.mjs` 等）

### 里程碑 3：质量门禁与归档
- [x] 任务 3.1: 更新 `CHANGELOG.md` 与 UI 规范/视觉台账
- [x] 任务 3.2: 运行 `pnpm gate` 全量通过
- [x] 任务 3.3: 归档规划文档 `pnpm plan:archive`

---

## 🧪 验收标准与测试记录

- [x] Trace ID 单行不换行，具备快速复制和按链路过滤
- [x] 结构化元数据 JSON 默认直出、深色终端风格，支持滚动与一键复制
- [x] 异常堆栈醒目展示
- [x] 门禁 `pnpm gate` 六项全绿
- [x] 前端单元测试 75/75 全绿
