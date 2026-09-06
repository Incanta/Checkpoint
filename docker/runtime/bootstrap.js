#!/usr/bin/env node
// Checkpoint runtime bootstrap: PID 1 of the runtime image.
//
// The runtime image carries no application code. This script resolves which
// bundle should be running, makes sure it is present and trustworthy on the
// state volume, and execs it. "Installing an update" is therefore just writing
// a new desired version and exiting: Docker's restart policy brings the
// container back and this script picks up the new bundle.
//
// Three modes, in precedence order:
//
//   CHECKPOINT_BUNDLE_PATH=/bundles/x.tar.zst
//       Offline. Uses a bundle the operator mounted. Never reaches the network,
//       never self-updates. This is the air-gapped path.
//
//   CHECKPOINT_BUNDLE_VERSION=0.5.0
//       Pinned. Downloads that exact version once and stays there. Self-update
//       is refused, so the deployment stays whatever its manifest says. This is
//       the GitOps/Kubernetes path.
//
//   CHECKPOINT_BUNDLE_CHANNEL=release|nightly
//       Following. Boots at the desired version if one has been staged by an
//       admin, otherwise whatever the channel manifest currently points at.
//       This is the docker-compose path.
//
// Bundles are Ed25519-signed and verified against the public key published in
// DNS. An unsigned or badly-signed bundle is refused: this process executes
// what it downloads.

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { execFileSync, spawn } = require("child_process");

// In the image, signing.js sits next to this file (see the Dockerfile COPY).
// Running straight out of a checkout, it is still at its source location.
const signing = (() => {
  try {
    return require("./signing.js");
  } catch {
    return require("../../scripts/bundle/signing.js");
  }
})();
const { resolvePublicKey, verifySidecar, sha256File } = signing;

// ─── Arguments ──────────────────────────────────────────────────────
//
// With no arguments this is PID 1 and boots the component. With --stage it
// downloads, verifies and extracts one bundle and exits, which is how the
// running app pre-stages an update: the admin panel shells out to this same
// script rather than reimplementing signature verification in the app.

const argv = process.argv.slice(2);
const cli = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) continue;
  const eq = a.indexOf("=");
  const flag = (eq === -1 ? a : a.slice(0, eq)).slice(2);
  if (flag === "stage") {
    cli.stage = true;
    continue;
  }
  cli[flag] = eq === -1 ? argv[++i] : a.slice(eq + 1);
}

// ─── Environment ────────────────────────────────────────────────────

const COMPONENT = cli.component || process.env["CHECKPOINT_COMPONENT"];
const STATE_DIR = process.env["CHECKPOINT_STATE_DIR"] || "/var/lib/checkpoint";
const REPOSITORY = process.env["CHECKPOINT_REPOSITORY"] || "Incanta/Checkpoint";
const CHANNEL = process.env["CHECKPOINT_BUNDLE_CHANNEL"] || "release";
const PINNED = process.env["CHECKPOINT_BUNDLE_VERSION"] || "";
const LOCAL_PATH = process.env["CHECKPOINT_BUNDLE_PATH"] || "";
const DB_PROVIDER = process.env["CHECKPOINT_DB_PROVIDER"] || "sqlite";
const RUNTIME_ABI = process.env["CHECKPOINT_RUNTIME_ABI"] || "";
const ALLOW_UNSIGNED =
  process.env["CHECKPOINT_BUNDLE_ALLOW_UNSIGNED"] === "1";
// How many superseded bundles to keep on disk for rollback.
const KEEP_BUNDLES = parseInt(
  process.env["CHECKPOINT_BUNDLE_KEEP"] || "2",
  10,
);

// Validated only when actually booting: the verification helpers below are
// imported by the test suite, which has no container environment to satisfy.
function validateEnvironment() {
  if (COMPONENT !== "app" && COMPONENT !== "server") {
    fatal("CHECKPOINT_COMPONENT must be 'app' or 'server'");
  }
  if (!["sqlite", "postgresql"].includes(DB_PROVIDER)) {
    fatal(
      `CHECKPOINT_DB_PROVIDER must be sqlite or postgresql, got ${DB_PROVIDER}`,
    );
  }
}

