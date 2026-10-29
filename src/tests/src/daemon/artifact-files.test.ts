/**
 * Which files an artifact upload collects (src/core/daemon/src/util/
 * artifact-files.ts): the repo config's include and exclude patterns for the
 * type, with `.chkignore` not applying, since build outputs are what it
 * ignores.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  artifactRulesFor,
  collectArtifactFiles,
  expandArtifactPaths,
  walkRoots,
} from "../../../core/daemon/src/util/artifact-files.js";

let root: string;

async function files(...paths: string[]): Promise<void> {
  for (const p of paths) {
    await mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await writeFile(path.join(root, p), p);
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "artifact-files-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("walkRoots", () => {
  it("starts at the literal folders before each pattern's last segment", () => {
    expect(walkRoots(["Engine/Binaries/Win64/"])).toEqual(["Engine/Binaries"]);
    expect(walkRoots(["/Engine/Binaries/Win64/**"])).toEqual([
      "Engine/Binaries/Win64",
    ]);
    expect(walkRoots(["Engine/Plugins/**/Binaries/"])).toEqual([
      "Engine/Plugins",
    ]);
  });

  it("walks everything for a pattern that matches at any depth", () => {
    expect(walkRoots(["*.dll"])).toEqual([""]);
    expect(walkRoots(["Binaries/"])).toEqual([""]);
    expect(walkRoots(["**/Binaries/Win64/"])).toEqual([""]);
    expect(walkRoots(["Engine/Binaries/", "*.dll"])).toEqual([""]);
  });

  it("keeps only the outermost roots, ignoring negations and comments", () => {
    expect(
      walkRoots([
        "Engine/Binaries/Win64/",
        "Engine/Binaries/Win64/Foo/",
        "engine/binaries/Linux/",
        "Engine/Plugins/X/Binaries/",
        "!Engine/Source/",
        "# note",
      ]),
    ).toEqual(["Engine/Binaries", "Engine/Plugins/X"]);
  });
});

describe("collectArtifactFiles", () => {
  beforeEach(async () => {
    await files(
      ".chkignore",
      "Engine/Binaries/Win64/UnrealEditor.exe",
      "Engine/Binaries/Win64/UnrealEditor.pdb",
      "Engine/Binaries/Win64/Sub/Tool.dll",
      "Engine/Binaries/Linux/UnrealEditor",
      "Engine/Plugins/Foo/Binaries/Win64/Foo.dll",
      "Engine/Plugins/Foo/Binaries/Win64/Foo.pdb",
      "Engine/Plugins/Foo/Source/Foo.cpp",
      "Engine/Source/Main.cpp",
      ".checkpoint/workspace.json",
    );
    await writeFile(path.join(root, ".chkignore"), "Binaries/\n*.pdb\n");
  });

  it("selects what the include patterns match and the exclude patterns don't, whatever .chkignore says", async () => {
    expect(
      await collectArtifactFiles(root, {
        include: ["Engine/Binaries/Win64/", "Engine/Plugins/**/Binaries/Win64/"],
        exclude: ["*.pdb"],
      }),
    ).toEqual([
      "Engine/Binaries/Win64/Sub/Tool.dll",
      "Engine/Binaries/Win64/UnrealEditor.exe",
      "Engine/Plugins/Foo/Binaries/Win64/Foo.dll",
    ]);
  });

  it("matches at any depth for a pattern without a slash before its end", async () => {
    expect(
      await collectArtifactFiles(root, { include: ["*.dll"], exclude: [] }),
    ).toEqual([
      "Engine/Binaries/Win64/Sub/Tool.dll",
      "Engine/Plugins/Foo/Binaries/Win64/Foo.dll",
    ]);
  });

  it("drops a whole excluded folder", async () => {
    expect(
      await collectArtifactFiles(root, {
        include: ["Engine/Binaries/"],
        exclude: ["Linux/", "Sub/", "*.pdb"],
      }),
    ).toEqual(["Engine/Binaries/Win64/UnrealEditor.exe"]);
  });

  it("never collects .checkpoint, or anything in a nested workspace", async () => {
    expect(
      await collectArtifactFiles(
        root,
        { include: ["*"], exclude: [] },
        ["Engine/Plugins/Foo"],
      ),
    ).not.toContain(".checkpoint/workspace.json");
    const collected = await collectArtifactFiles(
      root,
      { include: ["*"], exclude: [] },
      ["Engine/Plugins/Foo"],
    );
    expect(collected.some((f) => f.startsWith("Engine/Plugins/Foo"))).toBe(
      false,
    );
    expect(collected).toContain("Engine/Source/Main.cpp");
  });

  it("collects nothing when nothing matches", async () => {
    expect(
      await collectArtifactFiles(root, {
        include: ["Game/Binaries/"],
        exclude: [],
      }),
    ).toEqual([]);
  });
});

describe("expandArtifactPaths", () => {
  beforeEach(async () => {
    await files(
      "Engine/Binaries/Win64/UnrealEditor.exe",
      "Engine/Binaries/Win64/UnrealEditor.pdb",
      "Engine/Binaries/Win64/Sub/Tool.dll",
    );
    await writeFile(path.join(root, ".chkignore"), "Binaries/\n");
  });

  it("expands a folder without .chkignore, minus the exclude patterns", async () => {
    expect(
      await expandArtifactPaths(root, ["Engine/Binaries"], ["*.pdb"]),
    ).toEqual([
      "Engine/Binaries/Win64/Sub/Tool.dll",
      "Engine/Binaries/Win64/UnrealEditor.exe",
    ]);
  });

  it("keeps a file named outright, even one the exclude patterns match", async () => {
    expect(
      await expandArtifactPaths(
        root,
        ["Engine/Binaries/Win64/UnrealEditor.pdb", "./Engine/Binaries/Win64/Sub/"],
        ["*.pdb"],
      ),
    ).toEqual([
      "Engine/Binaries/Win64/Sub/Tool.dll",
      "Engine/Binaries/Win64/UnrealEditor.pdb",
    ]);
  });

  it("refuses a path that is missing or in a nested workspace", async () => {
    await expect(
      expandArtifactPaths(root, ["Engine/Nope.dll"], []),
    ).rejects.toThrow(/does not exist/);
    await expect(
      expandArtifactPaths(root, ["Engine/Binaries/Win64"], [], ["Engine/Binaries"]),
    ).rejects.toThrow(/nested here/);
  });
});

describe("artifactRulesFor", () => {
  it("reads a type's patterns, defaulting the missing ones", () => {
    const channels = [
      { type: "editor", requiredBadges: [], include: ["A/"] },
      { type: "game", requiredBadges: [], include: ["B/"], exclude: ["*.pdb"] },
    ];
    expect(artifactRulesFor(channels, "editor")).toEqual({
      include: ["A/"],
      exclude: [],
    });
    expect(artifactRulesFor(channels, "game")).toEqual({
      include: ["B/"],
      exclude: ["*.pdb"],
    });
    expect(artifactRulesFor(channels, "server")).toBeNull();
    expect(artifactRulesFor(undefined, "editor")).toBeNull();
  });
});
