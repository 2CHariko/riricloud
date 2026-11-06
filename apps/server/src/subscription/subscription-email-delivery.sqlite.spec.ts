import { PrismaClient } from '@prisma/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('SubscriptionEmailDelivery SQLite constraints', () => {
  let prisma: PrismaClient;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'riricloud-subscription-email-'));
    const databaseUrl = `file:${join(tempDir, 'delivery.db').replaceAll('\\', '/')}`;
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$connect();
    await prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON');
    await prisma.$executeRawUnsafe('CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY)');
    await prisma.$executeRawUnsafe('CREATE TABLE "Subscription" ("id" TEXT NOT NULL PRIMARY KEY)');
    await prisma.$executeRawUnsafe(`CREATE TABLE "SubscriptionEmailDelivery" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "subscriptionId" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "milestone" TEXT NOT NULL,
      "eventKey" TEXT NOT NULL,
      "state" TEXT NOT NULL DEFAULT 'PENDING',
      "attemptedAt" DATETIME,
      "sentAt" DATETIME,
      "errorCode" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
      FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`);
    await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX "SubscriptionEmailDelivery_subscriptionId_kind_eventKey_milestone_key" ON "SubscriptionEmailDelivery"("subscriptionId", "kind", "eventKey", "milestone")');
    await prisma.$executeRawUnsafe(`INSERT INTO "User" ("id") VALUES ('user-1')`);
    await prisma.$executeRawUnsafe(`INSERT INTO "Subscription" ("id") VALUES ('sub-1')`);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('同一周期、类型和里程碑只能建立一条投递记录', async () => {
    const data = {
      userId: 'user-1',
      subscriptionId: 'sub-1',
      kind: 'TRAFFIC_WARNING',
      milestone: '95',
      eventKey: '2026-11-01|2026-12-01',
      state: 'PENDING'
    };
    await prisma.subscriptionEmailDelivery.create({ data });
    await expect(prisma.subscriptionEmailDelivery.create({ data })).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.subscriptionEmailDelivery.count()).resolves.toBe(1);
  });
});