// Staging always fetches a named version from a release; the deployment's own
// mode is irrelevant to it.
const MODE = cli.stage
  ? "channel"
  : LOCAL_PATH
    ? "local"
    : PINNED
      ? "pinned"
      : "channel";

// COMPONENT is unset when the verification helpers are imported by tests
// rather than run as PID 1; validateEnvironment() rejects that for real boots.
const paths = {
  bundles: path.join(STATE_DIR, "bundles", COMPONENT || "unset"),
  downloads: path.join(STATE_DIR, "downloads"),
  state: path.join(STATE_DIR, "state"),
  desired: path.join(STATE_DIR, "state", "desired.json"),
  component: path.join(STATE_DIR, "state", `${COMPONENT}.json`),
};

// ─── Logging ────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[bootstrap] ${msg}`);
}
function warn(msg) {
  console.warn(`[bootstrap] WARN ${msg}`);
}
function fatal(msg) {
  console.error(`[bootstrap] FATAL ${msg}`);
  process.exit(1);
}

// ─── State helpers ──────────────────────────────────────────────────

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename so a crash mid-write cannot leave the container unable to
  // read its own state on the next boot.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** Directory a given version is extracted into. */
function bundleDir(version) {
  const suffix = COMPONENT === "app" ? `-${DB_PROVIDER}` : "";
  return path.join(paths.bundles, `${version}${suffix}`);
}

function assetName(version, component = COMPONENT, dbProvider = DB_PROVIDER) {
  if (component === "app") {
    const tag = dbProvider === "postgresql" ? "postgres" : "sqlite";
    return `checkpoint-bundle-app-${version}-${tag}.tar.zst`;
  }
  return `checkpoint-bundle-server-${version}.tar.zst`;
}

// ─── Network ────────────────────────────────────────────────────────

function httpGet(url, { json = false } = {}) {
  return new Promise((resolve, reject) => {
    const request = (target, redirects) => {
      if (redirects > 5) return reject(new Error("too many redirects"));
      https
        .get(
          target,
          { headers: { "User-Agent": "Checkpoint-Runtime-Bootstrap" } },
          (res) => {
            if (
              res.statusCode >= 300 &&
              res.statusCode < 400 &&
              res.headers.location
            ) {
              res.resume();
              return request(res.headers.location, redirects + 1);
            }
            if (res.statusCode !== 200) {
              res.resume();
              return reject(
                new Error(`GET ${target} returned ${res.statusCode}`),
              );
            }
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (body += c));
            res.on("end", () => {
              try {
                resolve(json ? JSON.parse(body) : body);
              } catch (err) {
                reject(err);
              }
            });
          },
        )
        .on("error", reject);
    };
    request(url, 0);
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const request = (target, redirects) => {
      if (redirects > 5) return reject(new Error("too many redirects"));
      https
        .get(
          target,
          { headers: { "User-Agent": "Checkpoint-Runtime-Bootstrap" } },
          (res) => {
            if (
              res.statusCode >= 300 &&
              res.statusCode < 400 &&
              res.headers.location
            ) {
              res.resume();
              return request(res.headers.location, redirects + 1);
            }
            if (res.statusCode !== 200) {
              res.resume();
              return reject(
                new Error(`GET ${target} returned ${res.statusCode}`),
              );
            }
            const total = parseInt(res.headers["content-length"] || "0", 10);
            let seen = 0;
            let lastPct = -1;
            const file = fs.createWriteStream(dest);
            res.on("data", (chunk) => {
              seen += chunk.length;
              if (total > 0) {
                const pct = Math.floor((seen / total) * 100);
                if (pct >= lastPct + 10) {
                  lastPct = pct;
                  log(`  ${pct}%`);
                }
              }
            });
            res.pipe(file);
            file.on("finish", () => file.close(() => resolve()));
            file.on("error", (err) => {
              fs.rmSync(dest, { force: true });
              reject(err);
            });
          },
        )
        .on("error", reject);
    };
    request(url, 0);
  });
}

