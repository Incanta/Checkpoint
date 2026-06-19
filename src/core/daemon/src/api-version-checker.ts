import {
  GetAllAuthConfigUsers,
  CreateApiClientAuth,
  checkApiVersionCompatibility,
  type VersionCheckResult,
  type AuthConfigUser,
} from "@checkpointvcs/common";
import { SERVER_API } from "./api-version.js";
import { Logger } from "./logging.js";

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface AppVersionStatus {
  endpoint: string;
  daemonId: string;
  result: VersionCheckResult;
  lastChecked: number;
}

// Polls every connected app server's version.current endpoint and records
// whether the daemon's expected SERVER_API still satisfies the server's
// minServerApi. The hard-block tRPC middleware reads these verdicts and
// returns FORBIDDEN if any one of them is `incompatible`.
export class ApiVersionChecker {
  private static instance: ApiVersionChecker | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private statuses: Map<string, AppVersionStatus> = new Map();

  private constructor() {}

  public static Get(): ApiVersionChecker {
    if (!ApiVersionChecker.instance) {
      ApiVersionChecker.instance = new ApiVersionChecker();
    }
    return ApiVersionChecker.instance;
  }

  public start(): void {
    Logger.info(
      `Starting API version checker (interval: ${CHECK_INTERVAL_MS / 1000}s, daemon's server_api: ${SERVER_API})`,
    );

    void this.checkAll();

    this.interval = setInterval(() => {
      void this.checkAll();
    }, CHECK_INTERVAL_MS);
  }

  public stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  public getStatuses(): AppVersionStatus[] {
    return Array.from(this.statuses.values());
  }

  private async checkAll(): Promise<void> {
    let users: Record<string, AuthConfigUser>;
    try {
      users = await GetAllAuthConfigUsers();
    } catch {
      return;
    }

    for (const [daemonId, user] of Object.entries(users)) {
      if (!user.apiToken) continue;

      try {
        const client = await CreateApiClientAuth(daemonId);
        const versionInfo = await client.version.current.query();

        const result = checkApiVersionCompatibility(SERVER_API, {
          current: versionInfo.serverApi,
          minimum: versionInfo.minServerApi,
        });

        const status: AppVersionStatus = {
          endpoint: user.endpoint,
          daemonId,
          result,
          lastChecked: Date.now(),
        };

        this.statuses.set(daemonId, status);

        if (result.status === "incompatible") {
          Logger.error(
            `Daemon below server's minServerApi at ${user.endpoint}: ${result.message}`,
          );
        } else {
          Logger.info(
            `Compatible with ${user.endpoint} (daemon server_api: ${SERVER_API}, server: ${versionInfo.serverApi})`,
          );
        }
      } catch (err) {
        Logger.warn(
          `Failed to check API version for ${user.endpoint}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
