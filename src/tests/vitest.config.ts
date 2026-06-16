import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      // `import "server-only"` would throw at module-eval time; swap for a
      // local no-op stub. The real package's `./empty.js` is gated behind
      // the `react-server` export condition and can't be reached otherwise.
      "server-only": path.resolve(
        __dirname,
        "src/harness/server-only-stub.ts",
      ),
      // `~/*` in the app's source resolves to `src/app/src/*`. Mirror that
      // here so test files can use the same import paths.
      "~": path.resolve(__dirname, "../app/src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/harness/vitest-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    environment: "node",
    pool: "forks",
  },
});
