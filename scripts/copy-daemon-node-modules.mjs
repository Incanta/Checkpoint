// Copies the native runtime modules the daemon SEA needs into
// <dist-sea>/node_modules so the packaged executable can require("better-sqlite3")
// at runtime. better-sqlite3 is a native module (a .node binary) and cannot be
// bundled into the single-file JS blob, so esbuild leaves it external and the
// SEA loads it from disk next to the executable (see esbuild.config.mjs).
//
// Run per-platform during the daemon build so the platform-correct
// better_sqlite3.node (built by `yarn install`) is the one that ships.
//
// Usage: node scripts/copy-sea-node-modules.mjs <dist-sea-dir>
import { createRequire } from "module";
import fs from "fs";
import path from "path";

const require = createRequire(import.meta.url);

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: node scripts/copy-sea-node-modules.mjs <dist-sea-dir>");
  process.exit(1);
}

const nodeModulesDir = path.join(outDir, "node_modules");
fs.mkdirSync(nodeModulesDir, { recursive: true });

function packageDir(name) {
  return path.dirname(require.resolve(`${name}/package.json`));
}

// bindings + file-uri-to-path are tiny pure-JS deps; copy them wholesale.
for (const name of ["bindings", "file-uri-to-path"]) {
  fs.cpSync(packageDir(name), path.join(nodeModulesDir, name), {
    recursive: true,
  });
}

// better-sqlite3 also ships C source (deps/) and build intermediates we don't
// need at runtime, so copy only the essentials: package.json, the JS in lib/,
// and the compiled native binary.
const bsSrc = packageDir("better-sqlite3");
const bsDst = path.join(nodeModulesDir, "better-sqlite3");
const nativeBinary = path.join(bsSrc, "build", "Release", "better_sqlite3.node");

if (!fs.existsSync(nativeBinary)) {
  console.error(
    `better-sqlite3 native binary not found at ${nativeBinary}. ` +
      `Was 'yarn install' run on this platform?`,
  );
  process.exit(1);
}

fs.mkdirSync(path.join(bsDst, "build", "Release"), { recursive: true });
fs.copyFileSync(
  path.join(bsSrc, "package.json"),
  path.join(bsDst, "package.json"),
);
fs.cpSync(path.join(bsSrc, "lib"), path.join(bsDst, "lib"), { recursive: true });
fs.copyFileSync(
  nativeBinary,
  path.join(bsDst, "build", "Release", "better_sqlite3.node"),
);

console.log(
  `Copied better-sqlite3 (+ bindings, file-uri-to-path) into ${nodeModulesDir}`,
);
