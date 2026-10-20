import path from "path";
import { Logger } from "../logging.js";
import {
  BACKUP_DIR,
  LocalChangeGuard,
  type RestoreResult,
} from "./pull-local-changes.js";
import {
  getWorkspaceState,
  updateWorkspaceState,
  type InterruptedPull,
  type Workspace,
} from "./util.js";
import type { DaemonConfigType } from "../daemon-config.js";

// A pull that dies partway (the daemon crashes, the machine reboots for an
// update, the user quits mid-sync) used to leave no trace. The files the
// native pass had written sat on disk against the old baselines, so they
// looked like the user's edits, and the user's real edits to those files were
// only in the pull's backup folder, which nothing pointed at.
//
// Now the pull records itself in the workspace state before its first write
// (`interruptedPull`) and clears that in the same transaction that records
// what it wrote, and the guard lists every backup in a journal beside the
// backup folder before anything is overwritten. A record still present when
// the daemon starts, or when the next pull starts, means the pull never
// finished: every backup is put back, and the record stays (marked restored)
// until a pull completes, so submits are refused meanwhile. Pulling again
// settles the files the dead pull wrote, the same way any pull settles a file
// that already has the incoming content.

/** Backup folders of pulls running in this process right now. */
const runningPulls = new Set<string>();

export function markPullRunning(backupRoot: string, running: boolean): void {
  if (running) runningPulls.add(backupRoot);
  else runningPulls.delete(backupRoot);
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface InterruptedPullRecovery {
  changelist: number;
  backupRoot: string;
  restore: RestoreResult;
}

/**
 * Puts back the local edits a pull that died partway had backed up. Returns
 * null when there is nothing to recover, or the pull is still running (in
 * this process, or in another daemon process on the same workspace).
 */
export async function recoverInterruptedPull(
  workspace: Pick<Workspace, "localPath">,
  backend?: DaemonConfigType["stateBackend"],
): Promise<InterruptedPullRecovery | null> {
  const state = await getWorkspaceState(workspace.localPath, backend);
  const record = state.interruptedPull;
  if (!record) return null;
  if (runningPulls.has(record.backupRoot) || processAlive(record.pid)) {
    return null;
  }

  // Only ever a folder under this workspace's own pull backups.
  const backupsDir = path.resolve(
    workspace.localPath,
    ".checkpoint",
    BACKUP_DIR,
  );
  const backupRoot = path.resolve(record.backupRoot);
  if (path.dirname(backupRoot) !== backupsDir) {
    Logger.warn(
      `Ignoring an interrupted pull record with a backup folder outside ${backupsDir}: ${record.backupRoot}`,
    );
    await updateWorkspaceState(
      workspace,
      { meta: { interruptedPull: { ...record, restoredAt: now() } } },
      backend,
    );
    return null;
  }

  const guard = await LocalChangeGuard.fromJournal(
    workspace.localPath,
    backupRoot,
  );
  const restore = await guard.restoreAll();

  if (restore.restored.length > 0 || restore.failed.length > 0) {
    Logger.warn(
      `A pull to changelist ${record.changelist} was interrupted. Put back ${restore.restored.length} locally changed file(s)` +
        (restore.failed.length > 0
          ? `; could not put back ${restore.failed.length}, whose local versions are kept in ${backupRoot}: ${restore.failed.map((f) => f.relativePath).join(", ")}`
          : "") +
        ". Pull again to finish syncing.",
    );
  } else if (!record.restoredAt) {
    Logger.warn(
      `A pull to changelist ${record.changelist} was interrupted before it changed any locally edited file. Pull again to finish syncing.`,
    );
  }

  // The record stays until a pull completes. It is marked restored only once
  // nothing is left to put back; a file that was locked keeps its journal
  // entry and is retried next time.
  if (restore.failed.length === 0 && !record.restoredAt) {
    await updateWorkspaceState(
      workspace,
      { meta: { interruptedPull: { ...record, restoredAt: now() } } },
      backend,
    );
  }

  return { changelist: record.changelist, backupRoot, restore };
}

/** The message a submit gets while a pull is unfinished. */
export function interruptedPullMessage(record: InterruptedPull): string {
  return `The last pull (to changelist ${record.changelist}) did not finish, so files it wrote look like local changes. Pull again before submitting. Your own local changes were put back.`;
}

function now(): string {
  return new Date().toISOString();
}
