#!/usr/bin/env node

// Runs `yarn npm audit --all --recursive` in every yarn project root in this
// repo and aggregates the exit codes. We have two separate yarn installs:
//
//   1. the repo root (which covers all `workspaces` entries)
//   2. src/longtail/addon (its own `packageManager`, own yarn.lock)
//
// `yarn npm audit` exits non-zero when it finds vulnerabilities, so chaining
// the two with `&&` would skip the second whenever the first has findings.
// This script runs both regardless and exits with the worst status seen.

const { spawnSync } = require("child_process");
const path = require("path");

const isWin = process.platform === "win32";
const yarn = isWin ? "yarn.cmd" : "yarn";

const repoRoot = path.resolve(__dirname, "..");

const projects = [
  { label: "root", dir: repoRoot },
  { label: "src/longtail/addon", dir: path.join(repoRoot, "src/longtail/addon") },
];

let worstExit = 0;

for (const { label, dir } of projects) {
  console.log(`\n=== Auditing ${label} ===`);
  const result = spawnSync(yarn, ["npm", "audit", "--all", "--recursive"], {
    cwd: dir,
    stdio: "inherit",
    shell: isWin,
  });
  const status = result.status ?? 1;
  if (status > worstExit) worstExit = status;
}

process.exit(worstExit);
