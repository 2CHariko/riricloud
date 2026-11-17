---
title: "流量账务与 SQLite 写入链路优化"
type: plan
status: active
target_version: "现网验收待排期"
updated_at: "2026-11-17"
created_at: 2026-09-03
---

# 流量账务与 SQLite 写入链路优化计划

## 2026-11-17 台账复核

本计划保留 **19/20**：协议与账务代码已交付，最后一项“生产替换与游标/写队列观察”仍未完成。本轮只读核对代码、迁移和测试记录，没有访问生产数据库或执行部署。旧 `0.5.0` 是历史交付版本，不再作为下一次目标版本；当前 Master/Agent 版本分别读取根 `package.json` 与 `apps/agent/VERSION`，不因台账收尾重新 bump。

## 目标与架构决策

- 保留 SQLite + WAL，不引入 PostgreSQL、Redis、MQ 或其他外部服务。
- Master 与 Agent 使用协议 v2，拒绝 v1/缺失版本；部署时须核对所有在线节点协议能力，不允许把历史 v0.5.0 发布记录当成已替换现网 Agent 的证据。
- Agent 通过 `QueryStats(reset=false)` 上报累计流量，Master 使用按节点与凭证隔离的 `TrafficCursor` 计算增量。
- 高频 Agent 写入使用单写者队列；同节点积压遥测和累计快照只保留最新值，速率指标按五分钟桶聚合后批量写入。

## 实施清单

### 协议 v2

- [x] 增加 `protocolVersion: 2`，WS `auth_result` 和 HTTP 轮询响应返回协议版本。
- [x] 将 `trafficRecords` 替换为 `trafficSnapshots`，累计值以十进制字符串传输。
- [x] Master 拒绝 v1、缺失版本和非法累计值；Agent 校验 Master 返回的协议版本。
- [x] WS 与 HTTP 复用同一累计快照采集和 Master 账务入口。

### 流量账务

- [x] 新增 `TrafficCursor(nodeId, credential)` 模型、唯一约束、索引与 Prisma migration。
- [x] 实现首次快照、递增差额、单方向重置、相等快照和未知凭证处理。
- [x] 将 `TrafficLog`、User/Subscription 配额、`TrafficCursor` 放入同一事务。
- [x] 按用户和订阅聚合后批量更新配额，保留增量流水记录。
- [x] 使用真实 Prisma Client + SQLite 测试大整数、重复快照、并发心跳和事务链路。

### SQLite 写入调度

- [x] 增加单例 Agent 写入队列，串行化心跳、注册、回执、速率写入、巡检和清理。
- [x] 同节点心跳采用最新值覆盖，速率指标在内存中按 UTC 五分钟桶聚合。
- [x] 写入失败保留最新心跳任务，使用指数退避继续重试；记录队列等待、队列深度、慢事务和计数器重置日志。
- [x] 保留 WAL 与 `busy_timeout`，不以无限增大事务超时解决写锁争用。

### 验证与文档

- [x] 更新 API、数据模型、架构和部署文档，写明协议破坏性变更、迁移顺序和回滚要求。
- [x] 更新 `CHANGELOG.md` 的 `[Unreleased]`，开发阶段保持根版本不变。
- [x] 补充协议边界、超大整数、未知凭证、重置计数器、SQLite 并发和写入失败重试测试。
- [x] 通过 Server 类型检查、Lint、全量 Jest、Agent gofmt/go test/go vet。
- [x] 通过 Prisma schema 校验并生成最新 Client。
- [x] 历史发布记录：在发布分支执行 `pnpm bump minor` 固化 `0.5.0`，完成五合一门禁、Agent/Docker 构建和 Release。
- [ ] 获得独立生产维护授权后，核对全部 Agent/Master 协议 v2 与实际版本，按部署顺序处理未升级节点，观察游标幂等、写队列积压/重试及慢事务；补部署记录和观察窗口结果后才能归档。

## 运行与回滚（待授权执行）

生产实施须单独确认维护窗口、节点清单和回滚版本。本轮未授权部署，此处只保留验收要求。遵循现行维护 CLI 和部署指南，对业务/观测双库、对应 WAL/SHM 与运行资源做停服冷备，独立保存加密密钥并先验证备份；不能直接复制正在写入的数据库冒充一致性备份。

对于仍处于旧协议的部署：停止旧 Agent 与 Master，使用已审核、兼容协议 v2 的分别版本产物，按当前追加迁移流程升级 Master，确认就绪后逐一恢复 Agent。已使用 v2 的部署不因本计划重复迁移或退回历史 v0.5.0。回滚应恢复相容的代码、双库和资源，不允许新旧协议混跑。

生产记录至少包含脱敏节点清单/协议版本、迁移前后版本、备份校验摘要、观察起止时刻，以及重复快照、计数器重置、队列深度/等待、重试和慢事务的结论；不能记录用户认证材料或原始数据库行。

## 本轮证据与局限

| 检查对象 | 证据 | 结论 |
| :--- | :--- | :--- |
| 累计快照与事务 | `apps/server/src/agent-gateway/agent-gateway.sqlite.spec.ts`：真实 SQLite 大整数、并发重复快照及事务回滚；`artifacts/verification/gate-submission.log` 对应套件 PASS | 证明隔离账务回归，不能证明现网已升级 |
| 历史集成基线 | `artifacts/validation/mail-logs-gate.log`：109 套件、1085 项通过，55 项 opt-in 跳过，Agent 门禁通过 | 保留历史基线；不是本轮最新完整门禁 |
| 本轮本地集成 | `artifacts/verification/gate-submission.log`：完整 gate 退出 0；Server 124 套件/1597 项通过，11 套件/105 项 native 跳过；Web 144 项、脚本 106 项、维护 33 项通过，脚本另 4 项默认跳过；Agent 通过 | 证明本轮本地门禁与隔离回归；工具链提交 `f982646`，其余集成尚未提交，不证明生产升级或观察通过 |
| 生产观察 | 未取得部署、游标或写队列观察工件 | 最后一项继续未勾选，不归档 |

早期 native discovery 与 E2E storage 的失败日志仅保留为历史排障；`gate-submission.log` 已记录成功复跑。最后一项生产观察仍缺维护授权、部署及观察窗口工件，继续未勾选且不归档。

## 历史验收记录（保留原记录，不作为本轮生产证据）

- Server 全量测试：27 个测试套件、218 项测试通过，包含协议边界、真实 SQLite 并发幂等和事务回滚测试。
- Agent：`go test ./...`、`go vet ./...` 通过，便携工具链版本为 Go 1.27.0。
- Prisma：schema validate、client generate 与本地 `prisma migrate deploy` 通过；迁移文件已加入仓库，生产部署使用 `prisma migrate deploy`。
- 发布：`v0.5.0` 已合并至 `main` 并创建 GitHub Release；WSL Docker 已完成 Master/Agent 双标签构建与镜像导出校验。
