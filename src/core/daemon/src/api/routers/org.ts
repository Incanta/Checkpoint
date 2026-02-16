import { publicProcedure, router } from "../trpc.js";
import { CreateApiClientAuth } from "@checkpointvcs/common";
import { z } from "zod";

export const orgRouter = router({
  list: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const client = await CreateApiClientAuth(input.daemonId);

      // TODO: figure out how to remove the any
      const orgs: any = await client.org.myOrgs.query();
      return { orgs };
    }),
});
