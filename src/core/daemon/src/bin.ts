import { InitApi } from "./api";
import { DaemonManager } from "./daemon-manager";

const manager = DaemonManager.Get();
await manager.init();
await InitApi();
