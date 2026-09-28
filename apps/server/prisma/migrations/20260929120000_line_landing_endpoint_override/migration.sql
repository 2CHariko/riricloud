-- AlterTable
ALTER TABLE "Line" ADD COLUMN "landingEndpointOverrideEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Line" ADD COLUMN "landingServerHost" TEXT;
ALTER TABLE "Line" ADD COLUMN "landingServerPort" INTEGER;
