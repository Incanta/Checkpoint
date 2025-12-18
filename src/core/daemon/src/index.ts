import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { existsSync, promises as fs } from "fs";
import { homedir } from "os";
import path from "path";
import type { AppRouter } from "./api";

export type { AppRouter } from "./api";

export * from "./types";

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function CreateDaemonClient() {
  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `http://127.0.0.1:${await GetDaemonListenPort()}`,
        transformer: superjson,
      }),
    ],
  });

  return client;
}

export async function GetDaemonListenPort(): Promise<number> {
  let listenPort = 3010;
  const configFilePath = path.join(homedir(), ".checkpoint", "config.json");

  if (existsSync(configFilePath)) {
    try {
      const configStr = await fs.readFile(configFilePath, "utf-8");
      const config = JSON.parse(configStr);

      if (config.daemonPort) {
        listenPort = config.daemonPort;
      }
    } catch (e: any) {
      //
    }
  }

  return listenPort;
}
