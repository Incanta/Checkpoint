import { publicProcedure, router } from "../trpc";
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
});
