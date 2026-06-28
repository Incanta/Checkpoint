import config from "@incanta/config";
import { z } from "zod";
import njwt from "njwt";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { getUserAndRepoWithAccess } from "../auth-utils";
import { recordActivity } from "../activity";
import {
  isR2Enabled,
  getR2Endpoint,
  createR2TempCredentials,
  getBucketUsageR2,
} from "~/server/r2-service";

export const storageRouter = createTRPCRouter({
  getToken: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        write: z.boolean(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        input.write ? "WRITE" : "READ",
      );

      // Record activity for billing (fire-and-forget)
      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: input.write ? "write" : "read",
      });

      const token = njwt.create(
        {
          iss: "checkpoint-vcs",
          sub: ctx.session.user.id,
          userId: ctx.session.user.id,
          orgId: repo.orgId,
          repoId: repo.id,
          mode: input.write ? "write" : "read",
          basePath: `/${repo.orgId}/${repo.id}`,
        },
        config.get<string>("storage.jwt.signing-key"),
      );

      const expirationSeconds = config.get<number>(
        "storage.token-expiration-seconds",
      );

      token.setExpiration(Date.now() + expirationSeconds * 1000);

      const serverUrl = config.get<string>("storage.backend-url.external");
      const expiration = Math.floor(Date.now() / 1000) + expirationSeconds;

      // R2: the client talks to R2 directly with scoped STS temp credentials.
      if (isR2Enabled()) {
        if (!repo.r2BucketName) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "R2 storage is enabled but repo does not have a bucket",
          });
        }

        const creds = await createR2TempCredentials(
          repo.r2BucketName,
          input.write ? "object-read-write" : "object-read-only",
          expirationSeconds,
        );

        return {
          kind: "r2" as const,
          token: token.compact(),
          expiration,
          serverUrl,
          r2: {
            accessKeyId: creds.accessKeyId,
            secretAccessKey: creds.secretAccessKey,
            sessionToken: creds.sessionToken,
            endpoint: getR2Endpoint(),
            bucket: repo.r2BucketName,
          },
        };
      }

      // Gateway modes (local / s3): the client talks to the core-server gateway
      // with the Checkpoint JWT; the server holds the backend credentials.
      return {
        kind: "gateway" as const,
        token: token.compact(),
        expiration,
        serverUrl,
        gatewayUrl: `${serverUrl}/storage`,
      };
    }),

  getRepoSize: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        "READ",
      );

      return { size: Number(repo.storageBytes) };
    }),

  // Called by the core server after a successful submit/merge to add that
  // submit's new content bytes to the repo's cached storage size.
  incrementRepoStorageBytes: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        bytes: z.number().int().nonnegative(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, "WRITE");
      if (input.bytes > 0) {
        await ctx.db.repo.update({
          where: { id: input.repoId },
          data: { storageBytes: { increment: BigInt(input.bytes) } },
        });
      }
      return { success: true };
    }),
});
