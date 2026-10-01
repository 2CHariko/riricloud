# syntax=docker/dockerfile:1

FROM golang:1.26-bookworm@sha256:9fdc884aacc3bec89b20ffc69f4bb369c78210e3e4f600387b5128b12c199f81 AS singbox-build

ARG TARGETARCH=amd64
ARG RIRICLOUD_VERSION=dev
ARG SINGBOX_VERSION=1.14.0
ARG CRONET_VERSION=v150.0.7871.63-2
ARG SINGBOX_SHA256=87baf6852e37941cbe40bdd94bec81c957c88a56751cecd6bbf0e6108bc69398
ARG CRONET_SHA256_AMD64=c3949c6ad64e1d8fcd1e3b1fae4e302b2e553d769665a4bd7576483564c3f026
ARG CRONET_SHA256_ARM64=8f13a6186aca498d37ee5e1f410282f587d663995aca60d6bf29a2d4f5536f2b
WORKDIR /src

RUN --mount=type=cache,id=riricloud-singbox-downloads,target=/tmp/singbox-cache,sharing=locked \
    apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl tar patch \
	&& rm -rf /var/lib/apt/lists/* \
	&& case "${TARGETARCH}" in amd64|arm64) ;; *) echo "unsupported Docker architecture: ${TARGETARCH}" >&2; exit 1 ;; esac \
	&& singbox_archive="/tmp/singbox-cache/sing-box-${SINGBOX_VERSION}.tar.gz" \
	&& cronet_library="/tmp/singbox-cache/libcronet-linux-${TARGETARCH}-${CRONET_VERSION}.so" \
	&& if [ ! -s "$singbox_archive" ]; then curl --fail --silent --show-error --location \
	  "https://github.com/SagerNet/sing-box/archive/refs/tags/v${SINGBOX_VERSION}.tar.gz" \
	  --output "${singbox_archive}.tmp" && mv "${singbox_archive}.tmp" "$singbox_archive"; fi \
	&& if [ ! -s "$cronet_library" ]; then curl --fail --silent --show-error --location \
	  "https://github.com/SagerNet/cronet-go/releases/download/${CRONET_VERSION}/libcronet-linux-${TARGETARCH}.so" \
	  --output "${cronet_library}.tmp" && mv "${cronet_library}.tmp" "$cronet_library"; fi \
	&& printf '%s  %s\n' "$SINGBOX_SHA256" "$singbox_archive" | sha256sum -c - \
	&& cronet_sha="$CRONET_SHA256_AMD64" \
	&& if [ "$TARGETARCH" = "arm64" ]; then cronet_sha="$CRONET_SHA256_ARM64"; fi \
	&& printf '%s  %s\n' "$cronet_sha" "$cronet_library" | sha256sum -c - \
	&& tar -xzf "$singbox_archive" \
	&& cp "$cronet_library" /libcronet.so \
	&& chmod 0755 /libcronet.so

WORKDIR /src/sing-box-${SINGBOX_VERSION}
COPY apps/agent/patches/sing-box-clashapi-inbound-user.patch /tmp/sing-box-clashapi-inbound-user.patch
RUN patch -p1 < /tmp/sing-box-clashapi-inbound-user.patch && rm -f /tmp/sing-box-clashapi-inbound-user.patch
RUN --mount=type=cache,id=riricloud-go-mod,target=/go/pkg/mod,sharing=locked \
	--mount=type=cache,id=riricloud-go-build,target=/root/.cache/go-build,sharing=locked \
	CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -trimpath \
	-tags with_v2ray_api,with_utls,with_quic,with_naive_outbound,with_purego,with_clash_api,with_riri_device_tracking \
	-ldflags "-s -w -X github.com/sagernet/sing-box/constant.Version=${SINGBOX_VERSION}" \
	-o /sing-box ./cmd/sing-box

FROM golang:1.26-bookworm@sha256:9fdc884aacc3bec89b20ffc69f4bb369c78210e3e4f600387b5128b12c199f81 AS agent-build

ARG TARGETARCH=amd64
ARG RIRICLOUD_VERSION=dev
WORKDIR /src

COPY apps/agent/go.mod apps/agent/go.sum ./
RUN --mount=type=cache,id=riricloud-go-mod,target=/go/pkg/mod,sharing=locked \
    go mod download
COPY apps/agent/ ./
COPY --from=singbox-build /sing-box /tmp/embed-singbox/sing-box
COPY --from=singbox-build /libcronet.so /tmp/embed-singbox/libcronet.so
RUN tar -czf internal/embedded/assets/singbox.tar.gz -C /tmp/embed-singbox sing-box libcronet.so \
    && rm -rf /tmp/embed-singbox
RUN --mount=type=cache,id=riricloud-go-mod,target=/go/pkg/mod,sharing=locked \
    --mount=type=cache,id=riricloud-go-build,target=/root/.cache/go-build,sharing=locked \
    agent_ver="$(cat VERSION 2>/dev/null || echo ${RIRICLOUD_VERSION:-dev})" && \
    CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -gcflags "main=-N -l" -trimpath \
    -ldflags "-s -w -X main.Version=${agent_ver}" \
    -o /out/riri-agent .

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS mihomo-fetch

ARG TARGETARCH=amd64
WORKDIR /prepare
COPY scripts/client-kernel-assets.json scripts/prepare-client-kernels.mjs ./scripts/
RUN --mount=type=cache,id=riricloud-mihomo-downloads,target=/client-kernels,sharing=locked \
    node scripts/prepare-client-kernels.mjs --target "linux-${TARGETARCH}" --output-root /client-kernels \
    && version="$(node scripts/prepare-client-kernels.mjs --target "linux-${TARGETARCH}" --field version)" \
    && cp "/client-kernels/${version}/linux-${TARGETARCH}/mihomo" /mihomo \
    && chmod 0755 /mihomo

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build

WORKDIR /workspace
ENV COREPACK_HOME=/tmp/corepack
ARG TARGETARCH=amd64
ARG RIRICLOUD_VERSION=dev
ARG SINGBOX_VERSION=1.14.0
ARG SINGBOX_REVISION=2
ARG CRONET_VERSION=v150.0.7871.63-2

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

# Install dependencies before copying source so Docker can reuse the pnpm layer.
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/server/prisma/ apps/server/prisma/
COPY apps/web/package.json apps/web/package.json
RUN --mount=type=cache,id=riricloud-corepack,target=/tmp/corepack,sharing=locked \
    --mount=type=cache,id=riricloud-pnpm,target=/workspace/.cache/pnpm,sharing=locked \
    pnpm install --frozen-lockfile

COPY . .
RUN mkdir -p /tmp/app-data && touch /tmp/app-data/.keep
RUN --mount=type=cache,id=riricloud-corepack,target=/tmp/corepack,sharing=locked \
    pnpm --filter @riricloud/web build
RUN --mount=type=cache,id=riricloud-corepack,target=/tmp/corepack,sharing=locked \
    pnpm --filter @riricloud/server build \
    && mkdir -p /tmp/server-dist \
    && cp -a apps/server/dist/. /tmp/server-dist/
RUN --mount=type=cache,id=riricloud-corepack,target=/tmp/corepack,sharing=locked \
    --mount=type=cache,id=riricloud-pnpm,target=/workspace/.cache/pnpm,sharing=locked \
    pnpm --filter @riricloud/server deploy --prod /out/server \
    && node -e "const r = require('./package.json'); const s = require('/out/server/package.json'); s.version = r.version; s.repository = r.repository; require('fs').writeFileSync('/out/server/package.json', JSON.stringify(s, null, 2) + '\n');" \
    && mkdir -p /out/server/dist \
    && cp -a /tmp/server-dist/. /out/server/dist/ \
    && if [ ! -f /out/server/dist/main.js ] && [ ! -f /out/server/dist/src/main.js ]; then \
      echo "server build output missing from /out/server/dist" >&2; \
      exit 1; \
    fi \
    && cd /out/server \
    && DATABASE_URL=file:/tmp/riri-build.db node node_modules/prisma/build/index.js generate \
    && TELEMETRY_DATABASE_URL=file:/tmp/riri-telem-build.db node node_modules/prisma/build/index.js generate --schema=prisma/telemetry/schema.prisma \
    && rm -f /tmp/riri-build.db /tmp/riri-telem-build.db \
    && rm -rf src tsconfig.json tsconfig.build.json nest-cli.json node_modules/.pnpm/node_modules \
    && rm -rf node_modules/typescript node_modules/@types/node \
    && rm -rf node_modules/.pnpm/typescript@* node_modules/.pnpm/@types+node@* \
    && find node_modules -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' \) -delete \
    && find node_modules -type f \( -path '*/@prisma/client/runtime/query_compiler_bg.*' \
      -o -path '*/@prisma/client/runtime/query_engine_bg.*' \
      -o -path '*/@prisma/client/runtime/wasm-compiler-edge.*' \
      -o -path '*/@prisma/client/runtime/wasm-engine-edge.*' \
      -o -path '*/.prisma/client/query_engine_bg.*' \
      -o -path '*/node_modules/prisma/build/query_compiler_bg.*' \
      -o -path '*/node_modules/prisma/build/query_engine_bg.*' \) -delete \
    && find node_modules -type d \( -path '*/node_modules/prisma/build/public' \
      -o -path '*/node_modules/prisma/prisma-client' \) -prune -exec rm -rf {} + \
    && find /out/server -type f \( -name '*.map' -o -name '*.tsbuildinfo' \) -delete

