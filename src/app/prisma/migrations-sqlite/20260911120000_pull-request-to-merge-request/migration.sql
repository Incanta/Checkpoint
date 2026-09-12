-- Rename Pull Request to Merge Request.
--
-- Checkpoint never "pulls" a branch: `mergeRequest.merge` squashes the source
-- branch's changelists into a single changelist on the target and deletes the
-- source. "Merge request" names what actually happens; "pull request" is Git
-- hosting vocabulary that describes a fetch-then-integrate model Checkpoint
-- does not have.
--
-- This is a pure rename: every row is carried across unchanged. SQLite cannot
-- rename a table's constraints in place, so the four tables (plus Notification,
-- which carries the foreign key) are redefined the way Prisma does it and the
-- rows copied over. Notification.type values are rewritten from the `pr_`
-- prefix to `mr_` so existing notifications stay consistent with the types the
-- app writes from here on, and Notification.link is repointed at the new
-- `/merge-requests/` route so old notifications still resolve.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "MergeRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "mergedAt" DATETIME,
    "closedAt" DATETIME,
    "sourceBranchName" TEXT NOT NULL,
    "targetBranchName" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    CONSTRAINT "MergeRequest_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MergeRequest_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "MergeRequest" ("id", "createdAt", "updatedAt", "number", "title", "description", "status", "mergedAt", "closedAt", "sourceBranchName", "targetBranchName", "repoId", "authorId")
SELECT "id", "createdAt", "updatedAt", "number", "title", "description", "status", "mergedAt", "closedAt", "sourceBranchName", "targetBranchName", "repoId", "authorId" FROM "PullRequest";
DROP TABLE "PullRequest";
CREATE INDEX "MergeRequest_repoId_status_idx" ON "MergeRequest"("repoId", "status");
CREATE UNIQUE INDEX "MergeRequest_repoId_number_key" ON "MergeRequest"("repoId", "number");

CREATE TABLE "MergeRequestComment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "body" TEXT NOT NULL,
    "mergeRequestId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    CONSTRAINT "MergeRequestComment_mergeRequestId_fkey" FOREIGN KEY ("mergeRequestId") REFERENCES "MergeRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MergeRequestComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "MergeRequestComment" ("id", "createdAt", "updatedAt", "body", "mergeRequestId", "authorId")
SELECT "id", "createdAt", "updatedAt", "body", "pullRequestId", "authorId" FROM "PullRequestComment";
DROP TABLE "PullRequestComment";

CREATE TABLE "MergeRequestReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "mergeRequestId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    CONSTRAINT "MergeRequestReview_mergeRequestId_fkey" FOREIGN KEY ("mergeRequestId") REFERENCES "MergeRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MergeRequestReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "MergeRequestReview" ("id", "createdAt", "updatedAt", "state", "mergeRequestId", "reviewerId")
SELECT "id", "createdAt", "updatedAt", "state", "pullRequestId", "reviewerId" FROM "PullRequestReview";
DROP TABLE "PullRequestReview";
CREATE UNIQUE INDEX "MergeRequestReview_mergeRequestId_reviewerId_key" ON "MergeRequestReview"("mergeRequestId", "reviewerId");

CREATE TABLE "MergeRequestSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mergeRequestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MergeRequestSubscription_mergeRequestId_fkey" FOREIGN KEY ("mergeRequestId") REFERENCES "MergeRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MergeRequestSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "MergeRequestSubscription" ("id", "mergeRequestId", "userId", "createdAt")
SELECT "id", "pullRequestId", "userId", "createdAt" FROM "PullRequestSubscription";
DROP TABLE "PullRequestSubscription";
CREATE UNIQUE INDEX "MergeRequestSubscription_mergeRequestId_userId_key" ON "MergeRequestSubscription"("mergeRequestId", "userId");

CREATE TABLE "new_Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "link" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "userId" TEXT NOT NULL,
    "actorId" TEXT,
    "issueId" TEXT,
    "mergeRequestId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Notification_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_mergeRequestId_fkey" FOREIGN KEY ("mergeRequestId") REFERENCES "MergeRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Notification" ("id", "type", "title", "body", "link", "read", "userId", "actorId", "issueId", "mergeRequestId", "createdAt")
SELECT "id", "type", "title", "body", "link", "read", "userId", "actorId", "issueId", "pullRequestId", "createdAt" FROM "Notification";
DROP TABLE "Notification";
ALTER TABLE "new_Notification" RENAME TO "Notification";
CREATE INDEX "Notification_userId_read_idx" ON "Notification"("userId", "read");
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- Rewrite notification type prefixes (pr_created -> mr_created, etc.)
UPDATE "Notification" SET "type" = 'mr_' || substr("type", 4) WHERE "type" LIKE 'pr\_%' ESCAPE '\';

-- Repoint notification deep links at the renamed route.
UPDATE "Notification" SET "link" = replace("link", '/pull-requests/', '/merge-requests/') WHERE "link" LIKE '%/pull-requests/%';
