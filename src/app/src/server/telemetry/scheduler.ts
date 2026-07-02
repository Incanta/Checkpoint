import "server-only";

import { Logger } from "~/server/logging";

// Check a few times a day; the report itself only fires once a week (gated by
// InstanceSettings.lastTelemetryAt), so the cadence here just needs to be
// finer than weekly to catch the due window after restarts.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_DELAY_MS = 30 * 1000;

const TELEMETRY_STATE = Symbol.for("checkpoint.telemetryScheduler");

interface TelemetryState {
  intervalId: ReturnType<typeof setInterval> | null;
}

function getState(): TelemetryState {
  const g = globalThis as unknown as Record<symbol, TelemetryState>;
  g[TELEMETRY_STATE] ??= { intervalId: null };
  return g[TELEMETRY_STATE];
}

async function tick(): Promise<void> {
  try {
    const { db } = await import("~/server/db");
    const { reportTelemetryIfDue } = await import("./weekly-report");
    await reportTelemetryIfDue(db);
  } catch (err: unknown) {
    Logger.debug(`[Telemetry] Scheduler tick failed: ${String(err)}`);
  }
}

/**
 * Start the weekly telemetry scheduler. Idempotent: a second call is a no-op.
 * Reporting self-gates (skips the license-manager instance and opted-out
 * installs), so it is safe to start unconditionally on every instance.
 */
export function initTelemetryScheduler(): void {
  const state = getState();
  if (state.intervalId) return;

  setTimeout(() => void tick(), STARTUP_DELAY_MS);
  state.intervalId = setInterval(() => void tick(), CHECK_INTERVAL_MS);

  Logger.debug("[Telemetry] Weekly telemetry scheduler started");
}