# 将应用版本与可分发的 Sing-box 资源版本分开登记，文件哈希写入运行时 manifest。
# 只保留 manifest 引用的版本化布局，不再复制扁平旧路径副本（由 manifest 认领链路兜底）。
COPY --from=agent-build /out/riri-agent /tmp/riri-agent
COPY --from=singbox-build /sing-box /tmp/sing-box
COPY --from=singbox-build /libcronet.so /tmp/libcronet.so
COPY --from=mihomo-fetch /mihomo /tmp/mihomo
RUN mkdir -p \
      /out/binaries/agent-linux-${TARGETARCH} \
      /out/binaries/singbox/${SINGBOX_VERSION}-r${SINGBOX_REVISION}/linux-${TARGETARCH} \
    && cp /workspace/apps/agent/VERSION /out/binaries/AGENT_VERSION \
    && cp /tmp/riri-agent /out/binaries/agent-linux-${TARGETARCH}/riri-agent \
    && cp /tmp/sing-box /out/binaries/singbox/${SINGBOX_VERSION}-r${SINGBOX_REVISION}/linux-${TARGETARCH}/sing-box \
    && cp /tmp/libcronet.so /out/binaries/singbox/${SINGBOX_VERSION}-r${SINGBOX_REVISION}/linux-${TARGETARCH}/libcronet.so \
    && chmod +x /out/binaries/agent-linux-${TARGETARCH}/riri-agent /out/binaries/singbox/${SINGBOX_VERSION}-r${SINGBOX_REVISION}/linux-${TARGETARCH}/sing-box
