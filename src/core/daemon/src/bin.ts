import { InitApi } from "./api/index.js";
import { DaemonManager } from "./daemon-manager.js";
import { getUpdater } from "./updater.js";

(async (): Promise<void> => {
  const manager = DaemonManager.Get();
  await manager.init();
  await InitApi();

  // Start the auto-update checker after the API is ready
  const updater = getUpdater();
  updater.start();

  // Clean up updater on shutdown
  const shutdown = async (): Promise<void> => {
    updater.stop();
    await manager.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
})();
