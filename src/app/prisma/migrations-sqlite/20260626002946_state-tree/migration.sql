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

