import { CreateApiClientAuth } from "@checkpointvcs/common";
import {
  getWorkspaceConfig,
  getWorkspaceState,
  type Workspace,
} from "../util.js";
import { DaemonConfig } from "../../daemon-config.js";
import { Logger } from "../../logging.js";

/** A workspace eligible for scheduled sync, paired with its owning org. */
export interface ScheduledWorkspace {
  workspace: Workspace;
  orgId: string;
}

/** How long a re-armed tick waits between checks (ms). */
const TICK_INTERVAL_MS = 60_000;

/**
 * Window, in ms, after a workspace's daily slot during which a missed slot is
 * still eligible to fire (catch-up). Also used as the minimum spacing between
 * runs so a slow or crash-restarted daemon does not double-fire.
 */
const CATCH_UP_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface GameSyncSchedulerDeps {
  /** Workspaces the daemon currently manages that may have a schedule. */
  listScheduled: () => Promise<ScheduledWorkspace[]>;
  /** True when a sync/build is already in flight for the workspace id. */
  isBusy: (workspaceId: string) => boolean;
  /**
   * Perform the actual scheduled sync. `targetChangelist` is null to mean
   * "sync to branch head"; a number pins the sync to that changelist.
   */
  runScheduledSync: (
    item: ScheduledWorkspace,
    targetChangelist: number | null,
  ) => Promise<void>;
}

/**
 * Drives per-workspace scheduled Game Sync (UnrealGameSync "Schedule" parity).
 *
 * Rather than arm a precise timer per workspace, it re-arms a single ~60s tick
 * and, on each tick, evaluates every scheduled workspace against the current
 * local wall-clock time. A workspace fires when the current time is at or past
 * its "HH:MM" slot for today, the slot is no more than CATCH_UP_WINDOW_MS
 * stale, and it has not already run for that slot. This is intentionally simple
 * and robust to the daemon sleeping, being paused, or restarting mid-day.
 *
 * Date.now()/new Date() are used directly; this runs in the normal Node daemon
 * runtime, not a deterministic workflow sandbox.
 */
