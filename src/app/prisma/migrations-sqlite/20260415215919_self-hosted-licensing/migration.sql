-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Org" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deletedAt" DATETIME,
    "deletedBy" TEXT,
    "name" TEXT NOT NULL,
    "defaultRepoAccess" TEXT NOT NULL DEFAULT 'WRITE',
    "defaultCanCreateRepos" BOOLEAN NOT NULL DEFAULT true,
    "binaryExtensions" TEXT NOT NULL DEFAULT '',
    "subscriptionTier" TEXT NOT NULL DEFAULT 'BASIC',
    "selfHosted" BOOLEAN NOT NULL DEFAULT false,
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
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

