---
title: "default-docker-hub-images"
type: plan
status: completed
target_version: v0.9.5
created_at: "2026-09-28"
author: "Antigravity & Maintainers"
archived_at: "2026-09-28"
---
# 项目 Docker 部署模板与安装命令全面切换 Docker Hub 官方镜像源

## 🎯 目标与背景

将项目中预构建镜像编排模板（`docker-compose.image.yml`）、配置示例（`.env.image.example`、`.env.example`）与服务端节点安装命令生成器默认镜像源全面对齐至 Docker Hub 官方仓库地址（`2chariko/riricloud-master:latest` 与 `2chariko/riricloud-agent:latest`），实现免配置一键在线拉取部署。

---

## 📋 里程碑与任务清单

### 里程碑 1：Docker Compose 模板与配置示例更新
- [x] 任务 1.1: 更新 `docker-compose.image.yml`，默认镜像指向 `2chariko/riricloud-master:latest` 与 `2chariko/riricloud-agent:latest`，将默认 `pull_policy` 设为 `if_not_present`
- [x] 任务 1.2: 更新 `.env.image.example` 与 `.env.example`，提供 Docker Hub 默认配置与 GHCR / 本地离线包备用注释示例

### 里程碑 2：服务端节点安装指令生成器与文档联动
- [x] 任务 2.1: 更新 `apps/server/src/nodes/nodes.service.ts` 与 `apps/server/src/system/system.service.ts`，默认 Agent 镜像回退值统一设为 `2chariko/riricloud-agent:latest`
- [x] 任务 2.2: 更新 `docs/DEPLOYMENT_GUIDE.md` 部署与运维指南，全面统一 Docker Hub 在线拉取与节点容器化部署指令

### 里程碑 3：工程治理、质量门禁与规划归档
- [x] 任务 3.1: 更新 `CHANGELOG.md` 维护 `[Unreleased]` 变更记录
- [x] 任务 3.2: 运行六合一质量门禁（`pnpm gate`）验证全绿并归档本规划任务

---

## 🧪 验收标准与测试记录

- [x] `docker-compose.image.yml` 默认无需手动指定变量即可直接拉取并运行
- [x] 节点管理页生成 Docker 命令正确包含 `2chariko/riricloud-agent:latest`
- [x] 六合一质量门禁 `pnpm gate` 校验全绿
