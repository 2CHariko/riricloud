#!/usr/bin/env bash
# 源码、发行包和 Docker 均运行同一 CLI；密钥只从环境/.env 读取，不进入参数。
set -euo pipefail
cd "$(dirname "$0")"
exec node prisma/maintenance-cli.js "$@"
