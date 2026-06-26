-- AlterTable
ALTER TABLE "Changelist" DROP COLUMN "stateTree",
ADD COLUMN     "stateRootHash" TEXT;

-- AlterTable
ALTER TABLE "Shelf" DROP COLUMN "stateTree";

-- CreateTable
CREATE TABLE "TreeBlock" (
    "repoId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "TreeBlock_pkey" PRIMARY KEY ("repoId","hash")
);

-- CreateIndex
CREATE INDEX "FileChange_repoId_changelistNumber_idx" ON "FileChange"("repoId", "changelistNumber");

