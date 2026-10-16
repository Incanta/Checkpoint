-- Branch heads that are gone from the branch list, kept so a branch can be
-- restored and its changelists stay reachable.

-- CreateTable
CREATE TABLE "DeletedBranch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "headNumber" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "parentBranchName" TEXT,
    "domainBranchName" TEXT,
    "merged" BOOLEAN NOT NULL,
    "deletedById" TEXT,
    "deletedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "DeletedBranch_repoId_name_idx" ON "DeletedBranch"("repoId", "name");
