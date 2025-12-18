import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter as ApiAppRouter } from "@checkpointvcs/app";
import superjson from "superjson";
import fs from "fs/promises";
import path from "path";
import os from "os";
import type { AuthConfig, AuthConfigUser } from "../types/auth-config";
import { existsSync } from "fs";

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function CreateApiClientUnauth(endpoint: string) {
  const client = createTRPCClient<ApiAppRouter>({
    links: [
      httpBatchLink({
        url: `${endpoint}/api/trpc`,
        transformer: superjson,
      }),
    ],
  });

  return client;
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function CreateApiClientAuthManual(
  endpoint: string,
  token: string,
) {
  const client = createTRPCClient<ApiAppRouter>({
    links: [
      httpBatchLink({
        url: `${endpoint}/api/trpc`,
        transformer: superjson,
        async headers() {
          return {
            Authorization: `Bearer ${token}`,
          };
        },
      }),
    ],
  });

  return client;
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function CreateApiClientAuth(daemonId: string) {
  let user: AuthConfigUser | null = null;
  try {
    user = await GetAuthConfigUser(daemonId);
  } catch (error) {
    //
  } finally {
    if (!user) {
      // eslint-disable-next-line no-unsafe-finally
      throw new Error(`Could not find a user under daemon ID ${daemonId}`);
    }

    if (!user.apiToken) {
      // eslint-disable-next-line no-unsafe-finally
      throw new Error(`Device isn't authorized yet.`);
    }
  }

  const client = createTRPCClient<ApiAppRouter>({
    links: [
      httpBatchLink({
        url: `${user.endpoint}/api/trpc`,
        transformer: superjson,
        async headers() {
          return {
            Authorization: `Bearer ${user.apiToken}`,
          };
        },
      }),
    ],
  });

  return client;
}

export async function SaveAuthToken(
  daemonId: string,
  endpoint: string,
  apiToken: string,
): Promise<void> {
  const authDir = path.join(os.homedir(), ".checkpoint");

  if (!existsSync(authDir)) {
    await fs.mkdir(authDir, { recursive: true });
  }

  const authFilePath = path.join(authDir, "auth.json");

  let authConfig: AuthConfig | null = null;

  if (existsSync(authFilePath)) {
    const authConfigStr = await fs.readFile(authFilePath, "utf-8");
    try {
      authConfig = JSON.parse(authConfigStr);
    } catch (e) {
      //
    }
  }

  if (authConfig === null) {
    authConfig = {
      users: {},
    };
  }

  authConfig.users[daemonId] = {
    endpoint,
    apiToken,
  };

  await fs.writeFile(authFilePath, JSON.stringify(authConfig, null, 2));
}

export async function DeleteAuthToken(daemonId: string): Promise<void> {
  const authFilePath = path.join(os.homedir(), ".checkpoint", "auth.json");

  let authConfig: AuthConfig | null = null;

  if (existsSync(authFilePath)) {
    const authConfigStr = await fs.readFile(authFilePath, "utf-8");
    try {
      authConfig = JSON.parse(authConfigStr);
    } catch (e) {
      //
    }
  }

  if (authConfig === null) {
    return;
  }

  delete authConfig.users[daemonId];

  await fs.writeFile(authFilePath, JSON.stringify(authConfig, null, 2));
}

export async function GetAllAuthConfigUsers(): Promise<
  Record<string, AuthConfigUser>
> {
  try {
    const authStr = await fs.readFile(
      path.join(os.homedir(), ".checkpoint", "auth.json"),
      "utf-8",
    );

    const auth: AuthConfig = JSON.parse(authStr);

    return auth.users || [];
  } catch (e) {
    //
  }

  return {};
}

export async function GetAuthConfigUser(
  daemonId: string,
): Promise<AuthConfigUser | null> {
  try {
    const authStr = await fs.readFile(
      path.join(os.homedir(), ".checkpoint", "auth.json"),
      "utf-8",
    );

    const auth: AuthConfig = JSON.parse(authStr);

    if (!auth.users) {
      return null;
    }

    const user = auth.users[daemonId];

    if (!user) {
      return null;
    }

    return user;
  } catch (e) {
    //
  }

  return null;
}
