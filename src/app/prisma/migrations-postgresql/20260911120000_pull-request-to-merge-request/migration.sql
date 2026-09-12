-- Rename Pull Request to Merge Request.
--
-- Checkpoint never "pulls" a branch: `mergeRequest.merge` squashes the source
-- branch's changelists into a single changelist on the target and deletes the
-- source. "Merge request" names what actually happens; "pull request" is Git
-- hosting vocabulary that describes a fetch-then-integrate model Checkpoint
-- does not have.
--
-- This is a pure rename: tables, columns, indexes, constraints, and the status
-- enum all keep their rows and shape. Notification.type values are rewritten
-- from the `pr_` prefix to `mr_` so existing notifications stay consistent with
-- the types the app writes from here on, and Notification.link is repointed at
-- the new `/merge-requests/` route so old notifications still resolve.

-- AlterEnum
ALTER TYPE "PullRequestStatus" RENAME TO "MergeRequestStatus";

-- RenameTable
ALTER TABLE "PullRequest" RENAME TO "MergeRequest";
ALTER TABLE "PullRequestComment" RENAME TO "MergeRequestComment";
ALTER TABLE "PullRequestReview" RENAME TO "MergeRequestReview";
ALTER TABLE "PullRequestSubscription" RENAME TO "MergeRequestSubscription";

-- RenameColumn
ALTER TABLE "MergeRequestComment" RENAME COLUMN "pullRequestId" TO "mergeRequestId";
ALTER TABLE "MergeRequestReview" RENAME COLUMN "pullRequestId" TO "mergeRequestId";
ALTER TABLE "MergeRequestSubscription" RENAME COLUMN "pullRequestId" TO "mergeRequestId";
ALTER TABLE "Notification" RENAME COLUMN "pullRequestId" TO "mergeRequestId";

-- RenameConstraint (primary keys)
ALTER TABLE "MergeRequest" RENAME CONSTRAINT "PullRequest_pkey" TO "MergeRequest_pkey";
ALTER TABLE "MergeRequestComment" RENAME CONSTRAINT "PullRequestComment_pkey" TO "MergeRequestComment_pkey";
ALTER TABLE "MergeRequestReview" RENAME CONSTRAINT "PullRequestReview_pkey" TO "MergeRequestReview_pkey";
ALTER TABLE "MergeRequestSubscription" RENAME CONSTRAINT "PullRequestSubscription_pkey" TO "MergeRequestSubscription_pkey";

-- RenameConstraint (foreign keys)
ALTER TABLE "MergeRequest" RENAME CONSTRAINT "PullRequest_repoId_fkey" TO "MergeRequest_repoId_fkey";
ALTER TABLE "MergeRequest" RENAME CONSTRAINT "PullRequest_authorId_fkey" TO "MergeRequest_authorId_fkey";
ALTER TABLE "MergeRequestComment" RENAME CONSTRAINT "PullRequestComment_pullRequestId_fkey" TO "MergeRequestComment_mergeRequestId_fkey";
ALTER TABLE "MergeRequestComment" RENAME CONSTRAINT "PullRequestComment_authorId_fkey" TO "MergeRequestComment_authorId_fkey";
ALTER TABLE "MergeRequestReview" RENAME CONSTRAINT "PullRequestReview_pullRequestId_fkey" TO "MergeRequestReview_mergeRequestId_fkey";
ALTER TABLE "MergeRequestReview" RENAME CONSTRAINT "PullRequestReview_reviewerId_fkey" TO "MergeRequestReview_reviewerId_fkey";
ALTER TABLE "MergeRequestSubscription" RENAME CONSTRAINT "PullRequestSubscription_pullRequestId_fkey" TO "MergeRequestSubscription_mergeRequestId_fkey";
ALTER TABLE "MergeRequestSubscription" RENAME CONSTRAINT "PullRequestSubscription_userId_fkey" TO "MergeRequestSubscription_userId_fkey";
ALTER TABLE "Notification" RENAME CONSTRAINT "Notification_pullRequestId_fkey" TO "Notification_mergeRequestId_fkey";

-- RenameIndex
ALTER INDEX "PullRequest_repoId_status_idx" RENAME TO "MergeRequest_repoId_status_idx";
ALTER INDEX "PullRequest_repoId_number_key" RENAME TO "MergeRequest_repoId_number_key";
ALTER INDEX "PullRequestReview_pullRequestId_reviewerId_key" RENAME TO "MergeRequestReview_mergeRequestId_reviewerId_key";
ALTER INDEX "PullRequestSubscription_pullRequestId_userId_key" RENAME TO "MergeRequestSubscription_mergeRequestId_userId_key";

-- Rewrite notification type prefixes (pr_created -> mr_created, etc.)
UPDATE "Notification" SET "type" = 'mr_' || substring("type" from 4) WHERE "type" LIKE 'pr\_%';

-- Repoint notification deep links at the renamed route.
UPDATE "Notification" SET "link" = replace("link", '/pull-requests/', '/merge-requests/') WHERE "link" LIKE '%/pull-requests/%';
