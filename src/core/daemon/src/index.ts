import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { existsSync, promises as fs } from "fs";
import { homedir } from "os";
import path from "path";
import type { AppRouter } from "./api/index.js";
import { DaemonConfig } from "./daemon-config.js";

export type { AppRouter } from "./api/index.js";

export * from "./types/index.js";

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function CreateDaemonClient() {
  const port = (await DaemonConfig.Get()).daemonPort;

  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `http://127.0.0.1:${port}`,
        transformer: superjson,
      }),
    ],
  });

  return client;
}
