/**
 * Folders that belong to another workspace nested inside this one (a Team
 * Sync mount path, or a folder holding its own .checkpoint): the ignore scan
 * finds them and stops there, the ignore cache excludes them in a way no
 * project ignore file can undo, and directory removals step around them
 * (src/core/daemon/src/file-status.ts, util/nested-workspaces.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildIgnoreCacheFromPatterns,
  isIgnoredOrHidden,
  ownedWithin,
  ownerOf,
  scanWorkspaceIgnoreFiles,
} from "../../../core/daemon/src/file-status.js";
import { removeTreeKeepingOwned } from "../../../core/daemon/src/util/nested-workspaces.js";

let root: string;

beforeEach(async () => {
  root = (await mkdtemp(path.join(tmpdir(), "chk-nested-"))).replace(
    /\\/g,
    "/",
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const write = async (rel: string, content = "x") => {
  const full = path.join(root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
};

/** Makes `rel` a workspace root, as `.checkpoint/workspace.json` does. */
const makeWorkspace = (rel: string) =>
  write(`${rel}/.checkpoint/workspace.json`, "{}");

describe("scanWorkspaceIgnoreFiles", () => {
  it("finds nested workspaces and does not read their ignore files", async () => {
    await write(".chkignore", "*.tmp\n");
    await makeWorkspace("Plugins/Studio");
    await write("Plugins/Studio/.chkignore", "*.uasset\n");
    await makeWorkspace("Tools/Deep/Child");
    await write("Source/.chkignore", "*.obj\n");

    const patterns = await scanWorkspaceIgnoreFiles(root);
    expect(patterns.nestedWorkspaces?.sort()).toEqual([
      "Plugins/Studio",
      "Tools/Deep/Child",
    ]);
    const dirs = patterns.ignore.map((e) => e.relativeDir).sort();
    expect(dirs).toEqual(["", "Source"]);
  });

  it("does not count a folder that is merely named .checkpoint", async () => {
    await write("Docs/.checkpoint/notes.txt");
    const patterns = await scanWorkspaceIgnoreFiles(root);
    expect(patterns.nestedWorkspaces).toEqual([]);
  });

  it("does not count the workspace's own .checkpoint", async () => {
    await makeWorkspace(".");
    const patterns = await scanWorkspaceIgnoreFiles(root);
    expect(patterns.nestedWorkspaces).toEqual([]);
  });
});

describe("buildIgnoreCacheFromPatterns with owned folders", () => {
  const ignored = (
    cache: ReturnType<typeof buildIgnoreCacheFromPatterns>,
    p: string,
    dir = false,
  ) => isIgnoredOrHidden(cache, p, dir);

  it("ignores mount paths and nested workspaces, and everything in them", () => {
    const cache = buildIgnoreCacheFromPatterns(
      { ignore: [], hidden: [], nestedWorkspaces: ["Tools/Child"] },
      ["Plugins/Studio"],
    );
    expect(cache.owned).toEqual(["Plugins/Studio", "Tools/Child"]);
    expect(ignored(cache, "Plugins/Studio", true)).toBe(true);
    expect(ignored(cache, "Plugins/Studio/a/b.cpp")).toBe(true);
    expect(ignored(cache, "Tools/Child/x.txt")).toBe(true);
    // Neighbors are not.
    expect(ignored(cache, "Plugins/StudioTools/a.cpp")).toBe(false);
    expect(ignored(cache, "Plugins/a.cpp")).toBe(false);
    expect(ignored(cache, "Studio/a.cpp")).toBe(false);
  });

  it("anchors to the workspace root", () => {
    const cache = buildIgnoreCacheFromPatterns({ ignore: [], hidden: [] }, [
      "Studio",
    ]);
    expect(ignored(cache, "Studio/a")).toBe(true);
    expect(ignored(cache, "Plugins/Studio/a")).toBe(false);
  });

  it("can't be undone by a project ignore file", () => {
    const cache = buildIgnoreCacheFromPatterns(
      {
        ignore: [
          {
            absolutePath: `${root}/.chkignore`,
            relativeDir: "",
            patterns: ["!Plugins/Studio/", "!Plugins/Studio/**"],
          },
        ],
        hidden: [],
      },
      ["Plugins/Studio"],
    );
    expect(ignored(cache, "Plugins/Studio/a.cpp")).toBe(true);
  });

  it("matches folder names with glob characters literally", () => {
    const cache = buildIgnoreCacheFromPatterns({ ignore: [], hidden: [] }, [
      "Plugins/[Studio] *Kit?",
      "!Bang",
      "#Hash",
    ]);
    expect(ignored(cache, "Plugins/[Studio] *Kit?/a")).toBe(true);
    expect(ignored(cache, "Plugins/S *KitX/a")).toBe(false);
    expect(ignored(cache, "!Bang/a")).toBe(true);
    expect(ignored(cache, "#Hash/a")).toBe(true);
  });

  it("drops duplicates, spelled differently or with stray slashes", () => {
    const cache = buildIgnoreCacheFromPatterns(
      { ignore: [], hidden: [], nestedWorkspaces: ["plugins/studio"] },
      ["Plugins/Studio/", "", "/"],
    );
    expect(cache.owned).toHaveLength(1);
  });
});

describe("ownerOf and ownedWithin", () => {
  const owned = ["Plugins/Studio", "Art"];
  it("finds the owning folder in any case", () => {
    expect(ownerOf(owned, "plugins/studio/x")).toBe("Plugins/Studio");
    expect(ownerOf(owned, "Art")).toBe("Art");
    expect(ownerOf(owned, "Artwork/x")).toBeNull();
    expect(ownerOf(owned, "Plugins")).toBeNull();
  });
  it("lists owned folders at or below a directory", () => {
    expect(ownedWithin(owned, "Plugins")).toEqual(["Plugins/Studio"]);
    expect(ownedWithin(owned, "")).toEqual(owned);
    expect(ownedWithin(owned, "Source")).toEqual([]);
    expect(ownedWithin(owned, "Plugins/Studio")).toEqual(["Plugins/Studio"]);
  });
});

describe("removeTreeKeepingOwned", () => {
  it("removes a directory with no owned folder in it", async () => {
    await write("Junk/a/b.txt");
    expect(await removeTreeKeepingOwned(root, "Junk", ["Plugins/Studio"])).toBe(
      true,
    );
    expect(existsSync(path.join(root, "Junk"))).toBe(false);
  });

  it("removes everything around an owned folder and keeps it whole", async () => {
    await write("Plugins/stray.txt");
    await write("Plugins/Other/x.uplugin");
    await write("Plugins/Studio/keep.uplugin", "keep");
    await write("Plugins/Studio/Source/a.cpp", "keep");

    expect(
      await removeTreeKeepingOwned(root, "Plugins", ["Plugins/Studio"]),
    ).toBe(false);
    expect(await readdir(path.join(root, "Plugins"))).toEqual(["Studio"]);
    expect(existsSync(path.join(root, "Plugins/Studio/keep.uplugin"))).toBe(
      true,
    );
    expect(existsSync(path.join(root, "Plugins/Studio/Source/a.cpp"))).toBe(
      true,
    );
  });

  it("leaves an owned folder alone when asked to remove it", async () => {
    await write("Plugins/Studio/keep.uplugin");
    expect(
      await removeTreeKeepingOwned(root, "plugins/studio", ["Plugins/Studio"]),
    ).toBe(false);
    expect(existsSync(path.join(root, "Plugins/Studio/keep.uplugin"))).toBe(
      true,
    );
  });
});