function manifestUrl() {
  if (CHANNEL === "nightly") {
    return `https://github.com/${REPOSITORY}/releases/download/nightly/checkpoint-nightly.json`;
  }
  return `https://github.com/${REPOSITORY}/releases/latest/download/checkpoint-release.json`;
}

function releaseAssetUrl(tag, asset) {
  return `https://github.com/${REPOSITORY}/releases/download/${tag}/${asset}`;
}

// ─── Resolve the target version ─────────────────────────────────────

async function resolveTarget() {
  if (MODE === "local") {
    return { version: null, tag: null, source: "local bundle" };
  }

  if (MODE === "pinned") {
    return {
      version: PINNED,
      // Pinning targets published releases, whose assets live on v<version>.
      // Nightly versions only ever exist on the rolling `nightly` tag and are
      // replaced there, so they are not pinnable by design.
      tag: `v${PINNED}`,
      source: "CHECKPOINT_BUNDLE_VERSION",
    };
  }

  // Channel mode. An admin-staged version wins over the channel pointer, which
  // is what makes "install this update" stick across restarts.
  const desired = readJson(paths.desired);
  if (desired?.version) {
    return {
      version: desired.version,
      tag: desired.releaseTag || `v${desired.version}`,
      source: `staged by ${desired.requestedBy || "an admin"}`,
    };
  }

  log(`Reading the ${CHANNEL} channel manifest...`);
  const manifest = await httpGet(manifestUrl(), { json: true });
  const server = manifest?.components?.server;
  if (!server?.version) {
    throw new Error(`${CHANNEL} manifest carries no server version`);
  }
  return {
    version: server.version,
    tag: server.releaseTag || `v${server.version}`,
    source: `${CHANNEL} channel`,
  };
}

// ─── Fetch and verify ───────────────────────────────────────────────

/**
 * Everything that must hold before a downloaded bundle is allowed to run.
 * Split out from extraction so it can be tested without a container: these
 * checks are the whole security and compatibility story, and each one exists
 * because the failure it prevents is otherwise very hard to diagnose.
 *
 * Exported for src/tests/src/deploy/bundle-verify.test.ts.
 */
async function checkBundle(manifest, archiveSha256, context) {
  const { component, runtimeAbi, dbProvider } = context;

  if (archiveSha256 !== manifest.sha256) {
    throw new Error(
      `bundle hash mismatch: manifest says ${manifest.sha256}, archive is ${archiveSha256}`,
    );
  }

  if (manifest.component !== component) {
    throw new Error(
      `bundle is for component "${manifest.component}", this container runs "${component}"`,
    );
  }

  // Native code inside the bundle (the longtail addon, Prisma query engines) is
  // built against a specific Node ABI, glibc and OpenSSL. Running a mismatched
  // bundle produces load errors and segfaults that are miserable to diagnose,
  // so refuse it here where the message can say what actually went wrong.
  if (runtimeAbi && manifest.runtimeAbi && manifest.runtimeAbi !== runtimeAbi) {
    throw new Error(
      `bundle needs runtime ABI "${manifest.runtimeAbi}" but this image provides "${runtimeAbi}". ` +
        `Pull a matching checkpoint-runtime image.`,
    );
  }

  if (component === "app" && manifest.provider && manifest.provider !== dbProvider) {
    throw new Error(
      `bundle was built for the ${manifest.provider} provider, but CHECKPOINT_DB_PROVIDER is ${dbProvider}`,
    );
  }

  return manifest;
}

