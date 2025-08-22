import config from "@incanta/config";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@checkpointvcs/app";
import superjson from "superjson";

export function CreateApiClient() {
  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${config.get<string>("checkpoint.api.url")}/api/trpc`,
        transformer: superjson,
        async headers() {
          return {
            // authorization: getAuthCookie(),
            // Authorization: `Bearer ${payload.apiToken}`,
            // "auth-provider": "auth0",
          };
        },
      }),
    ],
  });

  return client;
}
