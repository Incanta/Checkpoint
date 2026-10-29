-- Artifact types have no default: every upload names its set. The legacy
-- per-changelist artifact overlay is gone; ArtifactSet holds every upload
-- (the game-sync migration copied the overlays into it).

-- AlterTable
ALTER TABLE "ArtifactFile" ALTER COLUMN "type" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ArtifactSet" ALTER COLUMN "type" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Changelist" DROP COLUMN "artifactVersionIndex",
DROP COLUMN "artifactStateTree";
