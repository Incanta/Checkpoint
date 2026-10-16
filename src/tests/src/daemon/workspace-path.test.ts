/**
 * The daemon's containment check (src/core/daemon/src/util/workspace-path.ts)
 * and its copy of the server's path rules, which must answer exactly as the
 * app's (src/app/src/server/repo-path.ts) does.
 */
import path from "node:path";

import { describe, expect, it } from "vitest";

import * as appRules from "~/server/repo-path";
import * as daemonRules from "../../../core/daemon/src/util/repo-path-rules.js";
import {
  UnsafePathError,
  resolveInWorkspace,
  unsafePathReason,
} from "../../../core/daemon/src/util/workspace-path.js";

const VECTORS = [
  "Content/hero.uasset",
  "../escape.txt",
  "Content/../../escape.txt",
  "./a.txt",
  "Content//a.txt",
  "/rooted.txt",
  "Content/a.txt/",
  "C:/Windows/x",
  "",
  "a/\u0000b",
  "lone\ud800.txt",
  `${"a/".repeat(600)}x`,
  ".checkpoint/workspace.json",
  ".CHECKPOINT/workspace.json",
  ".checkpoint./x",
  ".checkpoint::$INDEX_ALLOCATION/x",
  ".check\u200cpoint/x",
  "CHECKP~1/x",
  ".checkpointrc",
  "Source/aux.h",
  "Logs/COM\u00b9.txt",
  "Content/level.",
  "Content/level ",
  "Notes/standup 10:15.txt",
  "Content/HERO~1.UAS",
  `Docs/${"\u6587".repeat(100)}.txt`,
  "Docs/emoji \u{1f3ae}.txt",
];

describe("the daemon's copy of the path rules", () => {
  it.each(VECTORS)("answers as the app does for %j", (p) => {
    expect(daemonRules.canonicalPathProblem(p)).toBe(
      appRules.canonicalPathProblem(p),
    );
    expect(daemonRules.portablePathProblem(p)).toBe(
      appRules.portablePathProblem(p),
    );
  });
});

describe("resolveInWorkspace", () => {
  const root = path.resolve("/workspaces/game");

  it("resolves a repo path inside the workspace", () => {
    expect(resolveInWorkspace(root, "Content/Maps/arena.umap")).toBe(
      path.join(root, "Content", "Maps", "arena.umap"),
    );
  });

  it.each([
    "../x",
    "Content/../../x",
    "/etc/passwd",
    "C:/Windows/x",
    ".checkpoint/workspace.json",
    ".Checkpoint/state.db",
    "",
  ])("refuses %j", (p) => {
    expect(() => resolveInWorkspace(root, p)).toThrow(UnsafePathError);
  });

  it("accepts backslash separators, which stay inside", () => {
    expect(resolveInWorkspace(root, "Content\\a.txt")).toBe(
      path.join(root, "Content", "a.txt"),
    );
    expect(() => resolveInWorkspace(root, "Content\\..\\..\\x")).toThrow(
      UnsafePathError,
    );
  });

  it("allows a name that merely starts with two dots", () => {
    expect(resolveInWorkspace(root, "..notes.txt")).toBe(
      path.join(root, "..notes.txt"),
    );
  });

  it("refuses a colon only on Windows, where NTFS reads it as a stream", () => {
    expect(unsafePathReason("Notes/10:15.txt", "win32")).not.toBeNull();
    expect(unsafePathReason("Notes/10:15.txt", "linux")).toBeNull();
    expect(unsafePathReason("Notes/10:15.txt", "darwin")).toBeNull();
  });
});
