import "server-only";

import { Logger } from "~/server/logging";
import {
  getCheckIntervalMs,
  getUpdateChannel,
  isUpdateCheckEnabled,
} from "./check";

// Give the app time to finish booting before reaching out over the network.
const STARTUP_DELAY_MS = 45 * 1000;

const UPDATE_STATE = Symbol.for("checkpoint.updateScheduler");

interface UpdateSchedulerState {
  intervalId: ReturnType<typeof setInterval> | null;
}

function getState(): UpdateSchedulerState {
  const g = globalThis as unknown as Record<symbol, UpdateSchedulerState>;
  g[UPDATE_STATE] ??= { intervalId: null };
  return g[UPDATE_STATE];
}

async function tick(): Promise<void> {
  try {
    const { db } = await import("~/server/db");
    const { checkForServerUpdate } = await import("./check");
    // The scheduled poll is the authoritative one, and it is what decides
    // whether to email, so it never serves a cached answer.
    await checkForServerUpdate(db, { force: true });
  } catch (err: unknown) {
    Logger.debug(`[Updates] Scheduler tick failed: ${String(err)}`);
  }
}

/**
 * Start polling the release channel for a newer server build. Idempotent: a
 * second call is a no-op.
 */
export function initUpdateScheduler(): void {
  const state = getState();
  if (state.intervalId) return;

  if (!isUpdateCheckEnabled()) {
    Logger.debug("[Updates] Update notifications disabled");
    return;
  }

  const intervalMs = getCheckIntervalMs();

  setTimeout(() => void tick(), STARTUP_DELAY_MS);
  state.intervalId = setInterval(() => void tick(), intervalMs);

  Logger.info(
    `[Updates] Watching the ${getUpdateChannel()} channel for server updates (every ${
      intervalMs / 1000 / 60 / 60
    }h)`,
  );
}
