-- 保留全部旧拨测 JSON（包括未知历史格式），与普通 Mihomo URLTest 摘要隔离。
ALTER TABLE "Line" ADD COLUMN "lastDebugProbeJson" TEXT;
ALTER TABLE "UpstreamNode" ADD COLUMN "lastDebugProbeJson" TEXT;

UPDATE "Line" SET "lastDebugProbeJson" = "lastProbeJson", "lastProbeJson" = NULL,
  "lastLatencyMs" = NULL, "lastTestedAt" = NULL, "lastTestStatus" = NULL, "lastTestMessage" = NULL;
UPDATE "UpstreamNode" SET "lastDebugProbeJson" = "lastProbeJson", "lastProbeJson" = NULL,
  "latencyMs" = NULL, "lastTestedAt" = NULL, "lastTestStatus" = NULL, "lastTestMessage" = NULL;
