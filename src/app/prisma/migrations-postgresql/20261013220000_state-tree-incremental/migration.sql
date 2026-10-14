-- Incremental state-tree updates.
--
-- fileCount lets the folder view show a changelist's total file count without
-- walking its whole tree; it is maintained per submit and merge, and null on
-- older changelists until filled in. TreeBlockLength records each stored
-- tree block's payload length so an incremental update can repack a changed
-- directory without fetching its untouched subdirectories. The File index
-- serves the path lookups every submit and claim check makes.
--
-- The index build takes a write lock on "File" for its duration. On a very
-- large File table, consider creating it beforehand with
-- CREATE INDEX CONCURRENTLY under the same name; this statement then fails
-- fast, so drop that line from a hand-applied copy.

-- AlterTable
ALTER TABLE "Changelist" ADD COLUMN "fileCount" INTEGER;

-- CreateTable
CREATE TABLE "TreeBlockLength" (
    "repoId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "length" INTEGER NOT NULL,

    CONSTRAINT "TreeBlockLength_pkey" PRIMARY KEY ("repoId","hash")
);

-- CreateIndex
CREATE INDEX "File_repoId_path_idx" ON "File"("repoId", "path");
