-- CreateTable
CREATE TABLE "OrgStoragePeak" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "peakStorageBytes" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgStoragePeak_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrgStoragePeak_orgId_idx" ON "OrgStoragePeak"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgStoragePeak_orgId_year_month_key" ON "OrgStoragePeak"("orgId", "year", "month");

-- AddForeignKey
ALTER TABLE "OrgStoragePeak" ADD CONSTRAINT "OrgStoragePeak_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

