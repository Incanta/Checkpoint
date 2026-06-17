// Toggle the global flags the billing code reads to decide whether Stripe /
// license-manager features are active.
//
// `isLicenseManager()` (in src/app/src/server/license-utils.ts) reads
// `globalThis[Symbol.for("checkpoint.licenseManagerVerified")]`. The webhook
// handler and several billing modules early-return when it's false.
//
// `getStripeClient()` reads `globalThis[Symbol.for("checkpoint.stripe.client")]`.
// Setting it short-circuits the real `new Stripe(secretKey)` constructor,
// letting us inject a mock.

import type Stripe from "stripe";

const LICENSE_MANAGER_KEY = Symbol.for("checkpoint.licenseManagerVerified");
const STRIPE_CLIENT_KEY = Symbol.for("checkpoint.stripe.client");
const TIME_MANAGER_KEY = Symbol.for("checkpoint.timeManager");

type WithSymbols = typeof globalThis & {
  [LICENSE_MANAGER_KEY]?: boolean;
  [STRIPE_CLIENT_KEY]?: Stripe | null;
  [TIME_MANAGER_KEY]?: {
    simulatedYear: number | null;
    simulatedMonth: number | null;
    simulatedDay: number | null;
  };
};

const g = globalThis as WithSymbols;

export function enableLicenseManager(): void {
  g[LICENSE_MANAGER_KEY] = true;
}

export function disableLicenseManager(): void {
  delete g[LICENSE_MANAGER_KEY];
}

export function setStripeClient(client: Stripe): void {
  g[STRIPE_CLIENT_KEY] = client;
}

export function clearStripeClient(): void {
  g[STRIPE_CLIENT_KEY] = null;
}

/**
 * Pin the simulated time the same way the billing-dev tRPC procedures do.
 * Reads the same Symbol-keyed global that `src/app/src/server/time.ts`'s
 * TimeManager consults.
 */
export function setSimulatedDay(date: Date): void {
  g[TIME_MANAGER_KEY] = {
    simulatedYear: date.getFullYear(),
    simulatedMonth: date.getMonth() + 1,
    simulatedDay: date.getDate(),
  };
}

export function clearSimulatedDay(): void {
  if (g[TIME_MANAGER_KEY]) {
    g[TIME_MANAGER_KEY].simulatedYear = null;
    g[TIME_MANAGER_KEY].simulatedMonth = null;
    g[TIME_MANAGER_KEY].simulatedDay = null;
  }
}

/** Reset every global the harness touches. Call in afterEach. */
export function resetGates(): void {
  disableLicenseManager();
  clearStripeClient();
  clearSimulatedDay();
}
