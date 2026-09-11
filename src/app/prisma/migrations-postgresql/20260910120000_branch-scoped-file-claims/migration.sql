-- Branch-scoped file claims. Replaces the repo-wide FileCheckout model with
-- FileClaim (scoped to a claim domain) plus an append-only audit trail.
--
-- FileCheckout is dropped rather than migrated: the feature had no production
-- users. If a specific instance needs a backfill, the mapping is
-- domainBranchName = branchName = the repo's default branch, strength =
-- locked ? EXCLUSIVE : ADVISORY, state = OPEN.

-- CreateEnum
CREATE TYPE "ClaimStrength" AS ENUM ('ADVISORY', 'EXCLUSIVE');

-- CreateEnum
CREATE TYPE "ClaimState" AS ENUM ('OPEN', 'SUBMITTED');

-- CreateEnum
CREATE TYPE "ClaimEventType" AS ENUM ('CLAIM', 'SUBMIT', 'ADVANCE', 'RELEASE', 'FORCE_RELEASE', 'DISCARD_RELEASE');

-- CreateEnum
CREATE TYPE "BranchDisposition" AS ENUM ('ACTIVE', 'MERGED', 'DISCARDED');

-- DropTable
DROP TABLE "FileCheckout";

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN "domainBranchName" TEXT;

-- AlterTable
ALTER TABLE "Branch" ADD COLUMN "isClaimDomainRoot" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Branch" ADD COLUMN "domainBranchName" TEXT;
ALTER TABLE "Branch" ADD COLUMN "disposition" "BranchDisposition" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "Branch" ADD COLUMN "purgeable" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "FileClaim" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "fileId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "domainBranchName" TEXT NOT NULL,
    "branchName" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "strength" "ClaimStrength" NOT NULL DEFAULT 'EXCLUSIVE',
    "state" "ClaimState" NOT NULL DEFAULT 'OPEN',
    "baseChangelistNumber" INTEGER NOT NULL,
    "headChangelistNumber" INTEGER,
    "releasedAt" TIMESTAMP(3),
    "releasedByChangelistNumber" INTEGER,

    CONSTRAINT "FileClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileClaimEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimId" TEXT NOT NULL,
    "type" "ClaimEventType" NOT NULL,
    "userId" TEXT,
    "workspaceId" TEXT,
    "branchName" TEXT NOT NULL,
    "changelistNumber" INTEGER,

    CONSTRAINT "FileClaimEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceBranch" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workspaceId" TEXT NOT NULL,
    "branchName" TEXT NOT NULL,

    CONSTRAINT "WorkspaceBranch_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "FileClaim" ADD CONSTRAINT "FileClaim_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileClaim" ADD CONSTRAINT "FileClaim_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileClaim" ADD CONSTRAINT "FileClaim_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileClaimEvent" ADD CONSTRAINT "FileClaimEvent_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "FileClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileClaimEvent" ADD CONSTRAINT "FileClaimEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceBranch" ADD CONSTRAINT "WorkspaceBranch_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill domain roots. Feature branches never anchor a domain; mainline and
-- release branches always do, which is the column default.
UPDATE "Branch" SET "isClaimDomainRoot" = false WHERE "type" = 'FEATURE';

-- Backfill the denormalized domain. Feature branches could only parent to a
-- mainline or release branch before this migration, so their parent is their
-- domain root; every other branch is its own.
UPDATE "Branch" SET "domainBranchName" = "parentBranchName" WHERE "type" = 'FEATURE' AND "parentBranchName" IS NOT NULL;
UPDATE "Branch" SET "domainBranchName" = "name" WHERE "domainBranchName" IS NULL;

-- Backfill disposition for branches already archived before this migration.
UPDATE "Branch" SET "disposition" = 'DISCARDED' WHERE "archivedAt" IS NOT NULL;

-- CreateIndex
CREATE INDEX "FileClaim_repoId_fileId_domainBranchName_releasedAt_idx" ON "FileClaim"("repoId", "fileId", "domainBranchName", "releasedAt");

-- CreateIndex
CREATE INDEX "FileClaim_repoId_domainBranchName_releasedAt_idx" ON "FileClaim"("repoId", "domainBranchName", "releasedAt");

-- CreateIndex
CREATE INDEX "FileClaim_repoId_branchName_releasedAt_idx" ON "FileClaim"("repoId", "branchName", "releasedAt");

-- CreateIndex
CREATE INDEX "FileClaim_workspaceId_releasedAt_idx" ON "FileClaim"("workspaceId", "releasedAt");

-- CreateIndex
CREATE INDEX "FileClaimEvent_claimId_createdAt_idx" ON "FileClaimEvent"("claimId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkspaceBranch_workspaceId_idx" ON "WorkspaceBranch"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceBranch_workspaceId_branchName_key" ON "WorkspaceBranch"("workspaceId", "branchName");

-- At most one active EXCLUSIVE claim per path per domain. Prisma cannot express
-- a partial unique index, so this is hand-written into both migration trees.
-- Advisory claims are deliberately unconstrained and stack freely.
--
-- The submit guard and claim acquisition MUST spell out both predicates
-- ("releasedAt" IS NULL AND "strength" = 'EXCLUSIVE') so the planner uses this
-- index and never scans the advisory rows, which are the overwhelming majority.
CREATE UNIQUE INDEX "FileClaim_active_exclusive"
    ON "FileClaim" ("repoId", "fileId", "domainBranchName")
    WHERE "releasedAt" IS NULL AND "strength" = 'EXCLUSIVE';
