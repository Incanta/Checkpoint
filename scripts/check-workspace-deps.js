/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-require-imports */

// Verifies that every workspace declares the same version range as the root
// package.json for any dep the root also declares.
//
// Mismatches matter:
//   - "*" or a looser range in a workspace lets yarn resolve a different
//     version than the root, producing duplicate installs at
//     <workspace>/node_modules/. TypeScript then sees two copies of the same
//     package as distinct type identities ("Type X is not assignable to type
//     X"). An ESM-only major sneaking into a CJS workspace is worse.
//   - The "*" range in particular doesn't mean "use the same as root" — it
//     means "any version", which yarn is free to satisfy independently.
//
// Run with --fix to auto-sync workspace ranges from the root package.json.
// Then `yarn install` to refresh yarn.lock.

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const FIX = process.argv.includes("--fix");

// Protocol-prefixed refs that are workspace-internal or otherwise not subject
// to version-range checks against the root.
const SKIP_PROTOCOLS = [
  "workspace:",
  "link:",
  "portal:",
  "file:",
  "patch:",
  "git",
  "http:",
  "https:",
];

function readPkg(pkgPath) {
  return JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
}

function writePkg(pkgPath, pkg) {
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

// Minimal glob support — handles the patterns Checkpoint actually uses
// (literal paths, "<prefix>/*"). Avoids pulling in a glob dependency.
function expandWorkspacePattern(pattern, baseDir) {
  if (!pattern.includes("*")) return [pattern];
  const idx = pattern.indexOf("*");
  // Only support trailing "/*".
  if (pattern.slice(idx) !== "*" || pattern[idx - 1] !== "/") return [pattern];
  const parentDir = pattern.slice(0, idx - 1);
  const fullParent = path.join(baseDir, parentDir);
  if (!fs.existsSync(fullParent)) return [];
  const out = [];
  for (const entry of fs.readdirSync(fullParent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    out.push(path.posix.join(parentDir, entry.name));
  }
  return out;
}

function collectWorkspaces() {
  const rootPkg = readPkg(path.join(repoRoot, "package.json"));
  const visited = new Set();
  const result = []; // { relPath, pkgPath, pkg }
  const queue = (rootPkg.workspaces || []).map((w) => ({
    pattern: w,
    baseDir: repoRoot,
    relBase: "",
  }));

  while (queue.length > 0) {
    const { pattern, baseDir, relBase } = queue.shift();
    const expanded = expandWorkspacePattern(pattern, baseDir);
    for (const rel of expanded) {
      const fullRel = path.posix.join(relBase, rel);
      if (visited.has(fullRel)) continue;
      visited.add(fullRel);

      const pkgPath = path.join(repoRoot, fullRel, "package.json");
      if (!fs.existsSync(pkgPath)) continue;

      const pkg = readPkg(pkgPath);
      result.push({ relPath: fullRel, pkgPath, pkg });

      // Recurse into nested workspaces — their patterns are relative to
      // their own dir.
      if (Array.isArray(pkg.workspaces)) {
        const subBaseDir = path.join(repoRoot, fullRel);
        for (const sub of pkg.workspaces) {
          queue.push({ pattern: sub, baseDir: subBaseDir, relBase: fullRel });
        }
      }
    }
  }

  return { rootPkg, workspaces: result };
}

function isSkippedSpec(spec) {
  if (typeof spec !== "string") return true;
  return SKIP_PROTOCOLS.some((p) => spec.startsWith(p));
}

function main() {
  const { rootPkg, workspaces } = collectWorkspaces();

  const rootRanges = {
    ...(rootPkg.dependencies || {}),
    ...(rootPkg.devDependencies || {}),
  };

  let anyMismatch = false;
  let anyFixed = false;
  const sections = ["dependencies", "devDependencies", "peerDependencies"];

  for (const ws of workspaces) {
    const label = ws.pkg.name || ws.relPath;
    const mismatches = []; // { section, name, declared, expected }

    for (const section of sections) {
      const deps = ws.pkg[section];
      if (!deps) continue;
      for (const [name, declared] of Object.entries(deps)) {
        if (isSkippedSpec(declared)) continue;
        const expected = rootRanges[name];
        if (!expected) continue;
        if (declared !== expected) {
          mismatches.push({ section, name, declared, expected });
        }
      }
    }

    if (mismatches.length === 0) {
      console.log(`${label}: ok`);
      continue;
    }

    if (FIX) {
      for (const m of mismatches) {
        ws.pkg[m.section][m.name] = m.expected;
      }
      writePkg(ws.pkgPath, ws.pkg);
      console.log(
        `${label}: fixed ${mismatches.length} version range(s) to match root`,
      );
      anyFixed = true;
    } else {
      console.error(
        `\n${label}: ${mismatches.length} dep version(s) don't match root:`,
      );
      for (const m of mismatches.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        console.error(
          `  - ${m.section}/${m.name}: declared "${m.declared}", root has "${m.expected}"`,
        );
      }
      anyMismatch = true;
    }
  }

  if (anyMismatch) {
    console.error(
      "\nVersion-range mismatches let yarn install duplicate copies of the\n" +
        "same package — one at the root and one in the workspace's\n" +
        'node_modules. TypeScript sees them as distinct identities ("Type X\n' +
        'is not assignable to type X"), and an ESM-only major shipping into\n' +
        "a CJS workspace will break at runtime.\n" +
        "\n" +
        "Re-run with `--fix` to sync ranges from the root package.json,\n" +
        "then `yarn install` to refresh yarn.lock.",
    );
    process.exit(1);
  }

  if (FIX && anyFixed) {
    console.log(
      "\nRun `yarn install` to refresh yarn.lock with the new version ranges.",
    );
  }
}

main();
