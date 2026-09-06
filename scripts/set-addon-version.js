#!/usr/bin/env node
// Point the repo at a specific @checkpointvcs/longtail-addon version.
//
// The addon is consumed by three workspaces (src/app, src/core/server,
// src/core/daemon), so a publish has to rewrite four package.json files in
// lockstep. That used to live as an inline `node -e` blob inside
// .github/workflows/publish-longtail-addon.yaml; it is a script now because
// the nightly stream also needs it, in a second job, without a commit.
//
// Usage:
//   node scripts/set-addon-version.js <version> [--dep-only] [--range caret|exact]
//
//   --dep-only  Only rewrite the dependents, not the addon's own package.json.
//               Used by downstream build jobs that consume an already-published
//               addon.
//   --range     How dependents pin the addon. Defaults to `caret` (^x.y.z) for
//               plain releases and `exact` for prereleases: a caret range does
//               not match prerelease versions, so nightly builds must pin.

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");

const ADDON_PACKAGE = "src/longtail/addon/package.json";
const DEPENDENTS = [
  "src/app/package.json",
  "src/core/server/package.json",
  "src/core/daemon/package.json",
];
const ADDON_NAME = "@checkpointvcs/longtail-addon";

// ─── Argument parsing ───────────────────────────────────────────────

const args = process.argv.slice(2);
let version = null;
let depOnly = false;
let range = null;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const eq = a.indexOf("=");
  const flag = eq === -1 ? a : a.slice(0, eq);
  const inline = eq === -1 ? null : a.slice(eq + 1);
  if (flag === "--dep-only") depOnly = true;
  else if (flag === "--range") range = inline ?? args[++i];
  else if (!a.startsWith("--")) version = a;
  else {
    console.error(`unknown flag: ${flag}`);
    process.exit(1);
  }
}

if (!version) {
  console.error(
    "usage: node scripts/set-addon-version.js <version> [--dep-only] [--range caret|exact]",
  );
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) {
  console.error(`invalid semver: ${version}`);
  process.exit(1);
}

const isPrerelease = version.includes("-");
range ??= isPrerelease ? "exact" : "caret";

if (range !== "caret" && range !== "exact") {
  console.error(`--range must be caret or exact, got: ${range}`);
  process.exit(1);
}

if (range === "caret" && isPrerelease) {
  console.error(
    `refusing to write a caret range for prerelease ${version}: ^${version} does not match other prereleases`,
  );
  process.exit(1);
}

const spec = range === "caret" ? `^${version}` : version;

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
