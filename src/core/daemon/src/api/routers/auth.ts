import { publicProcedure, router } from "../trpc.js";
import {
  CreateApiClientAuth,
  CreateApiClientAuthManual,
  DeleteAuthToken,
  GetAllAuthConfigUsers,
  GetAuthConfigUser,
  SaveAuthProfile,
  SaveAuthToken,
  UpdateAuthConfigUser,
} from "@checkpointvcs/common";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { User } from "../../types/index.js";
import { AuthenticateDevice } from "../../util/index.js";

/** Trims whitespace and trailing slashes, since the API path is appended. */
function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "");
}

/** An empty or whitespace-only label means "no label". */
function normalizeLabel(label: string | null | undefined) {
  if (label === undefined) return undefined;
  const trimmed = label?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

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
        label: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const endpoint = normalizeEndpoint(input.endpoint);
      const token = input.token.trim();
      const client = await CreateApiClientAuthManual(endpoint, token);

      let meResponse: User;
      try {
        meResponse = await client.user.me.query();
      } catch (e: any) {
        throw new Error("Invalid API token or endpoint");
      }

      await SaveAuthToken(input.daemonId, endpoint, token);

      const label = normalizeLabel(input.label);
      if (label !== undefined) {
        await UpdateAuthConfigUser(input.daemonId, { label });
      }

      return { user: meResponse };
    }),

  /**
   * Changes an existing account's settings: its server URL, API token, or
   * display label. A new URL or token is checked against the server first
   * (so a typo doesn't silently break the account) unless `skipValidation`
   * is set, which is for pointing an account at a server that's down right
   * now. Fields left out are kept.
   */
  updateUser: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        endpoint: z.string().min(1).optional(),
        token: z.string().min(1).optional(),
        label: z.string().nullable().optional(),
        skipValidation: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const existing = await GetAuthConfigUser(input.daemonId);
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No account under daemon ID ${input.daemonId}`,
        });
      }

      const endpoint =
        input.endpoint !== undefined
          ? normalizeEndpoint(input.endpoint)
          : undefined;
      const token = input.token !== undefined ? input.token.trim() : undefined;
      const label = normalizeLabel(input.label);

      const connectionChanged =
        (endpoint !== undefined && endpoint !== existing.endpoint) ||
        (token !== undefined && token !== existing.apiToken);

      let profile: User | undefined;
      if (connectionChanged && !input.skipValidation) {
        const nextEndpoint = endpoint ?? existing.endpoint;
        const nextToken = token ?? existing.apiToken;
        if (!nextToken) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "This account has no API token to check the server with.",
          });
        }

        try {
          const client = await CreateApiClientAuthManual(
            nextEndpoint,
            nextToken,
          );
          profile = await client.user.me.query();
        } catch (e: any) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Could not sign in to ${nextEndpoint} with ${
              token !== undefined ? "the new" : "this account's"
            } token: ${e?.message ?? "unknown error"}`,
          });
        }
      }

      const updated = await UpdateAuthConfigUser(input.daemonId, {
        endpoint,
        apiToken: token,
        label,
        profile: profile
          ? {
              id: profile.id,
              email: profile.email,
              name: profile.name ?? null,
              username: profile.username ?? null,
              image: profile.image ?? null,
            }
          : undefined,
      });

      return {
        daemonId: input.daemonId,
        endpoint: updated.endpoint,
        label: updated.label ?? null,
        validated: profile !== undefined,
      };
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
              label: string | null;
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
            label: user.label ?? null,
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
            label: user.label ?? null,
            reachable: false,
          } as User & {
            daemonId: string;
            endpoint: string;
            label: string | null;
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
