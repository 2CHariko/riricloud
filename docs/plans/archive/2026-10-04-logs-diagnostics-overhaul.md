---
title: 日志可信度与无重启诊断全链路优化
type: plan
status: completed
target_version: Unreleased
created_at: "2026-10-04"
author: "PI-Desktop & Maintainers"
archived_at: "2026-10-04"
---
# 日志可信度与无重启诊断全链路优化

## 目标与边界

修复真实错误丢失、DEBUG 采集阻断、脱敏误伤、发生时间缺失和写库失败静默丢失；补充只读快照、生命周期、过滤一致统计与完整性导出。保留旧 Agent/JSON/CSV 契约，不添加外部设施、访问全量记录或定时自动重启。不宣称已确认原故障根因。Master/Agent 版本保持不变，各自维护 Unreleased。

## 任务

- [x] 确认协议并先更新 API 文档，建立兼容契约
- [x] Agent：采集门槛、错误分类、实例/时间/序号、队列统计与重要事件保护
- [x] Agent：生命周期、只读进程/本地 API 快照、WS/HTTP 有界执行与发送
- [x] Server：精确脱敏与 HMAC 匿名相关性、协议校验与发生时间
- [x] Server：有界持久化重试与计数、统一过滤/稳定排序、诊断 bundle
- [x] Web：错误分类、上报可靠性、过滤统计/SSE、快照交互与完整性提示
- [x] 回归测试、E2E/fixture 影响核对、文档与双轨变更日志
- [x] 六项门禁通过并机械归档

## 验收记录

- 最终分别执行 gate:version、gate:docs、gate:i18n、gate:server、gate:web、gate:agent，全通过；Master 0.9.13、Agent 0.8.6 保持不变，无数据库迁移、依赖增删、commit/push。
- Server：tsc、eslint、102 套件/936 测试通过；8 套件/55 项原生内核测试按现有环境开关默认跳过，不宣称执行。补充 HTTP/WS 旧新日志、纳秒时间/metadata 预算、快照一次下发/过期、SSE 过滤/订阅清理、重试/损失/导出/精确清理、凭据与超预算身份保留回归。一次有界只读复核发现的 UUID、Cookie 尾段与身份截断缺陷均已复现、修复并验证。
- Agent：go vet、gofmt、全量 go test、Windows/amd64 build 通过；日志、Sing-box、runner、WS、HTTP、devices、stats 七包另以 -count=1 无缓存复跑通过。真实夹具子进程验证控制台 INFO 下 stdout DEBUG/stderr ERROR 采集、出生实例关联与启动输送；真实 WS/HTTP 测试验证任务能力、幂等、快照日志和失败重入。Linux/amd64、Linux/arm64、Darwin/amd64、Darwin/arm64 交叉构建通过，不等于目标平台运行验证。
- Web：TypeScript、ESLint、Vite、i18n 门禁通过；lib 下轻量测试 57/57（含新增日志 13/13）通过，代理池独立测试 8/9，通过合计 65/66。唯一失败为既有 proxy-pool-contract.test.mjs:55 字面源码正则与等价 disabled={!isAvailable} 实现不匹配，HEAD 已同样存在，两文件本次未修改。Vite 保留大 chunk 警告；en/ja 均 95.4%（各 180 条待翻译），按规范回退中文。
- E2E 影响核对：检索 scripts/dev-e2e* 与 fixture，协议版本/登录/启动参数不变，新字段可选且快照能力协商。已直接核对 Agent 保留 sing-box started 文本及 network health unverified 限定，并以生命周期测试断言；三个既有脚本测试文件 19 项通过（含真实 Nest CLI 隔离构建）。不需要修改既有启动 fixture；未执行完整 Master/Web/Agent 服务联调或生产长稳复现。
- 视觉索引已维护；视觉验证仅按需由 Antigravity 执行，本次 PI-Desktop 不执行。未验证真实浏览器下载/Beacon、Linux/macOS 原生运行或线上故障复现。原生产故障版本、资源趋势与根因仍未核实，不新增自动周期重启。
- 运行边界：队列/幂等缓存只在内存中，优先级与重试不构成零丢或持久化确认；快照 context/HTTP 预算不构成系统调用硬实时保证，本地 readiness 不证明业务网络、独立 OS 存活或响应进程身份。平台不支持资源时显式 unavailable，周期采样可能漏过短故障。
