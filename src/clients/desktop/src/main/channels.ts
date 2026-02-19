import type {
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
} from "electron";
import { Directory, Modification, FileStatus } from "@checkpointvcs/daemon";

export interface FileContextInfo {
  /** Absolute path to the file/directory */
  absolutePath: string;
  /** Path relative to workspace root */
  relativePath: string;
  /** Whether this is a directory */
  isDirectory: boolean;
  /** The file status */
  status: FileStatus;
  /** Whether the file has a valid changelist */
  hasChangelist: boolean;
  /** The changelist ID if available */
  changelistId: number | null;
}

export type Channels = {
  "state:get": null;
  "atom:value": { key: string; value: any };

  "auth:login": { daemonId: string; endpoint: string };
  "auth:select-user": { daemonId: string };

  "set-renderer-url": { url: string };

  "workspace:create": {
    repoId: string;
    name: string;
    path: string;
    defaultBranchName: string;
  };
  "workspace:select": { id: string };
  "workspace:create-branch": {
    name: string;
    headNumber: number;
    type: "MAINLINE" | "RELEASE" | "FEATURE";
    parentBranchName: string | null;
  };
  "workspace:create-branch:success": null;
  "workspace:create-branch:error": { message: string };
  "workspace:select-branch": { name: string };
  "workspace:select-branch:success": { branchName: string };
  "workspace:select-branch:error": { message: string };
  "workspace:branches": null;
  "workspace:branches:data": null;
  "workspace:archive-branch": { branchName: string };
  "workspace:archive-branch:success": null;
  "workspace:archive-branch:error": { message: string };
  "workspace:unarchive-branch": { branchName: string };
  "workspace:unarchive-branch:success": null;
  "workspace:unarchive-branch:error": { message: string };
  "workspace:delete-branch": { branchName: string };
  "workspace:delete-branch:success": null;
  "workspace:delete-branch:error": { message: string };
  "workspace:merge-branch": { incomingBranchName: string };
  "workspace:merge-branch:success": { message: string };
  "workspace:merge-branch:error": { message: string };
  "workspace:get-directory": { path: string };
  "workspace:directory-contents": { path: string; directory: Directory };
  "workspace:configure": null;
  "workspace:refresh": null;
  "workspace:history": null;
  "workspace:history:view-changes": { changelistNumber: number };
  "workspace:history:select-file": { filePath: string };
  "workspace:history:close": null;
  "workspace:history:open-window": null;
  "workspace:pull": { changelistId: number | null; filePaths: string[] | null };
  "workspace:revert": { filePaths: string[] };
  "workspace:submit": {
    message: string;
    modifications: Modification[];
    shelved: boolean;
  };
  "workspace:submit:success": null;
  "workspace:submit:error": { message: string };
  "workspace:diff:file": { path: string };
  "workspace:create-label": { changelistNumber: number; name: string };
  "workspace:create-label:success": null;
  "workspace:create-label:error": { message: string };
  "workspace:labels": null;
  "workspace:labels:data": {
    labels: {
      id: string;
      name: string;
      number: number;
      repoId: string;
      changelist: {
        number: number;
        message: string | null;
        createdAt: string;
        user: { email: string; name: string | null } | null;
      };
    }[];
  };
  "workspace:labels:error": { message: string };
  "workspace:delete-label": { labelId: string };
  "workspace:delete-label:success": null;
  "workspace:delete-label:error": { message: string };
  "workspace:rename-label": { labelId: string; newName: string };
  "workspace:rename-label:success": null;
  "workspace:rename-label:error": { message: string };
  "workspace:change-label-changelist": { labelId: string; newNumber: number };
  "workspace:change-label-changelist:success": null;
  "workspace:change-label-changelist:error": { message: string };

  // Context menu file operations
  "file:open": { path: string };
  "file:open-with": { path: string };
  "file:open-in-explorer": { path: string };
  "file:history": { path: string };
  "file:history:select-changelist": { changelistNumber: number };
  "file:history:close": null;
  "file:history:open-window": null;
  "file:mark-as-added": { path: string };
  "file:mark-directory-as-added": { path: string };
  "file:checkout": { path: string; locked?: boolean; checkForLock?: boolean };
  "file:undo-checkout": { path: string };
  "file:checkout:locked-warning": { path: string; lockedBy: string };
  "file:checkout:error": { message: string };
  "file:add-to-ignored": { pattern: string };
  "file:remove-from-ignored": { pattern: string };
  "file:add-to-hidden": { pattern: string };
  "file:remove-from-hidden": { pattern: string };
  "file:copy-full-path": { path: string; useBackslashes: boolean };
  "file:copy-relative-path": { path: string; useBackslashes: boolean };
  "file:rename": { path: string; newName: string };
  "file:rename:prompt": { path: string };
  "file:rename:result": { success: boolean; newPath?: string; error?: string };
  "file:delete-to-trash": { path: string };
  "file:force-delete": { path: string };

  "dashboard:refresh": { daemonId: string | null; orgId: string | null };
  "dashboard:select-workspace-folder": null;

  // Sync status & preview
  "workspace:sync-status": null;
  "workspace:sync-status:refresh": null;
  "workspace:sync-preview": null;
  "workspace:sync-preview:select-file": { filePath: string };
  "workspace:sync-preview:close": null;
  "workspace:check-conflicts": null;
  "workspace:pull:conflict-error": { message: string; conflictPaths: string[] };
  "workspace:pull:merge-result": {
    cleanMerges: string[];
    conflictMerges: string[];
  };
  "workspace:submit:conflict-error": {
    message: string;
    conflictPaths: string[];
  };

  // Resolve conflicts
  "file:resolve-conflict": { paths: string[] };
  "file:resolve-conflict:success": { resolvedPaths: string[] };
  "file:resolve-conflict:error": { message: string };
  "workspace:resolve-confirm-suppressed": null;
  "workspace:set-resolve-confirm-suppressed": {
    duration: "today" | "workspace";
  };
};

export type InvokeChannels = {
  "popout:get-diff": {
    request: {
      filePath: string;
      changelistNumber: number;
      previousChangelistNumber: number | null;
    };
    response: { left: string; right: string } | null;
  };
};

export function ipcSend<T extends keyof Channels>(
  sender: WebContents,

  channel: T,
  data: Channels[T],
): void {
  sender.send(channel, data);
}

export function ipcOn<T extends keyof Channels>(
  ipcMain: IpcMain,
  channel: T,
  callback: (event: IpcMainEvent, data: Channels[T]) => void,
): void {
  ipcMain.on(channel, (event, data: Channels[T]) => {
    callback(event, data);
  });
}

export function ipcHandle<T extends keyof InvokeChannels>(
  ipcMain: IpcMain,
  channel: T,
  callback: (
    event: IpcMainInvokeEvent,
    data: InvokeChannels[T]["request"],
  ) => Promise<InvokeChannels[T]["response"]>,
): void {
  ipcMain.handle(channel, (event, data: InvokeChannels[T]["request"]) => {
    return callback(event, data);
  });
}
