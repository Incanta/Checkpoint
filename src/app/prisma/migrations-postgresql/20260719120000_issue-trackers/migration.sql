-- CreateEnum
CREATE TYPE "IssuesPlatform" AS ENUM ('CHECKPOINT', 'JIRA', 'CODECKS', 'HACKNPLAN', 'DISABLED');

-- AlterTable
ALTER TABLE "Repo" ADD COLUMN "issuesPlatform" "IssuesPlatform" NOT NULL DEFAULT 'CHECKPOINT';

-- CreateTable
CREATE TABLE "RepoIssueTrackerConfig" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "jiraBaseUrl" TEXT,
    "jiraEmail" TEXT,
    "jiraProjectKey" TEXT,
    "codecksSubdomain" TEXT,
    "hacknplanProjectId" INTEGER,
    "encryptedToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepoIssueTrackerConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RepoIssueTrackerConfig_repoId_key" ON "RepoIssueTrackerConfig"("repoId");

-- AddForeignKey
ALTER TABLE "RepoIssueTrackerConfig" ADD CONSTRAINT "RepoIssueTrackerConfig_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
