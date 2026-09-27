#!/usr/bin/env node
// Deterministic fingerprint of the sources the longtail addon is built from.
//
// One definition of "what feeds the addon build", used by:
//   - .github/workflows/test.yaml, as the cache key for the source-built addon.
//     A stale cache there means CI silently tests a binary that does not match
//     the commit, which is the whole class of bug the source build exists to
//     close, so the key has to cover everything that changes the output.
//   - scripts/check-addon-version.js, which requires this file as a module to
//     compare the working tree against the commit a published addon came from.
//
// The file set comes from .github/release-config.json (the longtail-addon
// component's `paths`), so it cannot drift from CD change detection. A few
// entries are then dropped because they cannot affect the compiled output and
// would otherwise force pointless rebuilds; see NON_BUILD_INPUTS.
//
// Content is identified by git BLOB ID, not by hashing bytes read off disk.
// That matters: .gitattributes checks `*.bat` out as CRLF while the blob keeps
// LF, and the LFS filter rewrites some extensions entirely, so a byte hash of
// the working tree disagrees with the same commit's blobs (26 of the 341 files
// here) and would disagree between Windows and Linux. `git hash-object` applies
// exactly the filters git itself would, so the working tree and a ref produce
// the same digest for the same content.
//
// Paths are enumerated from tracked files only, so build directories and
// untracked scratch never leak in, but the working-tree mode digests what is on
// disk right now, including uncommitted edits. That is deliberate: it describes
// what would be built if you built it now.
//
// Usage:
//   node scripts/addon-source-fingerprint.js [--ref <git-ref>] [--verbose] [--list]
//
//   --ref      Fingerprint the sources as of a git ref instead of the working
//              tree. Used to fingerprint the commit a published addon came from.
//   --verbose  Print the per-file digests that went into the fingerprint.
//   --list     Print just the file list, no digest.
//
// Writes `fingerprint=<digest>` to GITHUB_OUTPUT when that is set.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const CONFIG = path.join(repoRoot, ".github", "release-config.json");
const COMPONENT = "longtail-addon";
const ADDON_PACKAGE_JSON = "src/longtail/addon/package.json";

// Config paths that are part of the component for CD purposes but cannot
// change the built binary. Including them would invalidate the build cache for
// edits that provably do not affect the output.
//
// Anything genuinely uncertain belongs OUT of this list: a needless rebuild
// costs minutes, a missed rebuild costs a silently stale binary.
const NON_BUILD_INPUTS = [
  /^\.github\//, // the publish workflow itself
  /(^|\/)\.vscode\//, // editor settings
  /(^|\/)\.gitignore$/,
  /\.md$/, // docs
];

// ─── Glob matching (same subset detect-changed-components.js supports) ───

const REGEX_SPECIALS = "\\^$.|?+()[]{}";

function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
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

// ─── Git ────────────────────────────────────────────────────────────

function git(gitArgs, input) {
  return execFileSync("git", gitArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    input,
    stdio:
      input === undefined
        ? ["ignore", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe"],
  });
}

// ─── Config ─────────────────────────────────────────────────────────

const config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
const component = config.components?.[COMPONENT];
if (!component) {
  throw new Error(`${COMPONENT} is not a component in ${CONFIG}`);
}

const matchers = component.paths.map(globToRegExp);
const isComponentPath = (file) => matchers.some((re) => re.test(file));
const isBuildInput = (file) => !NON_BUILD_INPUTS.some((re) => re.test(file));

// Narrow the git listing to the top directories the globs mention, so we do not
// enumerate the whole repository just to filter it back down.
const roots = [
  ...new Set(
    component.paths.map((p) => {
      const star = p.indexOf("*");
      const prefix = star === -1 ? p : p.slice(0, star);
      const slash = prefix.lastIndexOf("/");
      return slash === -1 ? prefix : prefix.slice(0, slash);
    }),
  ),
].filter(Boolean);

const byPath = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Map of component source path to git blob id.
 *
 * @param {string|null} ref  A git ref, or null for the working tree.
 */
