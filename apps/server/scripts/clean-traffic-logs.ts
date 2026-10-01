import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const lines = await prisma.line.findMany({
    select: {
      id: true,
      type: true,
      relayMode: true,
      entryNodeId: true,
      landingNodeId: true
    }
  });
  const directByNode = new Map<string, string[]>();
  const blindExitByNode = new Map<string, string[]>();
  for (const line of lines) {
    if (line.type === 'DIRECT' && line.entryNodeId) {
      directByNode.set(line.entryNodeId, [...(directByNode.get(line.entryNodeId) ?? []), line.id]);
    }
    if (line.type === 'RELAY' && line.relayMode === 'BLIND_FORWARD' && line.landingNodeId) {
      blindExitByNode.set(line.landingNodeId, [...(blindExitByNode.get(line.landingNodeId) ?? []), line.id]);
    }
  }

  const logs = await prisma.trafficLog.findMany({
    where: { lineId: null },
    select: { id: true, nodeId: true }
  });
  const updatesByLineId = new Map<string, string[]>();
  for (const log of logs) {
    const candidates = [...new Set([
      ...(directByNode.get(log.nodeId) ?? []),
      ...(blindExitByNode.get(log.nodeId) ?? [])
    ])];
    if (candidates.length !== 1) continue;
    const lineId = candidates[0];
    updatesByLineId.set(lineId, [...(updatesByLineId.get(lineId) ?? []), log.id]);
  }

  let updated = 0;
  for (const [lineId, logIds] of updatesByLineId) {
    const result = await prisma.trafficLog.updateMany({
      where: { id: { in: logIds }, lineId: null },
      data: { lineId }
    });
    updated += result.count;
  }
  console.log(`traffic log cleanup completed: scanned=${logs.length} updated=${updated}`);
}

main()
  .catch((error: unknown) => {
    console.error(`traffic log cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
