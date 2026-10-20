-- The Longtail format settings a repo's submits use, pinned from the
-- instance config the first time the repo is used.

-- AlterTable
ALTER TABLE "Repo" ADD COLUMN "longtailParams" TEXT;
