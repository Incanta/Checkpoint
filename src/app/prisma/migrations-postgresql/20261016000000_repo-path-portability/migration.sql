-- Whether a repo refuses new paths that some OS cannot store, or that fold
-- onto an existing path on case- or normalization-insensitive filesystems.

-- AlterTable
ALTER TABLE "Repo" ADD COLUMN "pathPortability" BOOLEAN NOT NULL DEFAULT true;
