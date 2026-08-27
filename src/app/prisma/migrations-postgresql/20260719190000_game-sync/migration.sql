-- CreateEnum
CREATE TYPE "BuildBadgeState" AS ENUM ('STARTING', 'FAILURE', 'WARNING', 'SUCCESS', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ChangelistVote" AS ENUM ('COMPILE_SUCCESS', 'COMPILE_FAILURE', 'GOOD', 'BAD');

-- AlterTable
ALTER TABLE "Changelist" ADD COLUMN "hasCodeChanges" BOOLEAN;
ALTER TABLE "Changelist" ADD COLUMN "hasContentChanges" BOOLEAN;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN "syncedAt" TIMESTAMP(3);
ALTER TABLE "Workspace" ADD COLUMN "syncedChangelistNumber" INTEGER;

-- AlterTable
ALTER TABLE "ArtifactFile" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'editor';

-- DropIndex
DROP INDEX "ArtifactFile_repoId_changelistNumber_fileId_key";

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactFile_repoId_changelistNumber_type_fileId_key" ON "ArtifactFile"("repoId", "changelistNumber", "type", "fileId");

-- CreateTable
CREATE TABLE "ArtifactSet" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "repoId" TEXT NOT NULL,
    "changelistNumber" INTEGER NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'editor',
    "versionIndex" TEXT NOT NULL,
    "stateTree" JSONB NOT NULL,

    CONSTRAINT "ArtifactSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuildBadge" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "repoId" TEXT NOT NULL,
    "changelistNumber" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "group" TEXT,
    "state" "BuildBadgeState" NOT NULL,
    "url" TEXT,
    "metadata" JSONB,
    "postedById" TEXT,

    CONSTRAINT "BuildBadge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangelistReview" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "repoId" TEXT NOT NULL,
    "changelistNumber" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "vote" "ChangelistVote",
    "starred" BOOLEAN NOT NULL DEFAULT false,
    "investigating" BOOLEAN NOT NULL DEFAULT false,
    "investigatingSince" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ChangelistReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangelistComment" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "body" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "changelistNumber" INTEGER NOT NULL,
    "authorId" TEXT NOT NULL,

    CONSTRAINT "ChangelistComment_pkey" PRIMARY KEY ("id")
);

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

-- AddForeignKey
ALTER TABLE "ArtifactSet" ADD CONSTRAINT "ArtifactSet_repoId_changelistNumber_fkey" FOREIGN KEY ("repoId", "changelistNumber") REFERENCES "Changelist"("repoId", "number") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildBadge" ADD CONSTRAINT "BuildBadge_repoId_changelistNumber_fkey" FOREIGN KEY ("repoId", "changelistNumber") REFERENCES "Changelist"("repoId", "number") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildBadge" ADD CONSTRAINT "BuildBadge_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangelistReview" ADD CONSTRAINT "ChangelistReview_repoId_changelistNumber_fkey" FOREIGN KEY ("repoId", "changelistNumber") REFERENCES "Changelist"("repoId", "number") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangelistReview" ADD CONSTRAINT "ChangelistReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangelistComment" ADD CONSTRAINT "ChangelistComment_repoId_changelistNumber_fkey" FOREIGN KEY ("repoId", "changelistNumber") REFERENCES "Changelist"("repoId", "number") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangelistComment" ADD CONSTRAINT "ChangelistComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill ArtifactSet from changelists with exactly-attached artifacts
-- (ArtifactFile rows exist at that CL). Inherited overlays are intentionally
-- excluded; the cumulative stateTree at an exact-attach CL is the correct
-- "set contents" for that CL.
INSERT INTO "ArtifactSet" ("id", "createdAt", "updatedAt", "repoId", "changelistNumber", "type", "versionIndex", "stateTree")
SELECT md5(random()::text || clock_timestamp()::text), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, c."repoId", c."number", 'editor',
       c."artifactVersionIndex", c."artifactStateTree"
FROM "Changelist" c
WHERE c."artifactVersionIndex" IS NOT NULL
  AND c."artifactStateTree" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "ArtifactFile" af
    WHERE af."repoId" = c."repoId" AND af."changelistNumber" = c."number"
  );
