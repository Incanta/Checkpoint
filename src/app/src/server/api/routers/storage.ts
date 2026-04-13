import config from "@incanta/config";
import { z } from "zod";
import njwt from "njwt";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { getUserAndRepoWithAccess } from "../auth-utils";
import { recordActivity } from "../activity";

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

      return {
        storageType: "seaweedfs" as "seaweedfs" | "r2",
        token: token.compact(),
        expiration: Math.floor(Date.now() / 1000) + expirationSeconds,
        backendUrl: config.get<string>("storage.backend-url.external"),
        r2Credentials: null as {
          accessKeyId: string;
          secretAccessKey: string;
          sessionToken: string;
          endpoint: string;
          bucket: string;
        } | null,
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

      const token = njwt.create(
        {
          iss: "checkpoint-vcs",
          sub: ctx.session.user.id,
          userId: ctx.session.user.id,
          orgId: repo.orgId,
          repoId: repo.id,
          mode: "read",
          basePath: `/${repo.orgId}/${repo.id}`,
        },
        config.get<string>("storage.jwt.signing-key"),
      );

      token.setExpiration(
        Date.now() +
          config.get<number>("storage.token-expiration-seconds") * 1000,
      );

      const backendUrl = config.get<string>("storage.backend-url.internal");

      const response = await fetch(`${backendUrl}/repo-size`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token.compact()}`,
        },
      });

      if (!response.ok) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to fetch repo size",
        });
      }

      const data = (await response.json()) as { size: number };
      return { size: data.size };
    }),
});
