#!/usr/bin/env bash
# 构建、标记、导出并运行 RiriCloud Docker 镜像。
set -euo pipefail

RIRI_ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$RIRI_ROOT"

COMMAND="${1:-build}"

case "$COMMAND" in
  build|export|up|down|tags) ;;
  *)
    echo "用法：$0 {build|export|up|down|tags} [docker compose options]" >&2
    exit 2
    ;;
esac

die() {
  echo "Docker 操作失败：$*" >&2
  exit 1
}

require_linux_docker_environment() {
  local shell_name
  local docker_os

  shell_name="$(uname -s 2>/dev/null || true)"
  [ "$shell_name" = "Linux" ] || die "Docker 构建、导出与 Compose 操作只能在 Linux/WSL shell 中执行；Windows PowerShell/Git Bash 请从 WSL 调用"
  command -v docker >/dev/null 2>&1 || die "缺少 docker，请确认 WSL 已启用 Docker Desktop 集成"
  docker_os="$(docker info --format '{{.OSType}}' 2>/dev/null || true)"
  [ "$docker_os" = "linux" ] || die "Docker daemon 必须运行在 Linux containers 模式，当前为：${docker_os:-unavailable}"
}

case "$COMMAND" in
  build|export|up|down)
    require_linux_docker_environment
    ;;
esac

NODE_BIN="${NODE_BIN:-node}"
case "$NODE_BIN" in
  *.exe) die "Linux/WSL 环境严禁调用 Windows Node.js 工具链（$NODE_BIN），请在当前 Linux/WSL 系统中安装原生 Node.js" ;;
esac
command -v "$NODE_BIN" >/dev/null 2>&1 || die "缺少原生 node（Linux/WSL 下严禁回退调用 Windows node.exe）"
if [ "$("$NODE_BIN" -p 'process.platform' 2>/dev/null || true)" = "win32" ]; then
  die "检测到当前 node 指向 Windows 工具链（win32），Linux/WSL 下必须使用原生 Node.js"
fi

VERSION="$($NODE_BIN -p "require('./package.json').version")"
MASTER_VERSION="${RIRICLOUD_VERSION:-$VERSION}"
MASTER_VERSION="${MASTER_VERSION#v}"

AGENT_VERSION="${RIRICLOUD_AGENT_VERSION:-}"
if [ -z "$AGENT_VERSION" ]; then
  if [ -f "$RIRI_ROOT/apps/agent/VERSION" ]; then
    AGENT_VERSION="$(tr -d '[:space:]' < "$RIRI_ROOT/apps/agent/VERSION")"
  else
    AGENT_VERSION="$MASTER_VERSION"
  fi
fi
AGENT_VERSION="${AGENT_VERSION#v}"

case "$MASTER_VERSION" in
  ''|*[!A-Za-z0-9_.-]*) die "MASTER_VERSION 不是合法的 Docker tag：$MASTER_VERSION" ;;
esac
case "$AGENT_VERSION" in
  ''|*[!A-Za-z0-9_.-]*) die "AGENT_VERSION 不是合法的 Docker tag：$AGENT_VERSION" ;;
esac

MASTER_REPOSITORY="${MASTER_IMAGE_REPOSITORY:-riricloud/master}"
AGENT_REPOSITORY="${AGENT_IMAGE_REPOSITORY:-riricloud/agent}"
MASTER_VERSION_IMAGE="${MASTER_IMAGE:-${MASTER_REPOSITORY}:${MASTER_VERSION}}"
AGENT_VERSION_IMAGE="${AGENT_IMAGE:-${AGENT_REPOSITORY}:${AGENT_VERSION}}"
MASTER_LATEST_IMAGE="${MASTER_LATEST_IMAGE:-${MASTER_REPOSITORY}:latest}"
AGENT_LATEST_IMAGE="${AGENT_LATEST_IMAGE:-${AGENT_REPOSITORY}:latest}"
SINGBOX_VERSION="${SINGBOX_VERSION:-1.14.0}"
SINGBOX_REVISION="${SINGBOX_REVISION:-2}"
CRONET_VERSION="${CRONET_VERSION:-v150.0.7871.63-2}"
SINGBOX_SHA256="${SINGBOX_SHA256:-87baf6852e37941cbe40bdd94bec81c957c88a56751cecd6bbf0e6108bc69398}"
CRONET_SHA256_AMD64="${CRONET_SHA256_AMD64:-c3949c6ad64e1d8fcd1e3b1fae4e302b2e553d769665a4bd7576483564c3f026}"
CRONET_SHA256_ARM64="${CRONET_SHA256_ARM64:-8f13a6186aca498d37ee5e1f410282f587d663995aca60d6bf29a2d4f5536f2b}"
MIHOMO_VERSION="$(node "$RIRI_ROOT/scripts/prepare-client-kernels.mjs" --target linux-amd64 --field version)"
ARTIFACT_ROOT="${RIRICLOUD_ARTIFACT_DIR:-$RIRI_ROOT/artifacts}"

