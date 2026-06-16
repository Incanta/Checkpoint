#!/usr/bin/env node

/**
 * Local CLI integration test runner — same scenarios as the GH Actions
 * test workflow, runnable without CI.
 *
 * Usage:
 *   yarn test
 *   node scripts/test.js              - Run the full test (auto-manage services)
 *   node scripts/test.js --no-manage  - Assume services are already running
 *
 * Behavior:
 *   - Errors out if the CLI binary isn't built.
 *   - If --no-manage is NOT passed and no dev.js process is running,
 *     starts services in the background, runs the test, then stops them.
 *   - If services are already running (or --no-manage is passed), just
 *     runs the test against them and leaves them running.
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

if (!fs.existsSync(cliBin)) {
  console.error(`CLI binary not found at ${cliBin}`);
  console.error(
    "Build it first:\n" +
      "  cd src/clients/cli && mkdir -p build && cd build && cmake .. && cmake --build . --parallel",
  );
  process.exit(1);
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

if (!noManage && !devRunning()) {
  console.log("Starting services in background...");
  const startResult = spawnSync(process.execPath, [devScript, "--background"], {
    stdio: "inherit",
    cwd: repoRoot,
  });
  if (startResult.status !== 0) {
    console.error("Failed to start services");
    process.exit(startResult.status ?? 1);
  }
  weStartedServices = true;
}

const result = spawnSync(process.execPath, [testScript, ...args], {
  stdio: "inherit",
  cwd: repoRoot,
});

if (weStartedServices) {
  console.log("\nStopping services...");
  spawnSync(process.execPath, [devScript, "stop"], {
    stdio: "inherit",
    cwd: repoRoot,
  });
}

process.exit(result.status ?? 1);
