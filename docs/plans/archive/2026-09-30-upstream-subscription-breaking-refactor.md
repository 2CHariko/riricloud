---
title: 上游订阅破坏性重构：统一线路授权与可靠同步
type: plan
status: completed
target_version: "下一次 MINOR 发布"
created_at: "2026-09-30"
author: "Maintainers & PI-Desktop"
archived_at: "2026-09-30"
---
# 上游订阅破坏性重构

## 批准依据与范围

执行已批准的 `.pi/plan/上游订阅破坏性重构-取消旧兼容-统一线路授权与可靠同步-20260930-1915.md` 快照。删除旧 `isDirectSub`、旧接口和 fingerprint，不做数据转换、旧数据回填或兼容分发；直接分发使用 EXTERNAL Line，沿用套餐与额外线路授权。用户摘要不输出连接秘密，中继经自建入口计费，外部直发不承诺本地流量、限速、设备执行或凭据撤销。

不清理现有数据库；隔离数据库验收，迁移前阻止携带旧上游数据的升级。不提交、推送、改版本或发布，不引入外部服务、新框架或新的 Agent 协议。

## 实施清单

- [x] 数据模型、新增迁移及旧上游数据升级前置检查
- [x] 删除旧直接分发路径、用户安全投影与序列化修复
- [x] 安全拉取、严格解析、稳定身份与原子同步
- [x] EXTERNAL 线路、统一授权与多格式连接编译
- [x] 中继可用性、用户名一致性、计费入口与配置失效
- [x] 前端新契约、分页、表单、直接分发风险说明
- [x] 同步架构、接口、数据、部署、UI 文档与 Unreleased
- [x] 定向回归、HTTP/隔离数据库与真实内核联调
- [x] 六门禁及最终差异检查

## 验收记录

2026-09-30 验收：

- `pnpm gate` 六门禁全绿，server 78 套件/724 测试；web lint/build、i18n、Agent vet/gofmt/test/build 全部通过。版本未改，未提交、推送或发布。
- `node --test scripts/upstream-upgrade-preflight.test.cjs scripts/upstream-migration.test.cjs apps/web/src/lib/upstream-contract.test.mjs`：13/13 通过；内存 SQLite 验证普通线路保留、旧上游数据在持久结构变化前拒绝，没有清理现有数据库。
- `node scripts/upstream-integration.cjs`：临时新库与回环 HTTP/JWT/RBAC，实际导入/加密、EXTERNAL 默认、安全摘要、ALL/TAGS/EXPLICIT/额外授权、到期/额度/邮箱、旧接口拒绝、源禁用/参数更新通过；真实配置服务的 WS 测试帧与 HTTP 共用配置缓存失效断言通过（不连接真实 Agent）。
- Sing-box 1.14 校验服务端/客户端配置，Mihomo 完整隔离订阅校验通过；外部 VLESS-WS 直发、VLESS 入口中继、HTTP 用户名密码入口中继的真实代理请求均返回 HTTP 204。为离线测试显式使用无 GeoIP 下载的测试模板，生产默认模板未改。
- `prisma validate`、Docker Node 语法、`bash -n scripts/dev-e2e.sh`、`git diff --check` 通过；E2E 脚本在任何迁移前加入只读上游升级检查，未运行原脚本以免复用现有联调数据库。
- 定向内核校验覆盖代表性协议；Naive 在 Windows 上缺 `libcronet.dll`，该协议本机原生验证未完成，不用 JSON 单测冒充实测。TLS SOCKS 明确拒绝。PI 环境不执行仅限 Antigravity 的视觉走查；英语/日语新增词条按约定回退中文。

最终集成修复：共享 SS2022 仍不可用户计费，仅 multi-user 允许；用户名密码协议使用冒号安全可逆登录名，统计还原原用户/线路；用户/套餐摘要白名单、模板内部编译保留外部连接、前后端统一 upstreamSummary；创建源 status 与文本切换元信息规则已补回归。
