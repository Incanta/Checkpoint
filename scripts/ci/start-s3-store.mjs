#!/usr/bin/env node
/**
 * Starts an S3-compatible object store for the integration tests and points
 * the core server at it.
 *
 * The suite normally runs with `storage.mode: local`, which never touches the
 * S3 half of the storage code: the server's S3 backend (and the conditional
 * write its store index lock is built on), and the addon's S3 adapter, which
 * the server-side store index merge goes through. This runs the same suite
 * against a real S3 API so those paths are tested too. Everything else about
 * the run (the gateway, the app, the tests) is unchanged.
 *
 * The store is SeaweedFS, which Checkpoint already supports as an S3 backend
 * and which ships as one self-contained binary for Linux and Windows. The
 * release is pinned and its archive is verified against the checksums below
 * before anything in it is run.
 *
 * All parameters (endpoint, bucket, credentials) live in
 * scripts/ci/storage-s3.override.json, which is also what gets installed as
 * the core server's config override. This script reads them from there, so
 * there is one place to change them.
 *
 * Usage:
 *   node scripts/ci/start-s3-store.mjs          start the store, configure the server
 *   node scripts/ci/start-s3-store.mjs --stop   stop the store, remove the override
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORK_DIR = path.join(ROOT, ".ci", "seaweedfs");
const OVERRIDE_TEMPLATE = path.join(ROOT, "scripts/ci/storage-s3.override.json");
const OVERRIDE_TARGET = path.join(ROOT, "src/core/server/config/override.json");
const PID_FILE = path.join(WORK_DIR, "weed.pid");

const VERSION = "4.48";
const ASSETS = {
  "linux-x64": {
    file: "linux_amd64.tar.gz",
    sha256: "4a7d108384d044d95212d1342cdda9533fa55842c1c9b41f606ca3c8a9561124",
    binary: "weed",
  },
  "win32-x64": {
    file: "windows_amd64.zip",
    sha256: "fe90c04c0620ad1a1c756f86cd5e1443773f56a446688077a4bb5ec04c3cc874",
    binary: "weed.exe",
  },
};

const settings = JSON.parse(fs.readFileSync(OVERRIDE_TEMPLATE, "utf8")).storage.s3;
const endpoint = new URL(settings.endpoint);
const s3Port = Number(endpoint.port);

function stop() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8"));
    process.kill(pid);
    console.log(`Stopped the S3 store (pid ${pid}).`);
  } catch {
    console.log("The S3 store was not running.");
  }
  fs.rmSync(PID_FILE, { force: true });

  // Only remove the override if it is the one this script installed.
  if (
    fs.existsSync(OVERRIDE_TARGET) &&
    fs.readFileSync(OVERRIDE_TARGET, "utf8") ===
      fs.readFileSync(OVERRIDE_TEMPLATE, "utf8")
  ) {
    fs.rmSync(OVERRIDE_TARGET);
    console.log("Removed the core server's S3 config override.");
  }
}

function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function download(asset) {
  const archive = path.join(WORK_DIR, asset.file);
  const sha256 = (file) =>
    createHash("sha256").update(fs.readFileSync(file)).digest("hex");

  if (!fs.existsSync(archive) || sha256(archive) !== asset.sha256) {
    const url = `https://github.com/seaweedfs/seaweedfs/releases/download/${VERSION}/${asset.file}`;
    console.log(`Downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Download failed: HTTP ${response.status}`);
    }
    fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }

  const actual = sha256(archive);
  if (actual !== asset.sha256) {
    fs.rmSync(archive, { force: true });
    throw new Error(
      `Checksum mismatch for ${asset.file}: expected ${asset.sha256}, got ${actual}. Nothing was run.`,
    );
  }

  const binDir = path.join(WORK_DIR, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  // On Windows the archive is a zip, which the bsdtar that ships with Windows
  // reads and the GNU tar that Git Bash puts first on PATH does not, so name
  // the system one. Relative paths, so neither mistakes a drive letter for a
  // remote host.
  const tar =
    process.platform === "win32"
      ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : "tar";
  execFileSync(tar, ["-xf", path.relative(binDir, archive)], { cwd: binDir });
  const binary = path.join(binDir, asset.binary);
  fs.chmodSync(binary, 0o755);
  return binary;
}

async function start() {
  const asset = ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) {
    throw new Error(
      `No pinned SeaweedFS build for ${process.platform}-${process.arch}`,
    );
  }

  if (
    fs.existsSync(OVERRIDE_TARGET) &&
    fs.readFileSync(OVERRIDE_TARGET, "utf8") !==
      fs.readFileSync(OVERRIDE_TEMPLATE, "utf8")
  ) {
    throw new Error(
      `${path.relative(ROOT, OVERRIDE_TARGET)} already exists with other settings. Move it aside first; this script will not overwrite it.`,
    );
  }

  fs.mkdirSync(path.join(WORK_DIR, "data"), { recursive: true });

  if (await isListening(s3Port)) {
    console.log(`Something is already listening on port ${s3Port}; using it.`);
  } else {
    const binary = await download(asset);

    const identities = path.join(WORK_DIR, "s3.json");
    fs.writeFileSync(
      identities,
      JSON.stringify(
        {
          identities: [
            {
              name: "checkpoint-ci",
              credentials: [
                {
                  accessKey: settings["access-key-id"],
                  secretKey: settings["secret-access-key"],
                },
              ],
              actions: ["Admin", "Read", "Write", "List", "Tagging"],
            },
          ],
        },
        null,
        2,
      ),
    );

    // Non-default ports throughout, so this does not collide with anything a
    // developer machine is likely to be running.
    const log = fs.openSync(path.join(WORK_DIR, "weed.log"), "w");
    const child = spawn(
      binary,
      [
        "server",
        `-dir=${path.join(WORK_DIR, "data")}`,
        "-ip=127.0.0.1",
        "-master.port=19333",
        "-volume.port=18080",
        "-volume.max=30",
        "-filer",
        "-filer.port=18888",
        "-s3",
        `-s3.port=${s3Port}`,
        `-s3.config=${identities}`,
      ],
      { detached: true, stdio: ["ignore", log, log], windowsHide: true },
    );
    child.unref();
    fs.writeFileSync(PID_FILE, String(child.pid));

    const deadline = Date.now() + 120_000;
    while (!(await isListening(s3Port))) {
      if (Date.now() > deadline) {
        throw new Error(
          `The S3 store did not start listening on ${s3Port}; see ${path.join(WORK_DIR, "weed.log")}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    console.log(`SeaweedFS ${VERSION} is serving S3 on ${settings.endpoint} (pid ${child.pid}).`);
  }

  // The server depends on the SDK; borrow it rather than add a dependency for
  // one bucket.
  const require = createRequire(path.join(ROOT, "src/core/server/package.json"));
  const { S3Client, CreateBucketCommand, HeadBucketCommand } = require(
    "@aws-sdk/client-s3",
  );
  const client = new S3Client({
    endpoint: settings.endpoint,
    region: settings.region,
    forcePathStyle: settings["force-path-style"],
    credentials: {
      accessKeyId: settings["access-key-id"],
      secretAccessKey: settings["secret-access-key"],
    },
  });

  // The gateway can be listening a moment before it can serve a request.
  let lastError;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      try {
        await client.send(new HeadBucketCommand({ Bucket: settings.bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket: settings.bucket }));
      }
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (lastError) {
    throw new Error(`Could not create bucket ${settings.bucket}: ${lastError}`);
  }
  console.log(`Bucket ${settings.bucket} is ready.`);

  fs.copyFileSync(OVERRIDE_TEMPLATE, OVERRIDE_TARGET);
  console.log(
    `Core server configured for S3 via ${path.relative(ROOT, OVERRIDE_TARGET)}. Start (or restart) the services to pick it up.`,
  );
}

try {
  if (process.argv.includes("--stop")) {
    stop();
  } else {
    await start();
  }
} catch (error) {
  console.error(`start-s3-store: ${error.message}`);
  process.exit(1);
}
