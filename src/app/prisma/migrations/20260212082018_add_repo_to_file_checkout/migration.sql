-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_FileCheckout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" DATETIME,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "fileId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    CONSTRAINT "FileCheckout_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FileCheckout_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FileCheckout_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_FileCheckout" ("createdAt", "fileId", "id", "locked", "removedAt", "workspaceId") SELECT "createdAt", "fileId", "id", "locked", "removedAt", "workspaceId" FROM "FileCheckout";
DROP TABLE "FileCheckout";
ALTER TABLE "new_FileCheckout" RENAME TO "FileCheckout";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
