import { publicProcedure, router } from "../trpc";
import { AuthenticateDevice } from "@checkpointvcs/client";
import { CreateApiClientAuth } from "@checkpointvcs/common";
import { z } from "zod";
import type { User } from "daemon/src/types/api-types";

export const authRouter = router({
  login: publicProcedure
    .input(
      z.object({
        endpoint: z.string(),
        daemonId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const code = await new Promise<string>((resolve) =>
        AuthenticateDevice(input.endpoint, input.daemonId, (code) => {
          resolve(code);
        }),
      );

      return { code };
    }),

  getUser: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const client = await CreateApiClientAuth(input.daemonId);

      let meResponse: User;
      try {
        meResponse = await client.user.me.query();
      } catch (e: any) {
        throw new Error("Not logged in");
      }

      return { user: meResponse };
    }),
});
