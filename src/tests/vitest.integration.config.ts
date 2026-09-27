import { defineConfig } from "vitest/config";

// Integration tests: real native addon, real app + daemon + server. Nothing is
// mocked, so the default harness setup file (which stubs the addon and the
// app's server modules) is deliberately not loaded here. Run with
// `yarn test:integration` once services are up; each file skips itself when
// CHECKPOINT_TEST_DAEMON_ID is unset.
export default defineConfig({
  test: {
    include: ["src/integration/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    // Every file talks to the same daemon and server; keep them serial so
    // submits never interleave.
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
