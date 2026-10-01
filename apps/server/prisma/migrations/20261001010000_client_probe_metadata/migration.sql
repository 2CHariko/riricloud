-- 新增安全测量摘要；旧 TCP/未记录内核的测量不能冒充端到端结果。
ALTER TABLE "Line" ADD COLUMN "lastProbeJson" TEXT;
ALTER TABLE "UpstreamNode" ADD COLUMN "lastProbeJson" TEXT;
UPDATE "Line" SET "lastLatencyMs" = NULL, "lastTestedAt" = NULL, "lastTestStatus" = NULL, "lastTestMessage" = NULL;
UPDATE "UpstreamNode" SET "latencyMs" = NULL, "lastTestedAt" = NULL, "lastTestStatus" = NULL, "lastTestMessage" = NULL;