if [ -n "${DOCKER_PLATFORM:-}" ]; then
  DOCKER_PLATFORM_VALUE="$DOCKER_PLATFORM"
elif [ "$COMMAND" = "build" ] || [ "$COMMAND" = "export" ]; then
  DOCKER_PLATFORM_VALUE="$(docker info --format '{{.OSType}}/{{.Architecture}}')"
else
  # tags/up/down 不需要解析 Docker daemon 平台；构建/导出时会在上方强制校验。
  DOCKER_PLATFORM_VALUE="${RIRICLOUD_DOCKER_PLATFORM:-linux/amd64}"
fi

platform_filename() {
  local platform="$1"
  local os="${platform%%/*}"
  local arch="${platform#*/}"
  arch="${arch%%/*}"
  case "$arch" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    armv7|arm) arch="armv7" ;;
  esac
  printf '%s_%s\n' "$os" "$arch"
}

PLATFORM_NAME="$(platform_filename "$DOCKER_PLATFORM_VALUE")"
PLATFORM_DIR="${PLATFORM_NAME//_/-}"
NORMALIZED_PLATFORM="${PLATFORM_NAME//_//}"
VCS_REF="${RIRICLOUD_VCS_REF:-$(git rev-parse HEAD 2>/dev/null || printf 'unknown')}"
BUILD_DATE="${RIRICLOUD_BUILD_DATE:-$(date -u '+%Y-%m-%dT%H:%M:%SZ')}"

platform_args=()
if [ -n "${DOCKER_PLATFORM:-}" ]; then
  platform_args+=(--platform "$DOCKER_PLATFORM")
fi

build_images() {
  echo "构建 Master 镜像：$MASTER_VERSION_IMAGE、$MASTER_LATEST_IMAGE"
  docker build "${platform_args[@]}" \
    --build-arg "RIRICLOUD_VERSION=$MASTER_VERSION" \
    --build-arg "RIRICLOUD_VCS_REF=$VCS_REF" \
    --build-arg "RIRICLOUD_BUILD_DATE=$BUILD_DATE" \
    --build-arg "RIRICLOUD_IMAGE_TAGS=$MASTER_VERSION,latest" \
    --build-arg "SINGBOX_VERSION=$SINGBOX_VERSION" \
    --build-arg "SINGBOX_REVISION=$SINGBOX_REVISION" \
    --build-arg "CRONET_VERSION=$CRONET_VERSION" \
    --build-arg "SINGBOX_SHA256=$SINGBOX_SHA256" \
    --build-arg "CRONET_SHA256_AMD64=$CRONET_SHA256_AMD64" \
    --build-arg "CRONET_SHA256_ARM64=$CRONET_SHA256_ARM64" \
    --tag "$MASTER_VERSION_IMAGE" \
    --tag "$MASTER_LATEST_IMAGE" \
    --file Dockerfile .

  echo "构建 Agent 镜像：$AGENT_VERSION_IMAGE、$AGENT_LATEST_IMAGE"
  docker build "${platform_args[@]}" \
    --build-arg "RIRICLOUD_VERSION=$AGENT_VERSION" \
    --build-arg "RIRICLOUD_VCS_REF=$VCS_REF" \
    --build-arg "RIRICLOUD_BUILD_DATE=$BUILD_DATE" \
    --build-arg "RIRICLOUD_IMAGE_TAGS=$AGENT_VERSION,latest" \
    --build-arg "SINGBOX_VERSION=$SINGBOX_VERSION" \
    --build-arg "SINGBOX_REVISION=$SINGBOX_REVISION" \
    --build-arg "CRONET_VERSION=$CRONET_VERSION" \
    --build-arg "SINGBOX_SHA256=$SINGBOX_SHA256" \
    --build-arg "CRONET_SHA256_AMD64=$CRONET_SHA256_AMD64" \
    --build-arg "CRONET_SHA256_ARM64=$CRONET_SHA256_ARM64" \
    --tag "$AGENT_VERSION_IMAGE" \
    --tag "$AGENT_LATEST_IMAGE" \
    --file Dockerfile.agent .
}

