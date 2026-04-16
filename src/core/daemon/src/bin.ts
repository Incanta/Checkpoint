import { InitApi } from "./api/index.js";
import { DaemonManager } from "./daemon-manager.js";
import { getUpdater } from "./updater.js";
import { ApiVersionChecker } from "./api-version-checker.js";

(async (): Promise<void> => {
  const manager = DaemonManager.Get();
  await manager.init();
  await InitApi();

  // Start the auto-update checker after the API is ready
  const updater = getUpdater();
  updater.start();

  // Start the API version compatibility checker
  const versionChecker = ApiVersionChecker.Get();
  versionChecker.start();

  // Clean up updater on shutdown
  const shutdown = async (): Promise<void> => {
    updater.stop();
    versionChecker.stop();
    await manager.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
})();
