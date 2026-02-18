import { publicProcedure, router } from "../trpc.js";
import { CreateApiClientAuth } from "@checkpointvcs/common";
import { z } from "zod";

export const repoRouter = router({
  list: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        orgId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const client = await CreateApiClientAuth(input.daemonId);

      const repos = await client.repo.list.query({
        orgId: input.orgId,
      });

      return { repos };
    }),

  create: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        orgId: z.string(),
        name: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const client = await CreateApiClientAuth(input.daemonId);

      const repo = await client.repo.createRepo.mutate({
        orgId: input.orgId,
        name: input.name,
      });

      return { repo };
    }),
});
