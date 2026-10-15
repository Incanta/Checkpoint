import { defineConfig } from "vitest/config";

// The data-loss red team's native-layer tests: the real addon against running
// services, with nothing mocked, so the harness setup that stubs the addon is
// deliberately not loaded (as in vitest.integration.config.ts). Each file
// skips itself unless CHECKPOINT_TEST_DAEMON_ID is set. A failure is an open
// bug; see src/data-loss/README.md. Run with `yarn test:data-loss:native`.
export default defineConfig({
  test: {
    include: ["src/data-loss/native/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
