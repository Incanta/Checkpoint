-- AlterTable
ALTER TABLE "Changelist" ADD COLUMN "artifactStateTree" JSONB;
ALTER TABLE "Changelist" ADD COLUMN "artifactVersionIndex" TEXT;

-- CreateTable
CREATE TABLE "ArtifactFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "repoId" TEXT NOT NULL,
    "changelistNumber" INTEGER NOT NULL,
    "fileId" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    CONSTRAINT "ArtifactFile_repoId_changelistNumber_fkey" FOREIGN KEY ("repoId", "changelistNumber") REFERENCES "Changelist" ("repoId", "number") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ArtifactFile_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ArtifactFile_repoId_changelistNumber_idx" ON "ArtifactFile"("repoId", "changelistNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactFile_repoId_changelistNumber_fileId_key" ON "ArtifactFile"("repoId", "changelistNumber", "fileId");