require_image_tags() {
  local image
  for image in "$MASTER_VERSION_IMAGE" "$MASTER_LATEST_IMAGE" "$AGENT_VERSION_IMAGE" "$AGENT_LATEST_IMAGE"; do
    docker image inspect "$image" >/dev/null 2>&1 || die "找不到镜像：$image，请先执行 pnpm docker:build"
  done
}

image_label() {
  local image="$1"
  local key="$2"
  local value
  value="$(docker image inspect "$image" --format "{{index .Config.Labels \"$key\"}}" 2>/dev/null || true)"
  [ "$value" = "<no value>" ] && value=""
  printf '%s' "$value"
}

export_images() {
  require_image_tags

  local output_dir="${DOCKER_EXPORT_DIR:-$ARTIFACT_ROOT/docker/${PLATFORM_DIR}}"
  mkdir -p "$output_dir"
  EXPORT_DIR="$output_dir"

  local master_archive="$EXPORT_DIR/riricloud-master_${MASTER_VERSION}_${PLATFORM_NAME}.tar.gz"
  local agent_archive="$EXPORT_DIR/riricloud-agent_${AGENT_VERSION}_${PLATFORM_NAME}.tar.gz"
  local checksum_file="$EXPORT_DIR/riricloud-docker-images_${MASTER_VERSION}_${PLATFORM_NAME}.sha256"
  local manifest_file="$EXPORT_DIR/riricloud-docker-images_${MASTER_VERSION}_${PLATFORM_NAME}.manifest.json"
  local master_label_version="$(image_label "$MASTER_VERSION_IMAGE" "org.opencontainers.image.version")"
  local master_label_revision="$(image_label "$MASTER_VERSION_IMAGE" "org.opencontainers.image.revision")"
  local master_label_created="$(image_label "$MASTER_VERSION_IMAGE" "org.opencontainers.image.created")"
  local master_label_tags="$(image_label "$MASTER_VERSION_IMAGE" "io.riricloud.image.tags")"
  local agent_label_version="$(image_label "$AGENT_VERSION_IMAGE" "org.opencontainers.image.version")"
  local agent_label_revision="$(image_label "$AGENT_VERSION_IMAGE" "org.opencontainers.image.revision")"
  local agent_label_created="$(image_label "$AGENT_VERSION_IMAGE" "org.opencontainers.image.created")"
  local agent_label_tags="$(image_label "$AGENT_VERSION_IMAGE" "io.riricloud.image.tags")"
  local agent_singbox_version="$(image_label "$AGENT_VERSION_IMAGE" "io.riricloud.singbox.version")"

  echo "导出 Master 镜像：$master_archive"
  docker save "$MASTER_VERSION_IMAGE" "$MASTER_LATEST_IMAGE" | gzip -n -c > "$master_archive"
  echo "导出 Agent 镜像：$agent_archive"
  docker save "$AGENT_VERSION_IMAGE" "$AGENT_LATEST_IMAGE" | gzip -n -c > "$agent_archive"

  (
    cd "$EXPORT_DIR"
    sha256sum "$(basename "$master_archive")" "$(basename "$agent_archive")" > "$checksum_file"
  )

  local master_digest
  local agent_digest
  master_digest="$(sha256sum "$master_archive" | awk '{print $1}')"
  agent_digest="$(sha256sum "$agent_archive" | awk '{print $1}')"
  local manifest_node_path="$manifest_file"

  "$NODE_BIN" -e '
    const fs = require("fs");
    const [manifestPath, version, platform, masterVersion, masterLatest, agentVersion, agentLatest,
      masterArchive, agentArchive, masterSha256, agentSha256, singboxVersion, singboxRevision, cronetVersion,
      masterLabelVersion, masterLabelRevision, masterLabelCreated, masterLabelTags,
      agentLabelVersion, agentLabelRevision, agentLabelCreated, agentLabelTags, created] = process.argv.slice(1);
    const manifest = {
      schemaVersion: 1,
      product: "RiriCloud",
      version,
      platform,
      generatedAt: created,
      images: [
        {
          component: "master",
          tags: [masterVersion, masterLatest],
          archive: masterArchive,
          sha256: masterSha256,
          labels: {
            "org.opencontainers.image.title": "RiriCloud Master",
            "org.opencontainers.image.version": masterLabelVersion || version,
            "org.opencontainers.image.revision": masterLabelRevision || "unknown",
            "org.opencontainers.image.created": masterLabelCreated || "unknown",
            "io.riricloud.image.tags": masterLabelTags || `${masterVersion},${masterLatest}`
          }
        },
        {
          component: "agent",
          tags: [agentVersion, agentLatest],
          archive: agentArchive,
          sha256: agentSha256,
          singboxVersion,
          singboxRevision,
          cronetVersion,
          labels: {
            "org.opencontainers.image.title": "RiriCloud Agent",
            "org.opencontainers.image.version": agentLabelVersion || version,
            "org.opencontainers.image.revision": agentLabelRevision || "unknown",
            "org.opencontainers.image.created": agentLabelCreated || "unknown",
            "io.riricloud.image.tags": agentLabelTags || `${agentVersion},${agentLatest}`
          }
        }
      ]
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  ' "$manifest_node_path" "$MASTER_VERSION" "$NORMALIZED_PLATFORM" \
    "$MASTER_VERSION_IMAGE" "$MASTER_LATEST_IMAGE" "$AGENT_VERSION_IMAGE" "$AGENT_LATEST_IMAGE" \
    "$(basename "$master_archive")" "$(basename "$agent_archive")" "$master_digest" "$agent_digest" \
    "${agent_singbox_version:-$SINGBOX_VERSION}" "$(image_label "$AGENT_VERSION_IMAGE" "io.riricloud.singbox.revision")" "$(image_label "$AGENT_VERSION_IMAGE" "io.riricloud.cronet.version")" \
    "$master_label_version" "$master_label_revision" "$master_label_created" "$master_label_tags" \
    "$agent_label_version" "$agent_label_revision" "$agent_label_created" "$agent_label_tags" "$BUILD_DATE"

  echo "镜像导出完成：$EXPORT_DIR"
  echo "版本清单：$manifest_file"
  echo "校验文件：$checksum_file"

  cleanup_exported_images
}

cleanup_exported_images() {
  case "${DOCKER_CLEANUP:-true}" in
    true|TRUE|1|yes|YES|on|ON)
      local image
      local cleanup_failed=0
      echo "清理已导出的本地 Docker 镜像标签..."
      for image in "$MASTER_VERSION_IMAGE" "$MASTER_LATEST_IMAGE" "$AGENT_VERSION_IMAGE" "$AGENT_LATEST_IMAGE"; do
        if ! docker image inspect "$image" >/dev/null 2>&1; then
          continue
        fi

        if docker image rm "$image" >/dev/null; then
          echo "已清理：$image"
        else
          echo "警告：无法清理 $image，可能仍被容器使用；导出包已保留" >&2
          cleanup_failed=1
        fi
      done

      if [ "$cleanup_failed" -ne 0 ]; then
        echo "部分 Docker 镜像未清理，请停止占用它们的容器后手动执行 docker image rm" >&2
      fi
      ;;
    false|FALSE|0|no|NO|off|OFF)
      echo "已跳过本地 Docker 镜像清理（DOCKER_CLEANUP=$DOCKER_CLEANUP）"
      ;;
    *)
      die "DOCKER_CLEANUP must be true or false"
      ;;
  esac
}

