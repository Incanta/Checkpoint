-- CreateTable
CREATE TABLE "Shelf" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "repoId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "versionIndex" TEXT NOT NULL,
    "stateTree" JSONB NOT NULL,
    "changelistNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "submittedToBranch" TEXT,
    "submittedAt" DATETIME,
    CONSTRAINT "Shelf_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Shelf_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ShelfFileChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shelfId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    CONSTRAINT "ShelfFileChange_shelfId_fkey" FOREIGN KEY ("shelfId") REFERENCES "Shelf" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ShelfFileChange_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Shelf_repoId_status_idx" ON "Shelf"("repoId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Shelf_repoId_name_key" ON "Shelf"("repoId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ShelfFileChange_shelfId_fileId_key" ON "ShelfFileChange"("shelfId", "fileId");
