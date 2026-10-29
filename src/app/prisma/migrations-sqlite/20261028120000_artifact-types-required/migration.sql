-- Artifact types have no default: every upload names its set. The legacy
-- per-changelist artifact overlay is gone; ArtifactSet holds every upload
-- (the game-sync migration copied the overlays into it).

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
    "type" TEXT NOT NULL,
    CONSTRAINT "ArtifactFile_repoId_changelistNumber_fkey" FOREIGN KEY ("repoId", "changelistNumber") REFERENCES "Changelist" ("repoId", "number") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ArtifactFile_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ArtifactFile" ("changelistNumber", "createdAt", "fileId", "id", "repoId", "size", "type") SELECT "changelistNumber", "createdAt", "fileId", "id", "repoId", "size", "type" FROM "ArtifactFile";
DROP TABLE "ArtifactFile";
ALTER TABLE "new_ArtifactFile" RENAME TO "ArtifactFile";
CREATE INDEX "ArtifactFile_repoId_changelistNumber_idx" ON "ArtifactFile"("repoId", "changelistNumber");
CREATE UNIQUE INDEX "ArtifactFile_repoId_changelistNumber_type_fileId_key" ON "ArtifactFile"("repoId", "changelistNumber", "type", "fileId");
CREATE TABLE "new_ArtifactSet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "repoId" TEXT NOT NULL,
    "changelistNumber" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "versionIndex" TEXT NOT NULL,
    "stateTree" JSONB NOT NULL,
    CONSTRAINT "ArtifactSet_repoId_changelistNumber_fkey" FOREIGN KEY ("repoId", "changelistNumber") REFERENCES "Changelist" ("repoId", "number") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ArtifactSet" ("changelistNumber", "createdAt", "id", "repoId", "stateTree", "type", "updatedAt", "versionIndex") SELECT "changelistNumber", "createdAt", "id", "repoId", "stateTree", "type", "updatedAt", "versionIndex" FROM "ArtifactSet";
DROP TABLE "ArtifactSet";
ALTER TABLE "new_ArtifactSet" RENAME TO "ArtifactSet";
CREATE INDEX "ArtifactSet_repoId_type_changelistNumber_idx" ON "ArtifactSet"("repoId", "type", "changelistNumber");
CREATE UNIQUE INDEX "ArtifactSet_repoId_changelistNumber_type_key" ON "ArtifactSet"("repoId", "changelistNumber", "type");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- AlterTable: dropped in place rather than by copying the changelist table.
ALTER TABLE "Changelist" DROP COLUMN "artifactVersionIndex";
ALTER TABLE "Changelist" DROP COLUMN "artifactStateTree";
