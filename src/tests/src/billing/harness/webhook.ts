// Helpers for testing the Stripe webhook route handler.
//
// The webhook route imports `db` from `~/server/db`. vitest-setup.ts swaps
// that import for a getter that reads `globalThis.__checkpointTestDb`. This
// helper just plumbs the test PrismaClient into that global and wraps the
// route's `POST` for ergonomic test use.
//
// Usage in a test file:
//
//   const env = setupWebhookEnv();
//   beforeAll(async () => { await env.start(); }, 120_000);
//   afterAll(async () => { await env.stop(); });
//   beforeEach(async () => { await env.reset(); });
//
//   it("...", async () => {
//     const { request } = buildSignedWebhookRequest(...);
//     const res = await env.POST(request);
//     ...
//   });

import type { NextRequest } from "next/server";
import { createTestDb, type TestDb } from "./db";
import {
  enableLicenseManager,
  setStripeClient,
  resetGates,
} from "./gates";
import { createStripeMock, type MockStripe } from "./stripe-mock";

declare global {
  // eslint-disable-next-line no-var
  var __checkpointTestDb: import("@prisma/client").PrismaClient | undefined;
  // eslint-disable-next-line no-var
  var __checkpointEmailMocks:
    | { sendEmail: import("vitest").Mock }
    | undefined;
}

/** Returns the shared sendEmail mock (set up by vitest-setup). */
export function getSendEmailMock(): import("vitest").Mock {
  const m = globalThis.__checkpointEmailMocks?.sendEmail;
  if (!m) {
    throw new Error(
      "Email mock not initialized. Did you forget to add vitest-setup as a setupFile?",
    );
  }
  return m;
}

export interface WebhookEnv {
  testDb: TestDb;
  stripe: MockStripe;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  reset: () => Promise<void>;
  POST: (req: Request | NextRequest) => Promise<Response>;
}

export function setupWebhookEnv(): WebhookEnv {
  const env: Partial<WebhookEnv> = {};

  env.start = async () => {
    const testDb = await createTestDb();
    globalThis.__checkpointTestDb = testDb.client;
    env.testDb = testDb;
    // Lazy-import after the db mock has a backing value, so the route's
    // top-level `import { db }` sees the real test client immediately.
    const route = await import("~/app/api/webhooks/stripe/route");
    env.POST = route.POST as WebhookEnv["POST"];
  };

  env.stop = async () => {
    if (env.testDb) await env.testDb.teardown();
    delete globalThis.__checkpointTestDb;
  };

  env.reset = async () => {
    if (env.testDb) await env.testDb.reset();
    resetGates();
    enableLicenseManager();
    env.stripe = createStripeMock();
    setStripeClient(env.stripe as never);
  };

  return env as WebhookEnv;
}
