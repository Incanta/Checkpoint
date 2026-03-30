import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { type Prisma, RepoAccess } from "@prisma/client";
import { getUserAndRepoWithAccess } from "../auth-utils";
import { recordActivity } from "../activity";
import {
  subscribeToIssue,
  notifyIssueSubscribers,
} from "~/server/notifications";

function issueLink(orgName: string, repoName: string, number: number) {
  return `/${orgName}/${repoName}/issues/${number}`;
}

export const issueRouter = createTRPCRouter({
  // ── Queries ─────────────────────────────────────────────────────

  list: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        status: z.enum(["OPEN", "CLOSED", "ALL"]).default("OPEN"),
        labelId: z.string().optional(),
        assigneeId: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const where: Prisma.IssueWhereInput = { repoId: input.repoId };
      if (input.status !== "ALL") where.status = input.status;
      if (input.labelId) {
        where.labels = { some: { labelId: input.labelId } };
      }
      if (input.assigneeId) {
        where.assignees = { some: { userId: input.assigneeId } };
      }

      return ctx.db.issue.findMany({
        where,
        include: {
          author: { select: { id: true, name: true, email: true, image: true } },
          labels: { include: { label: true } },
          assignees: {
            include: { user: { select: { id: true, name: true, email: true, image: true } } },
          },
          _count: { select: { comments: true } },
        },
        orderBy: { createdAt: "desc" },
      });
    }),

  get: protectedProcedure
    .input(z.object({ repoId: z.string(), number: z.number() }))
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const issue = await ctx.db.issue.findUnique({
        where: { repoId_number: { repoId: input.repoId, number: input.number } },
        include: {
          author: { select: { id: true, name: true, email: true, image: true } },
          comments: {
            include: {
              author: { select: { id: true, name: true, email: true, image: true } },
            },
            orderBy: { createdAt: "asc" },
          },
          labels: { include: { label: true } },
          assignees: {
            include: { user: { select: { id: true, name: true, email: true, image: true } } },
          },
        },
      });

      if (!issue) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Issue not found" });
      }

      return issue;
    }),

  countOpen: protectedProcedure
    .input(z.object({ repoId: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.db.issue.count({
        where: { repoId: input.repoId, status: "OPEN" },
      });
    }),

  // ── Label management ────────────────────────────────────────────

  listLabels: protectedProcedure
    .input(z.object({ repoId: z.string() }))
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);
      return ctx.db.issueLabel.findMany({
        where: { repoId: input.repoId },
        include: { _count: { select: { issues: true } } },
        orderBy: { name: "asc" },
      });
    }),

  createLabel: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        name: z.string().min(1).max(50),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#6366f1"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.WRITE);
      return ctx.db.issueLabel.create({
        data: { repoId: input.repoId, name: input.name, color: input.color },
      });
    }),

  updateLabel: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(50).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const label = await ctx.db.issueLabel.findUnique({ where: { id: input.id } });
      if (!label) throw new TRPCError({ code: "NOT_FOUND", message: "Label not found" });
      await getUserAndRepoWithAccess(ctx, label.repoId, RepoAccess.WRITE);
      return ctx.db.issueLabel.update({
        where: { id: input.id },
        data: { ...(input.name && { name: input.name }), ...(input.color && { color: input.color }) },
      });
    }),

  deleteLabel: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const label = await ctx.db.issueLabel.findUnique({ where: { id: input.id } });
      if (!label) throw new TRPCError({ code: "NOT_FOUND", message: "Label not found" });
      await getUserAndRepoWithAccess(ctx, label.repoId, RepoAccess.WRITE);
      await ctx.db.issueLabel.delete({ where: { id: input.id } });
      return { success: true };
    }),

  // ── Mutations ───────────────────────────────────────────────────

  create: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        title: z.string().min(1).max(256),
        body: z.string().default(""),
        labelIds: z.array(z.string()).default([]),
        assigneeIds: z.array(z.string()).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.WRITE);

      // Auto-increment issue number per repo
      const lastIssue = await ctx.db.issue.findFirst({
        where: { repoId: input.repoId },
        orderBy: { number: "desc" },
        select: { number: true },
      });
      const nextNumber = (lastIssue?.number ?? 0) + 1;

      const issue = await ctx.db.issue.create({
        data: {
          repoId: input.repoId,
          number: nextNumber,
          title: input.title,
          body: input.body,
          authorId: ctx.session.user.id,
          labels: input.labelIds.length > 0
            ? { create: input.labelIds.map((labelId) => ({ labelId })) }
            : undefined,
          assignees: input.assigneeIds.length > 0
            ? { create: input.assigneeIds.map((userId) => ({ userId })) }
            : undefined,
        },
        include: {
          author: { select: { id: true, name: true, email: true, image: true } },
          labels: { include: { label: true } },
          assignees: {
            include: { user: { select: { id: true, name: true, email: true, image: true } } },
          },
        },
      });

      await recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "write",
      });

      // Auto-subscribe author
      await subscribeToIssue(ctx.db, issue.id, ctx.session.user.id);
      // Auto-subscribe assignees
      for (const uid of input.assigneeIds) {
        await subscribeToIssue(ctx.db, issue.id, uid);
      }
      // Notify subscribers (mentions in body auto-subscribed)
      const link = issueLink(repo.org.name, repo.name, issue.number);
      void notifyIssueSubscribers({
        db: ctx.db,
        actorId: ctx.session.user.id,
        issueId: issue.id,
        type: "issue_created",
        title: `New issue #${issue.number}: ${issue.title}`,
        link,
        text: input.body,
      });

      return issue;
    }),

  update: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        number: z.number(),
        title: z.string().min(1).max(256).optional(),
        body: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.WRITE);

      const issue = await ctx.db.issue.findUnique({
        where: { repoId_number: { repoId: input.repoId, number: input.number } },
      });

      if (!issue) throw new TRPCError({ code: "NOT_FOUND", message: "Issue not found" });
      if (issue.authorId !== ctx.session.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the author can edit this issue" });
      }

      return ctx.db.issue.update({
        where: { id: issue.id },
        data: {
          ...(input.title !== undefined && { title: input.title }),
          ...(input.body !== undefined && { body: input.body }),
        },
      });
    }),

  close: protectedProcedure
    .input(z.object({ repoId: z.string(), number: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.WRITE);
      const issue = await ctx.db.issue.update({
        where: { repoId_number: { repoId: input.repoId, number: input.number } },
        data: { status: "CLOSED", closedAt: new Date() },
      });

      void notifyIssueSubscribers({
        db: ctx.db,
        actorId: ctx.session.user.id,
        issueId: issue.id,
        type: "issue_closed",
        title: `Issue #${issue.number} closed: ${issue.title}`,
        link: issueLink(repo.org.name, repo.name, issue.number),
      });

      return issue;
    }),

  reopen: protectedProcedure
    .input(z.object({ repoId: z.string(), number: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.WRITE);
      const issue = await ctx.db.issue.update({
        where: { repoId_number: { repoId: input.repoId, number: input.number } },
        data: { status: "OPEN", closedAt: null },
      });

      void notifyIssueSubscribers({
        db: ctx.db,
        actorId: ctx.session.user.id,
        issueId: issue.id,
        type: "issue_reopened",
        title: `Issue #${issue.number} reopened: ${issue.title}`,
        link: issueLink(repo.org.name, repo.name, issue.number),
      });

      return issue;
    }),

  // ── Comments ────────────────────────────────────────────────────

  addComment: protectedProcedure
    .input(z.object({ issueId: z.string(), body: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const issue = await ctx.db.issue.findUnique({
        where: { id: input.issueId },
        select: { id: true, number: true, title: true, repoId: true, repo: { select: { name: true, orgId: true, org: { select: { name: true } } } } },
      });
      if (!issue) throw new TRPCError({ code: "NOT_FOUND", message: "Issue not found" });
      await getUserAndRepoWithAccess(ctx, issue.repoId, RepoAccess.READ);

      const comment = await ctx.db.issueComment.create({
        data: {
          issueId: input.issueId,
          body: input.body,
          authorId: ctx.session.user.id,
        },
        include: {
          author: { select: { id: true, name: true, email: true, image: true } },
        },
      });

      await recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: issue.repo.orgId,
        type: "read",
      });

      // Auto-subscribe commenter
      await subscribeToIssue(ctx.db, issue.id, ctx.session.user.id);

      void notifyIssueSubscribers({
        db: ctx.db,
        actorId: ctx.session.user.id,
        issueId: issue.id,
        type: "issue_comment",
        title: `Comment on #${issue.number}: ${issue.title}`,
        body: input.body.slice(0, 200),
        link: issueLink(issue.repo.org.name, issue.repo.name, issue.number),
        text: input.body,
      });

      return comment;
    }),

  updateComment: protectedProcedure
    .input(z.object({ commentId: z.string(), body: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const comment = await ctx.db.issueComment.findUnique({ where: { id: input.commentId } });
      if (!comment) throw new TRPCError({ code: "NOT_FOUND", message: "Comment not found" });
      if (comment.authorId !== ctx.session.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the author can edit this comment" });
      }
      return ctx.db.issueComment.update({
        where: { id: input.commentId },
        data: { body: input.body },
        include: {
          author: { select: { id: true, name: true, email: true, image: true } },
        },
      });
    }),

  deleteComment: protectedProcedure
    .input(z.object({ commentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const comment = await ctx.db.issueComment.findUnique({ where: { id: input.commentId } });
      if (!comment) throw new TRPCError({ code: "NOT_FOUND", message: "Comment not found" });
      if (comment.authorId !== ctx.session.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the author can delete this comment" });
      }
      await ctx.db.issueComment.delete({ where: { id: input.commentId } });
      return { success: true };
    }),

  // ── Labels on issue ─────────────────────────────────────────────

  addLabelToIssue: protectedProcedure
    .input(z.object({ issueId: z.string(), labelId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const issue = await ctx.db.issue.findUnique({ where: { id: input.issueId }, select: { repoId: true } });
      if (!issue) throw new TRPCError({ code: "NOT_FOUND", message: "Issue not found" });
      await getUserAndRepoWithAccess(ctx, issue.repoId, RepoAccess.WRITE);
      return ctx.db.issueLabelLink.create({
        data: { issueId: input.issueId, labelId: input.labelId },
        include: { label: true },
      });
    }),

  removeLabelFromIssue: protectedProcedure
    .input(z.object({ issueId: z.string(), labelId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const issue = await ctx.db.issue.findUnique({ where: { id: input.issueId }, select: { repoId: true } });
      if (!issue) throw new TRPCError({ code: "NOT_FOUND", message: "Issue not found" });
      await getUserAndRepoWithAccess(ctx, issue.repoId, RepoAccess.WRITE);
      await ctx.db.issueLabelLink.delete({
        where: { issueId_labelId: { issueId: input.issueId, labelId: input.labelId } },
      });
      return { success: true };
    }),

  // ── Assignees ───────────────────────────────────────────────────

  addAssignee: protectedProcedure
    .input(z.object({ issueId: z.string(), userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const issue = await ctx.db.issue.findUnique({
        where: { id: input.issueId },
        select: { id: true, number: true, title: true, repoId: true, repo: { select: { name: true, org: { select: { name: true } } } } },
      });
      if (!issue) throw new TRPCError({ code: "NOT_FOUND", message: "Issue not found" });
      await getUserAndRepoWithAccess(ctx, issue.repoId, RepoAccess.WRITE);

      const result = await ctx.db.issueAssignee.create({
        data: { issueId: input.issueId, userId: input.userId },
        include: { user: { select: { id: true, name: true, email: true, image: true } } },
      });

      // Auto-subscribe assignee
      await subscribeToIssue(ctx.db, issue.id, input.userId);

      // Notify assignee directly
      if (input.userId !== ctx.session.user.id) {
        await ctx.db.notification.create({
          data: {
            userId: input.userId,
            actorId: ctx.session.user.id,
            type: "issue_assigned",
            title: `You were assigned to #${issue.number}: ${issue.title}`,
            link: issueLink(issue.repo.org.name, issue.repo.name, issue.number),
            issueId: issue.id,
          },
        });
      }

      return result;
    }),

  removeAssignee: protectedProcedure
    .input(z.object({ issueId: z.string(), userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const issue = await ctx.db.issue.findUnique({ where: { id: input.issueId }, select: { repoId: true } });
      if (!issue) throw new TRPCError({ code: "NOT_FOUND", message: "Issue not found" });
      await getUserAndRepoWithAccess(ctx, issue.repoId, RepoAccess.WRITE);
      await ctx.db.issueAssignee.delete({
        where: { issueId_userId: { issueId: input.issueId, userId: input.userId } },
      });
      return { success: true };
    }),

  // ── Subscriptions ──────────────────────────────────────────────

  isSubscribed: protectedProcedure
    .input(z.object({ issueId: z.string() }))
    .query(async ({ ctx, input }) => {
      const sub = await ctx.db.issueSubscription.findUnique({
        where: { issueId_userId: { issueId: input.issueId, userId: ctx.session.user.id } },
      });
      return !!sub;
    }),

  subscribe: protectedProcedure
    .input(z.object({ issueId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const issue = await ctx.db.issue.findUnique({ where: { id: input.issueId }, select: { repoId: true } });
      if (!issue) throw new TRPCError({ code: "NOT_FOUND", message: "Issue not found" });
      await getUserAndRepoWithAccess(ctx, issue.repoId, RepoAccess.READ);
      await subscribeToIssue(ctx.db, input.issueId, ctx.session.user.id);
      return { subscribed: true };
    }),

  unsubscribe: protectedProcedure
    .input(z.object({ issueId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.issueSubscription.deleteMany({
        where: { issueId: input.issueId, userId: ctx.session.user.id },
      });
      return { subscribed: false };
    }),
});
