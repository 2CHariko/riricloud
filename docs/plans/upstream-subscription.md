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
- [x] 任务 4.1: `/admin/upstreams` 页面（列表、创建/编辑、导入预览与物化、条目页签）
- [x] 任务 4.2: 线路表单新增出口选择器与健康门开关
- [x] 任务 4.3: 路由、侧边栏与 zh-CN i18n 词条
- [x] 任务 4.4: 同步更新 DATA_MODELS / API_AND_PROTOCOLS / ARCHITECTURE / FRONTEND_UI_GUIDELINES / VISUAL_VERIFICATION
- [x] 任务 4.5: `pnpm gate` 六门禁全绿（待真机联调项见下方验收记录，完成后归档本规划）

---

## 🧪 验收标准与测试记录

### 已由自动化门禁覆盖

- [x] 单元测试全绿：`pnpm --filter @riricloud/server exec jest`（74 套 / 690 用例，其中本特性新增 54 条）
  - 解析器 22 条：三种格式、Reality/WS/SS 变体、URI 六协议、`entryKey` 稳定性与凭据解耦、加密落库还原
  - 上游服务 23 条：URL 脱敏、预览不落库、对账（新增/凭据轮换/条目下线）、抓取失败 502、物化 2 条线路、CRUD
  - 健康门 9 条：成功下发、探测失败/无快照/快照过期剔除、线路级与全局开关、出口消失、普通线路不受影响
  - 出口凭据保护 5 条：`enc:v1:` 前缀、幂等、三元组提取、uuid 兜底、损坏输入容错
  - 编译器 5 条：单跳、出口线路不生成入站、双跳落地、上游不可用降级、跨节点出口补载与关系回填
  - 出口引用校验 7 条：四条拒绝规则 + UDP 放行 + 端口例外
- [x] `pnpm gate` 六门禁全绿（version / docs / i18n / server / web / agent，退出码 0）

### 待真机联调（需要在有 Agent 与真实机场订阅的环境执行）

- [ ] **P1 手工验收（单跳）**：在管理端建一条入口线路（如 VLESS+Reality），手工建一条上游出口线路并绑定上游条目，客户端导入订阅后确认出口 IP 为上游 IP
- [ ] **P1 手工验收（双跳）**：`RELAY/BLIND_FORWARD` 与 `RELAY/PROTOCOL_PROXY` 线路挂同一出口，确认流量路径为「入口 → 落地 → 上游」且落地节点本地出网
- [ ] **P1 手工验收（计费）**：上游线路流量正常入账，配额熔断、设备限制与倍率生效
- [ ] **P3 真实机场订阅联调**：走通「导入 → 预览（确认跳过原因合理）→ 物化 → 订阅可见 → 客户端连通」
- [ ] **P3 健康门实测**：停掉上游后触发测速，确认该线路从用户订阅中消失、恢复后重新出现，且线路 `status` 全程未被修改
- [ ] **P3 同步对账实测**：确认机场轮换凭据后用户侧不断流、线路 ID 与流量归属不变

> 上述真机项未执行前，不建议将本特性标记为生产就绪；规划保持 `active` 状态，完成后执行 `pnpm plan:archive upstream-subscription.md` 归档。
