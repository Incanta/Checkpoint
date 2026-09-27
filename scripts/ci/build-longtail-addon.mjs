#!/usr/bin/env node

// Build @checkpointvcs/longtail-addon from the sources in this checkout.
//
// The daemon, server, and app consume the addon from npm, so CI that only
// runs `yarn install` tests whatever binary was last published, not the C++
// in the commit under test. This script produces the same layout the npm
// package ships (dist/ plus prebuilds/<platform>-<arch>/longtail_addon.node)
// under an output directory, which install-local-addon.mjs then overlays onto
// every installed copy. The workflow caches the output directory keyed by a
// hash of the addon, wrapper, and library sources, so the build only runs
// when one of those changed.
//
// Usage:
//   node scripts/ci/build-longtail-addon.mjs [--out <dir>]   (default .ci/longtail-addon)

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const addonDir = path.join(repoRoot, "src", "longtail", "addon");

const { values: args } = parseArgs({
  options: { out: { type: "string" } },
});
const outDir = path.resolve(
  args.out ?? path.join(repoRoot, ".ci", "longtail-addon"),
);

function run(cmd, cwd, env = {}) {
  console.log(`\n  $ ${cmd}  (cwd: ${cwd})`);
  execSync(cmd, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
    timeout: 45 * 60_000,
  });
}

function findAddonBinary(dir) {
  const preferred = path.join(dir, "build", "Release", "longtail_addon.node");
  if (fs.existsSync(preferred)) return preferred;
  const stack = [path.join(dir, "build")];
  while (stack.length) {
    const current = stack.pop();
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === "longtail_addon.node") return full;
    }
  }
  return null;
}

function gitHead() {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}

const platform = os.platform();
const arch = os.arch();

console.log(`Building longtail addon for ${platform}-${arch} into ${outDir}`);

run("yarn install --immutable", addonDir);
run("npx cmake-js install", addonDir);
if (platform === "win32") {
  run("cmd /c build-msvc.bat", addonDir);
} else {
  run("npx cmake-js build --config Release", addonDir, {
    CMAKE_BUILD_PARALLEL_LEVEL: String(os.cpus().length),
  });
}
run("yarn build:ts", addonDir);

const binary = findAddonBinary(addonDir);
if (!binary) {
  console.error(
    "Build finished but no longtail_addon.node was produced under src/longtail/addon/build",
  );
  process.exit(1);
}
const dist = path.join(addonDir, "dist");
if (!fs.existsSync(path.join(dist, "index.js"))) {
  console.error(
    "Build finished but src/longtail/addon/dist/index.js is missing",
  );
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
const prebuildDir = path.join(outDir, "prebuilds", `${platform}-${arch}`);
fs.mkdirSync(prebuildDir, { recursive: true });
fs.copyFileSync(binary, path.join(prebuildDir, "longtail_addon.node"));
fs.cpSync(dist, path.join(outDir, "dist"), { recursive: true });
fs.writeFileSync(
  path.join(outDir, "BUILD-INFO.json"),
  JSON.stringify(
    {
      platform,
      arch,
      node: process.version,
      commit: gitHead(),
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);

console.log(`\nStaged source-built addon:`);
console.log(`  ${path.join(prebuildDir, "longtail_addon.node")}`);
console.log(`  ${path.join(outDir, "dist")}`);
