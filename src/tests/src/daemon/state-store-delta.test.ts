/**
 * Delta writes to the workspace state store.
 *
 * A save used to delete and reinsert every row of every table, so staging one
 * file cost as much as the workspace was large. `apply(delta)` writes only
 * what changed. The property that matters: after any sequence of deltas, what
 * the store loads equals `applyDeltaToState` run over the same sequence in
 * memory, on both backends.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

import {
  closeAllStateStores,
  getStateStore,
} from "../../../core/daemon/src/util/state-store.js";
import {
  applyDeltaToState,
  deltaRowCount,
  type StateDelta,
} from "../../../core/daemon/src/util/state-delta.js";
import type { WorkspaceState } from "../../../core/daemon/src/util/util.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "chk-delta-"));
  await mkdir(path.join(root, ".checkpoint"), { recursive: true });
});

afterEach(async () => {
  closeAllStateStores();
  await rm(root, { recursive: true, force: true });
});

/** Deterministic PRNG so a failure reproduces from its seed. */
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

const PATHS = Array.from({ length: 40 }, (_, i) => `dir${i % 5}/file${i}.txt`);

function randomDelta(rand: () => number): StateDelta {
  const pick = () => PATHS[Math.floor(rand() * PATHS.length)]!;
  const some = (n: number) =>
    Array.from({ length: Math.floor(rand() * n) }, pick);
  const file = (cl: number) => ({
    fileId: `id-${Math.floor(rand() * 1000)}`,
    changelist: cl,
    md5: rand() < 0.5 ? "" : "abc",
    size: Math.floor(rand() * 5000),
    ...(rand() < 0.7 && { mtime: Math.floor(rand() * 1e6) + 0.5 }),
    ...(rand() < 0.2 && { branch: "feature/x" }),
  });
  const record = (n: number) =>
    Object.fromEntries(some(n).map((p) => [p, file(Math.floor(rand() * 50))]));

  const delta: StateDelta = {};
  const r = rand();
  if (r < 0.1) delta.files = { replaceAll: record(10) };
  else if (r < 0.7) delta.files = { delete: some(3), upsert: record(4) };
  if (rand() < 0.3) {
    // Artifact files have a type but never a branch.
    const artifact = (cl: number) => {
      const { branch: _branch, ...rest } = file(cl);
      return rand() < 0.5 ? { ...rest, artifactType: "editor" } : rest;
    };
    delta.artifactFiles =
      rand() < 0.2
        ? {
            replaceAll: Object.fromEntries(
              some(4).map((p) => [p, artifact(1)]),
            ),
          }
        : {
            delete: some(2),
            upsert: Object.fromEntries(some(2).map((p) => [p, artifact(2)])),
          };
  }
  if (rand() < 0.4)
    delta.staged = { clear: rand() < 0.1, remove: some(3), add: some(3) };
  if (rand() < 0.2) {
    delta.bisect = {
      clear: rand() < 0.2,
      remove: [Math.floor(rand() * 10)],
      set: { [Math.floor(rand() * 10)]: rand() < 0.5 ? "pass" : "fail" },
    };
  }
  if (rand() < 0.5) {
    const maybe = <T>(value: T): T | null | undefined => {
      const x = rand();
      return x < 0.3 ? undefined : x < 0.5 ? null : value;
    };
    delta.meta = {
      ...(rand() < 0.5 && { changelistNumber: Math.floor(rand() * 100) }),
      branchHeads: maybe({ "feature/x": Math.floor(rand() * 100) }),
      syncFilterHash: maybe(`hash-${Math.floor(rand() * 10)}`),
      lastBuiltChangelist: maybe(Math.floor(rand() * 100)),
      lastScheduledSyncAt: maybe(
        new Date(Math.floor(rand() * 1e12)).toISOString(),
      ),
      appliedArtifacts: maybe({
        editor: {
          changelistNumber: 3,
          sourceChangelistNumber: 2,
          appliedAt: "x",
        },
      }),
      linkedPins: maybe({
        UE5: {
          changelist: Math.floor(rand() * 100),
          workspaceId: "ws-engine",
          appliedAt: "x",
        },
      }),
      linkHolder: maybe({
        workspaceId: `ws-game-${Math.floor(rand() * 3)}`,
        workspaceName: "game",
        localPath: "/games/game",
        changelist: Math.floor(rand() * 100),
        at: "x",
      }),
      mountPaths: maybe(
        ["Plugins/StudioPlugins", "Art/Source"].slice(
          0,
          Math.floor(rand() * 3),
        ),
      ),
    };
  }
  return delta;
}

