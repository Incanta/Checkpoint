import "server-only";

import config from "@incanta/config";

const TIME_MANAGER_KEY = Symbol.for("checkpoint.timeManager");

interface TimeManagerState {
  simulatedYear: number | null;
  simulatedMonth: number | null;
  simulatedDay: number | null;
}

const globalForTime = globalThis as unknown as {
  [TIME_MANAGER_KEY]?: TimeManagerState;
};

function getState(): TimeManagerState {
  if (!globalForTime[TIME_MANAGER_KEY]) {
    globalForTime[TIME_MANAGER_KEY] = {
      simulatedYear: null,
      simulatedMonth: null,
      simulatedDay: null,
    };
  }
  return globalForTime[TIME_MANAGER_KEY];
}

function isDevMode(): boolean {
  return config.tryGet<boolean>("auth.dev.allow-dev-login") === true;
}

/**
 * TimeManager provides a centralized time source for billing, metering,
 * and scheduling systems. In production, it delegates to native Date.
 * In dev mode, `setDay()` can override the date component while
 * preserving real wall-clock hours/minutes/seconds.
 */
export const TimeManager = {
  /** Get current date. Uses simulated day if set. */
  date(): Date {
    const state = getState();
    if (
      state.simulatedYear !== null &&
      state.simulatedMonth !== null &&
      state.simulatedDay !== null
    ) {
      const real = new Date();
      return new Date(
        state.simulatedYear,
        state.simulatedMonth - 1,
        state.simulatedDay,
        real.getHours(),
        real.getMinutes(),
        real.getSeconds(),
        real.getMilliseconds(),
      );
    }
    return new Date();
  },

  /** Get current timestamp in ms. Uses simulated day if set. */
  now(): number {
    return this.date().getTime();
  },

  /**
   * Override the date component for billing/metering systems.
   * Only available when dev login is enabled.
   * @param year  Full year (e.g. 2026)
   * @param month 1-12
   * @param day   1-31
   */
  setDay(year: number, month: number, day: number): void {
    if (!isDevMode()) {
      throw new Error("Time simulation is only available in dev mode");
    }
    const state = getState();
    state.simulatedYear = year;
    state.simulatedMonth = month;
    state.simulatedDay = day;
  },

  /** Revert to real time. */
  clearSimulation(): void {
    const state = getState();
    state.simulatedYear = null;
    state.simulatedMonth = null;
    state.simulatedDay = null;
  },

  /** Check if a simulated day is active. */
  isSimulated(): boolean {
    const state = getState();
    return state.simulatedYear !== null;
  },
};
