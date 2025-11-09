import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { promises as fs } from "fs";
import { homedir } from "os";
import path from "path";
import type { AppRouter } from "./api";

export type { AppRouter } from "./api";

export async function CreateDaemonClient() {
  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `http://127.0.0.1:${await GetDaemonListenPort()}/api/trpc`,
        transformer: superjson,
      }),
    ],
  });

  return client;
}

export async function GetDaemonListenPort(): Promise<number> {
  let listenPort = 3000;
  const configFilePath = path.join(homedir(), ".checkpoint", "config.json");

  if (await fs.exists(configFilePath)) {
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
