/**
 * The in-process shared copy of a workspace's state.
 *
 * Every operation used to load the whole state from disk and write the whole
 * state back. Two operations overlapping (a stage while a pull runs) each
 * wrote back what they had loaded, so the later one silently undid the
 * other. Now one copy is shared, changes go in as deltas, and a write from
 * another process (the CLI's ephemeral daemon) is noticed and reloaded.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

import { closeAllStateStores } from "../../../core/daemon/src/util/state-store.js";
import {
  getWorkspaceState,
  saveWorkspaceState,
  updateWorkspaceState,
} from "../../../core/daemon/src/util/util.js";

let root: string;
const ws = () => ({ localPath: root });
const file = (cl: number) => ({
  fileId: `f${cl}`,
  changelist: cl,
  md5: "",
  size: cl,
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "chk-shared-"));
  await mkdir(path.join(root, ".checkpoint"), { recursive: true });
});

afterEach(async () => {
  closeAllStateStores();
  await rm(root, { recursive: true, force: true });
});

describe("shared workspace state", () => {
  it("hands every caller the same copy and keeps it current", async () => {
    await updateWorkspaceState(
      ws(),
      { files: { upsert: { a: file(1) } } },
      "sqlite",
    );
    const first = await getWorkspaceState(root, "sqlite");
    const second = await getWorkspaceState(root, "sqlite");
    expect(second).toBe(first);

    await updateWorkspaceState(ws(), { staged: { add: ["a"] } }, "sqlite");
    expect(first.staged).toEqual(["a"]);
  });

  it("keeps a stage made while a pull is in flight", async () => {
    await updateWorkspaceState(
      ws(),
      {
        files: { upsert: { a: file(1), b: file(1) } },
        meta: { changelistNumber: 1 },
      },
      "sqlite",
    );

    // The pull reads the state, then a stage lands, then the pull records
    // what it wrote. Whole-state writes lost the stage here.
    const seenByPull = await getWorkspaceState(root, "sqlite");
    expect(seenByPull.changelistNumber).toBe(1);
    await updateWorkspaceState(ws(), { staged: { add: ["a"] } }, "sqlite");
    await updateWorkspaceState(
      ws(),
      { files: { upsert: { b: file(2) } }, meta: { changelistNumber: 2 } },
      "sqlite",
    );

    closeAllStateStores();
    const reloaded = await getWorkspaceState(root, "sqlite");
    expect(reloaded.staged).toEqual(["a"]);
    expect(reloaded.changelistNumber).toBe(2);
    expect(reloaded.files.b?.changelist).toBe(2);
  });

  it("reloads when another process writes the state", async () => {
    await updateWorkspaceState(
      ws(),
      { meta: { changelistNumber: 1 } },
      "sqlite",
    );
    expect((await getWorkspaceState(root, "sqlite")).changelistNumber).toBe(1);

    const other = new BetterSqlite3(path.join(root, ".checkpoint", "state.db"));
    other
      .prepare(
        "INSERT OR REPLACE INTO workspace_meta (key, value) VALUES ('changelistNumber', '7')",
      )
      .run();
    other.close();

    expect((await getWorkspaceState(root, "sqlite")).changelistNumber).toBe(7);
  });

  it("overwrites the shared copy in place on a whole-state save", async () => {
    await updateWorkspaceState(
      ws(),
      { files: { upsert: { a: file(1) } } },
      "sqlite",
    );
    const held = await getWorkspaceState(root, "sqlite");

    await saveWorkspaceState(
      ws(),
      { changelistNumber: 5, files: { z: file(5) } },
      "sqlite",
    );

    expect(held.changelistNumber).toBe(5);
    expect(Object.keys(held.files)).toEqual(["z"]);
    expect(await getWorkspaceState(root, "sqlite")).toBe(held);
  });

  it("does not let a failed delta change the shared copy", async () => {
    await updateWorkspaceState(
      ws(),
      { files: { upsert: { a: file(1) } } },
      "sqlite",
    );
    const held = await getWorkspaceState(root, "sqlite");

    await expect(
      updateWorkspaceState(
        ws(),
        {
          files: {
            delete: ["a"],
            upsert: { b: { ...file(2), fileId: null as never } },
          },
        },
        "sqlite",
      ),
    ).rejects.toThrow();

    expect(Object.keys(held.files)).toEqual(["a"]);
  });
});
