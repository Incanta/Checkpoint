#!/usr/bin/env node

/**
 * Local CLI integration test runner — same scenarios as the GH Actions
 * test workflow, runnable without CI.
 *
 * Usage:
 *   yarn test
 *   node scripts/test.js              - Run the full test (auto-manage services)
 *   node scripts/test.js --no-manage  - Assume services are already running
 *   node scripts/test.js --keep-overrides
 *                                      - Don't move config/override.json files
 *                                        aside before the run
 *
 * Behavior:
 *   - Errors out if the CLI binary isn't built.
 *   - If --no-manage is NOT passed and no dev.js process is running,
 *     starts services in the background, runs the test, then stops them.
 *   - Sets CI=true so the app starts in `dev:test` mode (the same mode CI
 *     uses, which enables auth.dev.allow-dev-login).
 *   - Temporarily moves the app and server `config/override.json` files
 *     aside so the run uses default (seaweedfs + Stripe off) config, the
 *     same as CI. The overrides are restored even if the test fails.
 *     Pass --keep-overrides to disable this.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const isWin = process.platform === "win32";

const cliBin = path.join(
  repoRoot,
  "src/clients/cli/build",
  isWin ? "chk.exe" : "chk",
);
const pidFile = path.join(repoRoot, "logs", ".dev.pid");
const devScript = path.join(repoRoot, "dev.js");
const testScript = path.join(repoRoot, ".github/workflows/test.js");

const args = process.argv.slice(2);
const noManage = args.includes("--no-manage");
const keepOverrides = args.includes("--keep-overrides");

if (!fs.existsSync(cliBin)) {
  console.error(`CLI binary not found at ${cliBin}`);
  console.error(
    "Build it first:\n" +
      "  cd src/clients/cli && mkdir -p build && cd build && cmake .. && cmake --build . --parallel",
  );
  process.exit(1);
}

const overridePaths = [
  path.join(repoRoot, "src/app/config/override.json"),
  path.join(repoRoot, "src/core/server/config/override.json"),
];

const movedOverrides = [];

function moveOverridesAside() {
  if (keepOverrides) return;
  for (const p of overridePaths) {
    if (fs.existsSync(p)) {
      const stash = `${p}.test-bak`;
      fs.renameSync(p, stash);
      movedOverrides.push({ original: p, stash });
    }
  }
  if (movedOverrides.length > 0) {
    console.log(
      `Moved ${movedOverrides.length} override.json file(s) aside for the test run.`,
    );
  }
}

function restoreOverrides() {
  for (const { original, stash } of movedOverrides) {
    try {
      if (fs.existsSync(stash)) fs.renameSync(stash, original);
    } catch (err) {
      console.error(`Failed to restore ${original}: ${err.message}`);
    }
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function devRunning() {
  if (!fs.existsSync(pidFile)) return false;
  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  return Number.isFinite(pid) && isRunning(pid);
}

let weStartedServices = false;
let exitCode = 1;

try {
  moveOverridesAside();

  const testEnv = { ...process.env, CI: "true" };

  if (!noManage && !devRunning()) {
    console.log("Starting services in background (CI=true)...");
    const startResult = spawnSync(
      process.execPath,
      [devScript, "--background"],
      {
        stdio: "inherit",
        cwd: repoRoot,
        env: testEnv,
      },
    );
    if (startResult.status !== 0) {
      console.error("Failed to start services");
      exitCode = startResult.status ?? 1;
      process.exit(exitCode);
    }
    weStartedServices = true;
  }

  const result = spawnSync(process.execPath, [testScript, ...args], {
    stdio: "inherit",
    cwd: repoRoot,
    env: testEnv,
  });

  exitCode = result.status ?? 1;
} finally {
  if (weStartedServices) {
    console.log("\nStopping services...");
    spawnSync(process.execPath, [devScript, "stop"], {
      stdio: "inherit",
      cwd: repoRoot,
    });
  }
  restoreOverrides();
}

process.exit(exitCode);
