-- AlterTable
ALTER TABLE "InstanceSettings" ADD COLUMN "lastUpdateCheckAt" DATETIME;
ALTER TABLE "InstanceSettings" ADD COLUMN "lastUpdateNotifiedVersion" TEXT;
