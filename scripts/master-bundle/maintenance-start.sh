#!/usr/bin/env bash
# 发行包入口：.env 由与源码/Docker 共用的 Node 维护入口解析；迁移前即持锁。
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  printf '%s\n' 'Missing .env; configure the release before starting Master.' >&2
  exit 2
fi
# 默认值放在 Node 解析 .env 后应用，避免覆盖用户显式配置。
exec node -e 'const c = require("./prisma/maintenance-config"); c.loadEnvironment(); process.env.DATABASE_URL ||= "file:./data/riri.db"; process.env.TELEMETRY_DATABASE_URL ||= "file:./data/telemetry.db"; process.env.PORT ||= "8080"; process.env.RIRICLOUD_ENV ||= "production"; process.env.RIRICLOUD_BINARY_DIR ||= require("node:path").resolve("binaries"); require("./prisma/maintenance-start").start().catch(e => { const r = require("./prisma/maintenance-errors").publicError(e); console.error(JSON.stringify(r)); process.exitCode = r.exitCode; });'
