// Staging helpers for deployment bundles.
//
// Split out of build-bundle.js because both of these encode non-obvious facts
// about how the build toolchains lay out node_modules, and both have already
// shipped bundles that booted and then died. They are covered by
// src/tests/src/deploy/bundle-stage.test.ts.

const fs = require("fs");
const path = require("path");

/**
 * Locate an installed package by walking node_modules upward from `fromDir`,
 * the way Node itself resolves. require.resolve is not usable here: many
 * packages have an "exports" map that hides package.json.
 */
function findPackage(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const pkgPath = path.join(dir, "node_modules", name, "package.json");
    if (fs.existsSync(pkgPath)) return pkgPath;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Copy a package and everything it needs at runtime.
 *
 * Copying just node_modules/prisma is not enough. The Prisma CLI's own
 * dependencies (@prisma/config, and through it `effect`) live hoisted at the
 * repo root, so they are present in the dev tree and absent from the bundle:
 * the app bundle's node_modules is Next's traced output, and Next only traces
 * what the app imports, which is the Prisma client, never the CLI.
 *
 * Anything already staged wins. Next's traced copy is the version the app was
 * built against, so a hoisted copy of the same package must not clobber it.
 */
function copyPackageClosure({ roots, repoRoot, stageDir }) {
  const copied = [];
  const kept = [];
  const missing = [];
  const seen = new Set();

  const visit = (name, fromDir, optional) => {
    if (seen.has(name)) return;

    const pkgPath = findPackage(name, fromDir);
    if (!pkgPath) {
      // Optional dependencies are routinely absent (platform-specific builds).
      if (!optional) missing.push(name);
      return;
    }
    seen.add(name);

    const pkgDir = path.dirname(pkgPath);
    const staged = path.join(stageDir, "node_modules", ...name.split("/"));

    if (fs.existsSync(staged)) {
      kept.push(name);
    } else {
      fs.mkdirSync(path.dirname(staged), { recursive: true });
      fs.cpSync(pkgDir, staged, { recursive: true, dereference: true });
      copied.push(name);
    }

    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      visit(dep, pkgDir, false);
    }
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
      visit(dep, pkgDir, true);
    }
  };

  for (const root of roots) visit(root, repoRoot, false);

  if (missing.length) {
    throw new Error(
      `cannot resolve ${missing.join(", ")} from the installed tree; ` +
        `the bundle would fail at runtime (did yarn install run?)`,
    );
  }

  return { copied, kept };
}

/**
 * Rewrite or materialise every symlink in the staged tree.
 *
 * fs.cpSync's `dereference` applies only to the path handed to it; symlinks
 * found while walking are recreated as symlinks. Two toolchains put absolute
 * links into what gets staged:
 *
 *   - Turbopack aliases server externals as
 *     .next/node_modules/<pkg>-<hash> -> <workspace>/node_modules/<pkg>
 *   - Yarn's node-modules linker symlinks every workspace into node_modules
 *
 * Both point at the build workspace, so both dangle once a bundle is extracted
 * to /var/lib/checkpoint. The previous images never hit this because they built
 * and ran at the same path, /app; a versioned bundle directory cannot.
 *
 * A link whose target is also staged becomes a relative link to that copy,
 * which costs nothing and survives extraction anywhere. A link to a package
 * that is not staged is materialised. A link to a repo directory that is not
 * staged (another workspace, e.g. the desktop client inside a server bundle) is
 * dropped: materialising it would smuggle an entire source tree into the
 * bundle, and nothing here should have needed it.
 */
