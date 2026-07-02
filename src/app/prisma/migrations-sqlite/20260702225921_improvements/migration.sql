-- DropIndex
DROP INDEX "LicenseUsageReport_licenseId_year_month_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "LicenseUsageReport";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "TreeBlock" (
    "repoId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "data" BLOB NOT NULL,

    PRIMARY KEY ("repoId", "hash")
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Changelist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "number" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "versionIndex" TEXT NOT NULL,
    "stateRootHash" TEXT,
    "artifactVersionIndex" TEXT,
    "artifactStateTree" JSONB,
    "repoId" TEXT NOT NULL,
    "userId" TEXT,
    "parentNumber" INTEGER,
    CONSTRAINT "Changelist_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Changelist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Changelist_repoId_parentNumber_fkey" FOREIGN KEY ("repoId", "parentNumber") REFERENCES "Changelist" ("repoId", "number") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Changelist" ("artifactStateTree", "artifactVersionIndex", "createdAt", "id", "message", "number", "parentNumber", "repoId", "updatedAt", "userId", "versionIndex") SELECT "artifactStateTree", "artifactVersionIndex", "createdAt", "id", "message", "number", "parentNumber", "repoId", "updatedAt", "userId", "versionIndex" FROM "Changelist";
DROP TABLE "Changelist";
ALTER TABLE "new_Changelist" RENAME TO "Changelist";
CREATE UNIQUE INDEX "Changelist_repoId_number_key" ON "Changelist"("repoId", "number");
CREATE TABLE "new_InstanceSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "instanceId" TEXT,
    "eulaAcceptedAt" DATETIME,
    "eulaAcceptedBy" TEXT,
    "telemetryEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastTelemetryAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_InstanceSettings" ("createdAt", "eulaAcceptedAt", "eulaAcceptedBy", "id", "updatedAt") SELECT "createdAt", "eulaAcceptedAt", "eulaAcceptedBy", "id", "updatedAt" FROM "InstanceSettings";
DROP TABLE "InstanceSettings";
ALTER TABLE "new_InstanceSettings" RENAME TO "InstanceSettings";
CREATE UNIQUE INDEX "InstanceSettings_instanceId_key" ON "InstanceSettings"("instanceId");
CREATE TABLE "new_License" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'BASIC',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "orgId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "License_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_License" ("active", "createdAt", "id", "key", "orgId", "secretHash", "tier", "updatedAt") SELECT "active", "createdAt", "id", "key", "orgId", "secretHash", "tier", "updatedAt" FROM "License";
DROP TABLE "License";
ALTER TABLE "new_License" RENAME TO "License";
CREATE UNIQUE INDEX "License_key_key" ON "License"("key");
CREATE UNIQUE INDEX "License_orgId_key" ON "License"("orgId");
CREATE TABLE "new_Org" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deletedAt" DATETIME,
    "deletedBy" TEXT,
    "name" TEXT NOT NULL,
    "defaultRepoAccess" TEXT NOT NULL DEFAULT 'WRITE',
    "defaultCanCreateRepos" BOOLEAN NOT NULL DEFAULT true,
    "binaryExtensions" TEXT NOT NULL DEFAULT '',
    "subscriptionTier" TEXT NOT NULL DEFAULT 'BASIC',
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "subscriptionStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "billingCycleAnchor" INTEGER NOT NULL DEFAULT 1,
    "trialEndsAt" DATETIME,
    "canceledAt" DATETIME,
    "delinquentSince" DATETIME,
    "suspendedAt" DATETIME,
    "creditBalanceCents" INTEGER NOT NULL DEFAULT 0,
    "scheduledTier" TEXT,
    "scheduledTierAt" DATETIME
);
INSERT INTO "new_Org" ("billingCycleAnchor", "binaryExtensions", "canceledAt", "creditBalanceCents", "defaultCanCreateRepos", "defaultRepoAccess", "deletedAt", "deletedBy", "delinquentSince", "id", "name", "scheduledTier", "scheduledTierAt", "stripeCustomerId", "stripeSubscriptionId", "subscriptionStatus", "subscriptionTier", "suspendedAt", "trialEndsAt") SELECT "billingCycleAnchor", "binaryExtensions", "canceledAt", "creditBalanceCents", "defaultCanCreateRepos", "defaultRepoAccess", "deletedAt", "deletedBy", "delinquentSince", "id", "name", "scheduledTier", "scheduledTierAt", "stripeCustomerId", "stripeSubscriptionId", "subscriptionStatus", "subscriptionTier", "suspendedAt", "trialEndsAt" FROM "Org";
DROP TABLE "Org";
ALTER TABLE "new_Org" RENAME TO "Org";
CREATE UNIQUE INDEX "Org_name_key" ON "Org"("name");
CREATE UNIQUE INDEX "Org_stripeCustomerId_key" ON "Org"("stripeCustomerId");
CREATE UNIQUE INDEX "Org_stripeSubscriptionId_key" ON "Org"("stripeSubscriptionId");
CREATE TABLE "new_Repo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deletedAt" DATETIME,
    "deletedBy" TEXT,
    "name" TEXT NOT NULL,
    "public" BOOLEAN NOT NULL DEFAULT false,
    "r2BucketName" TEXT,
    "storageBytes" BIGINT NOT NULL DEFAULT 0,
    "orgId" TEXT NOT NULL,
    "requiredReviews" INTEGER NOT NULL DEFAULT 0,
    "mergePermissionsSame" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "Repo_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Repo" ("deletedAt", "deletedBy", "id", "mergePermissionsSame", "name", "orgId", "public", "r2BucketName", "requiredReviews") SELECT "deletedAt", "deletedBy", "id", "mergePermissionsSame", "name", "orgId", "public", "r2BucketName", "requiredReviews" FROM "Repo";
DROP TABLE "Repo";
ALTER TABLE "new_Repo" RENAME TO "Repo";
CREATE UNIQUE INDEX "Repo_orgId_name_key" ON "Repo"("orgId", "name");
CREATE TABLE "new_Shelf" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "repoId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "versionIndex" TEXT NOT NULL,
    "changelistNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "submittedToBranch" TEXT,
    "submittedAt" DATETIME,
    CONSTRAINT "Shelf_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Shelf_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Shelf" ("authorId", "changelistNumber", "createdAt", "description", "id", "name", "repoId", "status", "submittedAt", "submittedToBranch", "updatedAt", "versionIndex") SELECT "authorId", "changelistNumber", "createdAt", "description", "id", "name", "repoId", "status", "submittedAt", "submittedToBranch", "updatedAt", "versionIndex" FROM "Shelf";
DROP TABLE "Shelf";
ALTER TABLE "new_Shelf" RENAME TO "Shelf";
CREATE INDEX "Shelf_repoId_status_idx" ON "Shelf"("repoId", "status");
CREATE UNIQUE INDEX "Shelf_repoId_name_key" ON "Shelf"("repoId", "name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "FileChange_repoId_changelistNumber_idx" ON "FileChange"("repoId", "changelistNumber");

