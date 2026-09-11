-- Remove shelves.
--
-- A shelf existed to be a cheap alternative to a branch. Git's stash earns its
-- keep by being local and free; Perforce's shelf exists because branching there
-- is expensive. Checkpoint has neither property: a feature branch is a named
-- changelist chain that does not even require its own workspace
-- materialization, so creating one is cheaper than creating a shelf (which
-- allocates a dangling changelist, uploads a version index, and writes
-- ShelfFileChange rows).
--
-- Branches are also already the unit of review and the way work reaches other
-- people, and they squash on merge, so a WIP commit costs nothing permanent.
-- Everything a shelf did is better served by submitting to a branch.
--
-- No conversion is needed: no running instance held real shelves. Were that
-- not true, each ACTIVE shelf would convert faithfully to a feature branch
-- carrying a single changelist.

-- DropTable
DROP TABLE "ShelfFileChange";

-- DropTable
DROP TABLE "Shelf";

-- DropEnum
DROP TYPE "ShelfStatus";