function blobMap(ref = null) {
  const blobs = new Map();

  if (ref === null) {
    const files = git(["ls-files", "-z", "--", ...roots])
      .split("\0")
      .filter(Boolean)
      .filter(isComponentPath)
      .filter(isBuildInput)
      .sort();
    if (files.length === 0) return blobs;

    // One hash-object call for the whole set. It applies the same clean filters
    // (eol, lfs) git would on commit, so these ids are comparable with a ref's.
    const ids = git(["hash-object", "--stdin-paths"], files.join("\n") + "\n")
      .trim()
      .split("\n");
    if (ids.length !== files.length) {
      throw new Error(
        `git hash-object returned ${ids.length} ids for ${files.length} paths`,
      );
    }
    files.forEach((file, i) => blobs.set(file, ids[i].trim()));
    return blobs;
  }

  // `<mode> <type> <sha>\t<path>` per entry.
  for (const entry of git(["ls-tree", "-r", "-z", ref, "--", ...roots]).split(
    "\0",
  )) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const file = entry.slice(tab + 1);
    if (!isComponentPath(file) || !isBuildInput(file)) continue;
    const [, type, sha] = entry.slice(0, tab).split(/\s+/);
    if (type !== "blob") continue;
    blobs.set(file, sha);
  }
  return new Map([...blobs.entries()].sort(byPath));
}

// ─── The addon's own package.json needs its version ignored ─────────

/** Canonical JSON: keys sorted at every level, so formatting never matters. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort())
      out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

/**
 * Digest for the addon's package.json with `version` removed. The version
 * changes on every publish and says nothing about the sources: leaving it in
 * would make a publish's own freshly built artifact look stale the moment it
 * landed, and would invalidate the build cache on every bump.
 *
 * Parsing and re-serializing also makes this immune to the line-ending and
 * whitespace differences the blob ids handle for everything else.
 */
function addonPackageDigest(ref) {
  const raw =
    ref === null
      ? fs.readFileSync(path.join(repoRoot, ADDON_PACKAGE_JSON), "utf8")
      : git(["show", `${ref}:${ADDON_PACKAGE_JSON}`]);
  const pkg = JSON.parse(raw);
  delete pkg.version;
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(pkg)))
    .digest("hex");
}

/** Per-file digests that feed the fingerprint (blob ids, version-stripped pkg). */
function digestMap(ref = null) {
  const out = new Map();
  for (const [file, blobId] of blobMap(ref)) {
    out.set(
      file,
      file === ADDON_PACKAGE_JSON ? addonPackageDigest(ref) : blobId,
    );
  }
  return out;
}

/**
 * One digest over every build-relevant source file.
 *
 * @param {string|null} ref  A git ref, or null for the working tree.
 * @param {(line: string) => void} [onFile]  Called with each per-file line.
 */
function fingerprint(ref = null, onFile) {
  const digests = digestMap(ref);
  if (digests.size === 0) {
    throw new Error(
      `No files matched ${COMPONENT} paths${ref ? ` at ${ref}` : ""}; refusing to fingerprint nothing`,
    );
  }
  const overall = crypto.createHash("sha256");
  for (const [file, digest] of digests) {
    if (onFile) onFile(`  ${digest.slice(0, 12)}  ${file}`);
    overall.update(`${file}\0${digest}\n`);
  }
  return { fingerprint: overall.digest("hex"), fileCount: digests.size };
}

/**
 * Build-relevant source files that differ between two refs, by content rather
 * than by path pattern. More precise than a path diff: a commit that only
 * touches the addon's README or the publish workflow reports nothing here.
 */
function changedFiles(baseRef, headRef = null) {
  const base = digestMap(baseRef);
  const head = digestMap(headRef);
  const changes = [];
  for (const [file, digest] of head) {
    if (!base.has(file)) changes.push({ file, change: "added" });
    else if (base.get(file) !== digest)
      changes.push({ file, change: "modified" });
  }
  for (const file of base.keys()) {
    if (!head.has(file)) changes.push({ file, change: "removed" });
  }
  return changes.sort((a, b) => byPath([a.file], [b.file]));
}

module.exports = { blobMap, digestMap, fingerprint, changedFiles, COMPONENT };

// ─── CLI ────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  let ref = null;
  let verbose = false;
  let listOnly = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf("=");
    const flag = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? null : a.slice(eq + 1);
    if (flag === "--ref") ref = inline ?? args[++i];
    else if (flag === "--verbose") verbose = true;
    else if (flag === "--list") listOnly = true;
    else {
      console.error(`unknown flag: ${flag}`);
      process.exit(1);
    }
  }

  try {
    if (listOnly) {
      for (const file of blobMap(ref).keys()) console.log(file);
      process.exit(0);
    }

    const { fingerprint: digest, fileCount } = fingerprint(
      ref,
      verbose ? (line) => console.error(line) : undefined,
    );

    if (verbose)
      console.error(`\n${fileCount} files${ref ? ` at ${ref}` : ""}`);
    console.log(digest);

    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `fingerprint=${digest}\nfile_count=${fileCount}\n`,
      );
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
