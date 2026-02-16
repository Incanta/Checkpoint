import { InitApi } from "./api/index.js";
import { DaemonManager } from "./daemon-manager.js";

(async (): Promise<void> => {
  const manager = DaemonManager.Get();
  await manager.init();
  await InitApi();
})();
