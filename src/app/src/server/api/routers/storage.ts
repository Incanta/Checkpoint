import config from "@incanta/config";
import { z } from "zod";
import njwt from "njwt";
import { storageSigningKey } from "~/server/storage-signing-key";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { getUserAndRepoWithAccess } from "../auth-utils";
import { recordActivity } from "../activity";
import { repoLongtailParams } from "~/server/longtail-params";
import {
  isR2Enabled,
  getR2Endpoint,
  createR2TempCredentials,
  getBucketUsageR2,
} from "~/server/r2-service";

/**
 * The storage protocol clients must speak. 3: submits ask the core server
 * which chunks exist (POST /existing-content) and upload a block map; the
 * repo-wide store.lsi is no longer written. A client that would still read
 * and merge store.lsi gets nothing it can use, so it is refused here, where
 * every storage access (gateway and r2 alike) starts. Mirrored in the daemon
 * (util/storage-options.ts STORAGE_PROTOCOL).
 */
export const MIN_STORAGE_PROTOCOL = 3;

export const storageRouter = createTRPCRouter({
  getToken: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        write: z.boolean(),
        /** The storage protocol the client speaks; absent means before 3. */
        clientProtocol: z.number().int().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      if ((input.clientProtocol ?? 0) < MIN_STORAGE_PROTOCOL) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `This Checkpoint client is too old for this server (storage protocol ${MIN_STORAGE_PROTOCOL}). Update Checkpoint.`,
        });
      }

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
        storageSigningKey(),
      );

      const expirationSeconds = config.get<number>(
        "storage.token-expiration-seconds",
      );

      token.setExpiration(Date.now() + expirationSeconds * 1000);

      const serverUrl = config.get<string>("storage.backend-url.external");
      // Optional LAN-only address; the daemon prefers it when the host is
      // HTTP-reachable, otherwise it falls back to serverUrl. Null when unset.
      const serverUrlLan =
        config.tryGet<string>("storage.backend-url.external-lan") ?? null;
      const expiration = Math.floor(Date.now() / 1000) + expirationSeconds;
      // What this repo's submits use, the same for every client.
      const longtail = await repoLongtailParams(ctx.db, repo);

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
          serverUrlLan,
          longtail,
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
        serverUrlLan,
        longtail,
        gatewayUrl: `${serverUrl}/storage`,
        gatewayUrlLan: serverUrlLan ? `${serverUrlLan}/storage` : null,
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
