// @obfuscate

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Changelist } from "@prisma/client";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { FileChangeType, RepoAccess } from "@prisma/client";
import { getUserAndRepoWithAccess } from "../auth-utils";
import { recordActivity } from "../activity";
import { subscribeToPR, notifyPRSubscribers } from "~/server/notifications";

function prLink(orgName: string, repoName: string, number: number) {
  return `/${orgName}/${repoName}/pull-requests/${number}`;
}

export const pullRequestRouter = createTRPCRouter({
  list: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        status: z.enum(["OPEN", "MERGED", "CLOSED", "ALL"]).default("OPEN"),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      return ctx.db.pullRequest.findMany({
        where: {
          repoId: input.repoId,
          ...(input.status !== "ALL" ? { status: input.status } : {}),
        },
        include: {
          author: {
            select: { id: true, name: true, email: true, image: true },
          },
          reviews: {
            include: {
              reviewer: {
                select: { id: true, name: true, email: true, image: true },
              },
            },
          },
          _count: { select: { comments: true } },
        },
        orderBy: { createdAt: "desc" },
      });
    }),

  get: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        number: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const pr = await ctx.db.pullRequest.findUnique({
        where: {
          repoId_number: {
            repoId: input.repoId,
            number: input.number,
          },
        },
        include: {
          author: {
            select: { id: true, name: true, email: true, image: true },
          },
          comments: {
            include: {
              author: {
                select: { id: true, name: true, email: true, image: true },
              },
            },
            orderBy: { createdAt: "asc" },
          },
          reviews: {
            include: {
              reviewer: {
                select: { id: true, name: true, email: true, image: true },
              },
            },
          },
          repo: {
            select: { requiredReviews: true, mergePermissionsSame: true },
          },
        },
      });

      if (!pr) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Pull request not found",
        });
      }

      return pr;
    }),

  create: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        title: z.string().min(1),
        description: z.string().default(""),
        sourceBranchName: z.string(),
        targetBranchName: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );

      // Validate branches exist
      const sourceBranch = await ctx.db.branch.findUnique({
        where: {
          repoId_name: { repoId: input.repoId, name: input.sourceBranchName },
        },
      });
      if (!sourceBranch) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Source branch "${input.sourceBranchName}" not found`,
        });
      }

      const targetBranch = await ctx.db.branch.findUnique({
        where: {
          repoId_name: { repoId: input.repoId, name: input.targetBranchName },
        },
      });
      if (!targetBranch) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Target branch "${input.targetBranchName}" not found`,
        });
      }

      // Validate source is a feature branch merging into its parent
      if (sourceBranch.type !== "FEATURE") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only feature branches can be used as PR source",
        });
      }
      if (sourceBranch.parentBranchName !== targetBranch.name) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Source branch must target its parent branch",
        });
      }

      // Check no existing open PR for same source branch
      const existing = await ctx.db.pullRequest.findFirst({
        where: {
          repoId: input.repoId,
          sourceBranchName: input.sourceBranchName,
          status: "OPEN",
        },
      });
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "An open pull request already exists for this branch",
        });
      }

      // Get next PR number
      const lastPr = await ctx.db.pullRequest.findFirst({
        where: { repoId: input.repoId },
        orderBy: { number: "desc" },
      });
      const nextNumber = (lastPr?.number ?? 0) + 1;

      const pr = await ctx.db.pullRequest.create({
        data: {
          number: nextNumber,
          title: input.title,
          description: input.description,
          sourceBranchName: input.sourceBranchName,
          targetBranchName: input.targetBranchName,
          repoId: input.repoId,
          authorId: ctx.session.user.id,
        },
      });

      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "write",
      });

      // Auto-subscribe author
      await subscribeToPR(ctx.db, pr.id, ctx.session.user.id);
      // Notify subscribers (mentions in description)
      const link = prLink(repo.org.name, repo.name, pr.number);
      void notifyPRSubscribers({
        db: ctx.db,
        actorId: ctx.session.user.id,
        pullRequestId: pr.id,
        type: "pr_created",
        title: `New PR #${pr.number}: ${pr.title}`,
        link,
        text: input.description,
      });

      return pr;
    }),

  update: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        number: z.number(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );

      const pr = await ctx.db.pullRequest.findUnique({
        where: {
          repoId_number: { repoId: input.repoId, number: input.number },
        },
      });
      if (!pr)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Pull request not found",
        });
      if (pr.authorId !== ctx.session.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the author can edit this pull request",
        });
      }

      const updated = await ctx.db.pullRequest.update({
        where: { id: pr.id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
        },
      });

      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "write",
      });

      return updated;
    }),

  close: protectedProcedure
    .input(z.object({ repoId: z.string(), number: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );

      const pr = await ctx.db.pullRequest.findUnique({
        where: {
          repoId_number: { repoId: input.repoId, number: input.number },
        },
      });
      if (!pr)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Pull request not found",
        });
      if (pr.status !== "OPEN")
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only open PRs can be closed",
        });

      const updated = await ctx.db.pullRequest.update({
        where: { id: pr.id },
        data: { status: "CLOSED", closedAt: new Date() },
      });

      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "write",
      });

      void notifyPRSubscribers({
        db: ctx.db,
        actorId: ctx.session.user.id,
        pullRequestId: pr.id,
        type: "pr_closed",
        title: `PR #${pr.number} closed: ${pr.title}`,
        link: prLink(repo.org.name, repo.name, pr.number),
      });

      return updated;
    }),

  reopen: protectedProcedure
    .input(z.object({ repoId: z.string(), number: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );

      const pr = await ctx.db.pullRequest.findUnique({
        where: {
          repoId_number: { repoId: input.repoId, number: input.number },
        },
      });
      if (!pr)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Pull request not found",
        });
      if (pr.status !== "CLOSED")
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only closed PRs can be reopened",
        });

      const updated = await ctx.db.pullRequest.update({
        where: { id: pr.id },
        data: { status: "OPEN", closedAt: null },
      });

      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "write",
      });

      void notifyPRSubscribers({
        db: ctx.db,
        actorId: ctx.session.user.id,
        pullRequestId: pr.id,
        type: "pr_reopened",
        title: `PR #${pr.number} reopened: ${pr.title}`,
        link: prLink(repo.org.name, repo.name, pr.number),
      });

      return updated;
    }),

  merge: protectedProcedure
    .input(z.object({ repoId: z.string(), number: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );

      const pr = await ctx.db.pullRequest.findUnique({
        where: {
          repoId_number: { repoId: input.repoId, number: input.number },
        },
        include: {
          reviews: true,
          repo: {
            select: { requiredReviews: true, mergePermissionsSame: true },
          },
        },
      });
      if (!pr)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Pull request not found",
        });
      if (pr.status !== "OPEN")
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only open PRs can be merged",
        });

      // Check required reviews
      const approvedCount = pr.reviews.filter(
        (r) => r.state === "APPROVED",
      ).length;
      const hasRequestChanges = pr.reviews.some(
        (r) => r.state === "REQUEST_CHANGES",
      );
      if (hasRequestChanges) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot merge: there are outstanding change requests",
        });
      }
      if (approvedCount < pr.repo.requiredReviews) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot merge: ${approvedCount}/${pr.repo.requiredReviews} required approvals`,
        });
      }

      // Check merge permissions
      const targetBranch = await ctx.db.branch.findUnique({
        where: {
          repoId_name: { repoId: input.repoId, name: pr.targetBranchName },
        },
      });
      if (!targetBranch) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Target branch no longer exists",
        });
      }

      const permType = pr.repo.mergePermissionsSame
        ? "MAINLINE"
        : targetBranch.type === "RELEASE"
          ? "RELEASE"
          : "MAINLINE";

      const permissions = await ctx.db.mergePermission.findMany({
        where: { repoId: input.repoId, type: permType },
      });

      // Empty list = all authorized
      if (permissions.length > 0) {
        const authorized = permissions.some(
          (p) => p.userId === ctx.session.user.id,
        );
        if (!authorized) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You are not authorized to merge into this branch",
          });
        }
      }

      // Validate source branch still exists
      const sourceBranch = await ctx.db.branch.findUnique({
        where: {
          repoId_name: { repoId: input.repoId, name: pr.sourceBranchName },
        },
      });
      if (!sourceBranch) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Source branch no longer exists",
        });
      }

      // Execute merge (replicated from branch.mergeBranch logic)
      // Collect all CLs on the incoming branch
      const incomingCls: (Changelist & { user: { email: string } | null })[] =
        [];
      let currentNumber: number | null = sourceBranch.headNumber;
      while (currentNumber !== null) {
        const cl: (Changelist & { user: { email: string } | null }) | null =
          await ctx.db.changelist.findUnique({
            where: {
              repoId_number: { repoId: input.repoId, number: currentNumber },
            },
            include: { user: { select: { email: true } } },
          });
        if (!cl) break;
        incomingCls.push(cl);
        currentNumber = cl.parentNumber;
        if (
          cl.parentNumber !== null &&
          cl.parentNumber <= targetBranch.headNumber
        )
          break;
      }

      if (incomingCls.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No changelists to merge",
        });
      }

      const firstLine = `Merged ${pr.sourceBranchName} into ${pr.targetBranchName}`;
      const clMessages = incomingCls
        .map((cl) => `#${cl.number} ${cl.message}`)
        .join("\n");
      const mergeMessage = `${firstLine}\n\n${clMessages}`;

      const incomingHead = await ctx.db.changelist.findUnique({
        where: {
          repoId_number: {
            repoId: input.repoId,
            number: sourceBranch.headNumber,
          },
        },
      });
      const targetHead = await ctx.db.changelist.findUnique({
        where: {
          repoId_number: {
            repoId: input.repoId,
            number: targetBranch.headNumber,
          },
        },
      });

      if (!incomingHead || !targetHead) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Could not find branch head changelists",
        });
      }

      const targetState: Record<string, number> = {
        ...(targetHead.stateTree as Record<string, number>),
      };
      const incomingState: Record<string, number> =
        incomingHead.stateTree as Record<string, number>;

      for (const [fileId, clNum] of Object.entries(incomingState)) {
        targetState[fileId] = clNum;
      }

      const incomingClNumbers = incomingCls.map((cl) => cl.number);
      const fileChanges = await ctx.db.fileChange.findMany({
        where: {
          repoId: input.repoId,
          changelistNumber: { in: incomingClNumbers },
        },
        include: { file: true },
      });

      for (const fc of fileChanges) {
        if (fc.type === FileChangeType.DELETE) {
          delete targetState[fc.fileId];
        }
      }

      const lastCl = await ctx.db.changelist.findFirst({
        where: { repoId: input.repoId },
        orderBy: { number: "desc" },
      });
      const nextNumber = (lastCl?.number ?? -1) + 1;

      const mergeCl = await ctx.db.changelist.create({
        data: {
          number: nextNumber,
          message: mergeMessage,
          versionIndex: incomingHead.versionIndex,
          parentNumber: targetBranch.headNumber,
          stateTree: targetState,
          repoId: input.repoId,
          userId: ctx.session.user.id,
        },
      });

      // Create de-duplicated file change records
      const latestFileChanges = new Map<
        string,
        { type: FileChangeType; oldPath: string | null }
      >();
      for (const fc of fileChanges.sort(
        (a, b) => a.changelistNumber - b.changelistNumber,
      )) {
        latestFileChanges.set(fc.fileId, {
          type: fc.type,
          oldPath: fc.oldPath,
        });
      }
      if (latestFileChanges.size > 0) {
        await ctx.db.fileChange.createMany({
          data: Array.from(latestFileChanges.entries()).map(
            ([fileId, change]) => ({
              repoId: input.repoId,
              fileId,
              changelistNumber: nextNumber,
              type: change.type,
              oldPath: change.oldPath,
            }),
          ),
        });
      }

      // Update target branch head
      await ctx.db.branch.update({
        where: { id: targetBranch.id },
        data: { headNumber: nextNumber },
      });

      // Delete source branch
      await ctx.db.branch.delete({
        where: { id: sourceBranch.id },
      });

      // Update PR status
      await ctx.db.pullRequest.update({
        where: { id: pr.id },
        data: { status: "MERGED", mergedAt: new Date() },
      });

      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "write",
      });

      void notifyPRSubscribers({
        db: ctx.db,
        actorId: ctx.session.user.id,
        pullRequestId: pr.id,
        type: "pr_merged",
        title: `PR #${pr.number} merged: ${pr.title}`,
        link: prLink(repo.org.name, repo.name, pr.number),
      });

      return {
        mergeChangelist: { id: mergeCl.id, number: mergeCl.number },
        deletedBranch: pr.sourceBranchName,
      };
    }),

  addComment: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        prNumber: z.number(),
        body: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.READ,
      );

      const pr = await ctx.db.pullRequest.findUnique({
        where: {
          repoId_number: { repoId: input.repoId, number: input.prNumber },
        },
      });
      if (!pr)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Pull request not found",
        });

      const comment = await ctx.db.pullRequestComment.create({
        data: {
          body: input.body,
          pullRequestId: pr.id,
          authorId: ctx.session.user.id,
        },
        include: {
          author: {
            select: { id: true, name: true, email: true, image: true },
          },
        },
      });

      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "read",
      });

      // Auto-subscribe commenter
      await subscribeToPR(ctx.db, pr.id, ctx.session.user.id);

      void notifyPRSubscribers({
        db: ctx.db,
        actorId: ctx.session.user.id,
        pullRequestId: pr.id,
        type: "pr_comment",
        title: `Comment on PR #${pr.number}: ${pr.title}`,
        body: input.body.slice(0, 200),
        link: prLink(repo.org.name, repo.name, pr.number),
        text: input.body,
      });

      return comment;
    }),

  deleteComment: protectedProcedure
    .input(z.object({ commentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const comment = await ctx.db.pullRequestComment.findUnique({
        where: { id: input.commentId },
        include: { pullRequest: { select: { repoId: true } } },
      });
      if (!comment)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Comment not found",
        });
      if (comment.authorId !== ctx.session.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can only delete your own comments",
        });
      }

      await ctx.db.pullRequestComment.delete({
        where: { id: input.commentId },
      });
      return { success: true };
    }),

  updateComment: protectedProcedure
    .input(z.object({ commentId: z.string(), body: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const comment = await ctx.db.pullRequestComment.findUnique({
        where: { id: input.commentId },
      });
      if (!comment)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Comment not found",
        });
      if (comment.authorId !== ctx.session.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can only edit your own comments",
        });
      }

      return ctx.db.pullRequestComment.update({
        where: { id: input.commentId },
        data: { body: input.body },
      });
    }),

  addReview: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        prNumber: z.number(),
        reviewerId: z.string(),
        state: z
          .enum(["PENDING", "REQUEST_CHANGES", "APPROVED"])
          .default("PENDING"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );

      const pr = await ctx.db.pullRequest.findUnique({
        where: {
          repoId_number: { repoId: input.repoId, number: input.prNumber },
        },
      });
      if (!pr)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Pull request not found",
        });
      if (pr.status !== "OPEN")
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot review a non-open PR",
        });

      // Can't review your own PR
      if (input.reviewerId === pr.authorId && input.state !== "PENDING") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot approve or request changes on your own PR",
        });
      }

      // Only the reviewer themselves can set APPROVED or REQUEST_CHANGES
      // Anyone with write access can set PENDING (requesting a review)
      if (
        input.state !== "PENDING" &&
        input.reviewerId !== ctx.session.user.id
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the reviewer can approve or request changes",
        });
      }

      const review = await ctx.db.pullRequestReview.upsert({
        where: {
          pullRequestId_reviewerId: {
            pullRequestId: pr.id,
            reviewerId: input.reviewerId,
          },
        },
        create: {
          pullRequestId: pr.id,
          reviewerId: input.reviewerId,
          state: input.state,
        },
        update: {
          state: input.state,
        },
        include: {
          reviewer: {
            select: { id: true, name: true, email: true, image: true },
          },
        },
      });

      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "write",
      });

      // Auto-subscribe reviewer
      await subscribeToPR(ctx.db, pr.id, input.reviewerId);

      const link = prLink(repo.org.name, repo.name, pr.number);
      if (input.state === "PENDING") {
        // Review requested — notify the reviewer
        if (input.reviewerId !== ctx.session.user.id) {
          await ctx.db.notification.create({
            data: {
              userId: input.reviewerId,
              actorId: ctx.session.user.id,
              type: "pr_review_requested",
              title: `Review requested on PR #${pr.number}: ${pr.title}`,
              link,
              pullRequestId: pr.id,
            },
          });
        }
      } else {
        // Approved or changes requested — notify all subscribers
        const stateLabel =
          input.state === "APPROVED" ? "approved" : "requested changes on";
        void notifyPRSubscribers({
          db: ctx.db,
          actorId: ctx.session.user.id,
          pullRequestId: pr.id,
          type:
            input.state === "APPROVED" ? "pr_approved" : "pr_changes_requested",
          title: `${review.reviewer.name ?? review.reviewer.email} ${stateLabel} PR #${pr.number}`,
          link,
        });
      }

      return review;
    }),

  // Get changelists on source branch that aren't on target (for History tab)
  getChangelists: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        prNumber: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const pr = await ctx.db.pullRequest.findUnique({
        where: {
          repoId_number: { repoId: input.repoId, number: input.prNumber },
        },
      });
      if (!pr)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Pull request not found",
        });

      const sourceBranch = await ctx.db.branch.findUnique({
        where: {
          repoId_name: { repoId: input.repoId, name: pr.sourceBranchName },
        },
      });
      const targetBranch = await ctx.db.branch.findUnique({
        where: {
          repoId_name: { repoId: input.repoId, name: pr.targetBranchName },
        },
      });

      if (!sourceBranch || !targetBranch) return [];

      // Walk source branch from head back to common ancestor
      const changelists: (Changelist & { user: { email: string } | null })[] =
        [];
      let currentNumber: number | null = sourceBranch.headNumber;
      while (currentNumber !== null) {
        const cl: (Changelist & { user: { email: string } | null }) | null =
          await ctx.db.changelist.findUnique({
            where: {
              repoId_number: { repoId: input.repoId, number: currentNumber },
            },
            include: { user: { select: { email: true } } },
          });
        if (!cl) break;
        changelists.push(cl);
        currentNumber = cl.parentNumber;
        if (
          cl.parentNumber !== null &&
          cl.parentNumber <= targetBranch.headNumber
        )
          break;
      }

      return changelists;
    }),

  // Get files changed between source and target (for Changes tab)
  getChangedFiles: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        prNumber: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const pr = await ctx.db.pullRequest.findUnique({
        where: {
          repoId_number: { repoId: input.repoId, number: input.prNumber },
        },
      });
      if (!pr)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Pull request not found",
        });

      const sourceBranch = await ctx.db.branch.findUnique({
        where: {
          repoId_name: { repoId: input.repoId, name: pr.sourceBranchName },
        },
      });
      const targetBranch = await ctx.db.branch.findUnique({
        where: {
          repoId_name: { repoId: input.repoId, name: pr.targetBranchName },
        },
      });

      if (!sourceBranch || !targetBranch)
        return { files: [], sourceHead: 0, targetHead: 0 };

      // Collect CL numbers on source branch
      const clNumbers: number[] = [];
      let currentNumber: number | null = sourceBranch.headNumber;
      while (currentNumber !== null) {
        clNumbers.push(currentNumber);
        const cl: { parentNumber: number | null } | null =
          await ctx.db.changelist.findUnique({
            where: {
              repoId_number: { repoId: input.repoId, number: currentNumber },
            },
            select: { parentNumber: true },
          });
        if (!cl) break;
        currentNumber = cl.parentNumber;
        if (
          cl.parentNumber !== null &&
          cl.parentNumber <= targetBranch.headNumber
        )
          break;
      }

      if (clNumbers.length === 0)
        return {
          files: [],
          sourceHead: sourceBranch.headNumber,
          targetHead: targetBranch.headNumber,
        };

      const fileChanges = await ctx.db.fileChange.findMany({
        where: {
          repoId: input.repoId,
          changelistNumber: { in: clNumbers },
        },
        include: { file: { select: { path: true } } },
      });

      // De-duplicate: keep latest change type per file path
      const byPath = new Map<string, { path: string; type: FileChangeType }>();
      for (const fc of fileChanges.sort(
        (a, b) => a.changelistNumber - b.changelistNumber,
      )) {
        byPath.set(fc.file.path, { path: fc.file.path, type: fc.type });
      }

      return {
        files: Array.from(byPath.values()).sort((a, b) =>
          a.path.localeCompare(b.path),
        ),
        sourceHead: sourceBranch.headNumber,
        targetHead: targetBranch.headNumber,
      };
    }),

  // Count open PRs for a repo (for tab badge)
  countOpen: protectedProcedure
    .input(z.object({ repoId: z.string() }))
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);
      return ctx.db.pullRequest.count({
        where: { repoId: input.repoId, status: "OPEN" },
      });
    }),

  // ── Subscriptions ──────────────────────────────────────────────

  isSubscribed: protectedProcedure
    .input(z.object({ pullRequestId: z.string() }))
    .query(async ({ ctx, input }) => {
      const sub = await ctx.db.pullRequestSubscription.findUnique({
        where: {
          pullRequestId_userId: {
            pullRequestId: input.pullRequestId,
            userId: ctx.session.user.id,
          },
        },
      });
      return !!sub;
    }),

  subscribe: protectedProcedure
    .input(z.object({ pullRequestId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const pr = await ctx.db.pullRequest.findUnique({
        where: { id: input.pullRequestId },
        select: { repoId: true },
      });
      if (!pr)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Pull request not found",
        });
      await getUserAndRepoWithAccess(ctx, pr.repoId, RepoAccess.READ);
      await subscribeToPR(ctx.db, input.pullRequestId, ctx.session.user.id);
      return { subscribed: true };
    }),

  unsubscribe: protectedProcedure
    .input(z.object({ pullRequestId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.pullRequestSubscription.deleteMany({
        where: {
          pullRequestId: input.pullRequestId,
          userId: ctx.session.user.id,
        },
      });
      return { subscribed: false };
    }),
});
