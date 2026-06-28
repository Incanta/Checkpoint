-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Repo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deletedAt" DATETIME,
    "deletedBy" TEXT,
    "name" TEXT NOT NULL,
    "public" BOOLEAN NOT NULL DEFAULT false,
    "r2BucketName" TEXT,
    "storageBytes" BIGINT NOT NULL DEFAULT 0,
    "orgId" TEXT NOT NULL,
    "requiredReviews" INTEGER NOT NULL DEFAULT 0,
    "mergePermissionsSame" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "Repo_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Repo" ("deletedAt", "deletedBy", "id", "mergePermissionsSame", "name", "orgId", "public", "r2BucketName", "requiredReviews") SELECT "deletedAt", "deletedBy", "id", "mergePermissionsSame", "name", "orgId", "public", "r2BucketName", "requiredReviews" FROM "Repo";
DROP TABLE "Repo";
ALTER TABLE "new_Repo" RENAME TO "Repo";
CREATE UNIQUE INDEX "Repo_orgId_name_key" ON "Repo"("orgId", "name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

