import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { IssuesPlatform, RepoAccess, type PrismaClient } from "@prisma/client";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { getUserAndRepoWithAccess } from "../auth-utils";
import { decryptSecret, encryptSecret } from "~/server/secret-encryption";
import {
  TrackerError,
  getAdapter,
  invalidateIssueCache,
  isExternalPlatform,
  listIssuesCached,
  type TrackerConfigWithSecret,
} from "~/server/issue-trackers";
import { buildIssueUrlTemplate } from "~/lib/issue-refs";

// Public (non-secret) config fields. The encrypted token is intentionally
// excluded everywhere; clients only ever learn whether one is stored.
const PUBLIC_CONFIG_SELECT = {
  jiraBaseUrl: true,
  jiraEmail: true,
  jiraProjectKey: true,
  codecksSubdomain: true,
  hacknplanProjectId: true,
} as const;

interface PublicConfig {
  platform: IssuesPlatform;
  jiraBaseUrl: string | null;
  jiraEmail: string | null;
  jiraProjectKey: string | null;
  codecksSubdomain: string | null;
  hacknplanProjectId: number | null;
  hasToken: boolean;
}

function toPublicConfig(
  platform: IssuesPlatform,
  config: {
    jiraBaseUrl: string | null;
    jiraEmail: string | null;
    jiraProjectKey: string | null;
    codecksSubdomain: string | null;
    hacknplanProjectId: number | null;
    encryptedToken?: string | null;
  } | null,
): PublicConfig {
  return {
    platform,
    jiraBaseUrl: config?.jiraBaseUrl ?? null,
    jiraEmail: config?.jiraEmail ?? null,
    jiraProjectKey: config?.jiraProjectKey ?? null,
    codecksSubdomain: config?.codecksSubdomain ?? null,
    hacknplanProjectId: config?.hacknplanProjectId ?? null,
    hasToken: !!config?.encryptedToken,
  };
}

function trackerErrorToTRPC(err: unknown): TRPCError {
  if (err instanceof TrackerError) {
    return new TRPCError({
      code:
        err.kind === "auth" || err.kind === "notFound"
          ? "PRECONDITION_FAILED"
          : "INTERNAL_SERVER_ERROR",
      message: err.message,
    });
  }
  if (err instanceof TRPCError) {
    return err;
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Failed to fetch issues from the configured issue tracker",
  });
}

async function loadConfigWithSecret(
  db: PrismaClient,
  repoId: string,
): Promise<TrackerConfigWithSecret> {
  const config = await db.repoIssueTrackerConfig.findUnique({
    where: { repoId },
  });

  if (!config?.encryptedToken) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "The issue tracker integration is not fully configured for this repository",
    });
  }

  let token: string;
  try {
    token = await decryptSecret(config.encryptedToken);
  } catch {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Stored issue tracker credentials could not be decrypted; re-enter the API token in repository settings",
    });
  }

  return { ...config, token };
}

