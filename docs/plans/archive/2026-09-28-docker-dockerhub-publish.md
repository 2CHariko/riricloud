---
title: "docker-dockerhub-publish"
type: plan
status: completed
target_version: v0.9.5
created_at: "2026-09-28"
author: "Antigravity & Maintainers"
archived_at: "2026-09-28"
---
# GitHub Actions 自动化双发布 Docker 镜像至 Docker Hub 与 GHCR

## 🎯 目标与背景

支持在 GitHub Actions 镜像构建工作流中同时将 RiriCloud Master（主控端）与 Agent（边缘节点）Docker 镜像自动构建并推送到 Docker 官方镜像仓库（Docker Hub, `docker.io`）与 GitHub Packages Container Registry (GHCR, `ghcr.io`)。
基于 Docker Buildx 单次多目标构建分发机制，在保证镜像 Digest 一致的同时免去重复构建；通过仓库 Secret 凭证（`DOCKERHUB_USERNAME` 与 `DOCKERHUB_TOKEN`）自适应鉴权，支持优雅降级与名称自动小写规整。

---

## 📋 里程碑与任务清单

### 里程碑 1：GitHub Actions 工作流改造与 Docker Hub 接入
- [x] 任务 1.1: 在 `.github/workflows/docker-publish.yml` 引入 `DOCKERHUB_USERNAME` 与 `DOCKERHUB_TOKEN` 凭证检测，增加 Docker Hub 登录步骤
- [x] 任务 1.2: 在元数据解析步骤中为 Master / Agent 镜像标签同时生成 GHCR 与 Docker Hub 标签列表（全小写规整），统一注入 Buildx 构建推送
- [x] 任务 1.3: 保持 Release 事件（`v*`、`agent-v*`）与手动 `workflow_dispatch` 独立构建模式，提供优雅降级（未配置 Secret 时安全回退至仅推 GHCR）

### 里程碑 2：部署模板与文档联动更新
- [x] 任务 2.1: 更新 `docker-compose.image.yml` 与 `.env.image.example` 补充 Docker Hub 镜像地址示例
- [x] 任务 2.2: 更新 `docs/DEPLOYMENT_GUIDE.md` 补充从 Docker Hub 在线拉取镜像部署完整指引及双 Registry 说明

### 里程碑 3：工程治理、质量门禁与归档
- [x] 任务 3.1: 更新 `CHANGELOG.md` 维护 `[Unreleased]` 变更记录
- [x] 任务 3.2: 运行全量质量门禁（`pnpm gate`）验证全绿并归档本规划任务

---

## 🧪 验收标准与测试记录

- [x] 工作流 YAML 语法合规，Docker Hub 凭证与条件判断分支健壮
- [x] 部署文档与 Compose 模板指引清晰
- [x] 六合一质量门禁 `pnpm gate` 校验全绿
