-- CreateTable
CREATE TABLE "OrgStoragePeak" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "peakStorageBytes" BIGINT NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OrgStoragePeak_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "OrgStoragePeak_orgId_idx" ON "OrgStoragePeak"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgStoragePeak_orgId_year_month_key" ON "OrgStoragePeak"("orgId", "year", "month");

