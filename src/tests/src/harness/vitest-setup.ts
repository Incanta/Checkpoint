// Global vitest setup. Runs once per test *file*, before the file's own
// imports execute (vi.mock is hoisted by vitest).
//
// What we replace:
//   1. `server-only` — would throw at module-eval time; swap for a no-op.
//   2. `@incanta/config` — point at the in-memory test config.
//   3. `~/server/logging` — silence pino + skip the YAML-driven config read.
//   4. `~/server/db` — proxy to a per-file PrismaClient that the caller
//      helper assigns via `globalThis.__checkpointTestDb`.
//   5. `~/server/storage-service` — no-op the HTTP calls to the SeaweedFS
//      backend so router tests don't need the server running.
//   6. `~/server/email/service` — capture-only, accessible via the
//      `getSendEmailMock()` helper.
//   7. `~/server/auth/config` — better-auth heavy init. Router tests bypass
//      `createTRPCContext` entirely (they pass session directly), so we
//      stub `auth` and `Session` enough to keep imports alive.
//
// Plus: reset config + clear mock call history between every test.

import { beforeEach, vi } from "vitest";

declare global {
  // eslint-disable-next-line no-var
  var __checkpointTestDb: import("@prisma/client").PrismaClient | undefined;
  // eslint-disable-next-line no-var
  var __checkpointEmailMocks:
    | { sendEmail: import("vitest").Mock }
    | undefined;
}

vi.mock("server-only", () => ({}));

vi.mock("@incanta/config", async () => {
  const mod = await import("./config");
  return { default: mod.testConfigShim };
});

vi.mock("~/server/logging", () => {
  const noop = vi.fn();
  const Logger = {
    log: noop,
    info: noop,
    warn: noop,
    debug: noop,
    error: noop,
    trace: noop,
    fatal: noop,
  };
  return { Logger, createLogger: () => Logger };
});

vi.mock("~/server/db", () => ({
  get db() {
    const g = globalThis as { __checkpointTestDb?: unknown };
    if (!g.__checkpointTestDb) {
      throw new Error(
        "Test db not initialized. Did you forget to call `await env.start()` in beforeAll?",
      );
    }
    return g.__checkpointTestDb;
  },
}));

vi.mock("~/server/storage-service", () => ({
  createSystemToken: vi.fn().mockReturnValue("test.system.token"),
  createOrgDirectory: vi.fn().mockResolvedValue(undefined),
  createRepoDirectory: vi.fn().mockResolvedValue(undefined),
  deleteOrgDirectory: vi.fn().mockResolvedValue(undefined),
  deleteRepoDirectory: vi.fn().mockResolvedValue(undefined),
}));

// Premium-only on `main` (the file doesn't exist there). Vitest treats this
// as a virtual mock when the path can't be resolved, so harmless either way.
vi.mock("~/server/r2-service", () => ({
  isR2Enabled: vi.fn().mockReturnValue(false),
  getBucketUsageR2: vi.fn().mockResolvedValue(0n),
  createR2Bucket: vi.fn().mockResolvedValue(undefined),
  deleteR2Bucket: vi.fn().mockResolvedValue(undefined),
}));

// Shared email mock — `vi.hoisted` runs before any `vi.mock` factory so we
// can attach the mock to a stable holder accessible to both the route and
// the asserting test.
const emailMocks = vi.hoisted(() => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("~/server/email/service", () => emailMocks);

(globalThis as { __checkpointEmailMocks?: unknown }).__checkpointEmailMocks =
  emailMocks;

// better-auth import chain pulls in @incanta/config, prisma, and a few
// server-only modules at eval time. Router tests don't exercise that path
// (we feed `session` directly into ctx), so a thin stub is enough.
vi.mock("~/server/auth/config", () => ({
  auth: Promise.resolve({
    api: {
      getSession: vi.fn().mockResolvedValue(null),
    },
  }),
  enabledProviderIds: [],
}));

beforeEach(async () => {
  const { resetConfig } = await import("./config");
  resetConfig();
  vi.clearAllMocks();
});
