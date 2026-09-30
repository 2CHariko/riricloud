-- 破坏性升级：旧上游资源必须由维护者先备份并显式处理，禁止自动转换/清理。
-- 即使直接运行 Prisma，也在任何持久结构变化之前拒绝旧数据。
CREATE TEMP TABLE "_upstream_upgrade_guard" (
  "count" INTEGER NOT NULL CONSTRAINT "backup_and_remove_legacy_upstream_before_upgrade" CHECK ("count" = 0)
);
INSERT INTO "_upstream_upgrade_guard" SELECT COUNT(*) FROM "UpstreamSubscription";
INSERT INTO "_upstream_upgrade_guard" SELECT COUNT(*) FROM "UpstreamNode";
INSERT INTO "_upstream_upgrade_guard" SELECT COUNT(*) FROM "Line" WHERE "upstreamNodeId" IS NOT NULL OR "relayMode" = 'UPSTREAM_NODE';
DROP TABLE "_upstream_upgrade_guard";

-- AlterTable
ALTER TABLE "UpstreamSubscription" ADD COLUMN "detectedFormat" TEXT;
ALTER TABLE "UpstreamSubscription" ADD COLUMN "lastSuccessAt" DATETIME;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Line" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "tag" TEXT,
    "listen" TEXT NOT NULL DEFAULT '0.0.0.0',
    "type" TEXT NOT NULL DEFAULT 'DIRECT',
    "relayMode" TEXT,
    "protocolType" TEXT NOT NULL DEFAULT 'VLESS',
    "paramsJson" TEXT NOT NULL DEFAULT '{}',
    "entryNodeId" TEXT,
    "entryPort" INTEGER,
    "landingNodeId" TEXT,
    "landingPort" INTEGER,
    "targetLineId" TEXT,
    "certificateId" TEXT,
    "endpointOverrideEnabled" BOOLEAN NOT NULL DEFAULT false,
    "serverHost" TEXT,
    "serverPort" INTEGER,
    "serverName" TEXT,
    "host" TEXT,
    "landingEndpointOverrideEnabled" BOOLEAN NOT NULL DEFAULT false,
    "landingServerHost" TEXT,
    "landingServerPort" INTEGER,
    "trafficRate" REAL NOT NULL DEFAULT 1,
    "allowLanAccess" BOOLEAN NOT NULL DEFAULT false,
    "tunnelType" TEXT,
    "tunnelPort" INTEGER,
    "tunnelSecret" TEXT,
    "speedLimitMbps" INTEGER DEFAULT 0,
    "tcpFastOpen" BOOLEAN NOT NULL DEFAULT false,
    "tcpMultiPath" BOOLEAN NOT NULL DEFAULT false,
    "udpFragment" BOOLEAN,
    "udpTimeout" TEXT,
    "proxyProtocol" BOOLEAN NOT NULL DEFAULT false,
    "proxyProtocolAcceptNoHeader" BOOLEAN NOT NULL DEFAULT false,
    "tagsJson" TEXT NOT NULL DEFAULT '[]',
    "level" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastLatencyMs" INTEGER,
    "lastTestedAt" DATETIME,
    "lastTestStatus" TEXT,
    "lastTestMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "upstreamNodeId" TEXT,
    CONSTRAINT "Line_entryNodeId_fkey" FOREIGN KEY ("entryNodeId") REFERENCES "Node" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Line_landingNodeId_fkey" FOREIGN KEY ("landingNodeId") REFERENCES "Node" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Line_targetLineId_fkey" FOREIGN KEY ("targetLineId") REFERENCES "Line" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Line_certificateId_fkey" FOREIGN KEY ("certificateId") REFERENCES "Certificate" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Line_upstreamNodeId_fkey" FOREIGN KEY ("upstreamNodeId") REFERENCES "UpstreamNode" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Line" ("allowLanAccess", "certificateId", "createdAt", "endpointOverrideEnabled", "entryNodeId", "entryPort", "host", "id", "isPublic", "landingEndpointOverrideEnabled", "landingNodeId", "landingPort", "landingServerHost", "landingServerPort", "lastLatencyMs", "lastTestMessage", "lastTestStatus", "lastTestedAt", "level", "listen", "name", "paramsJson", "protocolType", "proxyProtocol", "proxyProtocolAcceptNoHeader", "relayMode", "serverHost", "serverName", "serverPort", "sortOrder", "speedLimitMbps", "status", "tag", "tagsJson", "targetLineId", "tcpFastOpen", "tcpMultiPath", "trafficRate", "tunnelPort", "tunnelSecret", "tunnelType", "type", "udpFragment", "udpTimeout", "updatedAt", "upstreamNodeId") SELECT "allowLanAccess", "certificateId", "createdAt", "endpointOverrideEnabled", "entryNodeId", "entryPort", "host", "id", "isPublic", "landingEndpointOverrideEnabled", "landingNodeId", "landingPort", "landingServerHost", "landingServerPort", "lastLatencyMs", "lastTestMessage", "lastTestStatus", "lastTestedAt", "level", "listen", "name", "paramsJson", "protocolType", "proxyProtocol", "proxyProtocolAcceptNoHeader", "relayMode", "serverHost", "serverName", "serverPort", "sortOrder", "speedLimitMbps", "status", "tag", "tagsJson", "targetLineId", "tcpFastOpen", "tcpMultiPath", "trafficRate", "tunnelPort", "tunnelSecret", "tunnelType", "type", "udpFragment", "udpTimeout", "updatedAt", "upstreamNodeId" FROM "Line";