function resolveStagedSymlinks({ repoRoot, stageDir, log = () => {} }) {
  const summary = { relinked: 0, materialised: 0, dropped: 0 };

  const contains = (parent, child) => {
    const rel = path.relative(parent, child);
    return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
  };

  const relativeLink = (from, to) =>
    path.relative(path.dirname(from), to).split(path.sep).join("/") || ".";

  // Returns true if it created new content that may itself contain symlinks.
  const handle = (linkPath) => {
    let target;
    try {
      target = fs.realpathSync(linkPath);
    } catch {
      log(`  dropping broken link ${path.relative(stageDir, linkPath)}`);
      fs.rmSync(linkPath, { recursive: true, force: true });
      summary.dropped++;
      return false;
    }

    // Already pointing inside the bundle: either a link the source tree meant
    // to be internal, or one an earlier pass rewrote.
    if (contains(stageDir, target)) return false;

    const isInsideRepo = contains(repoRoot, target);
    const inRepo = isInsideRepo ? path.relative(repoRoot, target) : null;
    const staged = inRepo ? path.join(stageDir, inRepo) : null;

    if (staged && fs.existsSync(staged)) {
      // node_modules/.bin entries link to files, not directories. The type is
      // ignored on POSIX but wrong enough to matter if anyone builds on Windows.
      const type = fs.statSync(staged).isDirectory() ? "dir" : "file";
      fs.rmSync(linkPath, { recursive: true, force: true });
      try {
        // "dir", not "junction": a junction must be an absolute path, which is
        // the whole problem being fixed here.
        fs.symlinkSync(relativeLink(linkPath, staged), linkPath, type);
        summary.relinked++;
        return false;
      } catch (err) {
        // Windows refuses symlinks without Developer Mode or elevation. Local
        // bundle builds still need to produce something that runs.
        if (err.code !== "EPERM" && err.code !== "EACCES") throw err;
        fs.cpSync(staged, linkPath, { recursive: true, dereference: true });
        summary.materialised++;
        return true;
      }
    }

    if (inRepo && !inRepo.split(path.sep).includes("node_modules")) {
      log(
        `  dropping ${path.relative(stageDir, linkPath)} -> ${inRepo} (not in this bundle)`,
      );
      fs.rmSync(linkPath, { recursive: true, force: true });
      summary.dropped++;
      return false;
    }

    fs.rmSync(linkPath, { recursive: true, force: true });
    fs.cpSync(target, linkPath, { recursive: true, dereference: true });
    summary.materialised++;
    return true;
  };

  // Materialising can bring in further symlinks, so walk until a pass is clean.
  for (let pass = 0; ; pass++) {
    let rescan = false;

    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          if (handle(full)) rescan = true;
        } else if (entry.isDirectory()) {
          walk(full);
        }
      }
    };

    walk(stageDir);
    if (!rescan) break;
    if (pass === 4) {
      throw new Error("symlink resolution did not settle after 5 passes");
    }
  }

  return summary;
}

// Line-anchored on purpose. This runs over compiled-but-not-minified output,
// where imports sit at the start of a line; a looser pattern matches the word
// "from" inside SQL strings and every other quoted fragment in the file.
//
// Dynamic `import(...)` is matched anywhere, but `require(...)` deliberately is
// not: these workspaces are "type": "module", so a require call in the output
// is a string rather than a call, and matching it turns prose into a build
// failure.
/**
 * Peers that exist for typing and are never loaded at runtime.
 *
 * A production install drops them by design: typescript is a devDependency
 * everywhere, and @types/* packages contain only declaration files. Reporting
 * them as missing would fail every server bundle over @trpc/client's
 * `typescript` peer, which no running server has ever needed.
 */
function isTypeOnly(name) {
  return name === "typescript" || name.startsWith("@types/");
}

const IMPORT_PATTERNS = [
  /^\s*(?:import|export)\s[^\n]*?\bfrom\s*["']([^"']+)["']/gm,
  /^\s*import\s*["']([^"']+)["']/gm,
  /(?<![\w$.])import\(\s*["']([^"']+)["']\s*\)/g,
];

