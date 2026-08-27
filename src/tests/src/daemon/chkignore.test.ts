/**
 * `.chkignore` / `.chkhidden` semantics.
 *
 * Regression cover for the daemon reporting files that `.chkignore` excludes.
 * The two properties that matter here:
 *
 *  1. Discovery reads the **working tree**, never the submitted baseline. A
 *     repo that has submitted nothing yet (or is about to submit everything at
 *     once) still has a meaningful `.chkignore` on disk.
 *  2. Patterns follow gitignore semantics, including nested files, negations,
 *     directory-only rules, and pruning of ignored subtrees.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildIgnoreCacheFromPatterns,
  getFileStatuses,
  isIgnoredOrHidden,
  matchesPattern,
  normalizeRelativePath,
  prefixIgnorePattern,
  scanWorkspaceIgnoreFiles,
  type IgnoreCache,
} from "../../../core/daemon/src/file-status.js";
import { FileStatus } from "../../../core/daemon/src/types/index.js";
import type { WorkspaceState } from "../../../core/daemon/src/util/index.js";

/**
 * A literal backslash. Built from a char code so the intent survives every
 * layer of escaping a reader (or an editor's auto-format) might apply.
 */
const B = String.fromCharCode(92);
const NL = "\n";

let workspacePath: string;

beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(tmpdir(), "chkignore-"));
});

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true });
});

