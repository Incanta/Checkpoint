/**
 * Folders nested linked repos are mounted at belong to the child repo
 * (src/app/src/server/team-sync/mounts.ts): a link onto files the parent
 * tracks is a config error, and a submit adding files there is refused.
 */
import { describe, expect, it } from "vitest";

import {
  mountCollisionErrors,
  mountContaining,
  mountPathsOf,
  mountSubmitProblem,
  trackedUnderMount,
  type ListTreeDir,
} from "~/server/team-sync/mounts";

/** A tree as a list of file paths, listed the way the state tree is. */
function treeOf(paths: string[]): ListTreeDir & { reads: string[] } {
  const reads: string[] = [];
  const list = async (dir: string) => {
    reads.push(dir);
    const prefix = dir ? `${dir}/` : "";
    const under = paths.filter((p) => p.startsWith(prefix));
    if (dir && under.length === 0) return null;
    const files = new Set<string>();
    const dirs = new Set<string>();
    for (const p of under) {
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) files.add(rest);
      else dirs.add(rest.slice(0, slash));
    }
    return { files: [...files].map((name) => ({ name })), dirs: [...dirs] };
  };
  return Object.assign(list, { reads });
}

describe("mountPathsOf", () => {
  it("keeps only nested links, without stray slashes", () => {
    expect(
      mountPathsOf([
        { repo: "UE5" },
        { repo: "Plugins", path: "Plugins/Studio/" },
        { repo: "Art", path: "\\Art\\Source" },
      ]),
    ).toEqual(["Plugins/Studio", "Art/Source"]);
    expect(mountPathsOf(undefined)).toEqual([]);
  });
});

describe("mountContaining", () => {
  const mounts = ["Plugins/Studio"];
  it("matches the folder and what is inside it, in any case", () => {
    expect(mountContaining("Plugins/Studio", mounts)).toBe("Plugins/Studio");
    expect(mountContaining("plugins/studio/a.uplugin", mounts)).toBe(
      "Plugins/Studio",
    );
  });
  it("does not match a sibling that shares a prefix", () => {
    expect(mountContaining("Plugins/StudioTools/a.txt", mounts)).toBeNull();
    expect(mountContaining("Plugins/a.txt", mounts)).toBeNull();
  });
});

describe("trackedUnderMount", () => {
  it("finds nothing when the folder is not in the tree", async () => {
    const tree = treeOf(["Source/game.cpp", "Plugins/Other/x.uplugin"]);
    expect(await trackedUnderMount("Plugins/Studio", tree)).toBeNull();
  });

  it("names a file inside the folder, however deep", async () => {
    const tree = treeOf(["Plugins/Studio/Source/Deep/a.cpp"]);
    expect(await trackedUnderMount("Plugins/Studio", tree)).toBe(
      "Plugins/Studio/Source/Deep/a.cpp",
    );
  });

  it("finds the folder under another spelling", async () => {
    const tree = treeOf(["plugins/STUDIO/a.uplugin"]);
    expect(await trackedUnderMount("Plugins/Studio", tree)).toBe(
      "plugins/STUDIO/a.uplugin",
    );
  });

  it("counts a file standing where the folder would go", async () => {
    const tree = treeOf(["Plugins/Studio"]);
    expect(await trackedUnderMount("Plugins/Studio", tree)).toBe(
      "Plugins/Studio",
    );
    const parentIsFile = treeOf(["Plugins"]);
    expect(await trackedUnderMount("Plugins/Studio", parentIsFile)).toBe(
      "Plugins",
    );
  });

  it("only reads the directories on the way down", async () => {
    const tree = treeOf([
      "Content/a.uasset",
      "Content/b/c.uasset",
      "Plugins/Other/x",
    ]);
    await trackedUnderMount("Plugins/Studio", tree);
    expect(tree.reads).toEqual(["", "Plugins"]);
  });
});

describe("mountCollisionErrors", () => {
  it("reports each nested link mounted onto tracked files", async () => {
    const errors = await mountCollisionErrors(
      [
        { repo: "UE5" },
        { repo: "StudioPlugins", path: "Plugins/Studio" },
        { repo: "Art", path: "Art/Source" },
      ],
      treeOf(["Plugins/Studio/old.uplugin", "Source/game.cpp"]),
    );
    expect(errors).toEqual([
      'linkedRepos.1.path: "Plugins/Studio" is where StudioPlugins would be mounted, but this repo tracks files there (Plugins/Studio/old.uplugin). Move or delete them first.',
    ]);
  });
});

describe("mountSubmitProblem", () => {
  const mounts = ["Plugins/Studio"];

  it("allows submits outside mount paths, and none at all without mounts", () => {
    expect(
      mountSubmitProblem([{ path: "Source/a.cpp", delete: false }], mounts),
    ).toBeNull();
    expect(
      mountSubmitProblem([{ path: "Plugins/Studio/a", delete: false }], []),
    ).toBeNull();
  });

  it("refuses adding or changing files in a mount path, in any case", () => {
    const problem = mountSubmitProblem(
      [
        { path: "Source/a.cpp", delete: false },
        { path: "plugins/studio/a.uplugin", delete: false },
      ],
      mounts,
    );
    expect(problem).toMatch(/Cannot submit plugins\/studio\/a\.uplugin/);
    expect(problem).toMatch(/Plugins\/Studio belongs to a linked repo/);
  });

  it("allows deleting files there, which clears the way", () => {
    expect(
      mountSubmitProblem([{ path: "Plugins/Studio/a", delete: true }], mounts),
    ).toBeNull();
  });

  it("names a few files and counts the rest", () => {
    const mods = Array.from({ length: 8 }, (_, i) => ({
      path: `Plugins/Studio/f${i}`,
      delete: false,
    }));
    expect(mountSubmitProblem(mods, mounts)).toMatch(/f4 and 3 more:/);
  });
});
