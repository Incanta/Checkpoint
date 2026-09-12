import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Changelist } from "@prisma/client";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { FileChangeType, RepoAccess } from "@prisma/client";
import { getUserAndRepoWithAccess } from "../auth-utils";
import { recordActivity } from "../activity";
import { subscribeToMR, notifyMRSubscribers } from "~/server/notifications";
import { releaseClaimsForBranch } from "~/server/claims/claims";
import { settleClaimsForMerge } from "~/server/claims/landing";
import { restackChildren } from "~/server/claims/domain";
import {
  getStateTreePaths,
  buildStateTreeBlocks,
  primeStateTreePaths,
} from "~/server/state-tree";

function mrLink(orgName: string, repoName: string, number: number) {
  return `/${orgName}/${repoName}/merge-requests/${number}`;
}

export const mergeRequestRouter = createTRPCRouter({
  list: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        status: z.enum(["OPEN", "MERGED", "CLOSED", "ALL"]).default("OPEN"),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      return ctx.db.mergeRequest.findMany({
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

      const mr = await ctx.db.mergeRequest.findUnique({
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

      if (!mr) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Merge request not found",
        });
      }

      return mr;
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
          message: "Only feature branches can be used as merge request source",
        });
      }
      if (sourceBranch.parentBranchName !== targetBranch.name) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Source branch must target its parent branch",
        });
      }

      // Check no existing open MR for same source branch
      const existing = await ctx.db.mergeRequest.findFirst({
        where: {
          repoId: input.repoId,
          sourceBranchName: input.sourceBranchName,
          status: "OPEN",
        },
      });
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "An open merge request already exists for this branch",
        });
      }

      // Get next MR number
      const lastMr = await ctx.db.mergeRequest.findFirst({
        where: { repoId: input.repoId },
        orderBy: { number: "desc" },
      });
      const nextNumber = (lastMr?.number ?? 0) + 1;

      const mr = await ctx.db.mergeRequest.create({
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
      await subscribeToMR(ctx.db, mr.id, ctx.session.user.id);
      // Notify subscribers (mentions in description)
      const link = mrLink(repo.org.name, repo.name, mr.number);
      void notifyMRSubscribers({
        db: ctx.db,
        actorId: ctx.session.user.id,
        mergeRequestId: mr.id,
        type: "mr_created",
        title: `New MR #${mr.number}: ${mr.title}`,
        link,
        text: input.description,
      });

      return mr;
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

      const mr = await ctx.db.mergeRequest.findUnique({
        where: {
          repoId_number: { repoId: input.repoId, number: input.number },
        },
      });
      if (!mr)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Merge request not found",
        });
      if (mr.authorId !== ctx.session.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the author can edit this merge request",
        });
      }

      const updated = await ctx.db.mergeRequest.update({
        where: { id: mr.id },
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

      const mr = await ctx.db.mergeRequest.findUnique({
        where: {
          repoId_number: { repoId: input.repoId, number: input.number },
        },
      });
      if (!mr)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Merge request not found",
        });
      if (mr.status !== "OPEN")
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only open merge requests can be closed",
        });

      const updated = await ctx.db.mergeRequest.update({
        where: { id: mr.id },
        data: { status: "CLOSED", closedAt: new Date() },
      });

      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "write",
      });

      void notifyMRSubscribers({
        db: ctx.db,
        actorId: ctx.session.user.id,
        mergeRequestId: mr.id,
        type: "mr_closed",
        title: `MR #${mr.number} closed: ${mr.title}`,
        link: mrLink(repo.org.name, repo.name, mr.number),
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

      const mr = await ctx.db.mergeRequest.findUnique({
        where: {
          repoId_number: { repoId: input.repoId, number: input.number },
        },
      });
      if (!mr)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Merge request not found",
        });
      if (mr.status !== "CLOSED")
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only closed merge requests can be reopened",
        });

      const updated = await ctx.db.mergeRequest.update({
        where: { id: mr.id },
        data: { status: "OPEN", closedAt: null },
      });

      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "write",
      });

      void notifyMRSubscribers({
        db: ctx.db,
        actorId: ctx.session.user.id,
        mergeRequestId: mr.id,
        type: "mr_reopened",
        title: `MR #${mr.number} reopened: ${mr.title}`,
        link: mrLink(repo.org.name, repo.name, mr.number),
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

      const mr = await ctx.db.mergeRequest.findUnique({
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
      if (!mr)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Merge request not found",
        });
      if (mr.status !== "OPEN")
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only open merge requests can be merged",
        });

      // Check required reviews
      const approvedCount = mr.reviews.filter(
        (r) => r.state === "APPROVED",
      ).length;
      const hasRequestChanges = mr.reviews.some(
        (r) => r.state === "REQUEST_CHANGES",
      );
      if (hasRequestChanges) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot merge: there are outstanding change requests",
        });
      }
      if (approvedCount < mr.repo.requiredReviews) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot merge: ${approvedCount}/${mr.repo.requiredReviews} required approvals`,
        });
      }

      // Check merge permissions
      const targetBranch = await ctx.db.branch.findUnique({
        where: {
          repoId_name: { repoId: input.repoId, name: mr.targetBranchName },
        },
      });
      if (!targetBranch) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Target branch no longer exists",
        });
      }

      const permType = mr.repo.mergePermissionsSame
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
          repoId_name: { repoId: input.repoId, name: mr.sourceBranchName },
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

      const firstLine = `Merged ${mr.sourceBranchName} into ${mr.targetBranchName}`;
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

      const targetPaths = new Map(
        await getStateTreePaths(ctx.db, input.repoId, targetHead.number),
      );
      const incomingPaths = await getStateTreePaths(
        ctx.db,
        input.repoId,
        incomingHead.number,
      );
      for (const [path, clNum] of incomingPaths) {
        targetPaths.set(path, clNum);
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
          targetPaths.delete(fc.file.path);
        }
      }

      const lastCl = await ctx.db.changelist.findFirst({
        where: { repoId: input.repoId },
        orderBy: { number: "desc" },
      });
      const nextNumber = (lastCl?.number ?? -1) + 1;

      const stateRootHash = await buildStateTreeBlocks(
        ctx.db,
        input.repoId,
        targetPaths.entries(),
      );

      const mergeCl = await ctx.db.changelist.create({
        data: {
          number: nextNumber,
          message: mergeMessage,
          versionIndex: incomingHead.versionIndex,
          parentNumber: targetBranch.headNumber,
          stateRootHash,
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

      primeStateTreePaths(input.repoId, stateRootHash, targetPaths);

      // Update target branch head
      await ctx.db.branch.update({
        where: { id: targetBranch.id },
        data: { headNumber: nextNumber },
      });

      // Settle claims the merge carried: release when the target anchors its
      // own domain, advance onto the target when this was a stacked branch
      // merging one rung up.
      await settleClaimsForMerge(ctx.db, {
        repoId: input.repoId,
        incomingBranchName: mr.sourceBranchName,
        targetBranchName: mr.targetBranchName,
        mergeChangelistNumber: nextNumber,
        paths: fileChanges.map((fc) => fc.file.path),
        actor: { userId: ctx.session.user.id },
      });

      // Anything stacked on the merged branch re-parents to its parent, or the
      // stack deadlocks: a branch can only merge into its own parent.
      await restackChildren(ctx.db, {
        repoId: input.repoId,
        mergedBranchName: mr.sourceBranchName,
        newParentBranchName: mr.targetBranchName,
      });

      // Release claims taken on the source branch but never submitted.
      await releaseClaimsForBranch(ctx.db, input.repoId, mr.sourceBranchName, {
        userId: ctx.session.user.id,
      });

      // Delete source branch
      await ctx.db.branch.delete({
        where: { id: sourceBranch.id },
      });

      // Update MR status
      await ctx.db.mergeRequest.update({
        where: { id: mr.id },
        data: { status: "MERGED", mergedAt: new Date() },
      });

      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "write",
      });

      void notifyMRSubscribers({
        db: ctx.db,
        actorId: ctx.session.user.id,
        mergeRequestId: mr.id,
        type: "mr_merged",
        title: `MR #${mr.number} merged: ${mr.title}`,
        link: mrLink(repo.org.name, repo.name, mr.number),
      });

      return {
        mergeChangelist: { id: mergeCl.id, number: mergeCl.number },
        deletedBranch: mr.sourceBranchName,
      };
    }),

  addComment: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        mrNumber: z.number(),
        body: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.READ,
      );

      const mr = await ctx.db.mergeRequest.findUnique({
        where: {
          repoId_number: { repoId: input.repoId, number: input.mrNumber },
        },
      });
      if (!mr)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Merge request not found",
        });

      const comment = await ctx.db.mergeRequestComment.create({
        data: {
          body: input.body,
          mergeRequestId: mr.id,
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
      await subscribeToMR(ctx.db, mr.id, ctx.session.user.id);

      void notifyMRSubscribers({
        db: ctx.db,
        actorId: ctx.session.user.id,
        mergeRequestId: mr.id,
        type: "mr_comment",
        title: `Comment on MR #${mr.number}: ${mr.title}`,
        body: input.body.slice(0, 200),
        link: mrLink(repo.org.name, repo.name, mr.number),
        text: input.body,
      });

      return comment;
    }),

  deleteComment: protectedProcedure
    .input(z.object({ commentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const comment = await ctx.db.mergeRequestComment.findUnique({
        where: { id: input.commentId },
        include: { mergeRequest: { select: { repoId: true } } },
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

      await ctx.db.mergeRequestComment.delete({
        where: { id: input.commentId },
      });
      return { success: true };
    }),

  updateComment: protectedProcedure
    .input(z.object({ commentId: z.string(), body: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const comment = await ctx.db.mergeRequestComment.findUnique({
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

      return ctx.db.mergeRequestComment.update({
        where: { id: input.commentId },
        data: { body: input.body },
      });
    }),

  addReview: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        mrNumber: z.number(),
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

      const mr = await ctx.db.mergeRequest.findUnique({
        where: {
          repoId_number: { repoId: input.repoId, number: input.mrNumber },
        },
      });
      if (!mr)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Merge request not found",
        });
      if (mr.status !== "OPEN")
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot review a non-open merge request",
        });

      // Can't review your own MR
      if (input.reviewerId === mr.authorId && input.state !== "PENDING") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot approve or request changes on your own merge request",
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

      const review = await ctx.db.mergeRequestReview.upsert({
        where: {
          mergeRequestId_reviewerId: {
            mergeRequestId: mr.id,
            reviewerId: input.reviewerId,
          },
        },
        create: {
          mergeRequestId: mr.id,
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
      await subscribeToMR(ctx.db, mr.id, input.reviewerId);

      const link = mrLink(repo.org.name, repo.name, mr.number);
      if (input.state === "PENDING") {
        // Review requested: notify the reviewer
        if (input.reviewerId !== ctx.session.user.id) {
          await ctx.db.notification.create({
            data: {
              userId: input.reviewerId,
              actorId: ctx.session.user.id,
              type: "mr_review_requested",
              title: `Review requested on MR #${mr.number}: ${mr.title}`,
              link,
              mergeRequestId: mr.id,
            },
          });
        }
      } else {
        // Approved or changes requested: notify all subscribers
        const stateLabel =
          input.state === "APPROVED" ? "approved" : "requested changes on";
        void notifyMRSubscribers({
          db: ctx.db,
          actorId: ctx.session.user.id,
          mergeRequestId: mr.id,
          type:
            input.state === "APPROVED" ? "mr_approved" : "mr_changes_requested",
          title: `${review.reviewer.name ?? review.reviewer.email} ${stateLabel} MR #${mr.number}`,
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
        mrNumber: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const mr = await ctx.db.mergeRequest.findUnique({
        where: {
          repoId_number: { repoId: input.repoId, number: input.mrNumber },
        },
      });
      if (!mr)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Merge request not found",
        });

      const sourceBranch = await ctx.db.branch.findUnique({
        where: {
          repoId_name: { repoId: input.repoId, name: mr.sourceBranchName },
        },
      });
      const targetBranch = await ctx.db.branch.findUnique({
        where: {
          repoId_name: { repoId: input.repoId, name: mr.targetBranchName },
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
        mrNumber: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const mr = await ctx.db.mergeRequest.findUnique({
        where: {
          repoId_number: { repoId: input.repoId, number: input.mrNumber },
        },
      });
      if (!mr)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Merge request not found",
        });

      const sourceBranch = await ctx.db.branch.findUnique({
        where: {
          repoId_name: { repoId: input.repoId, name: mr.sourceBranchName },
        },
      });
      const targetBranch = await ctx.db.branch.findUnique({
        where: {
          repoId_name: { repoId: input.repoId, name: mr.targetBranchName },
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

  // Count open MRs for a repo (for tab badge)
  countOpen: protectedProcedure
    .input(z.object({ repoId: z.string() }))
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);
      return ctx.db.mergeRequest.count({
        where: { repoId: input.repoId, status: "OPEN" },
      });
    }),

  // ── Subscriptions ──────────────────────────────────────────────

  isSubscribed: protectedProcedure
    .input(z.object({ mergeRequestId: z.string() }))
    .query(async ({ ctx, input }) => {
      const sub = await ctx.db.mergeRequestSubscription.findUnique({
        where: {
          mergeRequestId_userId: {
            mergeRequestId: input.mergeRequestId,
            userId: ctx.session.user.id,
          },
        },
      });
      return !!sub;
    }),

  subscribe: protectedProcedure
    .input(z.object({ mergeRequestId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const mr = await ctx.db.mergeRequest.findUnique({
        where: { id: input.mergeRequestId },
        select: { repoId: true },
      });
      if (!mr)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Merge request not found",
        });
      await getUserAndRepoWithAccess(ctx, mr.repoId, RepoAccess.READ);
      await subscribeToMR(ctx.db, input.mergeRequestId, ctx.session.user.id);
      return { subscribed: true };
    }),

  unsubscribe: protectedProcedure
    .input(z.object({ mergeRequestId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.mergeRequestSubscription.deleteMany({
        where: {
          mergeRequestId: input.mergeRequestId,
          userId: ctx.session.user.id,
        },
      });
      return { subscribed: false };
    }),
});
