/**
 * Cover for the path list `expandDirectoriesForSubmit` hands to the native
 * submit.
 *
 * The reported bug: a selection naming both a directory and files under it
 * produced the same path twice (once pushed directly, once from the directory
 * walk). The addon sizes files by name, so only one of the duplicates got a
 * size and the other went into the changelist as a 0-byte asset, overwriting
 * real content for everyone who pulled it. These tests pin the dedupe.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DaemonManager } from "../../../core/daemon/src/daemon-manager.js";
import type { Workspace } from "../../../core/daemon/src/types/index.js";

const DAEMON_ID = "test-daemon";

let manager: DaemonManager;
let workspacePath: string;
let workspace: Workspace;

async function write(relativePath: string, content = "x"): Promise<void> {
  const full = path.join(workspacePath, relativePath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}

beforeEach(async () => {
  manager = DaemonManager.Get();
  workspacePath = await mkdtemp(path.join(tmpdir(), "chk-expand-"));
  workspace = {
    id: `ws-${path.basename(workspacePath)}`,
    repoId: "repo-1",
    name: "test-workspace",
    domainBranchName: "main",
    activeBranches: [],
    localPath: workspacePath.replace(/\\/g, "/"),
    daemonId: DAEMON_ID,
    userId: "",
    orgId: "",
    createdAt: new Date(0),
    deletedAt: null,
    syncedChangelistNumber: null,
    syncedAt: null,
  } as unknown as Workspace;
});

afterEach(async () => {
  manager.unlinkWorkspace(workspace.id, DAEMON_ID);
  await rm(workspacePath, { recursive: true, force: true });
});

describe("expandDirectoriesForSubmit", () => {
  it("emits a file once when both it and its parent directory are selected", async () => {
    await write("Source/Game.Target.cs");
    await write("Source/GameEditor.Target.cs");
    await manager.registerWorkspace(workspace, { watch: false });

    const expanded = await manager.expandDirectoriesForSubmit(workspace, [
      { delete: false, path: "Source/Game.Target.cs" },
      { delete: false, path: "Source/GameEditor.Target.cs" },
      { delete: false, path: "Source" },
    ]);

    expect(expanded.map((m) => m.path).sort()).toEqual([
      "Source/Game.Target.cs",
      "Source/GameEditor.Target.cs",
    ]);
  });

  it("still expands a directory that contributes files nothing else named", async () => {
    await write("Config/DefaultEngine.ini");
    await write("Config/DefaultGame.ini");
    await manager.registerWorkspace(workspace, { watch: false });

    const expanded = await manager.expandDirectoriesForSubmit(workspace, [
      { delete: false, path: "Config" },
    ]);

    expect(expanded.map((m) => m.path).sort()).toEqual([
      "Config/DefaultEngine.ini",
      "Config/DefaultGame.ini",
    ]);
  });

  it("treats a backslash-written path as the same file as its forward-slash form", async () => {
    const B = String.fromCharCode(92);

    await write("Source/Game.cpp");
    await manager.registerWorkspace(workspace, { watch: false });

    const expanded = await manager.expandDirectoriesForSubmit(workspace, [
      { delete: false, path: `Source${B}Game.cpp` },
      { delete: false, path: "Source/Game.cpp" },
    ]);

    // Normalized to forward slashes, which is the form the native submit and
    // the server's path keys both expect.
    expect(expanded.map((m) => m.path)).toEqual(["Source/Game.cpp"]);
  });

  it("keeps a delete for a path that no longer exists on disk", async () => {
    await manager.registerWorkspace(workspace, { watch: false });

    const expanded = await manager.expandDirectoriesForSubmit(workspace, [
      { delete: true, path: "Source/Gone.cpp" },
    ]);

    expect(expanded).toEqual([{ delete: true, path: "Source/Gone.cpp" }]);
  });
});
