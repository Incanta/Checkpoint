import { publicProcedure, router } from "../trpc";
import { AuthenticateDevice } from "@checkpointvcs/client";
import {
  CreateApiClientAuth,
  CreateApiClientAuthManual,
  GetAllAuthConfigUsers,
} from "@checkpointvcs/common";
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
      const [code, url] = await new Promise<[string, string]>((resolve) =>
        AuthenticateDevice(input.endpoint, input.daemonId, (code, url) => {
          resolve([code, url]);
        }),
      );

      return { code, url };
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

  getUsers: publicProcedure.query(async () => {
    const users = await GetAllAuthConfigUsers();

    const promises = Object.entries(users)
      .filter(([, user]) => user.apiToken)
      .map<Promise<(User & { daemonId: string; endpoint: string }) | null>>(
        async ([daemonId, user]) => {
          const client = await CreateApiClientAuthManual(
            user.endpoint,
            user.apiToken!,
          );

          try {
            const meResponse = await client.user.me.query();

            return {
              ...meResponse,
              daemonId,
              endpoint: user.endpoint,
            };
          } catch (e: any) {
            return null;
          }
        },
      );

    const results = await Promise.all(promises);

    return {
      users: results.filter((r) => r !== null),
    };
  }),
});
