/**
 * Symbolic links and Windows junctions in a workspace (util/links.ts).
 *
 * Checkpoint does not store links yet, and a link to a folder must never be
 * followed: a junction to an engine install turned 19 staged rows into
 * 377,595 files, and a directory symlink inside that tree reached the native
 * submit as a "file" ("Refusing to submit a directory as a file"). A link to
 * a folder is left out of pending changes and never walked; a link to a file
 * is still a pending change (submitted with its target's contents), marked as
 * a link so clients can show it as one.
 *
 * Folder links are made as junctions, which Windows allows without special
 * rights (Node makes a plain symlink elsewhere). File links need symlink
 * rights on Windows, so those tests skip where they cannot be made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { symlinkSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("@checkpointvcs/common", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const client = {
    file: { getWorkspaceClaims: { query: async () => [] } },
    repo: { getRepo: { query: async () => ({ orgId: "org" }) } },
    org: {
      getBinaryExtensions: { query: async () => ({ resolved: [".uasset"] }) },
    },
    branch: { getBranch: { query: async () => null } },
    workspace: { setBranchState: { mutate: async () => undefined } },
  };
  return { ...actual, CreateApiClientAuth: async () => client };
});

import { DaemonManager } from "../../../core/daemon/src/daemon-manager.js";
import {
  FileType,
  type Workspace,
  type WorkspacePendingChanges,
} from "../../../core/daemon/src/types/index.js";
import { closeAllStateStores } from "../../../core/daemon/src/util/state-store.js";
import { readLinkInfo } from "../../../core/daemon/src/util/links.js";

const DAEMON_ID = "test-daemon";

/** Whether this machine lets us make a symbolic link to a file. */
const canLinkFiles = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), "chk-linkprobe-"));
  try {
    writeFileSync(path.join(dir, "t"), "x");
    symlinkSync(path.join(dir, "t"), path.join(dir, "l"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

let manager: DaemonManager;
let root: string;
/** A folder outside the workspace that the links point into. */
let outside: string;
let workspace: Workspace;

async function write(base: string, rel: string, content = rel): Promise<void> {
  const full = path.join(base, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}

async function linkFolder(rel: string, target: string): Promise<void> {
  const full = path.join(root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await symlink(target, full, "junction");
}

beforeEach(async () => {
  manager = DaemonManager.Get();
  root = (await mkdtemp(path.join(tmpdir(), "chk-links-"))).replace(/\\/g, "/");
  outside = await mkdtemp(path.join(tmpdir(), "chk-links-target-"));
  workspace = {
    id: `ws-${path.basename(root)}`,
    repoId: "repo-1",
    name: "links",
    domainBranchName: "main",
    activeBranches: [],
    localPath: root,
    daemonId: DAEMON_ID,
  } as unknown as Workspace;

  // An "engine" with a nested folder link of its own, like the cargo
  // registry link that failed the real submit.
  await write(outside, "Engine/Build/Build.version");
  await write(outside, "Engine/Source/Core.cpp");
  await write(outside, "registry/v8/lib.rs");
  await symlink(
    path.join(outside, "registry"),
    path.join(outside, "Engine/gn_root"),
    "junction",
  );

  await write(root, "Source/Game.cpp");
  await linkFolder("EngineLink", outside);
  await manager.registerWorkspace(workspace, { watch: false });
});

afterEach(async () => {
  manager.unlinkWorkspace(workspace.id, DAEMON_ID);
  closeAllStateStores();
  // Links first, so removing the workspace never reaches through them.
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function rows(result: WorkspacePendingChanges) {
  return Object.fromEntries(
    Object.entries(result.files)
      .map(([p, f]) => [p, `${FileType[f.type]}${f.staged ? "+staged" : ""}`])
      .sort(([a], [b]) => a!.localeCompare(b!)),
  );
}

function full() {
  return manager.refreshWorkspaceContents(workspace, {
    forceFullRefresh: true,
  });
}

/** Refresh the way a running watcher would after reporting `dirty`. */
async function incremental(dirty: string[]) {
  (
    manager as unknown as { watchers: Map<string, { close(): void }> }
  ).watchers.set(workspace.id, { close: () => undefined });
  const set = (
    manager as unknown as { dirtyFiles: Map<string, Set<string>> }
  ).dirtyFiles.get(workspace.id)!;
  for (const p of dirty) set.add(p);
  return manager.refreshWorkspaceContents(workspace);
}

describe("links to folders", () => {
  it("are left out of pending changes", async () => {
    expect(rows(await full())).toEqual({ Source: "Directory" });
  });

  it("do not make an otherwise empty folder count as untracked content", async () => {
    await linkFolder("Plugins/Linked", outside);
    expect(rows(await full())).toEqual({ Source: "Directory" });
  });

  it("are left out by an incremental refresh too", async () => {
    await full();
    await linkFolder("Later", outside);
    expect(rows(await incremental(["Later", "EngineLink"]))).toEqual({
      Source: "Directory",
    });
  });

  it("get no row when staged by name", async () => {
    await manager.stage(workspace, ["EngineLink"]);
    expect(rows(await full())).toEqual({ Source: "Directory" });
  });

  it("are left out when listing a folder's pending children", async () => {
    await linkFolder("Source/ThirdParty", outside);
    const root = await manager.getDirectoryPending(workspace.id, workspace, "");
    expect(root.children.map((c) => c.path).sort()).toEqual(["Source"]);
    const source = await manager.getDirectoryPending(
      workspace.id,
      workspace,
      "Source",
    );
    expect(source.children.map((c) => c.path)).toEqual(["Game.cpp"]);
  });

  it("are never walked or submitted", async () => {
    await linkFolder("Source/ThirdParty", outside);
    const expanded = await manager.expandDirectoriesForSubmit(workspace, [
      { delete: false, path: "Source" },
      { delete: false, path: "EngineLink" },
    ]);
    expect(expanded.map((m) => m.path)).toEqual(["Source/Game.cpp"]);
  });

  it("read as links to folders, with their target", async () => {
    const info = await readLinkInfo(path.join(root, "EngineLink"));
    expect(info.directory).toBe(true);
    expect(path.resolve(info.target)).toBe(path.resolve(outside));
  });
});

describe.skipIf(!canLinkFiles)("links to files", () => {
  beforeEach(async () => {
    await write(outside, "notes.txt", "notes\n");
    await symlink(
      path.join(outside, "notes.txt"),
      path.join(root, "notes-link.txt"),
      "file",
    );
  });

  it("are pending changes, marked as links", async () => {
    const result = await full();
    const row = result.files["notes-link.txt"];
    expect(row?.type).toBe(FileType.Symlink);
    expect(row?.link?.directory).toBe(false);
    expect(path.resolve(row!.link!.target)).toBe(
      path.resolve(outside, "notes.txt"),
    );
  });

  it("are listed as links among a folder's pending children", async () => {
    const listing = await manager.getDirectoryPending(
      workspace.id,
      workspace,
      "",
    );
    const row = listing.children.find((c) => c.path === "notes-link.txt");
    expect(row?.type).toBe(FileType.Symlink);
    expect(row?.link?.directory).toBe(false);
  });

  it("are submitted like files", async () => {
    const expanded = await manager.expandDirectoriesForSubmit(workspace, [
      { delete: false, path: "notes-link.txt" },
    ]);
    expect(expanded.map((m) => m.path)).toEqual(["notes-link.txt"]);
  });

  it("make an otherwise empty folder count as untracked content", async () => {
    await mkdir(path.join(root, "Docs"));
    await symlink(
      path.join(outside, "notes.txt"),
      path.join(root, "Docs/readme.txt"),
      "file",
    );
    expect(rows(await full())).toEqual({
      Docs: "Directory",
      Source: "Directory",
      "notes-link.txt": "Symlink",
    });
  });
});
