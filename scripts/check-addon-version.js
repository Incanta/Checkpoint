#!/usr/bin/env node
// Awareness checks for @checkpointvcs/longtail-addon: is every consumer pinned
// to the same version, is that version the one on the registry, and was it
// built from the sources currently in the tree?
//
// Why this exists. The addon is a native binary published to npm and consumed
// from there by src/app, src/core/server, src/core/daemon and src/tests. The
// test workflow builds it from source, so CI proves the CODE in a commit is
// good, while every shipping workflow installs the PUBLISHED artifact. Those
// two can disagree for weeks without a single red check, which is exactly what
// happened with the submit sizing fix in 708b223: the fix was green in CI and
// live on the `nightly` dist-tag, while `latest` (what consumers resolve) still
// carried the data-loss bug.
//
// Three checks, deliberately different severities:
//
//   pins      Fatal, offline. Every consumer must pin the same exact version as
//             the addon's own package.json. Pins are exact (see
//             set-addon-version.js), so a consumer left behind resolves a
//             SECOND copy of the package rather than deduplicating onto one.
//             Deterministic, so there is no reason to let it through.
//
//   sources   Advisory by default. Compares the sources the pinned version was
//             built from against the tree. "Not published yet" is a normal state
//             on a feature branch, so this must not block. It becomes fatal
//             under --strict, which the release workflow uses: shipping a
//             release whose bundled addon predates the addon sources being
//             released is the failure this whole file is about.
//
//   registry  Advisory, needs network. Reports the pinned version against the
//             `latest` and `nightly` dist-tags. Never fatal on its own: a
//             publish from another branch would otherwise fail every open pull
//             request for a reason unrelated to the change under test, and
//             being deliberately behind is sometimes correct.
//
// Usage:
//   node scripts/check-addon-version.js [--sources] [--registry] [--strict]
//
//   --sources   Also check whether the pinned version was built from this tree.
//   --registry  Also compare the pin against the npm dist-tags.
//   --strict    Treat advisory findings as failures. For the release stream.
//
// Emits GitHub Actions annotations and a step summary when run in Actions.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { fingerprint, changedFiles } = require("./addon-source-fingerprint.js");

const repoRoot = path.resolve(__dirname, "..");

const ADDON_NAME = "@checkpointvcs/longtail-addon";
const ADDON_PACKAGE = "src/longtail/addon/package.json";
// Kept in lockstep with set-addon-version.js, which rewrites exactly these.
const DEPENDENTS = [
  "src/app/package.json",
  "src/core/server/package.json",
  "src/core/daemon/package.json",
  "src/tests/package.json",
];

// ─── Arguments ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
let checkSources = false;
let checkRegistry = false;
let strict = false;

for (const a of args) {
  if (a === "--sources") checkSources = true;
  else if (a === "--registry") checkRegistry = true;
  else if (a === "--strict") strict = true;
  else {
    console.error(`unknown flag: ${a}`);
    console.error(
      "usage: node scripts/check-addon-version.js [--sources] [--registry] [--strict]",
    );
    process.exit(1);
  }
}

// ─── Reporting ──────────────────────────────────────────────────────

const findings = [];

/** @param {"error"|"warning"|"notice"} level */
function report(level, title, detail) {
  findings.push({ level, title, detail });
  const prefix = { error: "✗", warning: "!", notice: "·" }[level];
  console.log(`${prefix} ${title}`);
  for (const line of detail) console.log(`    ${line}`);
  if (process.env.GITHUB_ACTIONS && level !== "notice") {
    // Annotations are single-line, so the detail is flattened.
    const message = [title, ...detail].join(" | ").replace(/\r?\n/g, " ");
    console.log(`::${level}::${message}`);
  }
}

/** Advisory unless --strict, where the whole point is to block. */
function advise(title, detail) {
  report(strict ? "error" : "warning", title, detail);
}

