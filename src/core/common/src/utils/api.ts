import config from "@incanta/config";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@checkpointvcs/app";
import superjson from "superjson";
import fs from "fs/promises";
import path from "path";
import os from "os";

export async function CreateApiClient() {
  let apiToken: string | null = null;
  try {
    apiToken = await GetAuthToken();
  } catch (error) {
    // Handle error (e.g., file not found, invalid JSON)
  }

  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${config.get<string>("checkpoint.host")}/api/trpc`,
        transformer: superjson,
        async headers() {
          return {
            Authorization: apiToken ? `Bearer ${apiToken}` : undefined,
          };
        },
      }),
    ],
  });

  return client;
}

export async function SaveAuthToken(apiToken: string): Promise<void> {
  const authDir = path.join(os.homedir(), ".checkpoint");
  await fs.mkdir(authDir, { recursive: true });
  const authFilePath = path.join(authDir, "auth.json");
  await fs.writeFile(authFilePath, JSON.stringify({ apiToken }));
}

export async function GetAuthToken(): Promise<string | null> {
  try {
    const auth = await fs.readFile(
      path.join(os.homedir(), ".checkpoint", "auth.json"),
      "utf-8"
    );
    return JSON.parse(auth).apiToken;
  } catch (e) {
    //
  }

  return null;
}
