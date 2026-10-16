-- The head a merge changelist merged, followed by the merge base as a
-- second parent.

-- AlterTable
ALTER TABLE "Changelist" ADD COLUMN "mergedFromNumber" INTEGER;
