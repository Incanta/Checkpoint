import {
  GetAllAuthConfigUsers,
  CreateApiClientAuth,
  type ApiVersionInfo,
  checkVersionCompatibility,
  type VersionCheckResult,
  type AuthConfigUser,
} from "@checkpointvcs/common";
import { DAEMON_APP_API_VERSION } from "./api-version.js";
import { Logger } from "./logging.js";

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface AppVersionStatus {
  endpoint: string;
  daemonId: string;
  result: VersionCheckResult;
  lastChecked: number;
}

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
      `Starting API version checker (interval: ${CHECK_INTERVAL_MS / 1000}s, daemon app API version: ${DAEMON_APP_API_VERSION})`,
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

        const remoteVersion: ApiVersionInfo = {
          currentVersion: versionInfo.apiVersion,
          minimumVersion: versionInfo.minimumDaemonVersion,
          recommendedVersion: versionInfo.recommendedDaemonVersion,
        };

        const result = checkVersionCompatibility(
          DAEMON_APP_API_VERSION,
          remoteVersion,
        );

        const status: AppVersionStatus = {
          endpoint: user.endpoint,
          daemonId,
          result,
          lastChecked: Date.now(),
        };

        this.statuses.set(daemonId, status);

        if (result.status === "incompatible") {
          Logger.error(
            `API version incompatible with ${user.endpoint}: ${result.message}`,
          );
        } else if (result.status === "warning") {
          Logger.warn(
            `API version warning for ${user.endpoint}: ${result.message}`,
          );
        } else {
          Logger.info(
            `API version compatible with ${user.endpoint} (daemon: ${DAEMON_APP_API_VERSION}, app: ${versionInfo.apiVersion})`,
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