compose() {
  RIRICLOUD_VERSION="$MASTER_VERSION" \
  RIRICLOUD_AGENT_VERSION="$AGENT_VERSION" \
  RIRICLOUD_VCS_REF="$VCS_REF" \
  RIRICLOUD_BUILD_DATE="$BUILD_DATE" \
  RIRICLOUD_IMAGE_TAGS="$MASTER_VERSION,latest" \
  MASTER_IMAGE="$MASTER_LATEST_IMAGE" \
  AGENT_IMAGE="$AGENT_LATEST_IMAGE" \
  docker compose "$@"
}

case "$COMMAND" in
  build)
    build_images
    case "${DOCKER_EXPORT:-true}" in
      true|TRUE|1|yes|YES|on|ON) export_images ;;
      false|FALSE|0|no|NO|off|OFF) echo "已跳过镜像导出（DOCKER_EXPORT=$DOCKER_EXPORT）" ;;
      *) die "DOCKER_EXPORT must be true or false" ;;
    esac
    ;;
  export)
    export_images
    ;;
  up)
    shift
    compose up -d --build "$@"
    ;;
  down)
    shift
    docker compose down --remove-orphans "$@"
    ;;
  tags)
    printf '%s\n' "$MASTER_VERSION_IMAGE" "$MASTER_LATEST_IMAGE" "$AGENT_VERSION_IMAGE" "$AGENT_LATEST_IMAGE"
    ;;
  *)
    die "未知 Docker 操作：$COMMAND"
    ;;
esac
