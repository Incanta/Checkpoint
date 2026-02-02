import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { CreateDaemonClient } from "@checkpointvcs/daemon";
import {
  CreateApiClientAuthManual,
  CreateApiClientUnauth,
  SaveAuthToken,
} from "@checkpointvcs/common";
import { v4 as uuidv4 } from "uuid";

export interface TestEnvironmentConfig {
  /**
   * Port for the Next.js app (default: 3000)
   */
  appPort?: number;

  /**
   * Port for the Bun server (default: 3001)
   */
  serverPort?: number;

  /**
   * Port for the daemon (default: 3010)
   */
  daemonPort?: number;
}

const DEFAULT_CONFIG: Required<TestEnvironmentConfig> = {
  appPort: 3000,
  serverPort: 3001,
  daemonPort: 3010,
};

export interface TestEnvironment {
  config: Required<TestEnvironmentConfig>;
  appUrl: string;
  serverUrl: string;
  daemonUrl: string;
  users: Array<{
    email: string;
    daemonId: string;
    apiClient: Awaited<ReturnType<typeof CreateApiClientAuthManual>>;
    daemonClient: Awaited<ReturnType<typeof CreateDaemonClient>>;
  }>;
}

/**
 * Create the test environment with clients connected to running services.
 * Services must already be running on the specified ports.
 */
export async function createTestEnvironment(
  userConfig: TestEnvironmentConfig = {},
): Promise<TestEnvironment> {
  const config = { ...DEFAULT_CONFIG, ...userConfig };

  const appUrl = `http://localhost:${config.appPort}`;
  const serverUrl = `http://localhost:${config.serverPort}`;
  const daemonUrl = `http://localhost:${config.daemonPort}`;

  const userNames = [
    `${uuidv4()}@example.com`,
    `${uuidv4()}@example.com`,
    `${uuidv4()}@example.com`,
  ];

  const users = [];
  for (const userName of userNames) {
    const unauth = await CreateApiClientUnauth(appUrl);
    const daemonId = uuidv4();

    const devLoginResponse = await unauth.auth.devLogin.mutate({
      email: userName,
      deviceCode: uuidv4(),
      tokenName: "test-token",
    });

    const apiClient = await CreateApiClientAuthManual(
      appUrl,
      devLoginResponse.apiToken,
    );

    // Save auth token so daemon can use it for this daemonId
    await SaveAuthToken(daemonId, appUrl, devLoginResponse.apiToken);

    // Create client for the daemon
    const daemonClient = await CreateDaemonClient();

    users.push({
      email: userName,
      daemonId,
      apiClient,
      daemonClient,
    });
  }

  return {
    config,
    appUrl,
    serverUrl,
    daemonUrl,
    users,
  };
}

/**
 * Get the default test environment (singleton for reuse across tests)
 */
let defaultEnv: TestEnvironment | null = null;

export async function getTestEnvironment(): Promise<TestEnvironment> {
  if (!defaultEnv) {
    defaultEnv = await createTestEnvironment();
  }
  return defaultEnv;
}