async function verifyAndExtract(archivePath, sidecar, destDir) {
  let manifest;

  if (!sidecar?.signature) {
    if (!ALLOW_UNSIGNED) {
      throw new Error(
        "bundle is unsigned. Refusing to execute it. " +
          "Set CHECKPOINT_BUNDLE_ALLOW_UNSIGNED=1 only when testing a locally built bundle.",
      );
    }
    warn("bundle is UNSIGNED and running only because it was explicitly allowed");
    manifest = JSON.parse(sidecar.manifest);
  } else {
    const publicKey = await resolvePublicKey();
    manifest = await verifySidecar(sidecar, publicKey);
    log("Signature verified against the published key");
  }

  await checkBundle(manifest, sha256File(archivePath), {
    component: COMPONENT,
    runtimeAbi: RUNTIME_ABI,
    dbProvider: DB_PROVIDER,
  });

  // Extract to a scratch dir and rename into place, so an interrupted
  // extraction never leaves a half-written bundle that looks installed.
  const staging = `${destDir}.incoming`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  log(`Extracting to ${destDir}...`);
  // Invoked from the archive's own directory with a bare filename: tar treats
  // an argument containing a colon as host:path, which a Windows-style path
  // trips over during local testing.
  execFileSync("tar", ["--zstd", "-xf", path.basename(archivePath), "-C", staging], {
    cwd: path.dirname(archivePath),
    stdio: "inherit",
  });

  writeJson(path.join(staging, "bundle.json"), manifest);

  fs.rmSync(destDir, { recursive: true, force: true });
  fs.renameSync(staging, destDir);

  return manifest;
}

