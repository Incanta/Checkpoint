-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Branch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "headNumber" INTEGER NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "type" TEXT NOT NULL DEFAULT 'MAINLINE',
    "archivedAt" DATETIME,
    "parentBranchName" TEXT,
    "createdById" TEXT,
    CONSTRAINT "Branch_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Branch_repoId_parentBranchName_fkey" FOREIGN KEY ("repoId", "parentBranchName") REFERENCES "Branch" ("repoId", "name") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Branch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Branch" ("headNumber", "id", "isDefault", "name", "repoId") SELECT "headNumber", "id", "isDefault", "name", "repoId" FROM "Branch";
DROP TABLE "Branch";
ALTER TABLE "new_Branch" RENAME TO "Branch";
CREATE UNIQUE INDEX "Branch_repoId_name_key" ON "Branch"("repoId", "name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
