-- 只新增代理池显式开关，不改变业务记录、凭据或统计游标。
ALTER TABLE "Line" ADD COLUMN "proxyPoolEnabled" BOOLEAN NOT NULL DEFAULT false;

-- 保留此前已交付的公共直连 Mixed；中继/私有/停用/无入口不自动开放。
UPDATE "Line" SET "proxyPoolEnabled" = true
WHERE "type" = 'DIRECT' AND "protocolType" = 'MIXED'
  AND "status" = 'ACTIVE' AND "isPublic" = true
  AND "entryNodeId" IS NOT NULL AND "entryPort" BETWEEN 1 AND 65535
  AND EXISTS (SELECT 1 FROM "Node" WHERE "Node"."id" = "Line"."entryNodeId");
