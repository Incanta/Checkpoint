import { defineConfig } from "vitest/config";

import base from "./vitest.config";

// Red-team suite: scenarios that lose work during push, pull, merge, and
// branch use. Each test states the safe behavior, so a failure here is an open
// data-loss bug (see src/data-loss/README.md), not a broken test. Kept out of
// `yarn test` so the main suite stays green while the bugs are open; run with
// `yarn test:data-loss`. Same aliases and harness setup as the main suite.
//
// src/data-loss/native needs the real addon and running services, so it has
// its own config (vitest.data-loss-native.config.ts).
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["src/data-loss/**/*.test.ts"],
    exclude: ["src/data-loss/native/**", "**/node_modules/**"],
    // Each test runs two daemons' worth of submits and pulls, and the Windows
    // file-lock tests start a PowerShell to hold the file. Hosted CI runners
    // can take several times as long as a workstation.
    testTimeout: 120_000,
  },
});
