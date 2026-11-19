---
title: "本地 E2E 启动恢复与数据面验收"
type: plan
status: completed
target_version: Unreleased
created_at: "2026-11-18"
author: "Contributors & Maintainers"
archived_at: "2026-11-18"
---
# 本地 E2E 启动恢复与数据面验收

## 🎯 目标与背景

保留原双库解决启动维护锁冲突，补齐本地真实业务链路的自动验收。Docker、发行包和公网部署不在本轮范围。

---

## 📋 里程碑与任务清单

- [x] 确认停服后只归档两处过期 E2E 锁，保留原双库、WAL/SHM 和密钥。
- [x] 维护锁冲突独立诊断；只在受验证 IPC 确认关闭且真实释放锁后重试绑定；Web 校验代理目标。
- [x] 新增隔离命令，验证真实 Agent、Cookie 与订阅、TCP/UDP 数据面以及退出清理。
- [x] 更新部署指南、架构、数据模型与未发布日志。

---

## 🧪 验收标准与测试记录

- [x] Windows Git Bash `pnpm gate` 通过，维护用例 34/34；预期只在原生矩阵运行的用例由常规门禁跳过。
- [x] 原双库在 Windows Git Bash 连续两次启动到内核就绪，停机后两把数据库锁均释放；未强制接管或重置数据库。
- [x] 隔离验收完成真实订阅 TCP HTTP 与 UDP 回显；主动让中途配置断言失败时返回非零，仍清理进程、端口、锁及临时目录。
- [x] 真实编译 Nest 在已占用端口返回 `MASTER_PORT_IN_USE` 并释放锁，使用同一双库重启及正常停机成功。
