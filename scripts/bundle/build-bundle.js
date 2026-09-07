#!/usr/bin/env node
// Assemble a deployment bundle for the app or the core server.
//
// A bundle is everything the runtime image needs to run one component, minus
// the base OS and Node itself: compiled output, the pruned production
// node_modules, config defaults, and (for the app) the Prisma schema,
// migrations and CLI for the chosen provider.
//
// Run AFTER the component has been built in this checkout:
//   app     yarn install && cd src/app && yarn build      (standalone output)
//   server  yarn install && yarn build && cd src/core/server && yarn build
//
// Usage:
//   node scripts/bundle/build-bundle.js --component app --version 0.5.0 \
//     --provider postgresql --out dist-bundles [--commit <sha>] [--sign]
//
// --sign requires CHECKPOINT_BUNDLE_SIGNING_KEY (base64 PKCS8 DER Ed25519) and
// writes <archive>.sig.json alongside the archive. Unsigned bundles are only
// useful for local testing: the runtime refuses them.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { signManifest, sha256File } = require("./signing");

const repoRoot = path.resolve(__dirname, "..", "..");

// The runtime image stamps this same string into CHECKPOINT_RUNTIME_ABI. A
// bundle carries native code (the longtail addon, Prisma query engines) built
// against a specific Node ABI, glibc and OpenSSL, so a mismatch has to be
// refused loudly rather than discovered as a segfault at boot.
const RUNTIME_ABI = "node24-debian12-openssl3";

// ─── Argument parsing ───────────────────────────────────────────────

const args = process.argv.slice(2);
const opt = { out: "dist-bundles" };

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith("--")) {
    console.error(`unexpected argument: ${a}`);
    process.exit(1);
  }
  const eq = a.indexOf("=");
  const flag = (eq === -1 ? a : a.slice(0, eq)).slice(2);
  if (flag === "sign") {
    opt.sign = true;
    continue;
  }
  // Leaves the staged tree next to the archive so its contents can be
  // inspected, or the bundled CLI run, without unpacking anything.
  if (flag === "keep-stage") {
    opt.keepStage = true;
    continue;
  }
  opt[flag] = eq === -1 ? args[++i] : a.slice(eq + 1);
}

const component = opt.component;
if (component !== "app" && component !== "server") {
  console.error("--component must be app or server");
  process.exit(1);
}
if (!opt.version) {
  console.error("--version is required");
  process.exit(1);
}

const provider = component === "app" ? (opt.provider ?? "sqlite") : null;
if (component === "app" && !["sqlite", "postgresql"].includes(provider)) {
  console.error(`--provider must be sqlite or postgresql, got: ${provider}`);
  process.exit(1);
}

// ─── Helpers ────────────────────────────────────────────────────────

function run(cmd, cmdArgs, cwd = repoRoot) {
  execFileSync(cmd, cmdArgs, { cwd, stdio: "inherit" });
}

