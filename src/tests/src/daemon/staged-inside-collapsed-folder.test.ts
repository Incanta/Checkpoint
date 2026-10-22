/**
 * An untracked folder is reported as one collapsed row. The desktop's Pending
 * page lets you expand it and stage one file from inside; that file then has
 * to be a row of its own, or it is neither listed in its changelist nor sent
 * by submit (which only sends staged rows). These pin that, through both the
 * full and the incremental refresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const DAEMON_ID = "test-daemon";

let manager: DaemonManager;
let root: string;
let workspace: Workspace;

beforeEach(async () => {
  manager = DaemonManager.Get();
  root = (await mkdtemp(path.join(tmpdir(), "chk-collapsed-"))).replace(
    /\\/g,
    "/",
  );
  workspace = {
    id: `ws-${path.basename(root)}`,
    repoId: "repo-1",
    name: "collapsed",
    domainBranchName: "main",
    activeBranches: [],
    localPath: root,
    daemonId: DAEMON_ID,
  } as unknown as Workspace;

  for (const p of [
    "Saved/logs/a.log",
    "Saved/logs/b.log",
    "Saved/Config/x.ini",
  ]) {
    await mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await writeFile(path.join(root, p), p);
  }
  await manager.registerWorkspace(workspace, { watch: false });
});

afterEach(async () => {
  manager.unlinkWorkspace(workspace.id, DAEMON_ID);
  closeAllStateStores();
  await rm(root, { recursive: true, force: true });
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

describe("staging inside a collapsed folder", () => {
  it("collapses an untracked folder to one row when nothing inside is staged", async () => {
    expect(rows(await full())).toEqual({ Saved: "Directory" });
  });

  it("gives a file staged from inside the folder its own staged row", async () => {
    await manager.stage(workspace, ["Saved/logs/a.log"]);
    expect(rows(await full())).toEqual({
      Saved: "Directory",
      "Saved/logs/a.log": "Text+staged",
    });
  });

  it("gives a staged subfolder its own staged folder row", async () => {
    await manager.stage(workspace, ["Saved/Config"]);
    expect(rows(await full())).toEqual({
      Saved: "Directory",
      "Saved/Config": "Directory+staged",
    });
  });

  it("adds no row for a staged path that is no longer on disk", async () => {
    await manager.stage(workspace, ["Saved/logs/gone.log"]);
    expect(rows(await full())).toEqual({ Saved: "Directory" });
  });

  it("stages the whole folder by its own row, with no extra rows", async () => {
    await manager.stage(workspace, ["Saved"]);
    expect(rows(await full())).toEqual({ Saved: "Directory+staged" });
  });

  it("keeps both when the folder and a file inside are staged", async () => {
    await manager.stage(workspace, ["Saved", "Saved/logs/b.log"]);
    expect(rows(await full())).toEqual({
      Saved: "Directory+staged",
      "Saved/logs/b.log": "Text+staged",
    });
  });

  it("agrees with a full rescan through stage and unstage, incrementally", async () => {
    await full();

    await manager.stage(workspace, ["Saved/logs/a.log"]);
    const staged = rows(await incremental([]));
    expect(staged).toEqual(rows(await full()));
    expect(staged["Saved/logs/a.log"]).toBe("Text+staged");

    await manager.unstage(workspace, ["Saved/logs/a.log"]);
    const unstaged = rows(await incremental([]));
    expect(unstaged).toEqual(rows(await full()));
    expect(unstaged).toEqual({ Saved: "Directory" });
  });

  it("drops the row incrementally when the staged file is deleted", async () => {
    await manager.stage(workspace, ["Saved/logs/a.log"]);
    await full();
    await rm(path.join(root, "Saved/logs/a.log"));
    expect(rows(await incremental(["Saved/logs/a.log"]))).toEqual({
      Saved: "Directory",
    });
  });
});
