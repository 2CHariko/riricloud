#!/usr/bin/env bash
# scripts/bundle-master.sh: 组装指定宿主架构的主控端自包含发行包
set -euo pipefail

RIRI_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RIRI_ROOT"

if [ -f "$RIRI_ROOT/scripts/dev-env.sh" ]; then
  # shellcheck source=scripts/dev-env.sh
  . "$RIRI_ROOT/scripts/dev-env.sh"
fi

die() {
  echo "主控包组装失败：$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法：bash scripts/bundle-master.sh [选项]

组装指定宿主架构的主控端生产发行包（包含生产依赖、Web 面板、启动脚本与对应架构的内置 Agent/Sing-box）。

选项：
  --target <target>     指定宿主架构（默认 linux-amd64，支持 linux-arm64）
  --version <version>   指定版本号（默认读取 package.json）
  --singbox-version <version>  指定独立 Sing-box 上游版本
  --singbox-revision <n>        指定 Sing-box 资源修订号
  --worktree <path>     指定源码工作区目录（默认当前仓根目录）
  --output-dir <path>   指定装配目标目录（默认 artifacts/master/<target>）
  --archive-dir <path>  指定压缩归档输出目录（默认 artifacts/packages）
  --no-archive          仅装配目录，不生成 .tar.gz 压缩包
  -h, --help            显示帮助
EOF
}

is_windows_shell() {
  case "$(uname -s 2>/dev/null || true)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

to_os_path() {
  local p="$1"
  if is_windows_shell && command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$p"
  else
    printf '%s\n' "$p"
  fi
}

to_node_path() {
  local p="$1"
  if is_windows_shell && [[ "${NODE_BIN:-node}" == *".exe" ]]; then
    to_os_path "$p"
  else
    printf '%s\n' "$p"
  fi
}

to_pnpm_path() {
  local p="$1"
  local pnpm_cmd="${PNPM_BIN:-pnpm}"
  if is_windows_shell && [[ "$pnpm_cmd" == *".cmd" || "$pnpm_cmd" == *".exe" ]]; then
    to_os_path "$p"
  else
    printf '%s\n' "$p"
  fi
}

TARGET="linux-amd64"
VERSION=""
SINGBOX_VERSION="${SINGBOX_VERSION:-1.14.0}"
SINGBOX_REVISION="${SINGBOX_REVISION:-2}"
CRONET_VERSION="${CRONET_VERSION:-v150.0.7871.63-2}"
WORKTREE_DIR="$RIRI_ROOT"
OUTPUT_DIR=""
ARCHIVE_DIR=""
DO_ARCHIVE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      [ $# -ge 2 ] || die "--target 缺少参数"
      TARGET="$2"
      shift 2
      ;;
    --version)
      [ $# -ge 2 ] || die "--version 缺少参数"
      VERSION="$2"
      shift 2
      ;;
    --singbox-version)
      [ $# -ge 2 ] || die "--singbox-version 缺少参数"
      SINGBOX_VERSION="$2"
      shift 2
      ;;
    --singbox-revision)
      [ $# -ge 2 ] || die "--singbox-revision 缺少参数"
      SINGBOX_REVISION="$2"
      shift 2
      ;;
    --worktree)
      [ $# -ge 2 ] || die "--worktree 缺少参数"
      WORKTREE_DIR="$2"
      shift 2
      ;;
    --output-dir)
      [ $# -ge 2 ] || die "--output-dir 缺少参数"
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --archive-dir)
      [ $# -ge 2 ] || die "--archive-dir 缺少参数"
      ARCHIVE_DIR="$2"
      shift 2
      ;;
    --no-archive)
      DO_ARCHIVE=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "未知选项：$1"
      ;;
  esac
done

resolve_node() {
  NODE_BIN="${NODE_BIN:-node}"
  if is_windows_shell; then
    if ! command -v "$NODE_BIN" >/dev/null 2>&1 && command -v node.exe >/dev/null 2>&1; then
      NODE_BIN="node.exe"
    fi
    command -v "$NODE_BIN" >/dev/null 2>&1 || die "缺少 Node.js 工具链（node 或 node.exe）"
  else
    case "$NODE_BIN" in
      *.exe) die "Linux/WSL 环境严禁调用 Windows Node.js 工具链（$NODE_BIN），请在当前系统中安装原生 Node.js" ;;
    esac
    command -v "$NODE_BIN" >/dev/null 2>&1 || die "缺少原生 Node.js 工具链（Linux/WSL 下严禁回退调用 Windows node.exe）"
    if [ "$("$NODE_BIN" -p 'process.platform' 2>/dev/null || true)" = "win32" ]; then
      die "检测到当前 node 指向 Windows 工具链（win32），Linux/WSL 下必须使用原生 Node.js"
    fi
  fi
}

