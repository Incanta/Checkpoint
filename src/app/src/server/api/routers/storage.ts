import config from "@incanta/config";
import { z } from "zod";
import njwt from "njwt";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { getUserAndRepoWithAccess } from "../auth-utils";
import { recordActivity } from "../activity";

const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

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
        config.get<string>(
          "storage.signing-keys." + (input.write ? "write" : "read"),
        ),
      );

      token.setExpiration(
        Date.now() +
          config.get<number>("storage.token-expiration-seconds") * 1000,
      );

      return {
        storageType: "seaweedfs" as const,
        token: token.compact(),
        expiration:
          Math.floor(Date.now() / 1000) +
          config.get<number>("storage.token-expiration-seconds"),
        backendUrl: config.get<string>("storage.backend-url"),
        r2Credentials: null as {
          accessKeyId: string;
          secretAccessKey: string;
          sessionToken: string;
          endpoint: string;
          bucket: string;
        } | null,
      };
    }),

  getFilerToken: protectedProcedure.query(({ ctx }) => {
    if (!config.get<boolean>("storage.filer-ui-enabled")) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Filer UI is not enabled",
      });
    }

    const token = njwt.create(
      {
        iss: "checkpoint-vcs",
        sub: ctx.session.user.id,
        userId: ctx.session.user.id,
        mode: "read",
        basePath: "/",
      },
      config.get<string>("storage.signing-keys.read"),
    );

    token.setExpiration(Date.now() + ONE_MONTH_MS);

    return {
      token: token.compact(),
      filerUrl: config.get<string>("storage.filer-url"),
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
        config.get<string>("storage.signing-keys.read"),
      );

      token.setExpiration(
        Date.now() +
          config.get<number>("storage.token-expiration-seconds") * 1000,
      );

      const backendUrl = config.get<string>("storage.backend-url");

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
