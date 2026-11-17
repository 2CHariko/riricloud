---
title: "NAT 落地 WireGuard 未来扩展"
type: plan
status: active
target_version: "未排期（未来扩展）"
created_at: "2026-11-17"
author: "Contributors & Maintainers"
---

# NAT 落地 WireGuard 未来扩展

本计划承接原 [NAT 反向穿透计划](./nat-landing-node-reverse-tunnel.md) 的任务 5.2、5.3。当前实现仍是 TCP/TLS Yamux；本轮只拆分台账，不实现 WireGuard，也不指定发版版本。`active` 表示尚未完成的计划，非已获准实施或正在开发。

## 原任务与后续启动条件

- [ ] 原 5.2：主控 WireGuard 拓扑生成器，为入口与落地分配隔离虚拟网段和 x25519 密钥对，明确配对、冲突、轮换与删除生命周期。
- [ ] 原 5.3：按届时锁定的 Sing-box 版本实现 WireGuard Endpoint 配置与路由适配，不以旧“1.11+”说明代替实际兼容性验证。
- [ ] 进入实施前重新确认授权、资源预算、权限/跨平台约束和部署/回滚设计；涉及红线变化先按项目规范审议。
- [ ] 实施后补密钥隔离、端点失效、UDP 不可用、路由与 NAT 场景测试，并完成对应原生与集成门禁。

## 完成边界

不得通过新增枚举或文档声明把本计划勾为完成；需实际代码和测试产物。NAT Yamux 主线是否可归档独立取决于其自身证据，不能用本计划承接已有实现的安全缺陷来绕过主线验收。