export const issueTrackerRouter = createTRPCRouter({
  getConfig: protectedProcedure
    .input(z.object({ repoId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.ADMIN,
      );

      const config = await ctx.db.repoIssueTrackerConfig.findUnique({
        where: { repoId: input.repoId },
        select: { ...PUBLIC_CONFIG_SELECT, encryptedToken: true },
      });

      return toPublicConfig(repo.issuesPlatform, config);
    }),

  updateConfig: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        platform: z.nativeEnum(IssuesPlatform),
        jiraBaseUrl: z.string().url().optional(),
        jiraEmail: z.string().optional(),
        jiraProjectKey: z.string().optional(),
        codecksSubdomain: z.string().optional(),
        hacknplanProjectId: z.number().int().positive().optional(),
        // Omitted = keep the currently stored token (same platform only)
        token: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.ADMIN,
      );

      const existing = await ctx.db.repoIssueTrackerConfig.findUnique({
        where: { repoId: input.repoId },
        select: { encryptedToken: true },
      });

      // A stored token belongs to the previously configured platform; never
      // reuse it after a platform switch.
      const platformChanged = input.platform !== repo.issuesPlatform;
      const hasStoredToken = !!existing?.encryptedToken && !platformChanged;

      if (isExternalPlatform(input.platform)) {
        const error = getAdapter(input.platform).validateConfig(
          {
            jiraBaseUrl: input.jiraBaseUrl,
            jiraEmail: input.jiraEmail,
            jiraProjectKey: input.jiraProjectKey,
            codecksSubdomain: input.codecksSubdomain,
            hacknplanProjectId: input.hacknplanProjectId,
            token: input.token,
          } as Partial<TrackerConfigWithSecret>,
          hasStoredToken,
        );
        if (error) {
          throw new TRPCError({ code: "BAD_REQUEST", message: error });
        }
      }

      const encryptedToken = input.token
        ? await encryptSecret(input.token)
        : platformChanged
          ? null
          : undefined;

      const publicFields = {
        jiraBaseUrl: input.jiraBaseUrl ?? (platformChanged ? null : undefined),
        jiraEmail: input.jiraEmail ?? (platformChanged ? null : undefined),
        jiraProjectKey:
          input.jiraProjectKey ?? (platformChanged ? null : undefined),
        codecksSubdomain:
          input.codecksSubdomain ?? (platformChanged ? null : undefined),
        hacknplanProjectId:
          input.hacknplanProjectId ?? (platformChanged ? null : undefined),
      };

      const [, config] = await ctx.db.$transaction([
        ctx.db.repo.update({
          where: { id: input.repoId },
          data: { issuesPlatform: input.platform },
        }),
        ctx.db.repoIssueTrackerConfig.upsert({
          where: { repoId: input.repoId },
          create: {
            repoId: input.repoId,
            jiraBaseUrl: input.jiraBaseUrl ?? null,
            jiraEmail: input.jiraEmail ?? null,
            jiraProjectKey: input.jiraProjectKey ?? null,
            codecksSubdomain: input.codecksSubdomain ?? null,
            hacknplanProjectId: input.hacknplanProjectId ?? null,
            encryptedToken: encryptedToken ?? null,
          },
          update: {
            ...publicFields,
            encryptedToken,
          },
          select: { ...PUBLIC_CONFIG_SELECT, encryptedToken: true },
        }),
      ]);

      invalidateIssueCache(input.repoId);

      return toPublicConfig(input.platform, config);
    }),

  getLinkInfo: protectedProcedure
    .input(z.object({ repoId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.READ,
      );

      if (!isExternalPlatform(repo.issuesPlatform)) {
        return { platform: repo.issuesPlatform, issueUrlTemplate: null };
      }

      const config = await ctx.db.repoIssueTrackerConfig.findUnique({
        where: { repoId: input.repoId },
        select: PUBLIC_CONFIG_SELECT,
      });

      return {
        platform: repo.issuesPlatform,
        issueUrlTemplate: config
          ? buildIssueUrlTemplate(repo.issuesPlatform, config)
          : null,
      };
    }),

  listExternal: protectedProcedure
    .input(z.object({ repoId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.READ,
      );

      if (!isExternalPlatform(repo.issuesPlatform)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "This repository is not configured for an external issue tracker",
        });
      }

      const config = await loadConfigWithSecret(ctx.db, input.repoId);

      try {
        return await listIssuesCached(
          input.repoId,
          repo.issuesPlatform,
          config,
        );
      } catch (err) {
        throw trackerErrorToTRPC(err);
      }
    }),

  testConnection: protectedProcedure
    .input(z.object({ repoId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.ADMIN,
      );

      if (!isExternalPlatform(repo.issuesPlatform)) {
        return {
          ok: false,
          message: "This repository is not using an external issue tracker",
        };
      }

      try {
        const config = await loadConfigWithSecret(ctx.db, input.repoId);
        const issues = await getAdapter(repo.issuesPlatform).listIssues(config);
        return { ok: true, count: issues.length };
      } catch (err) {
        const trpcError = trackerErrorToTRPC(err);
        return { ok: false, message: trpcError.message };
      }
    }),
});
