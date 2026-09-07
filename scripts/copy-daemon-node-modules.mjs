// Copies the native runtime modules the daemon needs into
// <dist-daemon>/node_modules so the bundle can require("better-sqlite3")
// at runtime. better-sqlite3 is a native module (a .node binary) and cannot be
// bundled into the single-file JS bundle, so esbuild leaves it external and the
// daemon loads it from disk next to the runtime (see esbuild.config.mjs).
//
// Run per-platform during the daemon build so the platform-correct
// better_sqlite3.node (built by `yarn install`) is the one that ships.
//
// Usage: node scripts/copy-daemon-node-modules.mjs <dist-daemon-dir>
import { createRequire } from "module";
import fs from "fs";
import path from "path";

const require = createRequire(import.meta.url);

const outDir = process.argv[2];
if (!outDir) {
  console.error(
    "usage: node scripts/copy-daemon-node-modules.mjs <dist-daemon-dir>",
  );
  process.exit(1);
}

const nodeModulesDir = path.join(outDir, "node_modules");
fs.mkdirSync(nodeModulesDir, { recursive: true });

function packageDir(name) {
  return path.dirname(require.resolve(`${name}/package.json`));
}

// better-sqlite3 also ships C source (deps/) and build intermediates we don't
// need at runtime, so copy only the essentials: package.json, the JS in lib/,
// and the one native binary this platform actually loads.
const bsSrc = packageDir("better-sqlite3");
const bsDst = path.join(nodeModulesDir, "better-sqlite3");

// Which binary that is depends on the version. Since v9 the package ships N-API
// prebuilds in prebuilds/<platform>-<arch>.node, lib/binding.js prefers them,
// and binding.gyp turns the compile into a no-op target when one exists for the
// host, so build/Release/better_sqlite3.node is never produced. Older versions
// only ever had build/Release. Ask the package which file it would load rather
// than guessing, so this keeps agreeing with it across upgrades.
//
// Resolution is host-relative (including musl detection), which is why this runs
// per-platform during the daemon build rather than once.
// Guarded because this whole script last broke by assuming a package layout:
// a version without the helper falls back to the pre-v9 build/Release path
// rather than throwing something unrelated to the actual problem.
const { getPrebuildPath } = require(path.join(bsSrc, "lib", "binding.js"));

const prebuild =
  typeof getPrebuildPath === "function" ? getPrebuildPath() : null;
const [nativeSrc, nativeDst] = prebuild
  ? [prebuild, path.join(bsDst, "prebuilds", path.basename(prebuild))]
  : [
      path.join(bsSrc, "build", "Release", "better_sqlite3.node"),
      path.join(bsDst, "build", "Release", "better_sqlite3.node"),
    ];

if (!fs.existsSync(nativeSrc)) {
  console.error(
    `better-sqlite3 native binary not found at ${nativeSrc}. ` +
      `Was 'yarn install' run on this platform?`,
  );
  process.exit(1);
}

fs.mkdirSync(path.dirname(nativeDst), { recursive: true });
fs.copyFileSync(
  path.join(bsSrc, "package.json"),
  path.join(bsDst, "package.json"),
);
fs.cpSync(path.join(bsSrc, "lib"), path.join(bsDst, "lib"), { recursive: true });
fs.copyFileSync(nativeSrc, nativeDst);

console.log(
  `Copied better-sqlite3 into ${nodeModulesDir} (${path.relative(bsSrc, nativeSrc)})`,
);
