// Sets the project version across every version-bearing file in one shot.
//
// Updates:
//   - ./VERSION
//   - "version" field in 6 workspace package.json files (app, core, core/common,
//     core/daemon, core/server, clients/desktop). The longtail addon ships on
//     its own release cadence and is intentionally NOT touched.
//   - API_VERSION in src/clients/cli/version.hpp
//   - trayApiVersion in src/clients/tray/main.go
//   - APP_API_VERSION in src/app/src/server/api/api-version.ts. The neighboring
//     APP_MIN_DAEMON_VERSION and APP_RECOMMENDED_DAEMON_VERSION are bumped
//     manually and intentionally NOT touched.
//   - VersionName (semver) and Version (auto-incremented int) in
//     src/clients/unreal/CheckpointSourceControl.uplugin
//
// Usage: node scripts/set-version.js <semver>
//   e.g. node scripts/set-version.js 0.4.0

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/set-version.js <semver>");
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) {
  console.error(`invalid semver: ${version}`);
  process.exit(1);
}

const PACKAGE_JSONS = [
  "src/app/package.json",
  "src/core/package.json",
  "src/core/common/package.json",
  "src/core/daemon/package.json",
  "src/core/server/package.json",
  "src/clients/desktop/package.json",
];

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}
function write(rel, content) {
  fs.writeFileSync(path.join(repoRoot, rel), content);
}

function updateJson(rel, mutate, indent) {
  const raw = read(rel);
  const trailingNewline = raw.endsWith("\n") ? "\n" : "";
  const data = JSON.parse(raw);
  mutate(data);
  write(rel, JSON.stringify(data, null, indent) + trailingNewline);
}

function updateText(rel, pattern, replacement) {
  const raw = read(rel);
  if (!pattern.test(raw)) {
    throw new Error(`pattern not found in ${rel}: ${pattern}`);
  }
  write(rel, raw.replace(pattern, replacement));
}

console.log(`Setting version to ${version}`);

// VERSION file
{
  const raw = read("VERSION");
  const trailingNewline = raw.endsWith("\n") ? "\n" : "";
  write("VERSION", version + trailingNewline);
  console.log("  updated VERSION");
}

// Workspace package.json files (2-space indent).
for (const rel of PACKAGE_JSONS) {
  updateJson(
    rel,
    (pkg) => {
      pkg.version = version;
    },
    2,
  );
  console.log(`  updated ${rel}`);
}

// CLI version header.
updateText(
  "src/clients/cli/version.hpp",
  /constexpr const char\* API_VERSION = "[^"]*";/,
  `constexpr const char* API_VERSION = "${version}";`,
);
console.log("  updated src/clients/cli/version.hpp");

// Tray version constant.
updateText(
  "src/clients/tray/main.go",
  /const trayApiVersion = "[^"]*"/,
  `const trayApiVersion = "${version}"`,
);
console.log("  updated src/clients/tray/main.go");

// App API version. The two neighboring daemon-version constants are bumped
// manually on a different cadence — only APP_API_VERSION is touched here.
updateText(
  "src/app/src/server/api/api-version.ts",
  /export const APP_API_VERSION = "[^"]*";/,
  `export const APP_API_VERSION = "${version}";`,
);
console.log("  updated src/app/src/server/api/api-version.ts");

// Unreal plugin descriptor: bump Version (int) and set VersionName to semver.
// .uplugin files are JSON with tab indentation.
{
  const rel = "src/clients/unreal/CheckpointSourceControl.uplugin";
  let nextVersion;
  updateJson(
    rel,
    (data) => {
      const current = typeof data.Version === "number" ? data.Version : 0;
      nextVersion = current + 1;
      data.Version = nextVersion;
      data.VersionName = version;
    },
    "\t",
  );
  console.log(
    `  updated ${rel} (Version=${nextVersion}, VersionName=${version})`,
  );
}

console.log("done");
