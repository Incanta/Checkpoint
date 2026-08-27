import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { RepoAccess, type BuildBadgeState } from "@prisma/client";
import { getUserAndRepoWithAccess } from "../auth-utils";
import { assertFeature } from "~/server/license-client";
import { getTeamSyncConfig } from "~/server/team-sync/config";
import { classifyPaths } from "~/server/team-sync/classify";

export type ChangelistVerdict = "good" | "bad" | "mixed" | null;

export interface ChangelistReviewSummary {
  verdict: ChangelistVerdict;
  goodVotes: number;
  badVotes: number;
  compileSuccesses: number;
  compileFailures: number;
  myReview: {
    vote: string | null;
    starred: boolean;
    investigating: boolean;
  } | null;
  starCount: number;
  investigators: {
    userId: string;
    name: string | null;
    username: string | null;
  }[];
  commentCount: number;
  lastComment: {
    authorName: string | null;
    body: string;
    createdAt: Date;
  } | null;
}

export interface ChangelistMeta {
  badges: {
    name: string;
    group: string | null;
    state: BuildBadgeState;
    url: string | null;
    updatedAt: Date;
  }[];
  reviews: ChangelistReviewSummary;
  syncedUsers: {
    userId: string;
    name: string | null;
    username: string | null;
    workspaceName: string;
  }[];
  artifactTypes: string[];
  hasCodeChanges: boolean;
  hasContentChanges: boolean;
}

function emptyReviewSummary(): ChangelistReviewSummary {
  return {
    verdict: null,
    goodVotes: 0,
    badVotes: 0,
    compileSuccesses: 0,
    compileFailures: 0,
    myReview: null,
    starCount: 0,
    investigators: [],
    commentCount: 0,
    lastComment: null,
  };
}

export const teamSyncRouter = createTRPCRouter({
  // Parsed + validated repo-committed Team Sync config
  // (`.checkpoint/teamsync.yaml`) as resolved at a changelist (default: the
  // default branch's head).
  getConfig: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumber: z.number().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.READ,
      );

      let changelistNumber = input.changelistNumber;
      if (changelistNumber === undefined) {
        const defaultBranch = await ctx.db.branch.findFirst({
          where: { repoId: input.repoId, isDefault: true },
        });

        if (!defaultBranch) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Repo has no default branch",
          });
        }

        changelistNumber = defaultBranch.headNumber;
      }

      return getTeamSyncConfig(
        ctx.db,
        ctx.session.user.id,
        repo,
        changelistNumber,
      );
    }),

  // The changelist browser's single per-page metadata round trip: badges,
  // review/vote summaries, presence, exactly-attached artifact types, and
  // code/content classification for a page of changelists.
  getChangelistMeta: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumbers: z.array(z.number()).min(1).max(250),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.READ,
      );
      await assertFeature(repo.orgId, "teamSync", ctx.db);

      const numbers = [...new Set(input.changelistNumbers)];
      const userId = ctx.session.user.id;

      const [badges, reviews, commentCounts, lastComments, syncedWorkspaces, artifactSets] =
        await Promise.all([
          ctx.db.buildBadge.findMany({
            where: { repoId: input.repoId, changelistNumber: { in: numbers } },
            select: {
              changelistNumber: true,
              name: true,
              group: true,
              state: true,
              url: true,
              updatedAt: true,
            },
          }),
          ctx.db.changelistReview.findMany({
            where: { repoId: input.repoId, changelistNumber: { in: numbers } },
            include: {
              user: { select: { id: true, name: true, username: true } },
            },
          }),
          ctx.db.changelistComment.groupBy({
            by: ["changelistNumber"],
            where: { repoId: input.repoId, changelistNumber: { in: numbers } },
            _count: { _all: true },
          }),
          ctx.db.changelistComment.findMany({
            where: { repoId: input.repoId, changelistNumber: { in: numbers } },
            orderBy: { createdAt: "desc" },
            distinct: ["changelistNumber"],
            include: {
              author: { select: { name: true, username: true } },
            },
          }),
          ctx.db.workspace.findMany({
            where: {
              repoId: input.repoId,
              deletedAt: null,
              syncedChangelistNumber: { in: numbers },
            },
            include: {
              user: { select: { id: true, name: true, username: true } },
            },
          }),
          ctx.db.artifactSet.findMany({
            where: { repoId: input.repoId, changelistNumber: { in: numbers } },
            select: { changelistNumber: true, type: true },
          }),
        ]);

      const classification = await classifyChangelists(
        ctx,
        repo,
        input.repoId,
        numbers,
      );

      const result: Record<string, ChangelistMeta> = {};
      for (const number of numbers) {
        result[String(number)] = {
          badges: [],
          reviews: emptyReviewSummary(),
          syncedUsers: [],
          artifactTypes: [],
          hasCodeChanges: classification.get(number)?.hasCodeChanges ?? false,
          hasContentChanges:
            classification.get(number)?.hasContentChanges ?? false,
        };
      }

      for (const badge of badges) {
        result[String(badge.changelistNumber)]?.badges.push({
          name: badge.name,
          group: badge.group,
          state: badge.state,
          url: badge.url,
          updatedAt: badge.updatedAt,
        });
      }

      for (const review of reviews) {
        const summary = result[String(review.changelistNumber)]?.reviews;
        if (!summary) continue;

        switch (review.vote) {
          case "GOOD":
            summary.goodVotes++;
            break;
          case "BAD":
            summary.badVotes++;
            break;
          case "COMPILE_SUCCESS":
            summary.compileSuccesses++;
            break;
          case "COMPILE_FAILURE":
            summary.compileFailures++;
            break;
          case null:
            break;
        }

        if (review.starred) {
          summary.starCount++;
        }

        if (review.investigating) {
          summary.investigators.push({
            userId: review.user.id,
            name: review.user.name,
            username: review.user.username,
          });
        }

        if (review.userId === userId) {
          summary.myReview = {
            vote: review.vote,
            starred: review.starred,
            investigating: review.investigating,
          };
        }
      }

      for (const meta of Object.values(result)) {
        const summary = meta.reviews;
        if (summary.goodVotes > 0 && summary.badVotes > 0) {
          summary.verdict = "mixed";
        } else if (summary.goodVotes > 0) {
          summary.verdict = "good";
        } else if (summary.badVotes > 0) {
          summary.verdict = "bad";
        }
      }

      for (const count of commentCounts) {
        const summary = result[String(count.changelistNumber)]?.reviews;
        if (summary) {
          summary.commentCount = count._count._all;
        }
      }

      for (const comment of lastComments) {
        const summary = result[String(comment.changelistNumber)]?.reviews;
        if (summary) {
          summary.lastComment = {
            authorName: comment.author.name ?? comment.author.username,
            body: comment.body,
            createdAt: comment.createdAt,
          };
        }
      }

      for (const workspace of syncedWorkspaces) {
        result[String(workspace.syncedChangelistNumber)]?.syncedUsers.push({
          userId: workspace.user.id,
          name: workspace.user.name,
          username: workspace.user.username,
          workspaceName: workspace.name,
        });
      }

      for (const set of artifactSets) {
        result[String(set.changelistNumber)]?.artifactTypes.push(set.type);
      }

      return result;
    }),
});