verify_binary_header() {
  local file_path="$1"
  local expected_os="$2"
  local expected_arch="$3"
  local native_path
  native_path="$(to_node_path "$file_path")"
  "$NODE_BIN" -e '
    const fs = require("fs");
    const [file, os, arch] = process.argv.slice(1);
    if (!fs.existsSync(file)) process.exit(2);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, 256, 0);
    fs.closeSync(fd);
    const header = buf.subarray(0, n);
    let actual = "unknown";
    if (header.length >= 20 && header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
      const le = header[5] === 1;
      const machine = le ? header.readUInt16LE(18) : header.readUInt16BE(18);
      const archMap = { 0x3e: "amd64", 0xb7: "arm64", 0x28: "arm", 0x03: "386" };
      actual = `linux/${archMap[machine] || "0x" + machine.toString(16)}`;
    } else if (header.length >= 8 && (header.readUInt32LE(0) === 0xfeedfacf || header.readUInt32BE(0) === 0xfeedfacf)) {
      const le = header.readUInt32LE(0) === 0xfeedfacf;
      const cpu = le ? header.readUInt32LE(4) : header.readUInt32BE(4);
      const archMap = { 0x01000007: "amd64", 0x0100000c: "arm64" };
      actual = `darwin/${archMap[cpu] || "0x" + cpu.toString(16)}`;
    } else if (header.length >= 0x40 && header[0] === 0x4d && header[1] === 0x5a) {
      const pe = header.readUInt32LE(0x3c);
      if (pe >= 0 && pe + 6 <= header.length && header[pe] === 0x50 && header[pe + 1] === 0x45 && header[pe + 2] === 0 && header[pe + 3] === 0) {
        const machine = header.readUInt16LE(pe + 4);
        const archMap = { 0x8664: "amd64", 0xaa64: "arm64", 0x014c: "386" };
        actual = `windows/${archMap[machine] || "0x" + machine.toString(16)}`;
      } else {
        actual = "windows/pe";
      }
    }
    const expected = `${os}/${arch}`;
    if (actual !== expected) {
      console.error(`二进制文件头校验失败: ${file} 期望 ${expected}，实际检测到 ${actual}`);
      process.exit(1);
    }
  ' "$native_path" "$expected_os" "$expected_arch"
}

resolve_node