export class GameSyncScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** workspace id -> slot timestamp we last fired, to dedupe within a slot. */
  private readonly firedSlots = new Map<string, number>();

  constructor(private readonly deps: GameSyncSchedulerDeps) {}

  /** Begin ticking. Idempotent: a second call while armed is a no-op. */
  start(): void {
    if (this.timer !== null) {
      return;
    }
    // Align the first tick to the next minute boundary so slot matching lands
    // near the top of the minute; subsequent ticks use the full interval.
    const delay = TICK_INTERVAL_MS - (Date.now() % TICK_INTERVAL_MS);
    this.arm(delay);
  }

  /** Stop ticking and clear any armed timer. */
  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private arm(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.tick().finally(() => {
        // Only re-arm if stop() has not been called in the meantime.
        if (this.timer !== null) {
          this.arm(TICK_INTERVAL_MS);
        }
      });
    }, delayMs);
    // Do not keep the process alive solely for the scheduler.
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  /**
   * Evaluate all scheduled workspaces once and fire those that are due.
   * Guarded so a slow run cannot overlap the next tick.
   */
  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    const now = Date.now();

    try {
      const items = await this.deps.listScheduled();
      for (const item of items) {
        try {
          await this.evaluate(item, now);
        } catch (e) {
          Logger.warn(
            `Scheduled sync evaluation failed for workspace ${item.workspace.id}: ${String(e)}`,
          );
        }
      }
    } catch (e) {
      Logger.warn(`Scheduled sync tick failed: ${String(e)}`);
    } finally {
      this.running = false;
    }
  }

  private async evaluate(item: ScheduledWorkspace, now: number): Promise<void> {
    const { workspace } = item;

    // Re-read settings from disk so config edits take effect without restart.
    const config = await getWorkspaceConfig(workspace.localPath);
    const scheduled = config?.gameSync?.scheduledSync;
    if (!scheduled || !scheduled.enabled) {
      return;
    }

    const slotTime = parseSlotTime(now, scheduled.timeOfDay);
    if (slotTime === null) {
      Logger.warn(
        `Ignoring scheduled sync for workspace ${workspace.id}: invalid timeOfDay "${scheduled.timeOfDay}".`,
      );
      return;
    }

    // Not yet reached today's slot.
    if (now < slotTime) {
      return;
    }
    // Slot is too stale; wait for tomorrow's slot rather than firing late.
    if (now - slotTime > CATCH_UP_WINDOW_MS) {
      return;
    }
    // Already fired this exact slot in this process.
    if (this.firedSlots.get(workspace.id) === slotTime) {
      return;
    }

    const backend = (await DaemonConfig.Get()).stateBackend;
    const state = await getWorkspaceState(workspace.localPath, backend);
    const lastRunIso = state.gameSync?.lastScheduledSyncAt;
    if (lastRunIso) {
      const lastRun = Date.parse(lastRunIso);
      // Persisted run already covers this slot.
      if (!Number.isNaN(lastRun) && lastRun >= slotTime) {
        return;
      }
    }

    if (this.deps.isBusy(workspace.id)) {
      // Try again on a later tick within the catch-up window.
      return;
    }

    const target = await this.resolveTargetChangelist(
      workspace,
      scheduled.target,
    );

    // Mark before awaiting the run so a long run cannot be re-triggered by the
    // next tick even before runScheduledSync persists lastScheduledSyncAt.
    this.firedSlots.set(workspace.id, slotTime);

    Logger.info(
      `Firing scheduled sync for workspace ${workspace.id} (target=${scheduled.target}, changelist=${target ?? "head"}).`,
    );
    await this.deps.runScheduledSync(item, target);
  }

  /**
   * Resolve the changelist a scheduled sync should target.
   * - "latest": null (sync to branch head).
   * - "latest-good": newest changelist at/below head whose required badges are
   *   all green; null when none qualify or the repo defines no required badges.
   * - "latest-starred": null for now (TODO: resolve once starred CLs are
   *   exposed to the daemon API).
   */
  private async resolveTargetChangelist(
    workspace: Workspace,
    target: "latest" | "latest-good" | "latest-starred",
  ): Promise<number | null> {
    if (target === "latest") {
      return null;
    }
    if (target === "latest-starred") {
      // TODO: resolve the latest starred changelist when that API exists.
      return null;
    }

    try {
      const client = await CreateApiClientAuth(workspace.daemonId);

      const branch = await client.branch.getBranch.query({
        repoId: workspace.repoId,
        name: workspace.branchName,
      });
      if (!branch) {
        return null;
      }

      const config = await client.gameSync.getConfig
        .query({
          repoId: workspace.repoId,
          changelistNumber: branch.headNumber,
        })
        .catch(() => null);
      const requiredBadges = [
        ...new Set(
          (config?.config?.artifacts ?? []).flatMap(
            (channel) => channel.requiredBadges,
          ),
        ),
      ];
      if (requiredBadges.length === 0) {
        return null;
      }

      const result = await client.buildBadge.findLatestGood.query({
        repoId: workspace.repoId,
        startNumber: branch.headNumber,
        requiredBadges,
      });
      return result?.changelistNumber ?? null;
    } catch (e) {
      Logger.warn(
        `Could not resolve latest-good changelist for workspace ${workspace.id}: ${String(e)}`,
      );
      return null;
    }
  }
}

/**
 * Compute the local timestamp (ms) of today's "HH:MM" slot relative to `now`,
 * or null when `timeOfDay` is not a valid 24h "HH:MM" string.
 */
function parseSlotTime(now: number, timeOfDay: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeOfDay.trim());
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  const d = new Date(now);
  const slot = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    hour,
    minute,
    0,
    0,
  );
  return slot.getTime();
}
