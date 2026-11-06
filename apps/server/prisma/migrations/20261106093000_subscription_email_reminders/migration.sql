-- AlterTable
ALTER TABLE "User" ADD COLUMN "subscriptionEmailNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "SubscriptionEmailDelivery" (
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
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionEmailDelivery_subscriptionId_kind_eventKey_milestone_key" ON "SubscriptionEmailDelivery"("subscriptionId", "kind", "eventKey", "milestone");
CREATE INDEX "SubscriptionEmailDelivery_state_attemptedAt_idx" ON "SubscriptionEmailDelivery"("state", "attemptedAt");
CREATE INDEX "SubscriptionEmailDelivery_createdAt_idx" ON "SubscriptionEmailDelivery"("createdAt");
