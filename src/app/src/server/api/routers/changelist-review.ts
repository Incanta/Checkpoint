import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import {
  RepoAccess,
  type ChangelistVote,
  type PrismaClient,
} from "@prisma/client";
import { getUserAndRepoWithAccess } from "../auth-utils";
import { assertFeature } from "~/server/license-client";
import {
  notifyChangelistComment,
  notifyChangelistMarkedBad,
} from "~/server/team-sync/notifications";

const voteSchema = z.enum([
  "COMPILE_SUCCESS",
  "COMPILE_FAILURE",
  "GOOD",
  "BAD",
]);

async function upsertReview(
  db: PrismaClient,
  repoId: string,
  changelistNumber: number,
  userId: string,
  data: {
    vote?: ChangelistVote | null;
    starred?: boolean;
    investigating?: boolean;
    investigatingSince?: Date | null;
    resolvedAt?: Date | null;
  },
): Promise<void> {
  await db.changelistReview.upsert({
    where: {
      repoId_changelistNumber_userId: { repoId, changelistNumber, userId },
    },
    create: { repoId, changelistNumber, userId, ...data },
    update: data,
  });
}

export const changelistReviewRouter = createTRPCRouter({
  // Set (or clear with null) the current user's vote on a changelist.
  setVote: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumber: z.number(),
        vote: voteSchema.nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.READ,
      );
      await assertFeature(repo.orgId, "teamSync", ctx.db);

      await upsertReview(
        ctx.db,
        input.repoId,
        input.changelistNumber,
        ctx.session.user.id,
        { vote: input.vote },
      );

      if (input.vote === "BAD") {
        void notifyChangelistMarkedBad(ctx.db, {
          repoId: input.repoId,
          orgName: repo.org.name,
          repoName: repo.name,
          changelistNumber: input.changelistNumber,
          actorId: ctx.session.user.id,
        }).catch(() => undefined);
      }

      return { ok: true };
    }),

  setStarred: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumber: z.number(),
        starred: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.READ,
      );
      await assertFeature(repo.orgId, "teamSync", ctx.db);

      await upsertReview(
        ctx.db,
        input.repoId,
        input.changelistNumber,
        ctx.session.user.id,
        { starred: input.starred },
      );
      return { ok: true };
    }),

  setInvestigating: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumber: z.number(),
        investigating: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.READ,
      );
      await assertFeature(repo.orgId, "teamSync", ctx.db);

      const now = new Date();
      await upsertReview(
        ctx.db,
        input.repoId,
        input.changelistNumber,
        ctx.session.user.id,
        input.investigating
          ? { investigating: true, investigatingSince: now, resolvedAt: null }
          : { investigating: false, resolvedAt: now },
      );
      return { ok: true };
    }),

  addComment: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumber: z.number(),
        body: z.string().min(1).max(4000),
      }),
    )
    .output(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.READ,
      );
      await assertFeature(repo.orgId, "teamSync", ctx.db);

      const changelist = await ctx.db.changelist.findUnique({
        where: {
          repoId_number: {
            repoId: input.repoId,
            number: input.changelistNumber,
          },
        },
        select: { number: true },
      });
      if (!changelist) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Changelist ${input.changelistNumber} not found`,
        });
      }

      const comment = await ctx.db.changelistComment.create({
        data: {
          repoId: input.repoId,
          changelistNumber: input.changelistNumber,
          authorId: ctx.session.user.id,
          body: input.body,
        },
        select: { id: true },
      });

      void notifyChangelistComment(ctx.db, {
        repoId: input.repoId,
        orgName: repo.org.name,
        repoName: repo.name,
        changelistNumber: input.changelistNumber,
        actorId: ctx.session.user.id,
      }).catch(() => undefined);

      return { id: comment.id };
    }),

  listComments: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumber: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const comments = await ctx.db.changelistComment.findMany({
        where: {
          repoId: input.repoId,
          changelistNumber: input.changelistNumber,
        },
        orderBy: { createdAt: "asc" },
        include: {
          author: {
            select: {
              id: true,
              name: true,
              username: true,
              email: true,
              image: true,
            },
          },
        },
      });

      return comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        createdAt: comment.createdAt,
        author: comment.author,
      }));
    }),

  deleteComment: protectedProcedure
    .input(z.object({ repoId: z.string(), commentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const comment = await ctx.db.changelistComment.findUnique({
        where: { id: input.commentId },
        select: { authorId: true, repoId: true },
      });
      if (comment?.repoId !== input.repoId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Comment not found" });
      }
      if (comment.authorId !== ctx.session.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can only delete your own comments",
        });
      }

      await ctx.db.changelistComment.delete({ where: { id: input.commentId } });
      return { ok: true };
    }),
});