/** Order-insensitive view, since a store need not keep list order. */
function normalize(state: WorkspaceState) {
  return {
    changelistNumber: state.changelistNumber,
    files: state.files,
    artifactFiles: state.artifactFiles ?? {},
    staged: [...(state.staged ?? [])].sort(),
    branchHeads: state.branchHeads,
    teamSync: state.teamSync,
  };
}

const empty = (): WorkspaceState => ({
  changelistNumber: 0,
  files: {},
  artifactFiles: {},
  staged: [],
});

describe.each(["sqlite"] as const)("%s store: apply(delta)", (backend) => {
  it.each([1, 2, 3, 4, 5])(
    "matches applyDeltaToState over 60 random deltas (seed %i)",
    async (seed) => {
      const rand = rng(seed);
      const expected = empty();

      for (let step = 0; step < 60; step++) {
        const delta = randomDelta(rand);
        applyDeltaToState(expected, delta);
        await getStateStore(root, backend).apply(delta);

        // Reopen now and then so the comparison is against what was persisted,
        // not anything the store keeps in memory.
        if (step % 15 === 14) closeAllStateStores();
        const loaded = await getStateStore(root, backend).load();
        expect(normalize(loaded), `seed ${seed} step ${step}`).toEqual(
          normalize(expected),
        );
      }
    },
  );

  it("counts only the rows a delta changes", async () => {
    const store = getStateStore(root, backend);
    const files = Object.fromEntries(
      PATHS.map((p) => [p, { fileId: p, changelist: 1, md5: "", size: 1 }]),
    );
    await store.apply({ files: { replaceAll: files } });

    const before = store.stats.rowsWritten;
    await store.apply({ staged: { add: [PATHS[0]!] } });
    expect(store.stats.rowsWritten - before).toBe(1);

    const pullDelta: StateDelta = {
      files: {
        delete: [PATHS[1]!],
        upsert: {
          [PATHS[2]!]: { fileId: "x", changelist: 2, md5: "", size: 2 },
        },
      },
      meta: { changelistNumber: 2 },
    };
    expect(deltaRowCount(pullDelta)).toBe(3);
  });

  it("treats adding a path twice and removing an absent one as no-ops", async () => {
    const store = getStateStore(root, backend);
    await store.apply({ staged: { add: ["a", "a"] } });
    await store.apply({ staged: { add: ["a"], remove: ["missing"] } });
    const state = await store.load();
    expect(state.staged).toEqual(["a"]);
  });

  it("removes a meta field on null and leaves it alone when absent", async () => {
    const store = getStateStore(root, backend);
    await store.apply({
      meta: { syncFilterHash: "h", lastBuiltChangelist: 4 },
    });
    await store.apply({ meta: { syncFilterHash: null } });
    const state = await store.load();
    expect(state.teamSync?.syncFilterHash).toBeUndefined();
    expect(state.teamSync?.lastBuiltChangelist).toBe(4);
  });
});

describe("sqlite store", () => {
  it("writes nothing when a delta fails partway", async () => {
    const store = getStateStore(root, "sqlite");
    await store.apply({
      files: {
        upsert: { a: { fileId: "a", changelist: 1, md5: "", size: 1 } },
      },
      meta: { changelistNumber: 1 },
    });

    // A file with no id violates NOT NULL after the delete has already run.
    await expect(
      store.apply({
        files: {
          delete: ["a"],
          upsert: {
            b: { fileId: null as never, changelist: 2, md5: "", size: 1 },
          },
        },
        meta: { changelistNumber: 2 },
      }),
    ).rejects.toThrow();

    const state = await store.load();
    expect(Object.keys(state.files)).toEqual(["a"]);
    expect(state.changelistNumber).toBe(1);
  });

  it("reports a write from another connection through dataVersion, not its own", async () => {
    const store = getStateStore(root, "sqlite");
    await store.apply({ meta: { changelistNumber: 1 } });
    const v1 = store.dataVersion();

    await store.apply({ meta: { changelistNumber: 2 } });
    expect(store.dataVersion()).toBe(v1);

    const other = new BetterSqlite3(path.join(root, ".checkpoint", "state.db"));
    other
      .prepare(
        "INSERT OR REPLACE INTO workspace_meta (key, value) VALUES ('changelistNumber', '9')",
      )
      .run();
    other.close();

    expect(store.dataVersion()).not.toBe(v1);
  });
});