async function ensureBundle(target) {
  if (MODE === "local") {
    const sidecarPath = `${LOCAL_PATH}.sig.json`;
    if (!fs.existsSync(LOCAL_PATH)) {
      throw new Error(`CHECKPOINT_BUNDLE_PATH does not exist: ${LOCAL_PATH}`);
    }
    if (!fs.existsSync(sidecarPath)) {
      throw new Error(
        `no signature file next to the bundle: expected ${sidecarPath}`,
      );
    }
    const sidecar = readJson(sidecarPath);
    const peek = JSON.parse(sidecar.manifest);
    const dest = bundleDir(peek.version);

    // Re-extract only when this exact bundle is not already unpacked.
    const installed = readJson(path.join(dest, "bundle.json"));
    if (installed?.sha256 === peek.sha256) {
      log(`Bundle ${peek.version} already extracted`);
      return { manifest: installed, dir: dest };
    }
    const manifest = await verifyAndExtract(LOCAL_PATH, sidecar, dest);
    return { manifest, dir: dest };
  }

  const dest = bundleDir(target.version);
  const installed = readJson(path.join(dest, "bundle.json"));
  if (installed?.version === target.version) {
    log(`Bundle ${target.version} already extracted`);
    return { manifest: installed, dir: dest };
  }

  fs.mkdirSync(paths.downloads, { recursive: true });
  const asset = assetName(target.version);
  const archivePath = path.join(paths.downloads, asset);

  log(`Fetching signature for ${asset}...`);
  const sidecar = JSON.parse(
    await httpGet(releaseAssetUrl(target.tag, `${asset}.sig.json`)),
  );

  log(`Downloading ${asset}...`);
  await download(releaseAssetUrl(target.tag, asset), archivePath);

  try {
    const manifest = await verifyAndExtract(archivePath, sidecar, dest);
    return { manifest, dir: dest };
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

// ─── Housekeeping ───────────────────────────────────────────────────

function pruneOldBundles(keepVersions) {
  let entries;
  try {
    entries = fs.readdirSync(paths.bundles, { withFileTypes: true });
  } catch {
    return;
  }

  const candidates = entries
    .filter((e) => e.isDirectory() && !e.name.endsWith(".incoming"))
    .map((e) => ({
      name: e.name,
      dir: path.join(paths.bundles, e.name),
      mtime: fs.statSync(path.join(paths.bundles, e.name)).mtimeMs,
    }))
    .filter((c) => !keepVersions.has(c.name))
    .sort((a, b) => b.mtime - a.mtime);

  for (const stale of candidates.slice(KEEP_BUNDLES)) {
    log(`Pruning superseded bundle ${stale.name}`);
    fs.rmSync(stale.dir, { recursive: true, force: true });
  }
}

// ─── Run ────────────────────────────────────────────────────────────

/**
 * Point the bundle at the operator's mounted config and data.
 *
 * The old images baked `ln -s /app/config .../config/local` into the image
 * layer. The bundle's config directory moves with every version, so the links
 * are recreated here on each boot instead. Returns the config directory to
 * hand to @incanta/config as NODE_CONFIG_DIR.
 */
function linkMounts(manifest, dir) {
  const link = (relative, target) => {
    if (!relative || !existsSyncSafe(target)) return;
    const linkPath = path.join(dir, relative);
    try {
      fs.rmSync(linkPath, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      fs.symlinkSync(target, linkPath, "dir");
      log(`Linked ${relative} -> ${target}`);
    } catch (err) {
      warn(`could not link ${relative} to ${target}: ${err.message}`);
    }
  };

  const configDir = manifest.exec?.configDir
    ? path.join(dir, manifest.exec.configDir)
    : null;

  if (configDir) {
    link(
      path.join(manifest.exec.configDir, "local"),
      process.env["CHECKPOINT_CONFIG_DIR"] || "/app/config",
    );
  }

  link(manifest.exec?.dataDir, process.env["CHECKPOINT_DATA_DIR"] || "/app/data");

  return configDir;
}

function existsSyncSafe(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function runMigrations(manifest, dir) {
  if (!manifest.exec?.migrate) return;

  const cwd = path.join(dir, manifest.exec.migrateCwd || ".");
  const [bin, ...rest] = manifest.exec.migrate;
  // The bundle ships its own Prisma CLI so its version always matches the
  // schema it is migrating.
  const cli = path.join(dir, "node_modules", ".bin", bin);
  const resolved = fs.existsSync(cli) ? cli : bin;

  log("Running database migrations...");
  execFileSync(resolved, rest, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_PATH: path.join(dir, "node_modules"),
      ...componentEnv(manifest, dir),
    },
  });
  log("Migrations complete.");
}

/** Environment every bundle process needs, whether migrating or serving. */
function componentEnv(manifest, dir, configDir) {
  const env = {
    CHECKPOINT_BUNDLE_VERSION_ACTIVE: manifest.version,
    CHECKPOINT_BUNDLE_MODE: MODE,
    CHECKPOINT_STATE_DIR: STATE_DIR,
    // The app shells out to this script to stage updates from the admin panel.
    CHECKPOINT_RUNTIME_BOOTSTRAP: __filename,
  };

  const resolvedConfigDir =
    configDir ??
    (manifest.exec?.configDir ? path.join(dir, manifest.exec.configDir) : null);

  if (resolvedConfigDir) {
    env.NODE_CONFIG_DIR = resolvedConfigDir;
    env.NODE_CONFIG_ENV = process.env["NODE_CONFIG_ENV"] || "local";
  }

  return env;
}

function execComponent(manifest, dir, configDir) {
  const [bin, ...rest] = manifest.exec.command;
  const cwd = path.join(dir, manifest.exec.cwd || ".");

  log(`Starting ${COMPONENT} ${manifest.version}`);

  const child = spawn(bin, rest, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...componentEnv(manifest, dir, configDir) },
  });

  // Forward signals so `docker stop` still stops the app promptly instead of
  // waiting out the kill timeout.
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => child.kill(signal));
  }

  child.on("exit", (code, signal) => {
    if (signal) {
      log(`${COMPONENT} terminated by ${signal}`);
      process.exit(0);
    }
    // A clean exit is how the component asks to be restarted onto a newly
    // staged bundle. Exit 0 so the restart policy brings us back.
    log(`${COMPONENT} exited with code ${code}`);
    process.exit(code ?? 0);
  });
}

/**
 * --stage: fetch and verify one bundle, then exit. Nothing is activated, so a
 * download that fails or fails verification costs no downtime; the admin panel
 * runs this before it ever writes a desired version.
 */
