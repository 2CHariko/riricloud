-- 上游订阅源与上游节点条目（v0.9.10）。
-- Line 新增上游出口编排维度：上游出口线路不监听入站，仅提供 client outbound 定义；
-- 其他线路通过 egressLineId 把用户流量路由到该出站。出口线路被引用时不可删除。
CREATE TABLE "UpstreamSubscription" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "syncIntervalMins" INTEGER NOT NULL DEFAULT 720,
  "userAgent" TEXT,
  "lastFetchedAt" DATETIME,
  "lastFetchStatus" TEXT,
  "lastFetchError" TEXT,
  "detectedFormat" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "UpstreamSubscription_enabled_idx" ON "UpstreamSubscription"("enabled");

CREATE TABLE "UpstreamProxyEntry" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "subscriptionId" TEXT,
  "name" TEXT NOT NULL,
  "protocolType" TEXT NOT NULL,
  "server" TEXT NOT NULL,
  "port" INTEGER NOT NULL,
  "paramsJson" TEXT NOT NULL DEFAULT '{}',
  "entryKey" TEXT NOT NULL,
  "available" BOOLEAN NOT NULL DEFAULT true,
  "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "UpstreamProxyEntry_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "UpstreamSubscription" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "UpstreamProxyEntry_subscriptionId_entryKey_key" ON "UpstreamProxyEntry"("subscriptionId", "entryKey");
CREATE INDEX "UpstreamProxyEntry_subscriptionId_idx" ON "UpstreamProxyEntry"("subscriptionId");
CREATE INDEX "UpstreamProxyEntry_available_idx" ON "UpstreamProxyEntry"("available");

ALTER TABLE "Line" ADD COLUMN "upstreamEntryId" TEXT REFERENCES "UpstreamProxyEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Line" ADD COLUMN "egressLineId" TEXT REFERENCES "Line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Line" ADD COLUMN "upstreamSubscriptionId" TEXT REFERENCES "UpstreamSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Line" ADD COLUMN "upstreamHealthGate" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Line" ADD COLUMN "upstreamHealthMaxAgeSecs" INTEGER;
CREATE INDEX "Line_upstreamEntryId_idx" ON "Line"("upstreamEntryId");
CREATE INDEX "Line_egressLineId_idx" ON "Line"("egressLineId");
CREATE INDEX "Line_upstreamSubscriptionId_idx" ON "Line"("upstreamSubscriptionId");
