-- Where a merged file's content lives: a merge changelist's rows name the
-- changelist whose version index holds each file (null: the row's own).

-- AlterTable
ALTER TABLE "FileChange" ADD COLUMN "sourceChangelistNumber" INTEGER;
