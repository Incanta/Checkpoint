-- AlterTable
ALTER TABLE "InstanceSettings" ADD COLUMN "lastUpdateCheckAt" TIMESTAMP(3);
ALTER TABLE "InstanceSettings" ADD COLUMN "lastUpdateNotifiedVersion" TEXT;
