---
title: 系统日志页紧凑布局恢复
type: plan
status: completed
target_version: Unreleased
created_at: "2026-10-04"
author: "PI-Desktop & Maintainers"
archived_at: "2026-10-04"
---
# 系统日志页紧凑布局恢复

## 目标与边界

以用户第二张截图为紧凑视觉基准，恢复单行日志、固定辅助列、彩色等级与宽搜索；模块/日期与新增诊断能力按需访问。不原样复制旧版裸 HTML，不回滚 Server/Agent、API、SSE、过滤、导出或节点详情，不修改全局 UI 原子样式，不新增依赖、不升版本。

用户要求先提交全部未提交变更：已在 feat/logs-diagnostics-overhaul 完成基线提交 53b04a1（66 文件）；提交前 pnpm gate 和日志契约 13/13 通过，正常执行 hook，工作区干净。后续实施位于 fix/web-logs-compact-ui，未推送。

## 任务

- [x] 对照截图/代码/Git 差异分析并获得方案批准
- [x] 保存现有全部变更为独立基线提交，切非 main 修复分支
- [x] 先补四项失败回归，再恢复 40px 单行表格与系统时区毫秒短时间
- [x] 高级筛选 RHF/Zod 响应式弹窗，应用/取消/日期校验与活跃摘要
- [x] 页头诊断弹窗，Portal 外观察状态与节点隔离，原节点卡展示保持
- [x] 中文词条、Unreleased、UI 规范与视觉索引同步
- [x] 最终轻量测试、六项门禁、diff 检查及机械归档

## 验收记录

- 日志专项 22/22（新增展示 9/9、原日志契约 13/13）通过；前端 lib 轻量测试 66/66 全通过。
- 最终 pnpm gate 全绿：版本/文档/i18n、Web TypeScript/ESLint/Vite、Server TypeScript/ESLint/Jest（102 套件、936 测试通过；8 套件、55 原生用例按现有配置跳过）、Agent vet/gofmt/test/Windows amd64 build。Vite 保留既有 >500 kB 分包警告，非阻断。
- git diff --check 通过，修改范围仅 Web 展示/测试/中文词条与对应文档，Server/Agent/API/启动/全局原子样式未变；UI 修复尚未提交或推送，版本保持不变。
- 轻量测试覆盖系统时区/毫秒/无效时间、本地输入 UTC 往返、模块-only 不改变时间预设；React 静态渲染长正文/高亮/节点/重复/Trace、筛选回调阻止行点击、分页/详情/空态/骨架；高级筛选应用/取消/倒序拒绝、诊断关闭重开复用观察。不是浏览器视觉或真实 DOM 事件验证。
- E2E 影响：只变展示与筛选入口，REST/WS 字段、请求、启动流程均未修改；旧日志契约继续覆盖统一过滤、SSE 新票据/资源清理、taskId 精确匹配与截止、bundle 截断。无需改 scripts/dev-e2e* 或 fixture，不宣称执行完整联调。
- 视觉验收仅限 Antigravity；本次 PI-Desktop 不执行浏览器走查，不引入框架/CI/hook。待用户或 Antigravity 对照双主题、桌面/手机/平板/超宽视口确认实际外观。
