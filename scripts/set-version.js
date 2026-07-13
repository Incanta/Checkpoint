// Source of truth for all versions in this repo is `./versions.json`. This
// script bumps the user-facing semver versions (server_version + client_version)
// in that file, then propagates them to every place a version is required:
//
//   - workspace package.json files (split by server vs. client)
//   - generated TypeScript constants — TWO files:
//       src/core/common/src/versions-generated.ts (server-side + bundled clients)
//       src/app/src/server/api/versions-generated.ts (app only; sidesteps a
//         type-resolution cycle with common/utils/api.ts importing
//         @checkpointvcs/app's AppRouter type)
//   - generated C++ header (src/clients/cli/version.hpp)
//   - generated Go file (src/clients/tray/version.go)
//   - Unreal plugin descriptor (Version int auto-incremented, VersionName set)
//
// The four integer API versions (server_api, min_server_api, daemon_api,
// min_daemon_api) are only touched when their flags are passed. Bump them
// when there's an actual wire-format break.
//
// Usage:
//   node scripts/set-version.js <semver>            # bumps both server + client
//   node scripts/set-version.js --client <semver>   # bumps client only
//   node scripts/set-version.js --server <semver>   # bumps server only
//   (combine --client and --server to set them independently)
//
//   Integer API versions (independent of the semver flags above):
//   node scripts/set-version.js --server-api <int>
//   node scripts/set-version.js --min-server-api <int>
//   node scripts/set-version.js --daemon-api <int>
//   node scripts/set-version.js --min-daemon-api <int>

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const versionsJsonPath = path.join(repoRoot, "versions.json");

// ─── Argument parsing ───────────────────────────────────────────────

const args = process.argv.slice(2);
let positional = null;
let clientArg = null;
let serverArg = null;
// Integer API-version flags. null means "leave whatever versions.json has".
const apiArgs = {
  server_api: null,
  min_server_api: null,
  daemon_api: null,
  min_daemon_api: null,
};
// Maps a CLI flag to its versions.json key.
const API_FLAGS = {
  "--server-api": "server_api",
  "--min-server-api": "min_server_api",
  "--daemon-api": "daemon_api",
  "--min-daemon-api": "min_daemon_api",
};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const eq = a.indexOf("=");
  const flag = eq === -1 ? a : a.slice(0, eq);
  const inlineVal = eq === -1 ? null : a.slice(eq + 1);
  if (flag === "--client") {
    clientArg = inlineVal ?? args[++i];
  } else if (flag === "--server") {
    serverArg = inlineVal ?? args[++i];
  } else if (Object.prototype.hasOwnProperty.call(API_FLAGS, flag)) {
    apiArgs[API_FLAGS[flag]] = inlineVal ?? args[++i];
  } else if (!a.startsWith("--")) {
    positional = a;
  } else {
    console.error(`unknown flag: ${flag}`);
    process.exit(1);
  }
}

const anyApiArg = Object.values(apiArgs).some((v) => v != null);
if (!positional && !clientArg && !serverArg && !anyApiArg) {
  console.error(
    "usage: node scripts/set-version.js <semver> [--client <x>] [--server <x>]\n" +
      "       [--server-api <n>] [--min-server-api <n>] [--daemon-api <n>] [--min-daemon-api <n>]",
  );
  process.exit(1);
}

const semverRe = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
function assertSemver(v, label) {
  if (!semverRe.test(v)) {
    console.error(`invalid semver for ${label}: ${v}`);
    process.exit(1);
  }
}

// Resolve final values: explicit flags win, else positional applies to both.
const newClient = clientArg ?? positional;
const newServer = serverArg ?? positional;
if (newClient) assertSemver(newClient, "client_version");
if (newServer) assertSemver(newServer, "server_version");

function parseApiInt(v, label) {
  if (!/^\d+$/.test(v)) {
    console.error(`invalid integer for ${label}: ${v}`);
    process.exit(1);
  }
  return parseInt(v, 10);
}
// Resolve API-version integers (null stays null so we leave versions.json alone).
const newApi = {};
for (const [key, raw] of Object.entries(apiArgs)) {
  newApi[key] = raw == null ? null : parseApiInt(raw, key);
}

// ─── Read versions.json ─────────────────────────────────────────────

const versions = JSON.parse(fs.readFileSync(versionsJsonPath, "utf8"));

if (newClient) versions.client_version = newClient;
if (newServer) versions.server_version = newServer;
for (const [key, val] of Object.entries(newApi)) {
  if (val != null) versions[key] = val;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}
function write(rel, content) {
  fs.writeFileSync(path.join(repoRoot, rel), content);
  console.log(`  wrote ${rel}`);
}
function updateJson(rel, mutate, indent) {
  const raw = read(rel);
  const trailingNewline = raw.endsWith("\n") ? "\n" : "";
  const data = JSON.parse(raw);
  mutate(data);
  write(rel, JSON.stringify(data, null, indent) + trailingNewline);
}

// ─── Write versions.json ─────────────────────────────────────────────

