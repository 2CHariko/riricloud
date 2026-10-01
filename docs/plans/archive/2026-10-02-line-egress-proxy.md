---
title: "线路最终落地 HTTP/SOCKS5 出站"
type: plan
status: completed
created_at: "2026-10-01"
target_version: "下一次 MINOR 发布"
archived_at: "2026-10-02"
---
# 线路最终落地代理出站

## 已批准范围

自建直连在当前节点、自建盲转发/协议代理中继在最终落地节点执行 HTTP CONNECT 或 SOCKS5 出站；TARGET_LINE 继承目标 DIRECT 线路。UPSTREAM_NODE/EXTERNAL 不叠加。代理侧解析保留的目标域名，SOCKS5 UDP 默认关闭、显式开启，HTTP 拒绝 UDP。故障不直连回退。配置整段 AES-GCM 加密，秘密仅送执行节点。高级覆盖双向冲突校验。复用 config_sync，不安装管理 WARP、不修改系统路由、不支持 HTTPS 或分流/代理链。

## 工作项

- [x] 可空列迁移、公共校验/加密/脱敏与 DTO/API。
- [x] 最终业务入站出站生成、私网/白名单优先、失败关闭与高级覆盖双向保护。
- [x] 桥接继承、复制、配置同步与拨测版本失效。
- [x] 前端高级设置、草稿/认证/清除交互、中文词条与纯表单测试。
- [x] 单元/契约、迁移与真实内核 HTTP/SOCKS5/DNS/UDP/无回退集成。
- [x] 完整质量门禁、文档/Unreleased/UI台账同步。

## 验证与部署边界

使用独立 scratch 库/端口/内核 fixtures，不改现有数据库/服务。WARP 实际出口和目标服务解锁待部署环境验证，不以本地 fixture 成功冒充解锁。PI-Desktop 不执行限定 Antigravity 的视觉走查。完成后用 pnpm plan:archive 归档。

## 实施证据与自查

- 独立分支 feat/server-line-egress，未改版本、未提交/推送/发布、未执行现有用户库迁移。
- pnpm gate 六门禁全绿：Server 95 套/830 测试通过，既有 5 套/34 测试跳过；Web lint/tsc/Vite、i18n、版本文档及 Agent vet/gofmt/test/build 通过。前端轻量契约共 30 项通过；Vite 大分块提示非阻断。
- Windows amd64、项目 Sing-box 1.14.0-r2 七标签真实编译内核：HTTP/SOCKS5 DIRECT/盲转发/协议中继/桥接、代理侧域名、UDP 默认拒绝/显式 SOCKS5 成功、错误认证/停止代理无直出全部通过；授权/来源白名单/gRPC 倍率计费不回归。
- 新增迁移与既有代理池迁移保留回归 2/2 通过；正式 Prisma generate 不修改用户库。
- 原 scripts/proxy-pool-integration.cjs 发现 WS/HTTP 缓存竞态，先补两项确定性复现后修复失效代数与批次等待者；原集成重新完整通过。
- 限定一次只读复核发现前端 trim 用户名问题，修正原样保留并补前后端凭据测试；未进行第二轮宽泛审查。
- 已检索 scripts/dev-e2e* 与 fixtures：新增字段可选，旧启动/创建/启停请求省略仍保持原行为，故不改启动脚本；新 API、WS/HTTP 同步及真实数据面由新增/既有测试覆盖。
- 未连接真实 WARP、未实测地区/服务解锁；只维护 UI-23/24 台账，不执行限定 Antigravity 的视觉验证，不宣称 Linux/macOS 原生执行。
