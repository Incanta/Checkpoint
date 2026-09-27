#!/usr/bin/env node
// Point the repo at a specific @checkpointvcs/longtail-addon version.
//
// The addon is consumed by four workspaces (src/app, src/core/server,
// src/core/daemon, src/tests), so a publish has to rewrite five package.json
// files in lockstep. That used to live as an inline `node -e` blob inside
// .github/workflows/publish-longtail-addon.yaml; it is a script now because
// the nightly stream also needs it, in a second job, without a commit.
//
// Dependents pin the addon EXACTLY (x.y.z, no caret). The addon is a native
// binary whose blast radius is the whole storage path, and every consumer
// installs from a committed lockfile with --immutable, so a range buys nothing
// at install time: it only adds a way for the version to move without a
// reviewable diff whenever the lockfile is regenerated. An exact pin also
// means the version is one string to compare, which is what
// scripts/check-addon-version.js relies on, and it removes the old split where
// releases used a caret but prereleases had to pin (a caret range does not
// match a prerelease at all).
//
// Because the pins are exact, every dependent must move together: a dependent
// left behind resolves a second copy of the package rather than quietly
// deduplicating onto one. check-addon-version.js fails CI when that happens.
//
// Usage:
//   node scripts/set-addon-version.js <version> [--dep-only]
//
//   --dep-only  Only rewrite the dependents, not the addon's own package.json.
//               Used by downstream build jobs that consume an already-published
//               addon.

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");

const ADDON_PACKAGE = "src/longtail/addon/package.json";
const DEPENDENTS = [
  "src/app/package.json",
  "src/core/server/package.json",
  "src/core/daemon/package.json",
  "src/tests/package.json",
];
const ADDON_NAME = "@checkpointvcs/longtail-addon";

// ─── Argument parsing ───────────────────────────────────────────────

const args = process.argv.slice(2);
let version = null;
let depOnly = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const eq = a.indexOf("=");
  const flag = eq === -1 ? a : a.slice(0, eq);
  if (flag === "--dep-only") depOnly = true;
  else if (!a.startsWith("--")) version = a;
  else {
    console.error(`unknown flag: ${flag}`);
    if (flag === "--range") {
      console.error(
        "  --range was removed: dependents always pin exactly. See the header comment.",
      );
    }
    process.exit(1);
  }
}

if (!version) {
  console.error(
    "usage: node scripts/set-addon-version.js <version> [--dep-only]",
  );
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) {
  console.error(`invalid semver: ${version}`);
  process.exit(1);
}

// Exact, always. See the header comment for why there is no range option.
const spec = version;

// ─── Rewrite ────────────────────────────────────────────────────────

function updateJson(rel, mutate) {
  const abs = path.join(repoRoot, rel);
  const raw = fs.readFileSync(abs, "utf8");
  const trailingNewline = raw.endsWith("\n") ? "\n" : "";
  const data = JSON.parse(raw);
  mutate(data);
  fs.writeFileSync(abs, JSON.stringify(data, null, 2) + trailingNewline);
  console.log(`  wrote ${rel}`);
}

console.log(`Setting ${ADDON_NAME} to ${version} (dependents pin "${spec}")`);

if (!depOnly) {
  updateJson(ADDON_PACKAGE, (pkg) => {
    pkg.version = version;
  });
}

for (const rel of DEPENDENTS) {
  updateJson(rel, (pkg) => {
    if (!pkg.dependencies?.[ADDON_NAME]) {
      console.error(`  ${rel} does not depend on ${ADDON_NAME}`);
      process.exitCode = 1;
      return;
    }
    pkg.dependencies[ADDON_NAME] = spec;
  });
}

console.log("done");
