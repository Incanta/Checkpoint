-- DropForeignKey
ALTER TABLE "LicenseUsageReport" DROP CONSTRAINT "LicenseUsageReport_licenseId_fkey";

-- AlterTable
ALTER TABLE "Changelist" DROP COLUMN "stateTree",
ADD COLUMN     "stateRootHash" TEXT;

-- AlterTable
ALTER TABLE "InstanceSettings" ADD COLUMN     "instanceId" TEXT,
ADD COLUMN     "lastTelemetryAt" TIMESTAMP(3),
ADD COLUMN     "telemetryEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "License" DROP COLUMN "instanceName",
DROP COLUMN "instanceUrl",
DROP COLUMN "lastReportAt";

-- AlterTable
ALTER TABLE "Org" DROP COLUMN "selfHosted";

-- AlterTable
ALTER TABLE "Repo" ADD COLUMN     "storageBytes" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Shelf" DROP COLUMN "stateTree";

-- DropTable
DROP TABLE "LicenseUsageReport";

-- CreateTable
CREATE TABLE "TreeBlock" (
    "repoId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "TreeBlock_pkey" PRIMARY KEY ("repoId","hash")
);

-- CreateIndex
CREATE INDEX "FileChange_repoId_changelistNumber_idx" ON "FileChange"("repoId", "changelistNumber");

-- CreateIndex
CREATE UNIQUE INDEX "InstanceSettings_instanceId_key" ON "InstanceSettings"("instanceId");

