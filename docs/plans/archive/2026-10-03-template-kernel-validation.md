---
title: 订阅预览原生校验与外部资源诊断
type: plan
status: completed
target_version: Unreleased
created_at: "2026-10-03"
author: "PI-Desktop & Maintainers"
archived_at: "2026-10-03"
---
# 订阅预览原生校验与外部资源诊断

## 目标与边界

将仅凭资源引用跳过校验改为结构化依赖分析与受控离线资源验证，区分未执行、失败和完整通过；不修改订阅规则语义，不联网获取任意 provider，不读取模板指定的任意宿主文件，不改变 Agent/数据库。

## 已完成任务

- [x] 建立独立分支、核对契约及版本规范，版本保持 0.9.11 并维护 Unreleased。
- [x] 先补复现测试，实现按内核/位置识别、去重、有界脱敏的资源明细。
- [x] 实现受控目录与固定哈希资源快照、临时目录准备及进程失败分类。
- [x] 接入固定地理资源清单与 Docker/发行包/本地 E2E 准备链路。
- [x] 实现前端中文诊断、语义状态、依赖明细及旧响应兼容。
- [x] 同步 API、架构、部署、技术与视觉索引文档以及 Unreleased。
- [x] 执行相关单元、契约、固定内核原生测试、资源准备验证及 pnpm gate。
- [x] 补充隔离 HTTP 预览接口回归，记录环境受限项与支持边界，归档。

## 实现及安全边界

- `resourceRequirements` 与截断计数为兼容新增字段，最多返回 50 项；保留 status/executed/scope/diagnostics。规则、DNS、sniffer 等入口共用资源分析，动态名称转换为配置序号位置。
- Mihomo 的固定 GEOIP/MMDB/DAT/GEOSITE/ASN、inline provider 和受控 domain/ipcidr YAML/text 文件可验证；Sing-box inline rule-set 不再误判。其他远程/不支持资源仍明确阻断，无内核静默回退。
- 地理资源必须同时匹配部署清单与应用的固定资产清单；不引入新的地理格式解析库。这样排除“坏文件配上正确自定义哈希”诱发内核修复下载。地理数据升级需同步固定清单并重做原生验证。
- 固定来源为 MetaCubeX/meta-rules-dat 提交 `a6544a371c34182ecec0363eafccd4ab3b93a58f`，四文件实际字节总计 40,504,233；下载和 SHA-256 已验证，来源/许可提示保留在清单。
- 单资源 32 MiB、快照 80 MiB、部署清单 256 项；快照与原配置分离，不写回共享库。校验并发 2 包住文件读取，仍复用全局进程两槽位。应用固定清单元数据只读缓存，实际资源字节每次有界读取并重新哈希，不用可能陈旧的文件内容缓存。
- 一次只读检查发现 sniffer 地址 GEOIP 遗漏、非固定地理包及准备失败清理异常导致槽位泄漏，均补测试修复。清理目录失败时 finally 释放槽位，并返回受控错误。

## 验证记录

2026-10-03，Windows Git Bash，Node 24.14.1、pnpm 9.15.9：

1. 初始四个复现用例先失败后通过：Sing-box inline rule-set、无关 local/remote 元数据、远程资源结构化诊断、重复 YAML 键。
2. `RUN_NATIVE_CLIENT_TESTS=1 pnpm --filter @riricloud/server exec jest --runInBand client-kernels templates.service.spec.ts`：7 套件、61 用例全通过。包括真实 Mihomo 1.19.30 的 MMDB/DAT/GEOSITE/ASN/嵌套规则、DNS、sniffer、inline/local provider，以及缺资源、远程哨兵、原生拒绝和进程清理；原有 Sing-box 原生最小检查亦通过。
3. `VALIDATION_RESOURCE_FIXTURE_DIR=artifacts/validation-resources node --test scripts/prepare-validation-resources.test.mjs scripts/client-kernels.test.mjs apps/web/src/lib/probe-contract.test.mjs`：21 项全通过、无跳过。真实字节离线导入、缓存校验/修复、原子失败保护、打包接入及 UI 状态契约均覆盖。
4. `pnpm gate`：version/docs/i18n/server/web/agent 六门禁全部通过；后端 99 套件、865 项通过，门禁默认未开启的原生等测试共 48 项跳过（本次相关原生测试已由第 2 项单独启用）。Web 构建只有非阻断大分包警告。
5. `node scripts/client-probe-integration.cjs`：隔离临时库与回环 HTTP 联调通过，新增预览 JWT/RBAC、真实 GeoIP 通过、原始配置保留、远程资源未执行及脱敏明细断言；已有真实代理 HTTP 状态/鉴权/超时/取消、任务与 STALE 写入也通过。未操作业务数据库。
6. `bash -n scripts/bundle-master.sh scripts/dev-e2e.sh`、Node 脚本语法检查及 `git diff --check` 通过。

## 未执行与范围说明

- 当前 PATH 无 Docker 命令，未进行完整 Docker 镜像构建/运行或非 root 容器实测；Docker 与发行包接入通过静态回归、目录/清单断言与脚本语法验证。未运行完整 Linux Master 发行包装配及 Linux arm64/macOS 原生检查。
- 隔离联调未提供 HTTPS fixture，脚本明确输出 NOT EXECUTED；不沿用历史 TLS 验证结论。本次不修改 TLS 请求逻辑。
- 当前非 Antigravity 环境，按项目规范未执行视觉走查；UI-19 索引已维护。
- 未启动会触及既有 dev/E2E 数据目录的完整 dev-e2e 流程；该启动脚本仅新增固定离线资源准备，已用独立隔离 HTTP 脚本验证相关新契约。
- 不支持任意远程资源联网验证/上传、任意宿主证书映射、classical/MRS 本地 provider 与 Sing-box 外部 rule-set；这些配置明示限制而非制造通过。
- 未执行提交、推送、PR 或生产部署；工作区保持在 `fix/templates-kernel-validation`。
