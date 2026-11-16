---
title: 邮件发送日志统一记录
type: plan
status: completed
target_version: Unreleased
created_at: "2026-11-17"
author: "Codex & Maintainers"
archived_at: "2026-11-17"
---
# 邮件发送日志统一记录

## 目标与边界

五个既有邮件发送入口统一记录 SERVER/Mail：验证码（REGISTER、CHANGE_EMAIL、VERIFY_CURRENT_EMAIL、RESET_PASSWORD）、流量预警、套餐到期、证书汇总、SMTP 测试。MailService 每次实际调用只提交一条终态：MAIL_SEND_ACCEPTED / INFO 或 MAIL_SEND_FAILED / ERROR；提醒巡检自身异常为 MAIL_SWEEP_FAILED / ERROR。SMTP 接受不等于收件箱投递。

仅服务端专用 enqueueMail 白名单保留业务邮箱、域名/IP、主题、SMTP 诊断明文；正文、验证码、密码和 AUTH 凭据不采集，诊断中的秘密仍须剔除，普通日志 mask 不变。metadata 保留 event、operationId（亦顶层 traceId）、mailType、action、to/from/subject、smtpHost/smtpPort/smtpSecure、durationMs、messageId、smtpResponse、accepted/rejected、stage（CONFIG/VERIFY/SEND/SWEEP）、error（name/message/code/responseCode/command/response），按业务关联 userId/subscriptionId/deliveryId/certificateIds/certificateRevisions/certificateCount。UTF-8 序列化超过 16 KiB 时保留 identity summary + truncated；重试生成新 operationId，同一投递沿用 deliveryId。

保留 AUTH 业务审计，调用方不重复记录相同发信失败；保存 SMTP 配置的 verify 仍为 HTTP 日志。沿用既有门槛、容量、清理与 SSE best effort，不新增 API、表、迁移、页面或依赖，版本保持 0.9.19，变更进入 Unreleased。

## 实施与验收台账

- [x] 读取根 AGENTS、架构/约束及相关接口、安全、部署和版本规范，核对五入口与日志链路。
- [x] 同步 API 日志契约、架构、查日志方法、安全边界澄清与 CHANGELOG Unreleased。
- [x] 检索 scripts/dev-e2e*、E2E 测试和 fixture，记录无需更新的具体理由。
- [x] 实现并集成 enqueueMail 白名单、凭据剔除、16 KiB 截断及普通 mask 回归测试；外部上报伪装 Mail 不得放宽规则。
- [x] 实现并集成 MailService 五入口与验证码四 action 的成功/失败单终态测试，覆盖 CONFIG/VERIFY/SEND、SMTP 诊断及返回/异常兼容。
- [x] 集成调用方 userId/subscriptionId/deliveryId/certificateIds/certificateRevisions/certificateCount 关联、重试新操作号、AUTH 审计保留、失败去重和 SWEEP 异常回归。
- [x] 完成集成验收与 pnpm gate 全绿，核对最终代码/契约一致并使用 pnpm plan:archive server-mail-logs.md 归档。

## E2E 自查（无需更新）

本次仅新增服务端内部观测记录，未改变 HTTP/WS 路径、鉴权、请求/响应结构、节点/Agent 生命周期或联调启动契约，无需修改下列脚本、测试及 fixture：

| 已检索消费者 | 具体判断 |
| :--- | :--- |
| scripts/dev-e2e.sh、dev-e2e-server.sh、dev-e2e-server-build.mjs、dev-e2e-server.test.mjs | 消费版本接口、本次进程与 HTTP listener ready、管理员登录 authenticated 响应和 riricloud_access Cookie，再准备节点/线路；本次均不改变，未将 Mail 事件作为就绪条件 |
| dev-e2e-agent-version*、dev-e2e-ports*、dev-e2e-sync-resource* | 校验 Agent 版本/资源、节点与线路端口、管理员 Cookie 鉴权及资源上传/启用/默认接口；未消费邮件发送结果或邮件 metadata，既有契约不变 |
| dev-e2e-kernel*、dev-e2e-native.test.mjs | 验证内核 PID/配置/本地 API、TCP 与原生进程链路；本次不改变 Agent、内核配置及协议，不触及其 fixture/断言 |
| scripts/line-egress-fixtures.cjs、apps/server/src/certificates/certificate-fixture.ts | 分别构造 CONNECT/SOCKS5/UDP 测试代理与 X.509 证书材料；邮件观测不改变这些输入、鉴权或证书材料。仓库未发现独立 apps/server/test E2E 目录 |

发送单终态、SMTP 错误信息、凭据剔除和提醒巡检的新增断言由服务层单元/回归测试承接；若集成时改变上述外部契约，必须重新评估本节并同步脚本与回归用例。

## 验收记录

2026-11-17 完成三个子代理并行实施及独立子代理代码审查；主任务负责调用方关联、复现测试、集成与完整门禁。

| 项目 | 最终结果 |
| :--- | :--- |
| 复现测试先行 | 已确认投递关联缺失、巡检异常未入日志及 SMTP 接受后台账写入失败被吞掉的旧行为，再实现修复 |
| 发送与日志回归 | 覆盖五入口、验证码四 action、CONFIG/VERIFY/SEND、异常和 resolved 全拒收、日志故障隔离、明文诊断、凭据剔除、16 KiB 截断及普通日志规则不变 |
| 业务关联与巡检 | 用户/订阅/投递/证书修订关联、六小时重试、去重、巡检异常、发送后台账/证书日限额事务失败及原重试行为均通过回归 |
| 最终 pnpm gate | gate:version、gate:docs、gate:i18n、gate:server、gate:web、gate:agent 全部通过；后端 109 套、1085 项通过，8 套、55 项需显式开启的原生内核测试按仓库默认条件跳过；前端测试/lint/构建及 Agent vet/gofmt/test/build 均通过 |
| E2E 与外部 SMTP | E2E 消费者已按上文评估，无需更新且未单独运行 dev-e2e 脚本；测试使用模拟 SMTP，未向真实收件箱发送测试邮件，不宣称收件箱投递成功 |
| 版本与格式 | Master 0.9.19、Agent 0.8.7 均保持不变；维护根 CHANGELOG Unreleased，git diff --check 通过 |

完整本地门禁输出保存在忽略目录 artifacts/validation/mail-logs-gate.log。独立审查指出的“SMTP 已接受后成功台账写入失败没有诊断”已补充订阅/证书复现测试与带业务关联的 MAIL_SWEEP_FAILED 日志；不重复记录 MAIL_SEND_FAILED，也不改变原六小时重试和证书日限额规则。
