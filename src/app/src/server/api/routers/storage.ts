import config from "@incanta/config";
import { z } from "zod";
import njwt from "njwt";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { getUserAndRepoWithAccess } from "../auth-utils";

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
        token: token.compact(),
        expiration:
          Math.floor(Date.now() / 1000) +
          config.get<number>("storage.token-expiration-seconds"),
        backendUrl: config.get<string>("storage.backend-url"),
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
});
