import path from "path";
import { DaemonConfig } from "./daemon-config";
import { InitLogger, Logger } from "./logging";
import {
  FileStatus,
  FileType,
  type File,
  type Workspace,
  type WorkspacePendingChanges,
} from "./types";
import {
  watch,
  type FSWatcher,
  promises as fs,
  type Stats,
  existsSync,
} from "fs";
import { CreateApiClientAuth } from "@checkpointvcs/common";

interface WorkspaceFile {
  id: string;
  changelist: number;
  stat: Stats;
}

export class DaemonManager {
  private static instance: DaemonManager | null = null;

  /** The key for this map is the daemonId of the user */
  public workspaces: Map<string, Workspace[]> = new Map();
  public workspacesFiles: Map<string, Map<string, WorkspaceFile | null>> =
    new Map();
  public workspacePendingChanges: Map<string, WorkspacePendingChanges> =
    new Map();

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

  public async refreshWorkspaceContents(
    workspace: Workspace,
    initial: boolean = false,
  ): Promise<WorkspacePendingChanges> {
    const result: WorkspacePendingChanges = {
      numChanges: 0,
      files: {},
    };

    const files = await fs.readdir(workspace.localPath, {
      recursive: true,
      withFileTypes: true,
    });

    const client = await CreateApiClientAuth(workspace.daemonId);
    const checkouts = await client.file.getCheckouts.query({
      workspaceId: workspace.id,
    });

    let workspaceFiles = this.workspacesFiles.get(workspace.localPath);

    if (!workspaceFiles) {
      workspaceFiles = new Map();
      this.workspacesFiles.set(workspace.localPath, workspaceFiles);
    }

    const promises = files.map(async (f) => {
      if (f.isDirectory()) {
        return;
      }

      const fullPath = path.join(f.parentPath, f.name).replace(/\\/g, "/");

      const stat = await fs.lstat(fullPath);

      if (initial) {
        workspaceFiles.set(fullPath, {
          stat,
          id: "", // todo
          changelist: 0, // todo
        });
      } else {
        const originalStat = workspaceFiles.get(fullPath);

        if (
          !originalStat ||
          (originalStat &&
            (stat.mtimeMs > originalStat.stat.mtimeMs ||
              stat.size !== originalStat.stat.size))
        ) {
          const pendingFile: File = {
            path: fullPath,
            type: stat.isSymbolicLink() ? FileType.Symlink : FileType.Binary, // text is a client setting
            size: stat.size,
            modifiedAt: stat.mtimeMs,

            status:
              originalStat === undefined
                ? FileStatus.Local
                : originalStat === null
                  ? FileStatus.Added
                  : originalStat !== null &&
                      checkouts.findIndex(
                        (c) => c.fileId === originalStat.id,
                      ) !== -1
                    ? FileStatus.ChangedCheckedOut
                    : FileStatus.ChangedNotCheckedOut, // todo support checked out
            id: !originalStat ? null : originalStat?.id,
            changelist: !originalStat ? null : originalStat?.changelist,
          };
          result.files[fullPath] = pendingFile;
          result.numChanges++;
        }
      }
    });

    await Promise.all(promises);

    const fileIds = Object.values(result.files).map((f) => f.id);
    const unchangedCheckouts = checkouts.filter(
      (c) => !fileIds.includes(c.fileId),
    );

    for (const checkout of unchangedCheckouts) {
      if (existsSync(checkout.file.path)) {
        const stat = await fs.lstat(checkout.file.path);
        const pendingFile: File = {
          path: checkout.file.path,
          type: stat.isSymbolicLink() ? FileType.Symlink : FileType.Binary,
          size: stat.size,
          modifiedAt: stat.mtimeMs,

          status: FileStatus.NotChangedCheckedOut,
          id: checkout.fileId,
          changelist: 0, // todo
        };
        result.files[checkout.file.path] = pendingFile;
        result.numChanges++;
      }
    }

    this.workspacePendingChanges.set(workspace.id, result);

    return result;
  }

  public watchWorkspace(workspace: Workspace): void {
    const watcher = watch(
      workspace.localPath,
      { recursive: true },
      async (eventType, filename) => {
        Logger.debug(
          `[DaemonManager] Detected change in workspace ${workspace.name} (${eventType} on ${filename})`,
        );

        // TODO: do something with the changes (e.g. keeping track of modified files)
      },
    );

    this.watchers.push(watcher);
  }
}