function copy(from, to, { optional = false } = {}) {
  const src = path.join(repoRoot, from);
  if (!fs.existsSync(src)) {
    if (optional) return false;
    throw new Error(`missing bundle input: ${from} (did the build run?)`);
  }
  const dest = path.join(stageDir, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });
  return true;
}

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
function copyPackageClosure(roots) {
  const copied = [];
  const skipped = [];
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
    const relative = path.join("node_modules", ...name.split("/"));

    if (fs.existsSync(path.join(stageDir, relative))) {
      skipped.push(name);
    } else {
      fs.mkdirSync(path.dirname(path.join(stageDir, relative)), {
        recursive: true,
      });
      fs.cpSync(pkgDir, path.join(stageDir, relative), {
        recursive: true,
        dereference: true,
      });
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

  console.log(
    `  ${roots.join(", ")}: copied ${copied.length} packages` +
      (skipped.length ? `, kept ${skipped.length} already staged` : ""),
  );
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

// ─── Stage ──────────────────────────────────────────────────────────

const outDir = path.resolve(repoRoot, opt.out);
const archiveName =
  component === "app"
    ? `checkpoint-bundle-app-${opt.version}-${provider === "postgresql" ? "postgres" : "sqlite"}.tar.zst`
    : `checkpoint-bundle-server-${opt.version}.tar.zst`;

const stageRoot = path.join(outDir, ".stage");
const stageDir = path.join(stageRoot, component);

fs.rmSync(stageRoot, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

console.log(`Staging ${component} bundle ${opt.version}...`);

if (component === "app") {
  // Next.js standalone output already carries its own traced node_modules and
  // server.js, which is the bulk of the bundle.
  copy("src/app/.next/standalone", ".");
  copy("src/app/.next/static", "src/app/.next/static");
  copy("src/app/public", "src/app/public");

  // Config defaults for @incanta/config. Operators mount their own overrides
  // over src/app/config/local; the runtime bootstrap creates that symlink on
  // each boot, since the path now moves with every bundle.
  copy("src/app/config", "src/app/config");

  // Prisma: schema, the resolved provider's migrations, and the CLI. The CLI
  // ships in the bundle rather than the runtime image so its version can never
  // drift from the schema it has to migrate.
  copy("src/app/prisma/schema.prisma", "src/app/prisma/schema.prisma");
  copy("src/app/prisma/datasource.prisma", "src/app/prisma/datasource.prisma");
  copy(
    `src/app/prisma/migrations-${provider}`,
    "src/app/prisma/migrations",
  );
  // The whole CLI, not just node_modules/prisma: its dependencies are hoisted
  // to the repo root and Next traced none of them, because the app imports the
  // Prisma client and never the CLI.
  copyPackageClosure(["prisma"]);
  // The generated client and its query engine, overwriting whatever Next
  // traced. This checkout's copy is the one `db:set-provider` + `prisma
  // generate` just produced for THIS provider, so it is the authoritative one.
  copy("node_modules/.prisma", "node_modules/.prisma", { optional: true });

  // Next's file tracing does not reliably pick up the native addon's prebuilt
  // binaries. Only the linux-x64 prebuild is meaningful in a container.
  copy(
    "node_modules/@checkpointvcs/longtail-addon/prebuilds/linux-x64",
    "node_modules/@checkpointvcs/longtail-addon/prebuilds/linux-x64",
  );
  copy(
    "node_modules/@checkpointvcs/longtail-addon/package.json",
    "node_modules/@checkpointvcs/longtail-addon/package.json",
  );
  copy(
    "node_modules/@checkpointvcs/longtail-addon/dist",
    "node_modules/@checkpointvcs/longtail-addon/dist",
    { optional: true },
  );

  // TypeScript sources leak into the standalone output via file tracing and
  // are dead weight in the shipped bundle.
  fs.rmSync(path.join(stageDir, "src/app/src"), {
    recursive: true,
    force: true,
  });
} else {
  copy("src/core/common/lib", "src/core/common/lib");
  copy("src/core/common/package.json", "src/core/common/package.json");
  copy("src/core/server/lib", "src/core/server/lib");
  copy("src/core/server/package.json", "src/core/server/package.json");
  copy("src/core/server/config", "src/core/server/config");
  copy("package.json", "package.json");

  // The production-only dependency tree, produced by
  // `yarn workspaces focus --production @checkpointvcs/server` before this
  // script runs. Without that prune this copies the full ~1.8 GB dev tree.
  copy("node_modules", "node_modules");
}

const payloadBytes = dirSize(stageDir);
console.log(`  staged ${(payloadBytes / 1024 / 1024).toFixed(1)} MiB`);

// ─── Archive ────────────────────────────────────────────────────────

const archivePath = path.join(outDir, archiveName);
console.log(`Archiving to ${archiveName}...`);

// --zstd needs the zstd binary, which both CI and the runtime image install.
// Run from the output directory with a bare filename so tar cannot mistake a
// Windows-style path for a host:path spec during local testing.
run("tar", ["--zstd", "-cf", archiveName, "-C", stageDir, "."], outDir);

if (opt.keepStage) {
  console.log(`  staged tree kept at ${stageDir}`);
} else {
  fs.rmSync(stageRoot, { recursive: true, force: true });
}

const archiveBytes = fs.statSync(archivePath).size;
console.log(`  ${(archiveBytes / 1024 / 1024).toFixed(1)} MiB compressed`);

// ─── Manifest ───────────────────────────────────────────────────────

const manifest = {
  schema: 1,
  component,
  version: opt.version,
  provider,
  runtimeAbi: RUNTIME_ABI,
  archive: archiveName,
  size: archiveBytes,
  sha256: sha256File(archivePath),
  commit: opt.commit ?? null,
  createdAt: new Date().toISOString(),
  // How the runtime starts this component once extracted. Keeping it in the
  // manifest means a future bundle can change its own start command without
  // needing a new runtime image.
  // How the runtime starts this component once extracted, and where the
  // operator's mounted config and data have to appear inside the bundle.
  // The old images baked these symlinks into the image; the paths now live
  // inside a bundle that changes per version, so the bootstrap recreates them
  // on every boot. Keeping them in the manifest means a future bundle can move
  // its own layout without needing a new runtime image.
  exec:
    component === "app"
      ? {
          migrate: ["prisma", "migrate", "deploy"],
          migrateCwd: "src/app",
          command: ["node", "src/app/server.js"],
          configDir: "src/app/config",
          // The app reads absolute paths under /app/data, so it needs no link.
          dataDir: null,
        }
      : {
          command: ["node", "src/core/server/lib/index.js"],
          cwd: "src/core/server",
          configDir: "src/core/server/config",
          dataDir: "src/core/server/data",
        },
};

const manifestPath = path.join(outDir, `${archiveName}.sig.json`);

if (opt.sign) {
  const key = process.env["CHECKPOINT_BUNDLE_SIGNING_KEY"];
  if (!key) {
    console.error(
      "--sign requires CHECKPOINT_BUNDLE_SIGNING_KEY (base64 PKCS8 DER Ed25519)",
    );
    process.exit(1);
  }
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(signManifest(manifest, key), null, 2) + "\n",
  );
  console.log(`  signed ${path.basename(manifestPath)}`);
} else {
  // Unsigned: still write the sidecar so local testing has something to read,
  // but leave the signature empty so the runtime refuses it unless explicitly
  // run with CHECKPOINT_BUNDLE_ALLOW_UNSIGNED=1.
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      { schema: 1, manifest: JSON.stringify(manifest), signature: null },
      null,
      2,
    ) + "\n",
  );
  console.log(`  UNSIGNED ${path.basename(manifestPath)} (local testing only)`);
}

const outFile = process.env.GITHUB_OUTPUT;
if (outFile) {
  fs.appendFileSync(
    outFile,
    `archive=${archiveName}\nsize=${archiveBytes}\n`,
  );
}

console.log("done");