/** Writes a file, creating any missing parent directories. */
async function write(relativePath: string, content = "x"): Promise<void> {
  const full = path.join(workspacePath, relativePath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}

/** Scans the working tree and builds the matcher the daemon would use. */
async function buildCache(): Promise<IgnoreCache> {
  return buildIgnoreCacheFromPatterns(
    await scanWorkspaceIgnoreFiles(workspacePath),
  );
}

const ignored = (cache: IgnoreCache, p: string, isDir = false): boolean =>
  matchesPattern(cache.ignore, p, isDir);

describe("scanWorkspaceIgnoreFiles", () => {
  it("honours a root .chkignore in a workspace that has submitted nothing", async () => {
    // The reported bug: a brand-new Unreal workspace listed every build
    // artifact because pattern discovery was driven by the submitted state.
    await write(".chkignore", "web-port\nBinaries\nIntermediate\nSaved\n");
    await write("Binaries/Win64/Game.dll");
    await write("Intermediate/Build/obj.o");
    await write("Saved/Config/WindowsEditor/Editor.ini");
    await write("web-port/index.html");
    await write("Source/Game.cpp");

    const cache = await buildCache();

    expect(ignored(cache, "Binaries", true)).toBe(true);
    expect(ignored(cache, "Binaries/Win64/Game.dll")).toBe(true);
    expect(ignored(cache, "Intermediate/Build/obj.o")).toBe(true);
    expect(ignored(cache, "Saved/Config/WindowsEditor/Editor.ini")).toBe(true);
    expect(ignored(cache, "web-port/index.html")).toBe(true);
    expect(ignored(cache, "Source/Game.cpp")).toBe(false);
  });

  it("uses the working copy of .chkignore, not the submitted one", async () => {
    // `Saved` was in the submitted revision; the working copy replaced it with
    // `Logs`. Only the working copy may drive the matcher.
    await write(".chkignore", "Logs\n");
    await write("Logs/run.log");
    await write("Saved/keep.txt");

    const cache = await buildCache();

    expect(ignored(cache, "Logs/run.log")).toBe(true);
    expect(ignored(cache, "Saved/keep.txt")).toBe(false);
  });

  it("finds .chkignore files in directories that hold no tracked files", async () => {
    // Discovery used to walk only directories containing submitted files, so a
    // nested .chkignore in an untracked subtree was never read.
    await write("Content/.chkignore", "Cache\n");
    await write("Content/Cache/blob.bin");
    await write("Content/Map.uasset");

    const patterns = await scanWorkspaceIgnoreFiles(workspacePath);
    const cache = buildIgnoreCacheFromPatterns(patterns);

    expect(patterns.ignore.map((e) => e.relativeDir)).toEqual(["Content"]);
    expect(ignored(cache, "Content/Cache/blob.bin")).toBe(true);
    expect(ignored(cache, "Content/Map.uasset")).toBe(false);
  });

  it("scopes nested patterns to the directory that declares them", async () => {
    await write("sub/.chkignore", "*.log\n");
    await write("sub/a.log");
    await write("sub/deep/b.log");
    await write("other/c.log");

    const cache = await buildCache();

    // No separator in the pattern, so it floats to any depth below `sub`.
    expect(ignored(cache, "sub/a.log")).toBe(true);
    expect(ignored(cache, "sub/deep/b.log")).toBe(true);
    // ...but never escapes to a sibling subtree.
    expect(ignored(cache, "other/c.log")).toBe(false);
  });

  it("anchors nested patterns that contain a separator", async () => {
    await write("sub/.chkignore", "build/out\n");
    await write("sub/build/out/x.o");
    await write("sub/deep/build/out/y.o");

    const cache = await buildCache();

    expect(ignored(cache, "sub/build/out/x.o")).toBe(true);
    expect(ignored(cache, "sub/deep/build/out/y.o")).toBe(false);
  });

  it("lets a nested .chkignore negate a root rule", async () => {
    await write(".chkignore", "*.log\n");
    await write("sub/.chkignore", "!keep.log\n");
    await write("sub/keep.log");
    await write("sub/drop.log");
    await write("root.log");

    const cache = await buildCache();

    expect(ignored(cache, "sub/keep.log")).toBe(false);
    expect(ignored(cache, "sub/drop.log")).toBe(true);
    expect(ignored(cache, "root.log")).toBe(true);
  });

  it("matches directory-only patterns against the directory itself", async () => {
    // `ignore` matches on the raw string, so `Saved/` does not match the bare
    // path `Saved`. Callers that know they hold a directory must say so.
    await write(".chkignore", "Saved/\n");
    await write("Saved/a.txt");

    const cache = await buildCache();

    expect(ignored(cache, "Saved", true)).toBe(true);
    expect(ignored(cache, "Saved/a.txt")).toBe(true);
  });

  it("does not descend into ignored directories", async () => {
    // A .chkignore inside an ignored subtree has no effect, and the walk must
    // not pay to enumerate it (Unreal's Saved/ and Intermediate/ dominate the
    // file count in a real project).
    await write(".chkignore", "Saved\n");
    await write("Saved/.chkignore", "!important.log\n");
    await write("Saved/important.log");

    const patterns = await scanWorkspaceIgnoreFiles(workspacePath);

    expect(patterns.ignore.map((e) => e.relativeDir)).toEqual([""]);
    expect(
      ignored(buildIgnoreCacheFromPatterns(patterns), "Saved/important.log"),
    ).toBe(true);
  });

  it("returns entries parent-first so deeper rules win", async () => {
    await write(".chkignore", "*.tmp\n");
    await write("a/.chkignore", "*.bak\n");
    await write("a/b/.chkignore", "!x.bak\n");
    await write("a/b/x.bak");

    const patterns = await scanWorkspaceIgnoreFiles(workspacePath);

    expect(patterns.ignore.map((e) => e.relativeDir)).toEqual(["", "a", "a/b"]);
    expect(ignored(buildIgnoreCacheFromPatterns(patterns), "a/b/x.bak")).toBe(
      false,
    );
  });

  it("never walks or reports the .checkpoint directory", async () => {
    await write(".checkpoint/workspace.json", "{}");
    await write(".checkpoint/.chkignore", "nonsense\n");

    const patterns = await scanWorkspaceIgnoreFiles(workspacePath);
    const cache = buildIgnoreCacheFromPatterns(patterns);

    expect(patterns.ignore).toEqual([]);
    expect(ignored(cache, ".checkpoint", true)).toBe(true);
    expect(ignored(cache, ".checkpoint/workspace.json")).toBe(true);
  });

  it("collects .chkhidden separately and keeps walking hidden subtrees", async () => {
    await write(".chkhidden", "Config\n");
    await write("Config/.chkignore", "generated\n");
    await write("Config/generated/out.ini");
    await write("Config/Default.ini");

    const patterns = await scanWorkspaceIgnoreFiles(workspacePath);
    const cache = buildIgnoreCacheFromPatterns(patterns);

    // Hidden files are still tracked, so hidden rules must not prune the walk.
    expect(patterns.ignore.map((e) => e.relativeDir)).toEqual(["Config"]);
    expect(patterns.hidden.map((e) => e.relativeDir)).toEqual([""]);
    expect(ignored(cache, "Config/generated/out.ini")).toBe(true);
    expect(matchesPattern(cache.hidden, "Config/Default.ini")).toBe(true);
    expect(isIgnoredOrHidden(cache, "Config/Default.ini")).toBe(true);
  });

  it("ignores comments and blank lines", async () => {
    await write(".chkignore", "# a comment\n\n  Saved  \n");
    await write("Saved/a.txt");
    await write("# a comment/b.txt");

    const cache = await buildCache();

    expect(ignored(cache, "Saved/a.txt")).toBe(true);
    expect(ignored(cache, "# a comment/b.txt")).toBe(false);
  });

  it("returns an empty result when the workspace has no ignore files", async () => {
    await write("Source/Game.cpp");

    const patterns = await scanWorkspaceIgnoreFiles(workspacePath);

    expect(patterns).toEqual({ ignore: [], hidden: [] });
  });
});

describe("windows separators", () => {
  // `ignore` treats `\` as a literal, so an unnormalized `Saved\Config` matches
  // nothing at all. Checkpoint is Windows-first: a `.chkignore` written by hand
  // there uses backslashes, and paths handed to the daemon mix both forms.

  it("treats a backslash in a .chkignore line as a separator", async () => {
    await write(".chkignore", `Saved${B}Config${NL}Binaries${B}Win64${NL}`);
    await write("Saved/Config/Editor.ini");
    await write("Saved/Logs/run.log");
    await write("Binaries/Win64/Game.dll");

    const cache = await buildCache();

    expect(ignored(cache, "Saved/Config/Editor.ini")).toBe(true);
    expect(ignored(cache, "Binaries/Win64/Game.dll")).toBe(true);
    // Anchored exactly like `Saved/Config` would be, so siblings survive.
    expect(ignored(cache, "Saved/Logs/run.log")).toBe(false);
  });

  it("treats a trailing backslash as a directory-only rule", async () => {
    await write(".chkignore", `Saved${B}${NL}`);
    await write("Saved/a.txt");

    const cache = await buildCache();

    expect(ignored(cache, "Saved", true)).toBe(true);
    expect(ignored(cache, "Saved/a.txt")).toBe(true);
  });

  it("matches paths that mix both separators", async () => {
    await write(".chkignore", `path/to/some/folder${NL}`);
    await write("path/to/some/folder/file.txt");

    const cache = await buildCache();

    expect(ignored(cache, `path${B}to${B}some/folder/file.txt`)).toBe(true);
    expect(ignored(cache, `path${B}to${B}some${B}folder`, true)).toBe(true);
    expect(ignored(cache, "path/to/some/folder/file.txt")).toBe(true);
  });

  it("handles a backslash pattern matched against a backslash path", async () => {
    await write(".chkignore", `web-port${B}dist${NL}`);
    await write("web-port/dist/index.html");

    const cache = await buildCache();

    expect(ignored(cache, `web-port${B}dist${B}index.html`)).toBe(true);
  });

  it("normalizes separators in nested ignore files too", async () => {
    await write("sub/.chkignore", `build${B}out${NL}`);
    await write("sub/build/out/x.o");
    await write("sub/build/keep.o");

    const cache = await buildCache();

    expect(ignored(cache, `sub${B}build${B}out${B}x.o`)).toBe(true);
    expect(ignored(cache, "sub/build/keep.o")).toBe(false);
  });

  it("tolerates leading and duplicated separators instead of throwing", async () => {
    // `ignore` throws on "", ".", "./x" and "/x"; every path funnels through
    // matchesPattern, so those forms must be absorbed rather than crash a scan.
    await write(".chkignore", `Saved${NL}`);
    await write("Saved/a.txt");

    const cache = await buildCache();

    expect(ignored(cache, "/Saved/a.txt")).toBe(true);
    expect(ignored(cache, "./Saved/a.txt")).toBe(true);
    expect(ignored(cache, `${B}Saved${B}a.txt`)).toBe(true);
    expect(ignored(cache, "Saved//a.txt")).toBe(true);

    // The workspace root is never ignorable, and these forms would throw.
    expect(ignored(cache, "")).toBe(false);
    expect(ignored(cache, ".")).toBe(false);
    expect(ignored(cache, "/")).toBe(false);
  });

  it("keeps duplicated separators from breaking a floating nested pattern", async () => {
    // A nested pattern compiles to `sub/**/x`, and `sub/**//x` matches nothing.
    await write("sub/.chkignore", `*.log${NL}`);
    await write("sub/deep/a.log");

    const cache = await buildCache();

    expect(ignored(cache, "sub//deep//a.log")).toBe(true);
    expect(ignored(cache, `sub${B}deep${B}a.log`)).toBe(true);
  });

  it("keeps a directory-only rule working through a duplicated separator", async () => {
    await write(".chkignore", `Saved/${NL}`);
    await write("Saved/a.txt");

    const cache = await buildCache();

    expect(ignored(cache, "Saved/", true)).toBe(true);
    expect(ignored(cache, `Saved${B}`, true)).toBe(true);
  });
});

describe("normalizeRelativePath", () => {
  it.each([
    [`path${B}to${B}some/folder/file.txt`, "path/to/some/folder/file.txt"],
    [`${B}${B}Saved`, "Saved"],
    [`.${B}Saved`, "Saved"],
    ["./Saved", "Saved"],
    ["/Saved", "Saved"],
    ["Saved//a.txt", "Saved/a.txt"],
    [".", ""],
    ["", ""],
    ["Saved/", "Saved/"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeRelativePath(input)).toBe(expected);
  });
});

describe("prefixIgnorePattern", () => {
  it.each([
    // [relativeDir, line, expected]
    ["", "Saved", "Saved"],
    ["", "!keep.log", "!keep.log"],
    ["sub", "*.log", "sub/**/*.log"],
    ["sub", "build/out", "sub/build/out"],
    ["sub", "/anchored", "sub/anchored"],
    ["sub", "Saved/", "sub/**/Saved/"],
    ["sub", "!keep.log", "!sub/**/keep.log"],
    ["sub", "!build/out/", "!sub/build/out/"],
    ["a/b", "*.tmp", "a/b/**/*.tmp"],
    // Backslashes are separators, in both the pattern and the directory.
    ["", `Saved${B}Config`, "Saved/Config"],
    ["", `Binaries${B}`, "Binaries/"],
    ["sub", `build${B}out`, "sub/build/out"],
    ["sub", `!build${B}out${B}`, "!sub/build/out/"],
    [`a${B}b`, "*.tmp", "a/b/**/*.tmp"],
    ["a/b/", "*.tmp", "a/b/**/*.tmp"],
    ["sub", `${B}anchored`, "sub/anchored"],
  ])("prefixes %j + %j as %j", (relativeDir, line, expected) => {
    expect(prefixIgnorePattern(relativeDir, line)).toBe(expected);
  });
});

describe("getFileStatuses", () => {
  const emptyState: WorkspaceState = {
    files: {},
  } as unknown as WorkspaceState;

  it("reports ignored files and ignored directories as Ignored", async () => {
    await write(".chkignore", "Saved/\nBinaries\n");
    await write("Saved/a.ini");
    await write("Binaries/game.dll");
    await write("Source/Game.cpp");

    const cache = await buildCache();
    const statuses = await getFileStatuses(
      workspacePath,
      [
        { relativePath: "Saved", existsOnDisk: true, isDirectory: true },
        { relativePath: "Saved/a.ini", existsOnDisk: true, isDirectory: false },
        { relativePath: "Binaries", existsOnDisk: true, isDirectory: true },
        {
          relativePath: "Source/Game.cpp",
          existsOnDisk: true,
          isDirectory: false,
        },
      ],
      emptyState,
      cache,
    );

    expect(statuses.get("Saved")?.status).toBe(FileStatus.Ignored);
    expect(statuses.get("Saved/a.ini")?.status).toBe(FileStatus.Ignored);
    expect(statuses.get("Binaries")?.status).toBe(FileStatus.Ignored);
    expect(statuses.get("Source/Game.cpp")?.status).toBe(FileStatus.Local);
  });

  it("reports .chkhidden matches as HiddenChanges", async () => {
    await write(".chkhidden", "Config\n");
    await write("Config/Default.ini");

    const cache = await buildCache();
    const statuses = await getFileStatuses(
      workspacePath,
      [
        {
          relativePath: "Config/Default.ini",
          existsOnDisk: true,
          isDirectory: false,
        },
      ],
      emptyState,
      cache,
    );

    expect(statuses.get("Config/Default.ini")?.status).toBe(
      FileStatus.HiddenChanges,
    );
  });

  it("keeps ignored files out of the result even when they have pending changes", async () => {
    await write(".chkignore", "Saved\n");
    await write("Saved/a.ini");

    const cache = await buildCache();
    const statuses = await getFileStatuses(
      workspacePath,
      [{ relativePath: "Saved/a.ini", existsOnDisk: true, isDirectory: false }],
      emptyState,
      cache,
      {
        "Saved/a.ini": {
          status: FileStatus.Local,
          id: null,
          changelist: null,
        },
      },
    );

    expect(statuses.get("Saved/a.ini")?.status).toBe(FileStatus.Ignored);
  });
});