console.log(
  `Setting versions: server=${versions.server_version}, client=${versions.client_version}`,
);
if (anyApiArg) {
  console.log(
    `Setting API versions: server_api=${versions.server_api}, min_server_api=${versions.min_server_api}, daemon_api=${versions.daemon_api}, min_daemon_api=${versions.min_daemon_api}`,
  );
}
write("versions.json", JSON.stringify(versions, null, 2) + "\n");

// ─── Workspace package.json files ───────────────────────────────────

const SERVER_PACKAGES = [
  "src/app/package.json",
  "src/core/server/package.json",
];
const CLIENT_PACKAGES = [
  "src/core/package.json",
  "src/core/common/package.json",
  "src/core/daemon/package.json",
  "src/clients/desktop/package.json",
  "src/clients/vscode/package.json",
];

for (const rel of SERVER_PACKAGES) {
  updateJson(
    rel,
    (pkg) => {
      pkg.version = versions.server_version;
    },
    2,
  );
}
for (const rel of CLIENT_PACKAGES) {
  updateJson(
    rel,
    (pkg) => {
      pkg.version = versions.client_version;
    },
    2,
  );
}

// ─── Generated TypeScript constants (consumed via @checkpointvcs/common) ───

write(
  "src/core/common/src/versions-generated.ts",
  `// AUTO-GENERATED by scripts/set-version.js — do not edit manually.
// Source of truth: versions.json at the repo root.
//
// User-facing semver versions:
//   SERVER_VERSION — src/app + src/core/server share this
//   CLIENT_VERSION — src/core/daemon + src/clients/{desktop,vscode,cli,tray} share this
//
// Integer API versions. Bump only when there's an actual wire-format break:
//   SERVER_API     — current server API the running server speaks
//   MIN_SERVER_API — minimum server-API a connecting daemon must speak
//   DAEMON_API     — current daemon API the running daemon speaks
//   MIN_DAEMON_API — minimum daemon-API a connecting client must speak

export const SERVER_VERSION = ${JSON.stringify(versions.server_version)};
export const CLIENT_VERSION = ${JSON.stringify(versions.client_version)};
export const SERVER_API = ${versions.server_api};
export const MIN_SERVER_API = ${versions.min_server_api};
export const DAEMON_API = ${versions.daemon_api};
export const MIN_DAEMON_API = ${versions.min_daemon_api};
`,
);

// ─── App-local copy (avoids the common ↔ app type cycle) ────────────

write(
  "src/app/src/server/api/versions-generated.ts",
  `// AUTO-GENERATED by scripts/set-version.js — do not edit manually.
// Source of truth: versions.json at the repo root.
//
// This file mirrors src/core/common/src/versions-generated.ts but lives in
// the app to avoid a type-resolution cycle:
//
//   common/utils/api.ts has \`import type { AppRouter } from "@checkpointvcs/app"\`,
//   so if app re-exported these from common, the app's own build would
//   transitively pull in its own dist/ as inputs and fail with TS5055.

export const SERVER_VERSION = ${JSON.stringify(versions.server_version)};
export const SERVER_API = ${versions.server_api};
export const MIN_SERVER_API = ${versions.min_server_api};
`,
);

// ─── Generated C++ header for the CLI ───────────────────────────────

write(
  "src/clients/cli/version.hpp",
  `// AUTO-GENERATED by scripts/set-version.js — do not edit manually.
// Source of truth: versions.json at the repo root.
#pragma once

namespace checkpoint {

// User-facing semver version of the bundled client installation.
constexpr const char* CLIENT_VERSION = ${JSON.stringify(versions.client_version)};

// Integer daemon-API version this CLI was built against. Compared against
// the daemon's min_daemon_api at connect time.
constexpr int DAEMON_API = ${versions.daemon_api};

}  // namespace checkpoint
`,
);

// ─── Generated Go file for the tray ─────────────────────────────────

write(
  "src/clients/tray/version.go",
  `// AUTO-GENERATED by scripts/set-version.js — do not edit manually.
// Source of truth: versions.json at the repo root.
package main

// User-facing semver version of the bundled client installation.
const ClientVersion = ${JSON.stringify(versions.client_version)}

// Integer daemon-API version this tray was built against. Compared against
// the daemon's min_daemon_api at connect time.
const DaemonAPI = ${versions.daemon_api}
`,
);

// ─── Unreal plugin descriptor ───────────────────────────────────────
// The plugin's API_VERSION (in CheckpointDaemonClient.h) is managed
// independently — the Unreal plugin has its own release cadence and may run
// against an older daemon_api than the current versions.json. This script
// only bumps the descriptor's VersionName (semver shown in the editor) and
// auto-increments the integer Version (Unreal's required ascending counter).
//
// The descriptor tracks client_version, so only touch it when the client
// semver changed. An API-only run must not bump the ascending Version.
if (newClient) {
  const rel = "src/clients/unreal/CheckpointSourceControl.uplugin";
  let nextVersion;
  updateJson(
    rel,
    (data) => {
      const current = typeof data.Version === "number" ? data.Version : 0;
      nextVersion = current + 1;
      data.Version = nextVersion;
      data.VersionName = versions.client_version;
    },
    "\t",
  );
  console.log(
    `  Unreal plugin: Version=${nextVersion}, VersionName=${versions.client_version}`,
  );
}

console.log("done");