DROP TABLE "Line";
ALTER TABLE "new_Line" RENAME TO "Line";
CREATE INDEX "Line_entryNodeId_idx" ON "Line"("entryNodeId");
CREATE INDEX "Line_landingNodeId_idx" ON "Line"("landingNodeId");
CREATE INDEX "Line_targetLineId_idx" ON "Line"("targetLineId");
CREATE INDEX "Line_certificateId_idx" ON "Line"("certificateId");
CREATE INDEX "Line_protocolType_idx" ON "Line"("protocolType");
CREATE INDEX "Line_type_status_idx" ON "Line"("type", "status");
CREATE INDEX "Line_isPublic_idx" ON "Line"("isPublic");
CREATE INDEX "Line_sortOrder_idx" ON "Line"("sortOrder");
CREATE INDEX "Line_upstreamNodeId_idx" ON "Line"("upstreamNodeId");
CREATE TABLE "new_UpstreamNode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subscriptionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "protocolType" TEXT NOT NULL,
    "serverHost" TEXT NOT NULL,
    "serverPort" INTEGER NOT NULL,
    "paramsJson" TEXT NOT NULL,
    "rawConfigJson" TEXT NOT NULL,
    "sourceKey" TEXT,
    "connectionHash" TEXT NOT NULL,
    "configHash" TEXT NOT NULL,
    "presenceStatus" TEXT NOT NULL DEFAULT 'PRESENT',
    "missingSince" DATETIME,
    "tagsJson" TEXT NOT NULL DEFAULT '[]',
    "latencyMs" INTEGER,
    "lastTestedAt" DATETIME,
    "lastTestStatus" TEXT,
    "lastTestMessage" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UpstreamNode_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "UpstreamSubscription" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_UpstreamNode" ("createdAt", "id", "lastTestMessage", "lastTestStatus", "lastTestedAt", "latencyMs", "name", "paramsJson", "protocolType", "rawConfigJson", "serverHost", "serverPort", "status", "subscriptionId", "tagsJson", "updatedAt") SELECT "createdAt", "id", "lastTestMessage", "lastTestStatus", "lastTestedAt", "latencyMs", "name", "paramsJson", "protocolType", "rawConfigJson", "serverHost", "serverPort", "status", "subscriptionId", "tagsJson", "updatedAt" FROM "UpstreamNode";
DROP TABLE "UpstreamNode";
ALTER TABLE "new_UpstreamNode" RENAME TO "UpstreamNode";
CREATE INDEX "UpstreamNode_subscriptionId_idx" ON "UpstreamNode"("subscriptionId");
CREATE INDEX "UpstreamNode_protocolType_idx" ON "UpstreamNode"("protocolType");
CREATE INDEX "UpstreamNode_status_presenceStatus_idx" ON "UpstreamNode"("status", "presenceStatus");
CREATE INDEX "UpstreamNode_subscriptionId_sourceKey_idx" ON "UpstreamNode"("subscriptionId", "sourceKey");
CREATE INDEX "UpstreamNode_subscriptionId_connectionHash_idx" ON "UpstreamNode"("subscriptionId", "connectionHash");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
