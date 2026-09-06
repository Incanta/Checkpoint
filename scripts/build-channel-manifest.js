#!/usr/bin/env node
// Build the channel manifest published as a GitHub release asset by
// .github/workflows/release.yaml.
//
// The manifest is what tells anything downstream "here is the newest build on
// this channel", without needing the GitHub API or a container registry query.
// The self-hosted app polls it to decide whether to email its operator about a
// pending server update (src/app/src/server/updates/), because server builds
// ship as container images and so have no release asset of their own to
// compare against.
//
// Components are merged, not replaced: a run that only rebuilt the server must
// leave the recorded client and addon versions alone.
//
// Usage:
//   node scripts/build-channel-manifest.js --channel nightly --commit <sha>
//     [--existing <path>] [--out <path>] [--release-tag <tag>]
//     [--server-version X --runtime-abi node24-debian12-openssl3]
//     [--client-version Y]
//     [--addon-version Z --npm-tag nightly]
//
// Any component whose --*-version is omitted is carried over from --existing.
//
// The server entry is also what the runtime container reads at boot to decide
// which bundle to run (docker/runtime/bootstrap.js), so `version` and
// `releaseTag` there are load-bearing, not just informational.

const fs = require("fs");

const args = process.argv.slice(2);
const opt = {};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith("--")) {
    console.error(`unexpected argument: ${a}`);
    process.exit(1);
  }
  const eq = a.indexOf("=");
  const flag = (eq === -1 ? a : a.slice(0, eq)).slice(2);
  const inline = eq === -1 ? null : a.slice(eq + 1);
  opt[flag] = inline ?? args[++i] ?? "";
}

const channel = opt.channel;
if (channel !== "nightly" && channel !== "release") {
  console.error("--channel must be nightly or release");
  process.exit(1);
}

// Empty strings are how the workflow says "this component did not build".
const value = (key) => {
  const v = opt[key];
  return v == null || v === "" ? null : v;
};

let existing = { components: {} };
if (opt.existing && fs.existsSync(opt.existing)) {
  try {
    existing = JSON.parse(fs.readFileSync(opt.existing, "utf8"));
    existing.components ??= {};
  } catch (err) {
    console.warn(
      `Ignoring unreadable existing manifest ${opt.existing}: ${err.message}`,
    );
    existing = { components: {} };
  }
}

const now = new Date().toISOString();
const components = { ...existing.components };

if (value("server-version")) {
  const serverVersion = value("server-version");
  // Where the bundle assets live. The runtime resolves asset URLs as
  // releases/download/<releaseTag>/<asset>, so this has to be the tag that
  // actually holds them: v<version> for releases, the rolling tag for nightly.
  const releaseTag =
    value("release-tag") ?? (channel === "release" ? `v${serverVersion}` : "nightly");

  components.server = {
    version: serverVersion,
    releaseTag,
    channel,
    runtimeAbi: value("runtime-abi"),
    bundles: {
      app: {
        sqlite: `checkpoint-bundle-app-${serverVersion}-sqlite.tar.zst`,
        postgres: `checkpoint-bundle-app-${serverVersion}-postgres.tar.zst`,
      },
      server: `checkpoint-bundle-server-${serverVersion}.tar.zst`,
    },
    updatedAt: now,
    commit: value("commit"),
  };
}

if (value("client-version")) {
  components.client = {
    version: value("client-version"),
    releaseTag: value("release-tag"),
    updatedAt: now,
    commit: value("commit"),
  };
}

if (value("addon-version")) {
  components.longtailAddon = {
    version: value("addon-version"),
    npmTag: value("npm-tag"),
    updatedAt: now,
    commit: value("commit"),
  };
}

const manifest = {
  schema: 1,
  channel,
  updatedAt: now,
  commit: value("commit"),
  components,
};

const json = JSON.stringify(manifest, null, 2) + "\n";

if (opt.out) {
  fs.writeFileSync(opt.out, json);
  console.log(`wrote ${opt.out}`);
}
console.log(json);