if [ -z "$VERSION" ]; then
  PACKAGE_JSON_OS="$(to_node_path "$WORKTREE_DIR/package.json")"
  VERSION="$($NODE_BIN -e "const fs = require('fs'); console.log(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')).version)" "$PACKAGE_JSON_OS")"
fi

TARGET_NORM="${TARGET//\//-}"
TARGET_OS="${TARGET_NORM%-*}"
TARGET_ARCH="${TARGET_NORM##*-}"
TARGET_UNDERSCORE="${TARGET//-/_}"
ARTIFACT_ROOT="${RIRICLOUD_ARTIFACT_DIR:-$RIRI_ROOT/artifacts}"
MASTER_DIR="${OUTPUT_DIR:-$ARTIFACT_ROOT/master/$TARGET_NORM}"
ARCHIVE_DIR="${ARCHIVE_DIR:-$ARTIFACT_ROOT/packages}"

echo "==> 装配主控端发行包（目标架构：$TARGET_NORM，版本：v$VERSION）"
rm -rf "$MASTER_DIR"
mkdir -p "$MASTER_DIR"

# 1. 部署生产依赖与编译产物
if [ ! -f "$WORKTREE_DIR/apps/server/dist/main.js" ] && [ ! -f "$WORKTREE_DIR/apps/server/dist/src/main.js" ]; then
  echo "  -> 编译主控服务端产物..."
  (cd "$WORKTREE_DIR" && pnpm --filter @riricloud/server build)
fi
echo "  -> 部署主控服务端生产依赖..."
(
  cd "$WORKTREE_DIR"
  pnpm --filter @riricloud/server deploy --prod --ignore-scripts "$(to_pnpm_path "$MASTER_DIR")"
)
if [ ! -d "$MASTER_DIR/dist" ]; then
  mkdir -p "$MASTER_DIR/dist"
  cp -r "$WORKTREE_DIR/apps/server/dist/." "$MASTER_DIR/dist/"
fi
rm -rf "$MASTER_DIR/node_modules/.pnpm/node_modules" "$WORKTREE_DIR/apps/server/artifacts"

# 2. 规范化符号链接为相对路径
echo "  -> 改写符号链接为包内相对路径..."
"$NODE_BIN" - "$(to_node_path "$MASTER_DIR")" <<'NODE'
const fs = require('fs');
const path = require('path');

const targetArg = process.argv.slice(1).find((arg) => arg && arg !== '-' && arg !== '[stdin]') || process.argv[1];
const root = path.resolve(targetArg);
let normalized = 0;

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = path.resolve(path.dirname(entryPath), fs.readlinkSync(entryPath));
      const relativeToRoot = path.relative(root, target);
      if (relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
        throw new Error(`发行包符号链接指向包外路径：${entryPath} -> ${target}`);
      }
      const relativeTarget = path.relative(path.dirname(entryPath), target) || '.';
      const targetType = fs.statSync(target).isDirectory() ? 'dir' : 'file';
      fs.unlinkSync(entryPath);
      fs.symlinkSync(relativeTarget, entryPath, targetType);
      normalized += 1;
      continue;
    }
    if (entry.isDirectory()) walk(entryPath);
  }
}

walk(root);
console.log(`    已将 ${normalized} 个发行包内部绝对符号链接改写为相对链接`);
NODE

