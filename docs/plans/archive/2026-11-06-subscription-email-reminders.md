---
title: "subscription-email-reminders"
type: plan
status: completed
target_version: Unreleased
created_at: "2026-11-06"
author: "Antigravity & Maintainers"
archived_at: "2026-11-06"
---
# 订阅流量预警与套餐到期邮件

## 🎯 目标与背景

为普通用户增加流量阈值预警和套餐到期邮件，复用现有 SMTP 与 SQLite，保持零外部队列依赖。全局功能默认关闭，用户可退订；仅向启用偏好、邮箱已验证且账号启用的普通用户发送。

---

## 📋 里程碑与任务清单

### 里程碑 1：数据模型与邮件基础
- [x] 任务 1.1: 增加 `User.subscriptionEmailNotificationsEnabled` 与 `SubscriptionEmailDelivery` 投递台账迁移。
- [x] 任务 1.2: 增加流量预警、套餐到期邮件模板与 BigInt 安全格式化。

### 里程碑 2：提醒巡检与配置
- [x] 任务 2.1: 实现启动 30 秒后首扫、每 5 分钟单飞巡检，按当前最高流量档/最紧迫到期档发送。
- [x] 任务 2.2: 实现周期键与里程碑唯一去重、失败 6 小时重试和 180 天台账清理。
- [x] 任务 2.3: 增加全局邮件开关、阈值 DTO 校验、SMTP 启用校验及用户偏好 API。

### 里程碑 3：前端交互与联调
- [x] 任务 3.1: 系统设置「订阅与分发」增加提醒配置卡片。
- [x] 任务 3.2: 个人中心增加订阅邮件即时开关与未验证提示。
- [x] 任务 3.3: 完成中/英/日词条与 i18n 门禁。

### 里程碑 4：文档与质量门禁
- [x] 任务 4.1: 同步更新数据模型、API、架构、前端 UI、视觉台账、路线图与 CHANGELOG。
- [x] 任务 4.2: 运行完整 `pnpm gate`，完成规划归档。

---

## 🧪 验收标准与测试记录

- [x] 单元测试覆盖流量/到期边界、当前最高档、周期去重、失败重试与 SMTP 配置校验。
- [x] SQLite 约束测试覆盖同一订阅、类型、周期和里程碑的唯一性。
- [x] 迁移 SQL 在最小 SQLite 模型上验证通过；`prisma validate` 通过。
- [x] 完整质量门禁全绿（`pnpm gate`，2026-11-06）。

## E2E 影响评估

现有 `scripts/dev-e2e*` 未消费 `/admin/settings`、`/auth/me` 或 `/user/notification-preferences`，本次新增字段与偏好接口不需要修改 E2E 脚本或 fixture；提醒链路由服务端单元测试和 SQLite 约束测试覆盖。
