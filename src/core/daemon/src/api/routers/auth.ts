import { publicProcedure, router } from "../trpc.js";
import {
  CreateApiClientAuth,
  CreateApiClientAuthManual,
  DeleteAuthToken,
  GetAllAuthConfigUsers,
  SaveAuthProfile,
  SaveAuthToken,
} from "@checkpointvcs/common";
import { z } from "zod";
import { User } from "../../types/index.js";
import { AuthenticateDevice } from "../../util/index.js";

export const authRouter = router({
  login: publicProcedure
    .input(
      z.object({
        endpoint: z.string(),
        daemonId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [code, url] = await new Promise<[string, string]>(
        (resolve, reject) =>
          AuthenticateDevice(input.endpoint, input.daemonId, (code, url) => {
            resolve([code, url]);
          }).catch((error) => {
            reject(error);
          }),
      );

      return { code, url };
    }),

  /**
   * Non-interactive login for headless/CI use. Validates the provided API
   * token against the endpoint, then persists it to ~/.checkpoint/auth.json
   * under the given daemonId. Tokens are minted in the web UI at
   * /settings/devices.
   */
  loginWithToken: publicProcedure
    .input(
      z.object({
        endpoint: z.string(),
        daemonId: z.string(),
        token: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await CreateApiClientAuthManual(
        input.endpoint,
        input.token,
      );

      let meResponse: User;
      try {
        meResponse = await client.user.me.query();
      } catch (e: any) {
        throw new Error("Invalid API token or endpoint");
      }

      await SaveAuthToken(input.daemonId, input.endpoint, input.token);

      return { user: meResponse };
    }),

  logout: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const users = await GetAllAuthConfigUsers();

      if (users[input.daemonId]) {
        await DeleteAuthToken(input.daemonId);
      }
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
      .map<
        Promise<
          | (User & {
              daemonId: string;
              endpoint: string;
              reachable: boolean;
            })
          | null
        >
      >(async ([daemonId, user]) => {
        const client = await CreateApiClientAuthManual(
          user.endpoint,
          user.apiToken!,
        );

        try {
          const meResponse = await client.user.me.query();

          // Cache the profile so a later launch can still render this account
          // (and route past the sign-in page) while the server is unreachable.
          await SaveAuthProfile(daemonId, {
            id: meResponse.id,
            email: meResponse.email,
            name: meResponse.name ?? null,
            username: meResponse.username ?? null,
            image: meResponse.image ?? null,
          });

          return {
            ...meResponse,
            daemonId,
            endpoint: user.endpoint,
            reachable: true,
          };
        } catch (e: any) {
          // The server is unreachable or the token was rejected. Don't drop the
          // account: it still exists locally, which is what the desktop app's
          // launch routing cares about. Fall back to the last cached profile so
          // the account can still be shown; if we've never reached the server,
          // surface a minimal placeholder so onboarding lands on the dashboard
          // rather than the sign-in page.
          const cached = user.profile;

          return {
            id: cached?.id ?? "",
            email: cached?.email ?? "",
            name: cached?.name ?? null,
            username: cached?.username ?? null,
            image: cached?.image ?? null,
            daemonId,
            endpoint: user.endpoint,
            reachable: false,
          } as User & {
            daemonId: string;
            endpoint: string;
            reachable: boolean;
          };
        }
      });

    const results = await Promise.all(promises);

    return {
      users: results.filter((r) => r !== null),
    };
  }),
});