rm -rf "$MASTER_DIR/src" "$MASTER_DIR/tsconfig.json" "$MASTER_DIR/tsconfig.build.json" "$MASTER_DIR/nest-cli.json" \
       "$MASTER_DIR/.env" "$MASTER_DIR"/*.db "$MASTER_DIR"/*.db-* "$MASTER_DIR/data" "$MASTER_DIR/.cache" \
       "$MASTER_DIR/artifacts" "$MASTER_DIR/test_deploy" "$MASTER_DIR/coverage"

# 3. 复制启动入口与配置模板
echo "  -> 复制启动脚本与配置模板..."
cp "$WORKTREE_DIR/scripts/master-bundle/start.sh" "$MASTER_DIR/"
cp "$WORKTREE_DIR/scripts/master-bundle/README.md" "$MASTER_DIR/"
cp "$WORKTREE_DIR/scripts/master-bundle/.env.example" "$MASTER_DIR/"
cp "$WORKTREE_DIR/scripts/master-bundle/admin-reset.sh" "$MASTER_DIR/"
chmod +x "$MASTER_DIR/start.sh" "$MASTER_DIR/admin-reset.sh"

# 4. 复制前端面板静态资源
echo "  -> 集成 Web 前端静态资源..."
if [ ! -d "$WORKTREE_DIR/apps/web/dist" ]; then
  (cd "$WORKTREE_DIR" && pnpm --filter @riricloud/web build)
fi
mkdir -p "$MASTER_DIR/web-dist"
cp -r "$WORKTREE_DIR/apps/web/dist/." "$MASTER_DIR/web-dist/"

# 5. 精确注入对应架构的内置 Sing-box 与内嵌内核的 Agent 二进制
echo "  -> 注入匹配架构 ($TARGET_NORM) 的内置 Sing-box 与 Agent..."
mkdir -p "$MASTER_DIR/binaries"

AGENT_VERSION=""
if [ -f "$RIRI_ROOT/apps/agent/VERSION" ]; then
  AGENT_VERSION="$(tr -d '[:space:]' < "$RIRI_ROOT/apps/agent/VERSION")"
else
  AGENT_VERSION="$VERSION"
fi

SINGBOX_RESOURCE_VERSION="${SINGBOX_VERSION}-r${SINGBOX_REVISION}"
SINGBOX_SRC="$ARTIFACT_ROOT/binaries/singbox/$SINGBOX_RESOURCE_VERSION/$TARGET_NORM/sing-box"
CRONET_SRC="$ARTIFACT_ROOT/binaries/singbox/$SINGBOX_RESOURCE_VERSION/$TARGET_NORM/libcronet.so"
AGENT_SRC="$ARTIFACT_ROOT/binaries/agent/$TARGET_NORM/riri-agent"

NEED_REBUILD_BINARIES=0
if [ ! -f "$SINGBOX_SRC" ] || [ ! -f "$CRONET_SRC" ] || [ ! -f "$AGENT_SRC" ]; then
  NEED_REBUILD_BINARIES=1
elif ! verify_binary_header "$SINGBOX_SRC" "$TARGET_OS" "$TARGET_ARCH" 2>/dev/null \
  || ! verify_binary_header "$CRONET_SRC" "$TARGET_OS" "$TARGET_ARCH" 2>/dev/null \
  || ! verify_binary_header "$AGENT_SRC" "$TARGET_OS" "$TARGET_ARCH" 2>/dev/null; then
  echo "    检测到现有内置二进制架构不匹配，触发全量重新构建..."
  rm -f "$SINGBOX_SRC" "$AGENT_SRC" || true
  NEED_REBUILD_BINARIES=1
fi

if [ "$NEED_REBUILD_BINARIES" = "1" ]; then
  echo "    准备/构建匹配架构 ($TARGET_NORM) 的定制 Sing-box 与内嵌 Agent..."
  bash "$RIRI_ROOT/scripts/build-binaries.sh" --target "$TARGET" --version "$AGENT_VERSION" \
    --singbox-version "$SINGBOX_VERSION" --singbox-revision "$SINGBOX_REVISION" --cronet-version "$CRONET_VERSION"
fi

[ -f "$SINGBOX_SRC" ] || SINGBOX_SRC="$ARTIFACT_ROOT/binaries/singbox/$TARGET_NORM/sing-box"
[ -f "$CRONET_SRC" ] || CRONET_SRC="$ARTIFACT_ROOT/binaries/singbox/$TARGET_NORM/libcronet.so"
[ -f "$SINGBOX_SRC" ] || die "缺少匹配架构的 Sing-box 二进制：$SINGBOX_SRC"
[ -f "$CRONET_SRC" ] || die "缺少匹配架构的 libcronet.so：$CRONET_SRC"
[ -f "$AGENT_SRC" ] || die "缺少匹配架构的 Agent 二进制：$AGENT_SRC"

verify_binary_header "$SINGBOX_SRC" "$TARGET_OS" "$TARGET_ARCH" || die "Sing-box 二进制架构校验未通过：$SINGBOX_SRC"
verify_binary_header "$CRONET_SRC" "$TARGET_OS" "$TARGET_ARCH" || die "libcronet.so 架构校验未通过：$CRONET_SRC"
verify_binary_header "$AGENT_SRC" "$TARGET_OS" "$TARGET_ARCH" || die "Agent 二进制架构校验未通过：$AGENT_SRC"

mkdir -p "$MASTER_DIR/binaries/agent/$TARGET_NORM"
cp "$AGENT_SRC" "$MASTER_DIR/binaries/agent/$TARGET_NORM/riri-agent"
chmod +x "$MASTER_DIR/binaries/agent/$TARGET_NORM/riri-agent"
printf '%s\n' "$AGENT_VERSION" > "$MASTER_DIR/binaries/AGENT_VERSION"

mkdir -p "$MASTER_DIR/binaries/singbox/$SINGBOX_RESOURCE_VERSION/$TARGET_NORM"
cp "$SINGBOX_SRC" "$MASTER_DIR/binaries/singbox/$SINGBOX_RESOURCE_VERSION/$TARGET_NORM/sing-box"
cp "$CRONET_SRC" "$MASTER_DIR/binaries/singbox/$SINGBOX_RESOURCE_VERSION/$TARGET_NORM/libcronet.so"
chmod +x "$MASTER_DIR/binaries/singbox/$SINGBOX_RESOURCE_VERSION/$TARGET_NORM/sing-box"

echo "  -> 准备主客户端 Mihomo 固定资源..."
"$NODE_BIN" "$RIRI_ROOT/scripts/prepare-client-kernels.mjs" --target "$TARGET_NORM" --output-root "$(to_node_path "$ARTIFACT_ROOT/binaries/mihomo")"
MIHOMO_VERSION="$("$NODE_BIN" "$RIRI_ROOT/scripts/prepare-client-kernels.mjs" --target "$TARGET_NORM" --field version)"
mkdir -p "$MASTER_DIR/binaries/mihomo/$MIHOMO_VERSION/$TARGET_NORM"
cp "$ARTIFACT_ROOT/binaries/mihomo/$MIHOMO_VERSION/$TARGET_NORM/mihomo" "$MASTER_DIR/binaries/mihomo/$MIHOMO_VERSION/$TARGET_NORM/mihomo"
cp "$ARTIFACT_ROOT/binaries/mihomo/$MIHOMO_VERSION/$TARGET_NORM/manifest.json" "$MASTER_DIR/binaries/mihomo/$MIHOMO_VERSION/$TARGET_NORM/manifest.json"
chmod +x "$MASTER_DIR/binaries/mihomo/$MIHOMO_VERSION/$TARGET_NORM/mihomo"

echo "  -> 生成内置二进制资源 manifest..."
"$NODE_BIN" -e '
  const fs = require("fs");
  const path = require("path");
  const crypto = require("crypto");
  const [root, appVersion, target, agentVersionArg] = process.argv.slice(1);
  const agentVersion = agentVersionArg || appVersion;
  const fileInfo = (name, role, absolute) => {
    const body = fs.readFileSync(absolute);
    return { name, role, path: path.relative(root, absolute).split(path.sep).join("/"), sha256: crypto.createHash("sha256").update(body).digest("hex"), size: body.length };
  };
  const agentName = "riri-agent";
  const agentPath = path.join(root, "agent", target, agentName);
  const resources = [];
  if (fs.existsSync(agentPath)) resources.push({ kind: "AGENT", upstreamVersion: agentVersion, revision: 1, source: "LOCAL", status: "ACTIVE", builtFromAppVersion: agentVersion, isDefault: true, assets: [{ target: `agent-${target}`, os: target.split("-")[0], arch: target.split("-")[1], files: [fileInfo(agentName, "main", agentPath)] }] });
  fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), applicationVersion: appVersion, resources }, null, 2)}\n`);
' "$MASTER_DIR/binaries" "$VERSION" "$TARGET_NORM" "$AGENT_VERSION"

# 6. 固化 package.json 并生成 Prisma 引擎
echo "  -> 固化 package.json 并生成 Prisma Client..."
"$NODE_BIN" -e "const fs = require('fs'); const rootPkg = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')); fs.writeFileSync(process.argv[1], JSON.stringify({ name: 'riricloud-master', version: process.argv[2], private: true, repository: rootPkg.repository || { type: 'git', url: 'https://github.com/Nanako660/riricloud' }, prisma: { seed: 'node prisma/seed.js' } }, null, 2))" "$(to_node_path "$MASTER_DIR/package.json")" "$VERSION" "$(to_node_path "$WORKTREE_DIR/package.json")"
(cd "$MASTER_DIR" && "$NODE_BIN" node_modules/prisma/build/index.js generate >/dev/null && "$NODE_BIN" node_modules/prisma/build/index.js generate --schema=prisma/telemetry/schema.prisma >/dev/null)

# 7. 打包为 tar.gz
if [ "$DO_ARCHIVE" = "1" ]; then
  mkdir -p "$ARCHIVE_DIR"
  ARCHIVE_FILE="$ARCHIVE_DIR/riri-master_${VERSION}_${TARGET_UNDERSCORE}.tar.gz"
  echo "  -> 打包归档：$ARCHIVE_FILE..."
  tar -czf "$ARCHIVE_FILE" -C "$(dirname "$MASTER_DIR")" "$(basename "$MASTER_DIR")"
  echo "==> 主控端发行包组装完成：$ARCHIVE_FILE"
else
  echo "==> 主控端发行包目录组装完成：$MASTER_DIR"
fi
