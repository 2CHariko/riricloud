-- 仅新增可空出站配置，旧线路保持原出站行为。
ALTER TABLE "Line" ADD COLUMN "egressProxyJson" TEXT;