function git(gitArgs) {
  return execFileSync("git", gitArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(gitArgs) {
  try {
    return git(gitArgs);
  } catch {
    return null;
  }
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8"));
}

// ─── Check 1: pins agree, exactly (fatal) ───────────────────────────

const addonPkg = readJson(ADDON_PACKAGE);
const addonVersion = addonPkg.version;

console.log(`${ADDON_NAME}`);
console.log(`  package version : ${addonVersion}`);

const pins = new Map();
for (const rel of DEPENDENTS) {
  const pkg = readJson(rel);
  pins.set(rel, pkg.dependencies?.[ADDON_NAME] ?? null);
}

for (const [rel, pin] of pins) {
  console.log(`  ${rel.padEnd(32)} ${pin ?? "(not a dependent)"}`);
}
console.log("");

const missing = [...pins].filter(([, pin]) => pin === null).map(([rel]) => rel);
if (missing.length > 0) {
  report("error", `${ADDON_NAME} is missing from some dependents`, [
    ...missing,
    `Either add the dependency or drop the file from DEPENDENTS in scripts/check-addon-version.js and scripts/set-addon-version.js.`,
  ]);
}

const ranged = [...pins].filter(
  ([, pin]) => pin !== null && /^[^\d]/.test(pin),
);
if (ranged.length > 0) {
  report("error", `${ADDON_NAME} must be pinned exactly, not as a range`, [
    ...ranged.map(([rel, pin]) => `${rel}: "${pin}"`),
    `A range lets the addon move without a reviewable diff whenever the lockfile is regenerated.`,
    `Fix: node scripts/set-addon-version.js ${addonVersion}`,
  ]);
}

const mismatched = [...pins].filter(
  ([, pin]) => pin !== null && !/^[^\d]/.test(pin) && pin !== addonVersion,
);
if (mismatched.length > 0) {
  report("error", `${ADDON_NAME} pins disagree with ${ADDON_PACKAGE}`, [
    ...mismatched.map(
      ([rel, pin]) => `${rel}: "${pin}" (expected "${addonVersion}")`,
    ),
    `Exact pins must move together or yarn installs two copies of the package.`,
    `Fix: node scripts/set-addon-version.js ${addonVersion}`,
  ]);
}

if (missing.length + ranged.length + mismatched.length === 0) {
  console.log(`✓ all ${pins.size} consumers pin ${addonVersion} exactly`);
}

// ─── Check 2: was the pinned version built from this tree? ──────────

/**
 * The commit a published addon version was built from.
 *
 * Prereleases carry it in the version string: compute-release-version.js
 * stamps nightlies as `x.y.z-nightly.<timestamp>.g<sha>`, so the answer is
 * right there and needs no history search.
 *
 * Release versions are clean semver, so we look for the commit the publish
 * workflow wrote. That message is generated by the workflow rather than typed
 * by a person, so it is a reliable marker. The bump commit lands AFTER the
 * build, but it only rewrites package.json versions and the lockfile, none of
 * which change the addon fingerprint (the version field is normalized out), so
 * the bump commit and the commit actually built have the same fingerprint.
 */
function publishedFromCommit(version) {
  const prerelease = /-.*\.g([0-9a-f]{7,40})$/.exec(version);
  if (prerelease) {
    const sha = tryGit([
      "rev-parse",
      "-q",
      "--verify",
      `${prerelease[1]}^{commit}`,
    ]);
    return sha
      ? { sha, how: `SHA embedded in the prerelease version` }
      : {
          sha: null,
          how: `version names commit ${prerelease[1]}, which is not in this clone`,
        };
  }

  const sha = tryGit([
    "log",
    "-1",
    "--format=%H",
    `--grep=^chore: release ${ADDON_NAME} v${version}$`,
    "HEAD",
  ]);
  return sha
    ? { sha, how: `release commit for v${version}` }
    : {
        sha: null,
        how: `no "chore: release ${ADDON_NAME} v${version}" commit reachable from HEAD`,
      };
}

if (checkSources) {
  console.log("");
  const pinned = pins.get(DEPENDENTS[0]) ?? addonVersion;
  const pinnedVersion = /^[^\d]/.test(pinned)
    ? pinned.replace(/^[^\d]+/, "")
    : pinned;
  const origin = publishedFromCommit(pinnedVersion);

  console.log(
    `published-from commit for ${pinnedVersion}: ${origin.sha ?? "unknown"}`,
  );
  console.log(`  (${origin.how})`);

  if (!origin.sha) {
    advise(
      `Cannot tell which sources ${ADDON_NAME} ${pinnedVersion} was built from`,
      [
        origin.how,
        `A shallow clone is the usual cause; this check needs fetch-depth: 0.`,
      ],
    );
  } else {
    const here = fingerprint(null).fingerprint;
    const there = fingerprint(origin.sha).fingerprint;
    console.log(`  tree fingerprint      : ${here}`);
    console.log(`  published fingerprint : ${there}`);

    if (here === there) {
      console.log(
        `✓ ${ADDON_NAME} ${pinnedVersion} was built from the addon sources in this tree`,
      );
    } else {
      const changes = changedFiles(origin.sha, null);
      const shown = changes
        .slice(0, 20)
        .map((c) => `${c.change.padEnd(8)} ${c.file}`);
      if (changes.length > shown.length) {
        shown.push(`... and ${changes.length - shown.length} more`);
      }
      advise(
        `${ADDON_NAME} ${pinnedVersion} predates the addon sources in this tree`,
        [
          `${changes.length} build-relevant file(s) changed since ${origin.sha.slice(0, 12)}.`,
          `Everything installing ${pinnedVersion} is running older native code than CI tested.`,
          `Publish the addon (workflow: CD, component longtail-addon) to close the gap.`,
          ...shown,
        ],
      );
    }
  }
}

// ─── Check 3: what the registry is serving ──────────────────────────

/**
 * Read dist-tags straight from the registry over HTTPS.
 *
 * Not `npm view`: npm is a .cmd shim on Windows that execFileSync cannot spawn
 * without a shell, and routing constants through a shell earns a Node
 * deprecation warning for no benefit. This also works where npm is not on PATH.
 *
 * Not `fetch` either. Its keep-alive sockets stay in a pool after the response,
 * and calling process.exit() with one of those handles still open aborts the
 * process on Windows ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)")
 * turning a clean advisory run into exit 127. `agent: false` opens a socket per
 * request and closes it, so the event loop drains and the real exit code stands.
 *
 * Assumes the public registry, which is where the package lives (it is
 * published with --access public). A private proxy would need the URL read from
 * npm config instead.
 */
function fetchDistTags() {
  const https = require("https");
  const url = `https://registry.npmjs.org/${ADDON_NAME.replace("/", "%2f")}`;

  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        agent: false,
        timeout: 30_000,
        headers: {
          accept: "application/vnd.npm.install-v1+json",
          "user-agent": "checkpoint-check-addon-version",
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body)["dist-tags"] ?? null);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error("registry request timed out")),
    );
    req.on("error", reject);
  });
}

