#!/usr/bin/env node
// Decide which CD components need rebuilding.
//
// Every component in .github/release-config.json owns a marker tag recording
// the commit it was last successfully built from. This script diffs
// <marker>..<head> for each component and reports the ones whose path filters
// matched, then applies the cascade rules (a new longtail addon forces the
// server and client to rebuild, since both bundle it).
//
// A missing marker tag means "never built through CD" and the component is
// treated as changed, so the first run after adopting this builds everything.
//
// Usage:
//   node scripts/detect-changed-components.js [--head <ref>] [--only <list>]
//                                             [--config <path>] [--json]
//
//   --only  Comma-separated component names (or "all") to force on regardless
//           of the diff. Used by the manual dispatch path.
//   --base  Diff every component against this ref instead of its marker tag.
//           Handy for previewing what a run would do without touching tags.
//   --json  Print the full decision object instead of the summary table.
//
// When GITHUB_OUTPUT is set, writes one boolean output per component (name
// lowercased with '-' turned into '_'), plus `any` and `head`.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");

// ─── Argument parsing ───────────────────────────────────────────────

const args = process.argv.slice(2);
let head = "HEAD";
let only = null;
let baseOverride = null;
let configPath = path.join(repoRoot, ".github", "release-config.json");
let asJson = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const eq = a.indexOf("=");
  const flag = eq === -1 ? a : a.slice(0, eq);
  const inline = eq === -1 ? null : a.slice(eq + 1);
  if (flag === "--head") head = inline ?? args[++i];
  else if (flag === "--only") only = inline ?? args[++i];
  else if (flag === "--base") baseOverride = inline ?? args[++i];
  else if (flag === "--config") configPath = inline ?? args[++i];
  else if (flag === "--json") asJson = true;
  else {
    console.error(`unknown flag: ${flag}`);
    process.exit(1);
  }
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const components = config.components;

// ─── Glob matching ──────────────────────────────────────────────────
// Supports the subset the config actually uses: literal paths, `*` (one path
// segment) and `**` (any number of segments). Everything else is escaped.

const REGEX_SPECIALS = "\\^$.|?+()[]{}";

function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          // `a/**/b` matches `a/b` as well as `a/x/y/b`.
          i++;
          out += "(?:.*/)?";
        } else {
          // Trailing `**` matches everything below the prefix.
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (REGEX_SPECIALS.includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp("^" + out + "$");
}

function matcherFor(paths) {
  const regexes = paths.map(globToRegExp);
  return (file) => regexes.some((re) => re.test(file));
}

// ─── Git helpers ────────────────────────────────────────────────────

function git(...gitArgs) {
  return execFileSync("git", gitArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(...gitArgs) {
  try {
    return git(...gitArgs);
  } catch {
    return null;
  }
}

function resolveMarker(marker) {
  return tryGit("rev-parse", "-q", "--verify", `refs/tags/${marker}^{commit}`);
}

function changedFiles(base, headRef) {
  const out = tryGit("diff", "--name-only", `${base}..${headRef}`);
  if (out === null) return null;
  return out.length ? out.split("\n") : [];
}

// ─── Decide ─────────────────────────────────────────────────────────

const headSha = git("rev-parse", head);

const forced =
  only == null
    ? null
    : only.trim() === "all"
      ? Object.keys(components)
      : only
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

if (forced) {
  for (const name of forced) {
    if (!components[name]) {
      console.error(
        `unknown component: ${name} (known: ${Object.keys(components).join(", ")})`,
      );
      process.exit(1);
    }
  }
}

const decisions = {};

for (const [name, component] of Object.entries(components)) {
  if (forced) {
    const on = forced.includes(name);
    decisions[name] = {
      build: on,
      reason: on ? "forced by --only" : "not selected by --only",
      base: null,
      files: [],
    };
    continue;
  }

  const base = baseOverride
    ? git("rev-parse", baseOverride)
    : resolveMarker(component.marker);

  if (!base) {
    decisions[name] = {
      build: true,
      reason: `no marker tag ${component.marker}; treating as first build`,
      base: null,
      files: [],
    };
    continue;
  }

  if (base === headSha) {
    decisions[name] = {
      build: false,
      reason: `marker already at ${headSha.slice(0, 8)}`,
      base,
      files: [],
    };
    continue;
  }

  const files = changedFiles(base, headSha);

  if (files === null) {
    decisions[name] = {
      build: true,
      reason: `cannot diff ${base.slice(0, 8)}..${headSha.slice(0, 8)} (history unavailable); building to be safe`,
      base,
      files: [],
    };
    continue;
  }

  const matches = files.filter(matcherFor(component.paths));
  decisions[name] = {
    build: matches.length > 0,
    reason: matches.length
      ? `${matches.length} matching file(s) since ${base.slice(0, 8)}`
      : `no matching files among ${files.length} changed since ${base.slice(0, 8)}`,
    base,
    files: matches,
  };
}

// Cascades. Iterate to a fixed point so a chain (a -> b -> c) resolves in one go.
if (!forced) {
  let changedSomething = true;
  while (changedSomething) {
    changedSomething = false;
    for (const [name, component] of Object.entries(components)) {
      if (!decisions[name].build) continue;
      for (const downstream of component.cascades ?? []) {
        if (decisions[downstream] && !decisions[downstream].build) {
          decisions[downstream].build = true;
          decisions[downstream].reason = `cascaded from ${name}`;
          changedSomething = true;
        }
      }
    }
  }
}

const any = Object.values(decisions).some((d) => d.build);
const result = { head: headSha, any, components: decisions };

// ─── Report ─────────────────────────────────────────────────────────

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`HEAD ${headSha}`);
  for (const [name, d] of Object.entries(decisions)) {
    console.log(
      `  ${d.build ? "BUILD " : "skip  "} ${name.padEnd(16)} ${d.reason}`,
    );
    for (const f of d.files.slice(0, 20)) console.log(`           ${f}`);
    if (d.files.length > 20) {
      console.log(`           ... and ${d.files.length - 20} more`);
    }
  }
  console.log(
    any ? "=> at least one component needs building" : "=> nothing to do",
  );
}

const outFile = process.env.GITHUB_OUTPUT;
if (outFile) {
  const lines = [`any=${any}`, `head=${headSha}`];
  for (const [name, d] of Object.entries(decisions)) {
    lines.push(`${name.replace(/-/g, "_")}=${d.build}`);
  }
  fs.appendFileSync(outFile, lines.join("\n") + "\n");
}

const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile) {
  const rows = Object.entries(decisions)
    .map(
      ([name, d]) => `| ${name} | ${d.build ? "build" : "skip"} | ${d.reason} |`,
    )
    .join("\n");
  fs.appendFileSync(
    summaryFile,
    `### CD change detection\n\n| Component | Decision | Why |\n| --- | --- | --- |\n${rows}\n\n`,
  );
}
