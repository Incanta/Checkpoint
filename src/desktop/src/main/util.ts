/* eslint import/prefer-default-export: off */
import { URL } from "url";
import path from "path";
import os from "os";
import fs from "fs";
import type { AppRouter } from "@checkpointvcs/daemon";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from 'superjson';

export function resolveHtmlPath(htmlFileName: string): string {
  if (process.env.NODE_ENV === "development") {
    const port = process.env.PORT || 1212;
    const url = new URL(`http://localhost:${port}`);
    url.pathname = htmlFileName;
    return url.href;
  }
  return `file://${path.resolve(__dirname, "../renderer/", htmlFileName)}`;
}

let daemonPort: number | null = null;

export function createDaemonClient() {
  const checkpointConfigPath = path.join(os.homedir(), ".checkpoint", "config.json");

  try {
    if (!fs.existsSync(checkpointConfigPath)) {
      throw new Error("Checkpoint config not found");
    }

    const checkpointConfigString = fs.readFileSync(checkpointConfigPath, "utf-8");
    const checkpointConfig = JSON.parse(checkpointConfigString);

    if (!checkpointConfig.daemonPort) {
      throw new Error("Daemon port not found in config");
    }

    daemonPort = checkpointConfig.daemonPort;
  } catch(e) {
    throw new Error(`Could not connect to Checkpoint daemon due to missing configuration; has it been installed/running?`);
  }

  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `http://127.0.0.1:${daemonPort}/api/trpc`,
        transformer: superjson,
      }),
    ],
  });

  return client;
}