async function registryCheck() {
  console.log("");
  let tags = null;
  try {
    tags = await fetchDistTags();
  } catch (err) {
    report("notice", `Could not reach the npm registry for ${ADDON_NAME}`, [
      String(err.message ?? err).split("\n")[0],
      `Skipping the registry comparison; this never fails the build on its own.`,
    ]);
    return;
  }

  if (!tags) {
    report("notice", `Registry returned no dist-tags for ${ADDON_NAME}`, [
      `Skipping the registry comparison.`,
    ]);
    return;
  }

  console.log(`registry dist-tags for ${ADDON_NAME}:`);
  for (const [tag, version] of Object.entries(tags)) {
    console.log(`  ${tag.padEnd(10)} ${version}`);
  }

  if (tags.latest && tags.latest !== addonVersion) {
    report("notice", `Pinned version differs from the latest dist-tag`, [
      `pinned: ${addonVersion}, latest: ${tags.latest}`,
      `Intentional if you are holding back on purpose.`,
    ]);
  } else if (tags.latest) {
    console.log(`✓ pinned version matches the latest dist-tag`);
  }

  // A nightly whose base version is ahead of `latest` means a build of newer
  // sources exists but was never promoted, which is the state that hid the
  // submit sizing fix for two weeks.
  if (tags.nightly && tags.latest) {
    const nightlyBase = tags.nightly.split("-")[0];
    if (nightlyBase !== tags.latest) {
      report("notice", `A nightly addon exists ahead of latest`, [
        `latest: ${tags.latest}, nightly: ${tags.nightly}`,
        `Consumers resolve ${tags.latest}; the nightly's changes are not shipped.`,
      ]);
    }
  }
}

// ─── Summary and exit ───────────────────────────────────────────────

function finish() {
  const errors = findings.filter((f) => f.level === "error");
  const warnings = findings.filter((f) => f.level === "warning");

  if (process.env.GITHUB_STEP_SUMMARY) {
    const icon = { error: "🔴", warning: "🟡", notice: "⬜" };
    const lines = [`### ${ADDON_NAME} status`, ""];
    lines.push(`Pinned version: \`${addonVersion}\``, "");
    if (findings.length === 0) {
      lines.push(
        "Everything consistent: pins agree and the published addon matches these sources.",
      );
    } else {
      lines.push("| | Finding | Detail |", "| --- | --- | --- |");
      for (const f of findings) {
        lines.push(
          `| ${icon[f.level]} | ${f.title} | ${f.detail.join("<br>").replace(/\|/g, "\\|")} |`,
        );
      }
    }
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      lines.join("\n") + "\n\n",
    );
  }

  console.log("");
  // process.exitCode rather than process.exit(): the latter tears the process
  // down mid-event-loop, which is what crashed here once a network handle was
  // in play. Setting the code lets node exit on its own terms.
  if (errors.length > 0) {
    console.log(`${errors.length} error(s), ${warnings.length} warning(s)`);
    process.exitCode = 1;
    return;
  }
  if (warnings.length > 0) {
    console.log(`${warnings.length} warning(s); not failing the build`);
    return;
  }
  console.log("addon version checks passed");
}

(async () => {
  if (checkRegistry) await registryCheck();
  finish();
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
