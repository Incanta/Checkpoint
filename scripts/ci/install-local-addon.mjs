#!/usr/bin/env node

// Overlay a source-built @checkpointvcs/longtail-addon (the output of
// build-longtail-addon.mjs) onto every installed copy in this checkout, so the
// daemon, server, and app load the C++ from the commit under test instead of
// the published binary.
//
// With nodeLinker: node-modules there is normally a single hoisted copy at
// the repo root, but a workspace that pins a different range gets a nested
// copy, so every workspace's node_modules is checked. The overlay replaces
// dist/ (the TypeScript bindings) and the prebuild for this platform, which
// is the first location the package's loader looks after the
// CHECKPOINT_LONGTAIL_ADDON_PATH override.
//
// Usage:
//   node scripts/ci/install-local-addon.mjs [--from <dir>]   (default .ci/longtail-addon)

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
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
const PACKAGE = path.join("@checkpointvcs", "longtail-addon");

const { values: args } = parseArgs({
  options: { from: { type: "string" } },
});
const fromDir = path.resolve(
  args.from ?? path.join(repoRoot, ".ci", "longtail-addon"),
);

const platform = os.platform();
const arch = os.arch();
const sourceBinary = path.join(
  fromDir,
  "prebuilds",
  `${platform}-${arch}`,
  "longtail_addon.node",
);
const sourceDist = path.join(fromDir, "dist");

if (
  !fs.existsSync(sourceBinary) ||
  !fs.existsSync(path.join(sourceDist, "index.js"))
) {
  console.error(
    `No source-built addon for ${platform}-${arch} under ${fromDir}.`,
  );
  console.error("Run: node scripts/ci/build-longtail-addon.mjs");
  process.exit(1);
}

const sha256 = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sourceHash = sha256(sourceBinary);
let buildInfo = null;
try {
  buildInfo = JSON.parse(
    fs.readFileSync(path.join(fromDir, "BUILD-INFO.json"), "utf-8"),
  );
} catch {
  // optional
}

// Root plus every workspace directory declared in the root package.json.
const rootPkg = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"),
);
const searchRoots = [repoRoot];
for (const pattern of rootPkg.workspaces ?? []) {
  if (pattern.includes("*")) {
    const parent = path.join(repoRoot, pattern.slice(0, pattern.indexOf("*")));
    if (!fs.existsSync(parent)) continue;
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) searchRoots.push(path.join(parent, entry.name));
    }
  } else {
    searchRoots.push(path.join(repoRoot, pattern));
  }
}

const targets = searchRoots
  .map((dir) => path.join(dir, "node_modules", PACKAGE))
  .filter((dir) => fs.existsSync(path.join(dir, "package.json")));

if (targets.length === 0) {
  console.error(
    "No installed copy of @checkpointvcs/longtail-addon found. Run `yarn install` first.",
  );
  process.exit(1);
}

for (const target of targets) {
  const targetDist = path.join(target, "dist");
  fs.rmSync(targetDist, { recursive: true, force: true });
  fs.cpSync(sourceDist, targetDist, { recursive: true });

  const prebuildDir = path.join(target, "prebuilds", `${platform}-${arch}`);
  fs.mkdirSync(prebuildDir, { recursive: true });
  fs.copyFileSync(sourceBinary, path.join(prebuildDir, "longtail_addon.node"));

  fs.writeFileSync(
    path.join(target, "SOURCE-BUILT.json"),
    JSON.stringify({ ...buildInfo, binarySha256: sourceHash }, null, 2) + "\n",
  );
  console.log(`overlaid ${path.relative(repoRoot, target)}`);
}

// Prove the overlay is what actually loads: require the hoisted copy and make
// sure the binary on disk is byte-identical to the one we staged.
const require = createRequire(import.meta.url);
const primary = targets[0];
const installedHash = sha256(
  path.join(primary, "prebuilds", `${platform}-${arch}`, "longtail_addon.node"),
);
if (installedHash !== sourceHash) {
  console.error("Installed binary does not match the staged one after copy");
  process.exit(1);
}
const addon = require(path.join(primary, "dist", "index.js"));
if (
  typeof addon.submitAsync !== "function" ||
  typeof addon.pullAsync !== "function"
) {
  console.error(
    "Source-built addon loaded but does not export submitAsync/pullAsync",
  );
  process.exit(1);
}

console.log(
  `\nsource-built longtail addon in use (${platform}-${arch}, sha256 ${sourceHash.slice(0, 12)}` +
    (buildInfo?.commit ? `, built from ${buildInfo.commit.slice(0, 12)}` : "") +
    `)`,
);
