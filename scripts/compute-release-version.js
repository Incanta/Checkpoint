#!/usr/bin/env node
// Compute the versions a CD run should stamp, for either delivery stream.
//
//   release  Uses versions.json / the addon package.json verbatim. Bumping
//            those is a deliberate, committed act (scripts/set-version.js), so
//            the release stream never invents a version.
//
//   nightly  Bumps the patch of each released version and appends a semver
//            prerelease: <next>-nightly.<YYYYMMDDHHmm>.g<shortsha>
//
//            The patch bump matters for ordering. versions.json holds the last
//            *released* version, so 0.4.15-nightly.* would sort BELOW the 0.4.15
//            already in users' hands. Nightlies are pre-releases of the version
//            that comes next, hence 0.4.16-nightly.*, which sorts above 0.4.15
//            and below the eventual 0.4.16.
//
//            The UTC timestamp keeps successive nightlies ordered; the short sha
//            makes a build traceable to its commit and keeps npm from rejecting
//            a same-minute re-run as a duplicate.
//
// Usage:
//   node scripts/compute-release-version.js --stream nightly|release
//                                           [--sha <sha>] [--now <iso>] [--json]
//
// Writes server_version / client_version / addon_version to GITHUB_OUTPUT when
// it is set, and prints them either way.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");

// ─── Argument parsing ───────────────────────────────────────────────

const args = process.argv.slice(2);
let stream = null;
let sha = null;
let nowIso = null;
let asJson = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const eq = a.indexOf("=");
  const flag = eq === -1 ? a : a.slice(0, eq);
  const inline = eq === -1 ? null : a.slice(eq + 1);
  if (flag === "--stream") stream = inline ?? args[++i];
  else if (flag === "--sha") sha = inline ?? args[++i];
  else if (flag === "--now") nowIso = inline ?? args[++i];
  else if (flag === "--json") asJson = true;
  else {
    console.error(`unknown flag: ${flag}`);
    process.exit(1);
  }
}

if (stream !== "nightly" && stream !== "release") {
  console.error("usage: compute-release-version.js --stream nightly|release");
  process.exit(1);
}

// ─── Inputs ─────────────────────────────────────────────────────────

const versions = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "versions.json"), "utf8"),
);
const addonPkg = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, "src/longtail/addon/package.json"),
    "utf8",
  ),
);

function shortSha() {
  if (sha) return sha.slice(0, 8);
  try {
    return execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function stamp() {
  const d = nowIso ? new Date(nowIso) : new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}` +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes())
  );
}

// ─── Version math ───────────────────────────────────────────────────

/** Drop any existing prerelease/build metadata and bump the patch. */
function nextPatch(version) {
  const core = version.split("-")[0].split("+")[0];
  const parts = core.split(".").map((n) => parseInt(n, 10));
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    console.error(`cannot bump non-semver version: ${version}`);
    process.exit(1);
  }
  parts[2] += 1;
  return parts.join(".");
}

const suffix = `nightly.${stamp()}.g${shortSha()}`;

function forStream(released) {
  return stream === "release" ? released : `${nextPatch(released)}-${suffix}`;
}

const result = {
  stream,
  server_version: forStream(versions.server_version),
  client_version: forStream(versions.client_version),
  addon_version: forStream(addonPkg.version),
  // npm dist-tag and container/GitHub-release channel name.
  channel: stream === "release" ? "latest" : "nightly",
};

// ─── Report ─────────────────────────────────────────────────────────

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  for (const [key, value] of Object.entries(result)) {
    console.log(`${key}=${value}`);
  }
}

const outFile = process.env.GITHUB_OUTPUT;
if (outFile) {
  fs.appendFileSync(
    outFile,
    Object.entries(result)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n",
  );
}
