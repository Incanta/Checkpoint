/**
 * DaemonManager-level cover for `.chkignore` handling.
 *
 * The reported bug was not in the pattern matcher: a workspace created while
 * the daemon was already running never had its ignore files scanned, so its
 * ignore set stayed permanently empty and `chk status` listed every build
 * artifact. These tests pin the registration and rescan paths that fix it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DaemonManager } from "../../../core/daemon/src/daemon-manager.js";
import { matchesPattern } from "../../../core/daemon/src/file-status.js";
import {
  FileStatus,
  type Workspace,
} from "../../../core/daemon/src/types/index.js";

const DAEMON_ID = "test-daemon";
const NL = "\n";

let manager: DaemonManager;
let workspacePath: string;
let workspace: Workspace;

/** Writes a file, creating any missing parent directories. */
async function write(relativePath: string, content = "x"): Promise<void> {
  const full = path.join(workspacePath, relativePath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}

beforeEach(async () => {
  manager = DaemonManager.Get();
  workspacePath = await mkdtemp(path.join(tmpdir(), "chk-daemon-"));
  workspace = {
    id: `ws-${path.basename(workspacePath)}`,
    repoId: "repo-1",
    name: "test-workspace",
    branchName: "main",
    localPath: workspacePath.replace(/\\/g, "/"),
    daemonId: DAEMON_ID,
    userId: "",
    orgId: "",
    createdAt: new Date(0),
    deletedAt: null,
    syncedChangelistNumber: null,
    syncedAt: null,
  } as unknown as Workspace;

  // No submitted state: state.json is absent, exactly like a fresh workspace
  // about to submit everything at once.
});

afterEach(async () => {
  manager.unlinkWorkspace(workspace.id, DAEMON_ID);
  await rm(workspacePath, { recursive: true, force: true });
});

describe("registerWorkspace", () => {
  it("scans .chkignore for a workspace registered after the daemon started", async () => {
    // Workspaces created at runtime used to be pushed straight onto the
    // registry, skipping the ignore scan entirely.
    await write(".chkignore", "Binaries\nSaved\n");
    await write("Binaries/Game.dll");
    await write("Source/Game.cpp");

    await manager.registerWorkspace(workspace, { watch: false });

    const cache = manager.getIgnoreCache(workspace.id);
    expect(matchesPattern(cache.ignore, "Binaries", true)).toBe(true);
    expect(matchesPattern(cache.ignore, "Binaries/Game.dll")).toBe(true);
    expect(matchesPattern(cache.ignore, "Source/Game.cpp")).toBe(false);
  });

  it("finds .chkignore files nested in directories with no submitted files", async () => {
    // Scanning used to visit only directories containing submitted files, so
    // with an empty baseline only the workspace root was ever examined.
    await write("Content/.chkignore", "Cache\n");
    await write("Content/Cache/blob.bin");

    await manager.registerWorkspace(workspace, { watch: false });

    const cache = manager.getIgnoreCache(workspace.id);
    expect(matchesPattern(cache.ignore, "Content/Cache/blob.bin")).toBe(true);
  });

  it("is idempotent and does not duplicate the registry entry", async () => {
    await write(".chkignore", "Saved\n");

    await manager.registerWorkspace(workspace, { watch: false });
    await manager.registerWorkspace(workspace, { watch: false });

    const registered = manager.workspaces.get(DAEMON_ID) ?? [];
    expect(registered.filter((w) => w.id === workspace.id)).toHaveLength(1);
  });
});

describe("getIgnoreCache", () => {
  it("falls back to an empty set before registration, then reflects the scan", async () => {
    // The fallback must stay a fallback. It used to memoise its empty result,
    // so any read before the scan (an in-flight request during workspace
    // creation, say) made "nothing is ignored" permanent for that workspace.
    await write(".chkignore", "Saved\n");
    await write("Saved/a.ini");

    const before = manager.getIgnoreCache(workspace.id);
    expect(matchesPattern(before.ignore, "Saved/a.ini")).toBe(false);

    await manager.registerWorkspace(workspace, { watch: false });

    const after = manager.getIgnoreCache(workspace.id);
    expect(matchesPattern(after.ignore, "Saved/a.ini")).toBe(true);
  });
});

describe("scanIgnoreFiles", () => {
  it("picks up a .chkignore created after the workspace was registered", async () => {
    await write("Saved/a.ini");
    await manager.registerWorkspace(workspace, { watch: false });

    expect(
      matchesPattern(
        manager.getIgnoreCache(workspace.id).ignore,
        "Saved/a.ini",
      ),
    ).toBe(false);

    await write(".chkignore", "Saved\n");
    await manager.scanIgnoreFiles(workspace);

    expect(
      matchesPattern(
        manager.getIgnoreCache(workspace.id).ignore,
        "Saved/a.ini",
      ),
    ).toBe(true);
  });

  it("drops patterns when .chkignore is emptied", async () => {
    await write(".chkignore", "Saved\n");
    await write("Saved/a.ini");
    await manager.registerWorkspace(workspace, { watch: false });

    await write(".chkignore", "");
    await manager.scanIgnoreFiles(workspace);

    expect(
      matchesPattern(
        manager.getIgnoreCache(workspace.id).ignore,
        "Saved/a.ini",
      ),
    ).toBe(false);
  });
});

describe("getDirectoryPending", () => {
  it("omits ignored entries from the pending listing", async () => {
    await write(".chkignore", "Binaries\nSaved\nweb-port\n");
    await write("Binaries/Game.dll");
    await write("Saved/Logs/run.log");
    await write("web-port/index.html");
    await write("Source/Game.cpp");
    await write("README.md");

    await manager.registerWorkspace(workspace, { watch: false });

    const { children } = await manager.getDirectoryPending(
      workspace.id,
      workspace,
      "",
    );
    const names = children.map((c) => c.path).sort();

    expect(names).toEqual([".chkignore", "README.md", "Source"]);
    expect(children.every((c) => c.status !== FileStatus.Ignored)).toBe(true);
  });

  it("honours backslash-written rules and a backslash directory argument", async () => {
    const B = String.fromCharCode(92);

    await write(".chkignore", `Saved${B}Config${B}${NL}Binaries${NL}`);
    await write("Saved/Config/Editor.ini");
    await write("Saved/Logs/run.log");
    await write("Binaries/Game.dll");

    await manager.registerWorkspace(workspace, { watch: false });

    // The directory argument arrives verbatim from a tRPC input.
    const { children } = await manager.getDirectoryPending(
      workspace.id,
      workspace,
      `${B}Saved`,
    );

    // Config/ is excluded by the backslash rule; Logs/ is not.
    expect(children.map((c) => c.path).sort()).toEqual(["Logs"]);
  });

  it("honours a nested .chkignore inside an untracked directory", async () => {
    await write("Content/.chkignore", "*\n");
    await write("Content/Cache/blob.bin");
    await write("Source/Game.cpp");

    await manager.registerWorkspace(workspace, { watch: false });

    const { children } = await manager.getDirectoryPending(
      workspace.id,
      workspace,
      "",
    );

    // Every file under Content/ is ignored, so the directory contributes
    // nothing to the pending listing.
    expect(children.map((c) => c.path).sort()).toEqual(["Source"]);
  });
});

describe("watchWorkspace", () => {
  it("rebuilds the ignore cache when .chkignore is created on disk", async () => {
    await write("Saved/a.ini");
    await manager.registerWorkspace(workspace);

    await write(".chkignore", "Saved\n");

    await vi.waitFor(
      () => {
        expect(
          matchesPattern(
            manager.getIgnoreCache(workspace.id).ignore,
            "Saved/a.ini",
          ),
        ).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
  });
});
