import { InitApi } from "./api/index.js";
import { DaemonManager } from "./daemon-manager.js";
import { DaemonConfig } from "./daemon-config.js";
import { getUpdater } from "./updater.js";
import { ApiVersionChecker } from "./api-version-checker.js";
import { McpManager } from "./mcp-server.js";

(async (): Promise<void> => {
  const manager = DaemonManager.Get();
  await manager.init();
  await InitApi();

  // Start the opt-in MCP server if enabled in daemon.json. A failure here
  // (e.g. port in use) is reported via mcp.getStatus and must not take the
  // daemon down.
  if ((await DaemonConfig.Get()).mcp?.enabled) {
    try {
      await McpManager.Get().start();
    } catch (e) {
      console.error("Failed to start MCP server:", e);
    }
  }

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
    await McpManager.Get().stop();
    await manager.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
})();
