CREATE TABLE "LineCredential" (
  "id" TEXT NOT NULL PRIMARY KEY, "lineId" TEXT NOT NULL, "version" INTEGER NOT NULL,
  "encryptedPayload" TEXT, "uuidHash" TEXT NOT NULL, "nameHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING', "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedAt" DATETIME, "revokedAt" DATETIME,
  CONSTRAINT "LineCredential_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "Line"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "LineCredential_uuidHash_key" ON "LineCredential"("uuidHash");
CREATE UNIQUE INDEX "LineCredential_nameHash_key" ON "LineCredential"("nameHash");
CREATE UNIQUE INDEX "LineCredential_lineId_version_key" ON "LineCredential"("lineId", "version");
CREATE INDEX "LineCredential_lineId_status_idx" ON "LineCredential"("lineId", "status");
CREATE TABLE "LineCredentialRotation" (
  "id" TEXT NOT NULL PRIMARY KEY, "operationId" TEXT NOT NULL, "lineId" TEXT NOT NULL,
  "fromVersion" INTEGER, "targetVersion" INTEGER NOT NULL, "landingCredentialVersion" INTEGER, "stage" TEXT NOT NULL DEFAULT 'STOPPING_ENTRY',
  "failedStage" TEXT, "errorCode" TEXT, "entryNodeId" TEXT NOT NULL, "landingNodeId" TEXT NOT NULL,
  "targetLineId" TEXT, "previousEntryNodeId" TEXT, "previousLandingNodeId" TEXT, "entryTag" TEXT NOT NULL, "landingTag" TEXT NOT NULL, "previousEntryTag" TEXT, "previousLandingTag" TEXT, "expectedNodeId" TEXT, "expectedConfigVersion" BIGINT,
  "accepted" BOOLEAN NOT NULL DEFAULT false, "entryStopConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "requestedById" TEXT, "deadlineAt" DATETIME NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL, "confirmedAt" DATETIME,
  CONSTRAINT "LineCredentialRotation_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "Line"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "LineCredentialRotation_operationId_key" ON "LineCredentialRotation"("operationId");
CREATE UNIQUE INDEX "LineCredentialRotation_lineId_key" ON "LineCredentialRotation"("lineId");
CREATE INDEX "LineCredentialRotation_stage_deadlineAt_idx" ON "LineCredentialRotation"("stage", "deadlineAt");
CREATE INDEX "LineCredentialRotation_expectedNodeId_expectedConfigVersion_idx" ON "LineCredentialRotation"("expectedNodeId", "expectedConfigVersion");
