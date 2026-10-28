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

  // Open a URL in the user's default browser.
  "app:open-external": { url: string };

  "auth:login": { daemonId: string; endpoint: string };
  // Re-query the daemon for the known users and their reachability. Used by the
  // "server unreachable" banner's retry button.
  "auth:recheck": null;
  "auth:logout": { daemonId: string };
  "auth:logout:success": null;
  "auth:logout:error": { message: string };
  "auth:select-user": { daemonId: string };

  "set-renderer-url": { url: string };

  "workspace:create": {
    repoId: string;
    name: string;
    path: string;
    defaultBranchName: string;
  };
  "workspace:select": { id: string };
  "workspace:unlink": { workspaceId: string };
  "workspace:unlink:success": { workspaceId: string };
  "workspace:unlink:error": { message: string };
  "workspace:create-branch": {
    name: string;
    headNumber: number;
    type: "MAINLINE" | "RELEASE" | "FEATURE";
    parentBranchName: string | null;
  };
  "workspace:create-branch:success": null;
  "workspace:create-branch:error": { message: string };
  "workspace:select-branch": { name: string };
  "workspace:select-branch:success": {
    branchName: string;
    domainBranchName: string;
    activeBranches: string[];
  };
  "workspace:select-branch:error": { message: string };
  "workspace:branches": null;
  "workspace:branches:data": null;
  "workspace:archive-branch": { branchName: string };
  "workspace:archive-branch:success": null;
  "workspace:archive-branch:error": { message: string };
  "workspace:unarchive-branch": { branchName: string };
  "workspace:unarchive-branch:success": null;
  "workspace:unarchive-branch:error": { message: string };
  "workspace:delete-branch": {
    branchName: string;
    /** Discard changelists the parent never got (asked for after a refusal). */
    discardUnmerged?: boolean;
  };
  "workspace:delete-branch:success": null;
  "workspace:delete-branch:error": { message: string };
  "workspace:merge-branch": { incomingBranchName: string };
  /**
   * Brings a feature branch's parent into it. With resolvedInLatest, the
   * branch's latest changelist resolves the conflicts the last try listed.
   */
  "workspace:update-branch": { branchName: string; resolvedInLatest?: boolean };
  "workspace:update-branch:success": { message: string };
  "workspace:update-branch:error": { message: string; conflicts: boolean };
  "workspace:merge-branch:success": { message: string };
  "workspace:merge-branch:error": { message: string };
  "workspace:get-directory": { path: string };
  "workspace:directory-contents": { path: string; directory: Directory };
  "workspace:get-directory-pending": { path: string };
  "workspace:directory-pending-contents": {
    path: string;
    directory: Directory;
  };
  "workspace:configure": null;
  "workspace:refresh": null;
  "workspace:refresh-ignores": null;
  "workspace:history": null;
  "workspace:history:view-changes": { changelistNumber: number };
  "workspace:history:select-file": { filePath: string };
  "workspace:history:close": null;
  "workspace:history:open-window": null;
  "workspace:pull": { changelistId: number | null; filePaths: string[] | null };
  "workspace:revert": { filePaths: string[] };
  "workspace:submit": {
    message: string;
    /** Which branch's default changelist to submit. Defaults to the domain root. */
    branchName?: string;
    /** Submit this numbered pending changelist instead. */
    changelistId?: number;
  };
  "workspace:stage": {
    paths: string[];
    branchName?: string;
    /** A numbered pending changelist; null or absent is the branch default. */
    changelistId?: number | null;
  };
  "workspace:unstage": { paths: string[] };
  "workspace:pending-cl:create": {
    description: string;
    branchName?: string;
    /** Staged into the new changelist once it exists. */
    paths?: string[];
  };
  /** A numbered changelist by id, or a branch's default one by branchName. */
  "workspace:pending-cl:set-description": {
    description: string;
    changelistId?: number;
    branchName?: string;
  };
  "workspace:pending-cl:delete": { changelistId: number };
  /**
   * Retarget a numbered changelist. The branch is activated first if it is
   * not, and with createBranch it is created off the domain root's head.
   */
  "workspace:pending-cl:set-branch": {
    changelistId: number;
    branchName: string;
    createBranch?: boolean;
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
  /** Stage the untracked files at or under a path (file or folder). */
  "file:stage-new": { path: string };
  /** Executable (or not) in the next submit; the only way from Windows. */
  "file:set-executable": { path: string; executable: boolean };
  "file:set-executable:error": { message: string };
  "file:checkout": {
    path: string;
    /** Take an exclusive claim even on a mergeable file. */
    forceExclusive?: boolean;
    /** Warn instead of proceeding when someone else's claim blocks this. */
    checkForClaim?: boolean;
  };
  "file:release-claim": { path: string };
  "file:checkout:claimed-warning": {
    path: string;
    claimedBy: string;
    /** The branch the blocking claim is held on. */
    branchName: string;
  };
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

  // Auto-update
  "update:check": null;
  "update:download": null;
  "update:apply": null;
  "update:dismiss": null;
  "update:set-channel": { channel: "release" | "nightly" };

  // API version check
  "version:dismiss": null;

  // Window chrome: update the native controls overlay colors on theme change.
  "window:set-titlebar-overlay": { color: string; symbolColor: string };

  // ─── Team Sync (Phase 1) ─────────────────────────────────────────
  // Enter Team Sync for a workspace: main fetches project info/config/settings/
  // history, sets the atoms, and starts a head poll.
  "team-sync:enter": { workspaceId: string };
  // Leave Team Sync: stop the head poll.
  "team-sync:exit": null;
  // Re-fetch config/settings/status/history for the current workspace.
  "team-sync:refresh": null;
  // Run the sync pipeline (null = latest, or a specific changelist).
  // `confirmLinks` names linked repos the user agreed to move despite local
  // changes, being ahead of the pin, or another workspace holding them;
  // `skipLinks` syncs this workspace alone.
  "team-sync:sync": {
    changelistNumber: number | null;
    confirmLinks?: string[];
    skipLinks?: boolean;
  };
  "team-sync:sync:error": { message: string };
  // Launch the Unreal editor; `config` is an optional build configuration.
  "team-sync:launch-editor": { config?: string };
  "team-sync:launch-editor:error": { message: string };
  // Request cancellation of a running Team Sync daemon job.
  "team-sync:cancel-job": { jobId: string };
  // Persist per-workspace Team Sync settings.
  "team-sync:update-settings": { settings: any };
  // Sync to the newest changelist whose required badges are all green.
  "team-sync:sync-latest-good": null;
  // No changelist qualified as "latest good".
  "team-sync:sync-latest-good:none": null;
  // Set/clear the current user's vote on a changelist.
  "team-sync:vote": {
    changelistNumber: number;
    vote: "COMPILE_SUCCESS" | "COMPILE_FAILURE" | "GOOD" | "BAD" | null;
  };
  // Toggle the current user's star on a changelist.
  "team-sync:star": { changelistNumber: number; starred: boolean };
  // Toggle the current user's "investigating" flag on a changelist.
  "team-sync:investigate": { changelistNumber: number; investigating: boolean };
  // Leave a comment on a changelist.
  "team-sync:comment": { changelistNumber: number; body: string };
  // Run local build steps (compile). `forceClean` forces a clean rebuild.
  "team-sync:build": { forceClean?: boolean };
  // Regenerate IDE project files.
  "team-sync:generate-project-files": null;
  // Main -> renderer: append newly captured job log lines. `startLine` is the
  // seq of the first line in `lines` so the renderer can order/dedupe.
  "team-sync:log:append": { jobId: string; startLine: number; lines: string[] };

  // ─── Team Sync (Phase 2/3) ───────────────────────────────────────
  // Request a clean preview; main sets teamSyncCleanAtom and replies with :data.
  "team-sync:clean:preview": null;
  "team-sync:clean:preview:data": {
    files: { path: string; size: number; category: string }[];
  };
  // Delete the selected intermediate/untracked files.
  "team-sync:clean:execute": { paths: string[] };
  // Request the current bisect state; main sets teamSyncBisectAtom + replies.
  "team-sync:bisect:refresh": null;
  "team-sync:bisect:data": {
    bisect: Record<string, string>;
    next: {
      nextCl: number | null;
      remaining: number;
      low: number | null;
      high: number | null;
    };
  };
  // Record a verdict for a changelist in the active bisect.
  "team-sync:bisect:mark": {
    changelistNumber: number;
    verdict: "pass" | "fail" | "include" | "exclude";
  };
  // Clear all bisect verdicts.
  "team-sync:bisect:reset": null;
  // Preview which synced files a proposed filter change would remove on the
  // next sync (UGS's destructive-filter warning).
  "team-sync:filter:preview": { settings: any };
  "team-sync:filter:preview:data": { toDelete: string[] };

  // ─── Team Sync linked repos ──────────────────────────────────────
  // Re-fetch link statuses and candidate workspaces into teamSyncLinksAtom.
  "team-sync:links:refresh": null;
  // Set this workspace's choice for a link (a mode, and a workspace or none).
  "team-sync:links:set": {
    repo: string;
    mode: "follow-pin" | "manual" | "ignore";
    linkedWorkspaceId: string | null;
  };
  // Drop this workspace's choice, falling back to the preset or default.
  "team-sync:links:clear": { repo: string };
  // Create a workspace of the linked repo in a folder and link it.
  "team-sync:links:create": {
    repo: string;
    path: string;
    name: string;
    mode: "follow-pin" | "manual";
  };
  // Pick a folder for a new linked workspace; main replies with :data.
  "team-sync:links:pick-folder": { repo: string };
  "team-sync:links:pick-folder:data": { repo: string; path: string };
  // Close the "linked repos need confirmation" prompt without syncing.
  "team-sync:link-confirm:dismiss": null;
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

  // Settings dialog
  "settings:mcp:get-status": {
    request: null;
    response: { enabled: boolean; available: boolean };
  };
  "settings:mcp:set-enabled": {
    request: { enabled: boolean };
    response: { enabled: boolean; available: boolean };
  };
  "settings:get-app-info": {
    request: null;
    response: { appVersion: string; electron: string; chrome: string };
  };
  "settings:zoom:get": {
    request: null;
    response: { factor: number };
  };
  "settings:zoom:set": {
    request: { factor: number };
    response: { factor: number };
  };
  // Collect a redacted log bundle (daemon + this app) and reveal it.
  "settings:collect-bug-report": {
    request: null;
    response: { path: string } | { error: string };
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