/**
 * Check that every package the staged code imports is actually in the bundle.
 *
 * Yarn hoists, so a workspace can import a package it never declared and work
 * fine in the dev tree. `yarn workspaces focus --production` then prunes to
 * what IS declared, and the bundle boots without it. That is how the core
 * server shipped importing @incanta/config, date-fns, njwt, pino, pino-pretty
 * and yup while declaring none of them.
 *
 * Presence of the package directory is the question, not full specifier
 * resolution: subpath "exports" maps make require.resolve throw for packages
 * that are present and perfectly loadable, and a missing package is the failure
 * mode that actually takes the container down.
 *
 * The direct imports are only the starting point. From there this follows the
 * dependency graph through the staged tree, because a package can be present
 * while something it needs is not: Yarn never installs peer dependencies, so
 * @trpc/client arrived without @trpc/server, which it imports from splitLink.
 * That took the server down one boot after the undeclared imports above were
 * fixed, and scanning our own output could not have seen it.
 *
 * Following reachability rather than auditing every package in node_modules
 * matters for accuracy: plenty of packages declare peers they do not really
 * require (app-builder-lib asks for electron-builder-squirrel-windows without
 * marking it optional), and flagging those would fail builds over packages the
 * bundle never loads.
 */
function verifyBundleResolves({ stageDir, scanDirs }) {
  const builtins = new Set(require("module").builtinModules);
  const missing = new Map();

  const packageName = (specifier) => {
    const parts = specifier.split("/");
    return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  };

  // Node's own resolution: walk node_modules upward, stopping at the bundle
  // root so nothing resolves against the build machine's tree.
  const findWithin = (name, fromDir) => {
    let dir = fromDir;
    for (;;) {
      const candidate = path.join(dir, "node_modules", name);
      if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
      if (path.resolve(dir) === path.resolve(stageDir)) return null;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  };

  // Work list of packages to account for, seeded by the direct imports below.
  const pending = [];
  const request = (name, from, reason) => pending.push({ name, from, reason });

  const scanFile = (file) => {
    const source = fs.readFileSync(file, "utf8");
    const specifiers = new Set();
    for (const pattern of IMPORT_PATTERNS) {
      for (const m of source.matchAll(pattern)) specifiers.add(m[1]);
    }

    const from = path.dirname(file);

    for (const specifier of specifiers) {
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      if (specifier.startsWith("node:")) continue;
      const name = packageName(specifier);
      if (builtins.has(name)) continue;

      request(name, from, `imported by ${path.relative(stageDir, file)}`);
    }
  };

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) scanFile(full);
    }
  };

  for (const relative of scanDirs) {
    const dir = path.join(stageDir, relative);
    if (fs.existsSync(dir)) walk(dir);
  }

  // Walk out from those imports through the dependency graph as it exists in
  // the bundle. Each package is expanded once; a package reached from two
  // places resolves to the same directory and is only opened once.
  const expanded = new Set();
  let checked = 0;

  while (pending.length) {
    const { name, from, reason } = pending.shift();
    checked++;

    const dir = findWithin(name, from);
    if (!dir) {
      if (!missing.has(name)) missing.set(name, reason);
      continue;
    }
    if (expanded.has(dir)) continue;
    expanded.add(dir);

    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const label = pkg.name ?? name;

    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      request(dep, dir, `dependency of ${label}`);
    }

    // Optional dependencies are absent by design when they do not apply, so
    // they are followed if present and never reported.
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
      if (findWithin(dep, dir)) request(dep, dir, `optional dependency of ${label}`);
    }

    for (const peer of Object.keys(pkg.peerDependencies ?? {})) {
      if (pkg.peerDependenciesMeta?.[peer]?.optional) continue;
      if (builtins.has(peer) || isTypeOnly(peer)) continue;
      request(peer, dir, `peer dependency of ${label}`);
    }
  }

  if (missing.size) {
    const lines = [...missing]
      .map(([name, reason]) => `  ${name}: ${reason}`)
      .join("\n");
    throw new Error(
      `the bundle is missing packages it needs at runtime:\n${lines}\n` +
        `Declare them in the importing workspace's package.json. Hoisting hides ` +
        `a missing dependency, and Yarn never installs peers, until the tree is ` +
        `pruned for production.`,
    );
  }

  return { scanned: checked, packages: expanded.size };
}

module.exports = {
  findPackage,
  copyPackageClosure,
  resolveStagedSymlinks,
  verifyBundleResolves,
};
