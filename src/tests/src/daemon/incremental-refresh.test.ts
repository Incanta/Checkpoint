/**
 * Incremental change detection must agree with a full rescan.
 *
 * The incremental path re-checks only paths the watcher reported (expanding a
 * reported directory to the tracked files under it). It used to find those
 * files by scanning every tracked path once per dirty path; it now asks the
 * path index. Whatever the lookup, the answer must be the one a full walk of
 * the workspace gives, so this drives random edits, feeds the manager the
 * paths a watcher would report, and compares the two refreshes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
import type { Workspace } from "../../../core/daemon/src/types/index.js";
import { closeAllStateStores } from "../../../core/daemon/src/util/state-store.js";
import { updateWorkspaceState } from "../../../core/daemon/src/util/util.js";

const DAEMON_ID = "test-daemon";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let manager: DaemonManager;
let root: string;
let workspace: Workspace;

beforeEach(async () => {
  manager = DaemonManager.Get();
  root = (await mkdtemp(path.join(tmpdir(), "chk-incr-"))).replace(/\\/g, "/");
  workspace = {
    id: `ws-${path.basename(root)}`,
    repoId: "repo-1",
    name: "incremental",
    domainBranchName: "main",
    activeBranches: [],
    localPath: root,
    daemonId: DAEMON_ID,
  } as unknown as Workspace;
});

afterEach(async () => {
  manager.unlinkWorkspace(workspace.id, DAEMON_ID);
  closeAllStateStores();
  await rm(root, { recursive: true, force: true });
});

async function put(relativePath: string, content: string) {
  const full = path.join(root, relativePath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}

/** Path -> status, the part of a refresh result that must agree. */
function summary(result: {
  files: Record<string, { status: unknown; staged?: boolean }>;
}) {
  return Object.fromEntries(
    Object.entries(result.files)
      .map(
        ([p, f]) =>
          [p, `${String(f.status)}${f.staged ? "+staged" : ""}`] as const,
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

describe("incremental refresh", () => {
  it.each([1, 2, 3, 4])(
    "agrees with a full rescan after random edits (seed %i)",
    async (seed) => {
      const rand = rng(seed);

      // A tracked tree, recorded in state with the size and mtime on disk.
      const tracked: string[] = [];
      for (const dir of ["src/a", "src/b", "src/b/deep", "content", "docs"]) {
        for (let i = 0; i < 6; i++) {
          const ext = dir === "content" ? "uasset" : "txt";
          tracked.push(`${dir}/f${i}.${ext}`);
        }
      }
      const files: Record<
        string,
        {
          fileId: string;
          changelist: number;
          md5: string;
          size: number;
          mtime: number;
        }
      > = {};
      for (const p of tracked) {
        await put(p, `${p}\n`);
        const s = await stat(path.join(root, p));
        files[p] = {
          fileId: `id:${p}`,
          changelist: 1,
          md5: "",
          size: s.size,
          mtime: s.mtimeMs,
        };
      }
      await put("Saved/logs/old.log", "untracked");
      await updateWorkspaceState(
        { localPath: root },
        { files: { upsert: files }, meta: { changelistNumber: 1 } },
        "sqlite",
      );

      await manager.registerWorkspace(workspace, { watch: false });
      // Stand in for the filesystem watcher: this test reports the dirty paths
      // itself, and the manager only trusts its cache while a watcher runs.
      (
        manager as unknown as { watchers: Map<string, { close(): void }> }
      ).watchers.set(workspace.id, { close: () => undefined });
      await manager.refreshWorkspaceContents(workspace, {
        forceFullRefresh: true,
      });
      const dirty = (
        manager as unknown as { dirtyFiles: Map<string, Set<string>> }
      ).dirtyFiles;

      const incrementalCalls = vi.spyOn(
        manager as unknown as { incrementalRefresh: () => unknown },
        "incrementalRefresh",
      );

      let counter = 0;
      for (let round = 0; round < 6; round++) {
        const reported: string[] = [];
        for (let op = 0; op < 4; op++) {
          const live = tracked.filter((p) => files[p]);
          const pick = live[Math.floor(rand() * live.length)]!;
          const r = rand();
          if (r < 0.3) {
            await put(pick, `edited ${++counter} ${"x".repeat(counter)}`);
            reported.push(pick);
          } else if (r < 0.45) {
            await rm(path.join(root, pick), { force: true });
            reported.push(pick);
          } else if (r < 0.6) {
            const p = `${path.posix.dirname(pick)}/new${++counter}.txt`;
            await put(p, "new");
            reported.push(p);
          } else if (r < 0.75) {
            const top = `Untracked${++counter}`;
            await put(`${top}/inner/file.txt`, "u");
            reported.push(top, `${top}/inner/file.txt`);
          } else if (r < 0.85) {
            // A whole tracked directory removed: the watcher reports the
            // directory, not each file inside it.
            const dir = rand() < 0.5 ? "src/b/deep" : "docs";
            await rm(path.join(root, dir), { recursive: true, force: true });
            reported.push(dir);
          } else {
            await put(`Saved/logs/new${++counter}.log`, "u");
            reported.push(`Saved/logs/new${counter}.log`);
          }
        }
        if (rand() < 0.5) {
          const stage = tracked.filter((p) => files[p]).slice(0, 2);
          await manager.stage(workspace, stage);
        }

        for (const p of reported) dirty.get(workspace.id)!.add(p);
        const incremental = summary(
          await manager.refreshWorkspaceContents(workspace),
        );
        const full = summary(
          await manager.refreshWorkspaceContents(workspace, {
            forceFullRefresh: true,
          }),
        );
        expect(incremental, `seed ${seed} round ${round}`).toEqual(full);
      }

      // Every round's first refresh took the incremental path.
      expect(incrementalCalls.mock.calls.length).toBe(6);
      incrementalCalls.mockRestore();
    },
  );
});