# 使用 Dockerfile heredoc 保持 manifest 生成脚本为单条 RUN 指令。
RUN node - /out/binaries "$RIRICLOUD_VERSION" "$TARGETARCH" <<'NODE'
  const fs = require("fs");
  const path = require("path");
  const crypto = require("crypto");
  const [root, appVersion, arch] = process.argv.slice(2);
  const info = (name, role, file) => { const body = fs.readFileSync(file); return { name, role, path: path.relative(root, file).split(path.sep).join("/"), sha256: crypto.createHash("sha256").update(body).digest("hex"), size: body.length }; };
  const platform = `linux-${arch}`;
  const agentVerFile = path.join("/workspace/apps/agent/VERSION");
  const agentVersion = fs.existsSync(agentVerFile) ? fs.readFileSync(agentVerFile, "utf8").trim() : appVersion;
  const resources = [
    { kind: "AGENT", upstreamVersion: agentVersion, revision: 1, source: "LOCAL", status: "ACTIVE", builtFromAppVersion: agentVersion, isDefault: true, assets: [{ target: `agent-${platform}`, os: "linux", arch, files: [info("riri-agent", "main", path.join(root, `agent-${platform}`, "riri-agent"))] }] }
  ];
  fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), applicationVersion: appVersion, resources }, null, 2)}\n`);
NODE

FROM gcr.io/distroless/nodejs20-debian12@sha256:6fe218dbad37e979c7542e670d28d6e23d3f53d2929693bc9cdded8b622f339f AS runtime

ARG TARGETARCH=amd64

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_URL=file:/app/data/riri.db \
    TELEMETRY_DATABASE_URL=file:/app/data/telemetry.db \
    SINGBOX_BINARY_PATH=/usr/local/bin/sing-box \
    MIHOMO_BINARY_PATH=/usr/local/bin/mihomo

ARG RIRICLOUD_VERSION=dev
ARG RIRICLOUD_VCS_REF=unknown
ARG RIRICLOUD_BUILD_DATE=unknown
ARG RIRICLOUD_IMAGE_TAGS=latest
ARG SINGBOX_VERSION=1.14.0
ARG SINGBOX_REVISION=2
ARG CRONET_VERSION=v150.0.7871.63-2
ARG MIHOMO_VERSION=1.19.30
LABEL org.opencontainers.image.title="RiriCloud Master" \
      org.opencontainers.image.description="RiriCloud control plane and web dashboard" \
      org.opencontainers.image.version="$RIRICLOUD_VERSION" \
      org.opencontainers.image.revision="$RIRICLOUD_VCS_REF" \
      org.opencontainers.image.created="$RIRICLOUD_BUILD_DATE" \
      org.opencontainers.image.licenses="GPL-3.0-only" \
      io.riricloud.singbox.version="$SINGBOX_VERSION" \
      io.riricloud.singbox.revision="$SINGBOX_REVISION" \
      io.riricloud.cronet.version="$CRONET_VERSION" \
      io.riricloud.mihomo.version="$MIHOMO_VERSION" \
      io.riricloud.image.tags="$RIRICLOUD_IMAGE_TAGS"

COPY --from=build /out/server/ ./
COPY --from=build --chown=65532:65532 /tmp/app-data/ /app/data/
COPY --from=build /workspace/apps/web/dist/ ./web-dist/
COPY --from=build /out/binaries/ ./binaries/
COPY --from=singbox-build /sing-box /usr/local/bin/sing-box
COPY --from=singbox-build /libcronet.so /usr/local/bin/libcronet.so
COPY --from=mihomo-fetch /mihomo /usr/local/bin/mihomo
COPY scripts/docker-entrypoint.js ./docker-entrypoint.js

USER 65532:65532

VOLUME ["/app/data"]
EXPOSE 3000
ENTRYPOINT ["/nodejs/bin/node", "/app/docker-entrypoint.js"]
