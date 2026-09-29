---
title: "上游订阅导入与出口编排"
type: plan
status: active
target_version: "v0.9.10"
created_at: "2026-09-30"
author: "Antigravity & Maintainers"
---

# 上游订阅导入与出口编排

## 🎯 目标与背景

支持导入 mihomo / sing-box / Base64 URI 三种格式的上游订阅，把其中的节点转换为 RiriCloud 自有线路，并满足三种交付形态：① 作为独立线路进入用户订阅；② 作为指定线路的中转出口；③ 作为直连代理（代理池 `IP:Port:User:Pass`）。

**核心架构决策**：上游节点不能直接写进用户订阅——用户订阅里的每个条目都是"我们的公网节点 + 我们生成的入站凭据"，直接透传上游服务器与凭据会把上游账号交给用户，并绕开配额、设备限制与计费。因此三种形态统一收敛为一个机制：

> **任何线路都可以声明一个"出口"（egress），把自己的用户流量路由到一个指向上游的 sing-box outbound。**

三种形态只是同一机制在不同 `protocolType` / `type` 下的暴露方式。已确认的产品决策：入口节点可为任意在线节点（含 `Master-Local`）；上游线路完全等同普通线路，参与套餐匹配与公开列表（因此**健康门是必需品**）；解析器覆盖 mihomo / sing-box / Base64 URI；单跳与双跳拓扑都要支持。

---

## 📋 里程碑与任务清单

### 里程碑 1：出口机制（P1）
- [x] 任务 1.1: `Line` 新增 `upstreamEntryId` / `egressLineId` / `upstreamSubscriptionId` / `upstreamHealthGate` / `upstreamHealthMaxAgeSecs`，新增 `UpstreamSubscription` 与 `UpstreamProxyEntry` 模型与迁移
- [x] 任务 1.2: `buildProtocolRelayOutbound` 凭据来源参数化（内部中转 vs 上游真实凭据）
- [x] 任务 1.3: 编译器 egress 分支：单跳（`DIRECT` / `TARGET_LINE`）与双跳（`BLIND_FORWARD` / `PROTOCOL_PROXY` 落地）拓扑
- [x] 任务 1.4: 上游出口线路不生成入站、不占用真实端口；出口线路跨节点绑定时按 `egressLineId` 补载并回填关系
- [x] 任务 1.5: `lines.service` 四条出口引用校验（必须指向上游出口线路、禁止链式出口、上游出口线路不支持中继、本地代理入站不得直连纯 UDP 上游）
- [x] 任务 1.6: `egressLineId` / `upstreamHealthGate` / `upstreamHealthMaxAgeSecs` 的 DTO 与 view 输出（上游凭据不进响应）
- [x] 任务 1.7: 上游凭据应用层 AES-GCM 加密（`protectEntryParams` 幂等）与 `resolveUpstreamCredentials`
- [x] 任务 1.8: 单测覆盖编译器单跳/双跳/不可用上游/跨节点出口补载，以及五条校验规则与端口例外

### 里程碑 2：上游解析器（P2）
- [x] 任务 2.1: 格式识别（mihomo YAML / sing-box JSON / Base64 URI）与 `proxy-providers` 递归一层
- [x] 任务 2.2: mihomo 解析器（`reality-opts` / `ws-opts` / `ss` 等变体）
- [x] 任务 2.3: sing-box 解析器（`outbounds[]`）
- [x] 任务 2.4: Base64 URI 列表解析器（vless / vmess / trojan / hysteria2 / tuic / ss）
- [x] 任务 2.5: 出口参数归一化（显式写 `tls`，不依赖入站默认值），`entryKey` 排除凭据
- [x] 任务 2.6: 不支持项逐条给出跳过原因，不因单节点失败中断整批导入
- [x] 任务 2.7: 三种格式的真实脱敏样本 fixture 单测与 `entryKey` 稳定性断言

### 里程碑 3：订阅源、物化与健康门（P3）
- [x] 任务 3.1: `fetchSafeRemoteBuffer` 封装、`maskUpstreamUrl` 脱敏、URL 不入日志
- [x] 任务 3.2: 订阅源 CRUD、立即同步、导入预览（预览不落库）
- [x] 任务 3.3: 物化（一键生成线路）与对账（凭据刷新、条目下线保留线路）
- [x] 任务 3.4: 定时同步（`setInterval` + `unref`，零新依赖）
- [x] 任务 3.5: 健康门：上游出口线路直连探测 + `getAvailableForPlan` 新鲜度过滤
- [x] 任务 3.6: `upstreamSubscriptionEnabled` / `upstreamHealthGateEnabled` / `upstreamHealthMaxAgeSecs` 系统设置
- [x] 任务 3.7: 全部 `/admin/upstreams/*` REST API 与 Swagger 注解

### 里程碑 4：前端与文档（P4）
- [ ] 任务 4.1: `/admin/upstreams` 页面（列表、创建/编辑、导入预览与物化、条目页签）
- [ ] 任务 4.2: 线路表单新增出口选择器与健康门开关
- [ ] 任务 4.3: 路由、侧边栏与 zh-CN i18n 词条
- [ ] 任务 4.4: 同步更新 DATA_MODELS / API_AND_PROTOCOLS / ARCHITECTURE / FRONTEND_UI_GUIDELINES / VISUAL_VERIFICATION
- [ ] 任务 4.5: `pnpm gate` 六门禁全绿并归档本规划

---

## 🧪 验收标准与测试记录

- [x] P1 单元测试：`pnpm --filter @riricloud/server exec jest` 全绿（72 套 / 636 用例）
- [x] P1 手工验收（单跳）：手工建入口线路 + 上游出口线路，客户端导入订阅后出口 IP 为上游 IP
- [x] P1 手工验收（计费）：上游线路流量正常入账，配额熔断与设备限制生效
- [x] P2 解析器 fixture 全过（22 条解析单测）
- [x] P3 上游服务单测全过（23 条：脱敏、预览、对账、物化、CRUD）+ 健康门 9 条
- [ ] P3 真实机场订阅联调走通"导入 → 预览 → 物化 → 订阅可见"
- [ ] P4 `pnpm gate` 六门禁全绿
