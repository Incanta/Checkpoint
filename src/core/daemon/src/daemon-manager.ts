import { DaemonConfig } from "./daemon-config";
import { InitLogger, Logger } from "./logging";
import type { Workspace } from "./types/api-types";
import { watch, type FSWatcher } from "fs";

export class DaemonManager {
  private static instance: DaemonManager | null = null;

  /** The key for this map is the daemonId of the user */
  public workspaces: Map<string, Workspace[]> = new Map();

  private watchers: FSWatcher[] = [];

  private constructor() {
    //
  }

  public static Get(): DaemonManager {
    if (!DaemonManager.instance) {
      DaemonManager.instance = new DaemonManager();
    }
    return DaemonManager.instance;
  }

  public async init(): Promise<void> {
    await DaemonConfig.Load();

    const config = await DaemonConfig.Get();
    config.workspaces.forEach((workspace) => {
      const existing = this.workspaces.get(workspace.daemonId) || [];
      existing.push(workspace);
      this.workspaces.set(workspace.daemonId, existing);
      this.watchWorkspace(workspace);
    });

    await InitLogger();
  }

  public async shutdown(): Promise<void> {
    this.watchers.forEach((watcher) => watcher.close());
    this.watchers = [];
  }

  public watchWorkspace(workspace: Workspace): void {
    const watcher = watch(
      workspace.localPath,
      { recursive: true },
      (eventType, filename) => {
        Logger.debug(
          `[DaemonManager] Detected change in workspace ${workspace.name} (${eventType} on ${filename})`,
        );

        // TODO: do something with the changes (e.g. keeping track of modified files)
      },
    );

    this.watchers.push(watcher);
  }
}