async function stage() {
  if (!cli.version) fatal("--stage requires --version");

  log(`Staging ${COMPONENT} ${cli.version}...`);

  fs.mkdirSync(paths.state, { recursive: true });
  fs.mkdirSync(paths.bundles, { recursive: true });

  const { manifest, dir } = await ensureBundle({
    version: cli.version,
    tag: cli.tag || `v${cli.version}`,
    source: "staging request",
  });

  log(`Staged ${COMPONENT} ${manifest.version} at ${dir}`);
  process.exit(0);
}

async function main() {
  validateEnvironment();

  if (cli.stage) return await stage();

  log(`Checkpoint runtime (${COMPONENT}, ${MODE} mode, ABI ${RUNTIME_ABI || "unset"})`);

  fs.mkdirSync(paths.state, { recursive: true });
  fs.mkdirSync(paths.bundles, { recursive: true });

  const previous = readJson(paths.component);

  let target;
  try {
    target = await resolveTarget();
  } catch (err) {
    // Falling back to whatever last ran keeps a transient GitHub outage from
    // taking the deployment down on an unrelated restart.
    if (previous?.active) {
      warn(`${err.message}; falling back to the installed ${previous.active}`);
      target = {
        version: previous.active,
        // The tag recorded when that version last booted. `v<version>` is only
        // a fallback for state written before the tag was recorded; a nightly
        // never had assets under one.
        tag: previous.activeReleaseTag ?? `v${previous.active}`,
        source: "last known good",
      };
    } else {
      fatal(`cannot determine which version to run: ${err.message}`);
    }
  }

  if (target.version) {
    log(`Target version ${target.version} (${target.source})`);
  }

  let result;
  try {
    result = await ensureBundle(target);
  } catch (err) {
    if (previous?.active && previous.active !== target.version) {
      warn(`failed to install ${target.version}: ${err.message}`);
      warn(`staying on ${previous.active}`);
      const fallbackDir = bundleDir(previous.active);
      const manifest = readJson(path.join(fallbackDir, "bundle.json"));
      if (!manifest) fatal(`installed bundle ${previous.active} is missing`);
      result = { manifest, dir: fallbackDir };
    } else {
      fatal(err.message);
    }
  }

  const { manifest, dir } = result;

  const rolledOver = previous?.active && previous.active !== manifest.version;

  writeJson(paths.component, {
    component: COMPONENT,
    active: manifest.version,
    // The tag this version's assets live on, recorded rather than derived. A
    // nightly version only ever exists on the rolling tag, so a rollback that
    // reconstructed `v<version>` would 404 the moment the bundle it wants is no
    // longer extracted on disk.
    activeReleaseTag: target.tag ?? null,
    previous: rolledOver ? previous.active : (previous?.previous ?? null),
    previousReleaseTag: rolledOver
      ? (previous.activeReleaseTag ?? null)
      : (previous?.previousReleaseTag ?? null),
    provider: COMPONENT === "app" ? DB_PROVIDER : null,
    mode: MODE,
    channel: MODE === "channel" ? CHANNEL : null,
    runtimeAbi: RUNTIME_ABI || null,
    // The app reads this to decide whether to offer an update button at all.
    selfUpdatable: MODE === "channel",
    startedAt: new Date().toISOString(),
    hostname: os.hostname(),
  });

  pruneOldBundles(
    new Set(
      [manifest.version, previous?.active, previous?.previous]
        .filter(Boolean)
        .map((v) => path.basename(bundleDir(v))),
    ),
  );

  const configDir = linkMounts(manifest, dir);

  runMigrations(manifest, dir);
  execComponent(manifest, dir, configDir);
}

// Only boot when this file is the process entry point, so tests can import the
// verification helpers without the container starting up underneath them.
if (require.main === module) {
  main().catch((err) => fatal(err.stack || err.message));
}

module.exports = { checkBundle, assetName, manifestUrl, releaseAssetUrl };
