/**
 * SQLite state-store schema migrations and the staged set.
 *
 * The regression these pin: `WORKSPACE_STATE_VERSION` was bumped to 3 when
 * multi-branch workspaces landed, but `MIGRATIONS` still stopped at 2. Any
 * workspace with an existing state.db therefore threw "No state-store
 * migration path from schema version 2 to 3" on open, which is a crash on
 * daemon start rather than a degraded feature.
 *
 * These also cover the three fields the sqlite backend was silently dropping:
 * the staged set, per-file branch attribution, and overlay branch heads.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

import {
  getStateStore,
  closeAllStateStores,
} from "../../../core/daemon/src/util/state-store.js";
import {
  WORKSPACE_STATE_VERSION,
  type WorkspaceState,
} from "../../../core/daemon/src/util/util.js";

let workspacePath: string;

/**
 * Builds a state.db at the pre-multi-branch schema (version 2): no `staged`
 * table, no `files.branch` column.
 */
function writeV2Database(): string {
  const dbPath = path.join(workspacePath, ".checkpoint", "state.db");
  const db = new BetterSqlite3(dbPath);
  db.exec(`
    CREATE TABLE workspace_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE files (
      path       TEXT PRIMARY KEY,
      file_id    TEXT NOT NULL,
      changelist INTEGER NOT NULL,
      hash       TEXT NOT NULL,
      size       INTEGER NOT NULL,
      mtime      REAL
    );
    CREATE TABLE artifact_files (
      path          TEXT PRIMARY KEY,
      file_id       TEXT NOT NULL,
      changelist    INTEGER NOT NULL,
      hash          TEXT NOT NULL,
      size          INTEGER NOT NULL,
      mtime         REAL,
      artifact_type TEXT
    );
    CREATE TABLE marked_for_add (path TEXT PRIMARY KEY);
    CREATE TABLE bisect (changelist INTEGER PRIMARY KEY, verdict TEXT NOT NULL);
  `);
  db.prepare(
    "INSERT INTO workspace_meta (key, value) VALUES ('schemaVersion', '2')",
  ).run();
  db.prepare(
    "INSERT INTO workspace_meta (key, value) VALUES ('changelistNumber', '7')",
  ).run();
  db.prepare(
    "INSERT INTO files (path, file_id, changelist, hash, size, mtime) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("Content/foo.uasset", "file-1", 7, "abc", 10, 1000);
  db.close();
  return dbPath;
}

beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(tmpdir(), "chk-state-"));
  await mkdir(path.join(workspacePath, ".checkpoint"), { recursive: true });
});

afterEach(async () => {
  closeAllStateStores();
  await rm(workspacePath, { recursive: true, force: true });
});

describe("sqlite state store", () => {
  it("migrates a version 2 database instead of throwing", async () => {
    const dbPath = writeV2Database();

    const store = getStateStore(workspacePath, "sqlite");
    const state = await store.load();

    // Pre-existing content survives the migration.
    expect(state.changelistNumber).toBe(7);
    expect(state.files["Content/foo.uasset"]?.fileId).toBe("file-1");

    const db = new BetterSqlite3(dbPath, { readonly: true });
    const version = (
      db
        .prepare("SELECT value FROM workspace_meta WHERE key = 'schemaVersion'")
        .get() as { value: string }
    ).value;
    const columns = db
      .prepare("PRAGMA table_info(files)")
      .all() as Array<{ name: string }>;
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    db.close();

    expect(parseInt(version, 10)).toBe(WORKSPACE_STATE_VERSION);
    expect(columns.map((c) => c.name)).toContain("branch");
    expect(tables.map((t) => t.name)).toContain("staged");
  });

  it("round-trips the staged set", async () => {
    const store = getStateStore(workspacePath, "sqlite");

    const state: WorkspaceState = {
      changelistNumber: 1,
      files: {},
      staged: ["Source/a.cpp", "Content/b.uasset"],
    };
    await store.save(state);

    closeAllStateStores();
    const reopened = await getStateStore(workspacePath, "sqlite").load();

    expect(new Set(reopened.staged)).toEqual(
      new Set(["Source/a.cpp", "Content/b.uasset"]),
    );
  });

  it("round-trips per-file branch attribution and overlay heads", async () => {
    const store = getStateStore(workspacePath, "sqlite");

    await store.save({
      changelistNumber: 3,
      // The domain root has no `branch`; an overlaid file names its branch.
      files: {
        "Source/a.cpp": {
          fileId: "f1",
          changelist: 3,
          md5: "x",
          size: 1,
        },
        "Content/b.uasset": {
          fileId: "f2",
          changelist: 5,
          md5: "y",
          size: 2,
          branch: "feature/a",
        },
      },
      branchHeads: { "feature/a": 5 },
    });

    closeAllStateStores();
    const reopened = await getStateStore(workspacePath, "sqlite").load();

    expect(reopened.files["Source/a.cpp"]?.branch).toBeUndefined();
    expect(reopened.files["Content/b.uasset"]?.branch).toBe("feature/a");
    expect(reopened.branchHeads).toEqual({ "feature/a": 5 });
  });

  it("survives corrupt overlay heads rather than losing the tree", async () => {
    const store = getStateStore(workspacePath, "sqlite");
    await store.save({ changelistNumber: 2, files: {} });
    closeAllStateStores();

    const dbPath = path.join(workspacePath, ".checkpoint", "state.db");
    const db = new BetterSqlite3(dbPath);
    db.prepare(
      "INSERT OR REPLACE INTO workspace_meta (key, value) VALUES ('branchHeads', ?)",
    ).run("{not json");
    db.close();

    const reopened = await getStateStore(workspacePath, "sqlite").load();

    // Overlay heads are recomputable from the next sync; the tree is not.
    expect(reopened.branchHeads).toBeUndefined();
    expect(reopened.changelistNumber).toBe(2);
  });
});
