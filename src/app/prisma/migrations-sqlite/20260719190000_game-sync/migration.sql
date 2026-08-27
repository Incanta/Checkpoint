-- AlterTable
ALTER TABLE "Changelist" ADD COLUMN "hasCodeChanges" BOOLEAN;
ALTER TABLE "Changelist" ADD COLUMN "hasContentChanges" BOOLEAN;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN "syncedAt" DATETIME;
ALTER TABLE "Workspace" ADD COLUMN "syncedChangelistNumber" INTEGER;

-- CreateTable
CREATE TABLE "ArtifactSet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "repoId" TEXT NOT NULL,
    "changelistNumber" INTEGER NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'editor',
    "versionIndex" TEXT NOT NULL,
    "stateTree" JSONB NOT NULL,
    CONSTRAINT "ArtifactSet_repoId_changelistNumber_fkey" FOREIGN KEY ("repoId", "changelistNumber") REFERENCES "Changelist" ("repoId", "number") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BuildBadge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "repoId" TEXT NOT NULL,
    "changelistNumber" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "group" TEXT,
    "state" TEXT NOT NULL,
    "url" TEXT,
    "metadata" JSONB,
    "postedById" TEXT,
    CONSTRAINT "BuildBadge_repoId_changelistNumber_fkey" FOREIGN KEY ("repoId", "changelistNumber") REFERENCES "Changelist" ("repoId", "number") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BuildBadge_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChangelistReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "repoId" TEXT NOT NULL,
    "changelistNumber" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "vote" TEXT,
    "starred" BOOLEAN NOT NULL DEFAULT false,
    "investigating" BOOLEAN NOT NULL DEFAULT false,
    "investigatingSince" DATETIME,
    "resolvedAt" DATETIME,
    CONSTRAINT "ChangelistReview_repoId_changelistNumber_fkey" FOREIGN KEY ("repoId", "changelistNumber") REFERENCES "Changelist" ("repoId", "number") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ChangelistReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChangelistComment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "body" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "changelistNumber" INTEGER NOT NULL,
    "authorId" TEXT NOT NULL,
    CONSTRAINT "ChangelistComment_repoId_changelistNumber_fkey" FOREIGN KEY ("repoId", "changelistNumber") REFERENCES "Changelist" ("repoId", "number") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ChangelistComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ArtifactFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "repoId" TEXT NOT NULL,
    "changelistNumber" INTEGER NOT NULL,
    "fileId" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'editor',
    CONSTRAINT "ArtifactFile_repoId_changelistNumber_fkey" FOREIGN KEY ("repoId", "changelistNumber") REFERENCES "Changelist" ("repoId", "number") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ArtifactFile_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ArtifactFile" ("changelistNumber", "createdAt", "fileId", "id", "repoId", "size") SELECT "changelistNumber", "createdAt", "fileId", "id", "repoId", "size" FROM "ArtifactFile";
DROP TABLE "ArtifactFile";
ALTER TABLE "new_ArtifactFile" RENAME TO "ArtifactFile";
CREATE INDEX "ArtifactFile_repoId_changelistNumber_idx" ON "ArtifactFile"("repoId", "changelistNumber");
CREATE UNIQUE INDEX "ArtifactFile_repoId_changelistNumber_type_fileId_key" ON "ArtifactFile"("repoId", "changelistNumber", "type", "fileId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ArtifactSet_repoId_type_changelistNumber_idx" ON "ArtifactSet"("repoId", "type", "changelistNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactSet_repoId_changelistNumber_type_key" ON "ArtifactSet"("repoId", "changelistNumber", "type");

-- CreateIndex
CREATE INDEX "BuildBadge_repoId_changelistNumber_idx" ON "BuildBadge"("repoId", "changelistNumber");

-- CreateIndex
CREATE INDEX "BuildBadge_repoId_name_changelistNumber_idx" ON "BuildBadge"("repoId", "name", "changelistNumber");

-- CreateIndex
CREATE UNIQUE INDEX "BuildBadge_repoId_changelistNumber_name_key" ON "BuildBadge"("repoId", "changelistNumber", "name");

-- CreateIndex
CREATE INDEX "ChangelistReview_repoId_changelistNumber_idx" ON "ChangelistReview"("repoId", "changelistNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ChangelistReview_repoId_changelistNumber_userId_key" ON "ChangelistReview"("repoId", "changelistNumber", "userId");

-- CreateIndex
CREATE INDEX "ChangelistComment_repoId_changelistNumber_idx" ON "ChangelistComment"("repoId", "changelistNumber");

-- CreateIndex
CREATE INDEX "Workspace_repoId_syncedChangelistNumber_idx" ON "Workspace"("repoId", "syncedChangelistNumber");

-- Backfill ArtifactSet from changelists with exactly-attached artifacts
-- (ArtifactFile rows exist at that CL). Inherited overlays are intentionally
-- excluded; the cumulative stateTree at an exact-attach CL is the correct
-- "set contents" for that CL.
INSERT INTO "ArtifactSet" ("id", "createdAt", "updatedAt", "repoId", "changelistNumber", "type", "versionIndex", "stateTree")
SELECT lower(hex(randomblob(16))), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, c."repoId", c."number", 'editor', c."artifactVersionIndex", c."artifactStateTree"
FROM "Changelist" c
WHERE c."artifactVersionIndex" IS NOT NULL
  AND c."artifactStateTree" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "ArtifactFile" af
    WHERE af."repoId" = c."repoId" AND af."changelistNumber" = c."number"
  );