type TeamSyncContext = Parameters<
  Parameters<typeof protectedProcedure.query>[0]
>[0]["ctx"];

async function classifyChangelists(
  ctx: TeamSyncContext,
  repo: { id: string; orgId: string; r2BucketName: string | null },
  repoId: string,
  numbers: number[],
): Promise<Map<number, { hasCodeChanges: boolean; hasContentChanges: boolean }>> {
  const classification = new Map<
    number,
    { hasCodeChanges: boolean; hasContentChanges: boolean }
  >();

  // codeExtensions override: classify the whole page per-request without
  // persisting (materialized flags could disagree with the override).
  const maxNumber = Math.max(...numbers);
  const configResult = await getTeamSyncConfig(
    ctx.db,
    ctx.session.user.id,
    repo,
    maxNumber,
  ).catch(() => null);
  const codeExtensions = configResult?.config?.codeExtensions;

  const rows = await ctx.db.changelist.findMany({
    where: { repoId, number: { in: numbers } },
    select: { number: true, hasCodeChanges: true, hasContentChanges: true },
  });

  const toCompute: number[] = [];
  for (const row of rows) {
    if (
      codeExtensions === undefined &&
      row.hasCodeChanges !== null &&
      row.hasContentChanges !== null
    ) {
      classification.set(row.number, {
        hasCodeChanges: row.hasCodeChanges,
        hasContentChanges: row.hasContentChanges,
      });
    } else {
      toCompute.push(row.number);
    }
  }

  if (toCompute.length === 0) {
    return classification;
  }

  const fileChanges = await ctx.db.fileChange.findMany({
    where: { repoId, changelistNumber: { in: toCompute } },
    select: {
      changelistNumber: true,
      file: { select: { path: true } },
    },
  });

  const pathsByNumber = new Map<number, string[]>();
  for (const change of fileChanges) {
    (pathsByNumber.get(change.changelistNumber) ??
      pathsByNumber
        .set(change.changelistNumber, [])
        .get(change.changelistNumber)!).push(change.file.path);
  }

  for (const number of toCompute) {
    classification.set(
      number,
      classifyPaths(pathsByNumber.get(number) ?? [], codeExtensions),
    );
  }

  // Materialize the default-extension classification for future pages.
  if (codeExtensions === undefined) {
    const groups = new Map<string, number[]>();
    for (const number of toCompute) {
      const flags = classification.get(number)!;
      const key = `${flags.hasCodeChanges}:${flags.hasContentChanges}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(number);
    }

    await Promise.all(
      [...groups.entries()].map(([key, groupNumbers]) => {
        const [code, content] = key.split(":");
        return ctx.db.changelist.updateMany({
          where: { repoId, number: { in: groupNumbers } },
          data: {
            hasCodeChanges: code === "true",
            hasContentChanges: content === "true",
          },
        });
      }),
    );
  }

  return classification;
}
