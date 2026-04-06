import path from "path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  promises as fs,
} from "fs";
import type { WorkspaceStateFile } from "@checkpointvcs/common";
import BetterSqlite3 from "better-sqlite3";
import type { WorkspaceState } from "./util.js";
import { DaemonConfigType } from "../daemon-config.js";

// ── public interface ──────────────────────────────────────────────

export interface StateStore {
  load(): Promise<WorkspaceState>;
  save(state: WorkspaceState): Promise<void>;
  close(): void;
}

// ── factory ───────────────────────────────────────────────────────

const storeCache = new Map<string, StateStore>();

/**
 * Return (or create) a StateStore for the workspace at `localPath`.
 * The returned instance is cached per `localPath` so repeated calls
 * are cheap.
 */
export function getStateStore(
  localPath: string,
  backend: DaemonConfigType["stateBackend"] = "json",
): StateStore {
  const key = `${backend}:${localPath}`;
  let store = storeCache.get(key);
  if (!store) {
    store =
      backend === "sqlite"
        ? new SqliteStateStore(localPath)
        : new JsonStateStore(localPath);
    storeCache.set(key, store);
  }
  return store;
}

/**
 * Close and remove every cached store (useful on shutdown).
 */
export function closeAllStateStores(): void {
  for (const store of storeCache.values()) {
    store.close();
  }
  storeCache.clear();
}

// ── JSON backend ──────────────────────────────────────────────────

class JsonStateStore implements StateStore {
  private statePath: string;

  public constructor(localPath: string) {
    this.statePath = path.join(localPath, ".checkpoint", "state.json");
  }

  public async load(): Promise<WorkspaceState> {
    try {
      const raw = await fs.readFile(this.statePath, "utf-8");
      return JSON.parse(raw) as WorkspaceState;
    } catch {
      return { changelistNumber: 0, files: {}, markedForAdd: [] };
    }
  }

  public async save(state: WorkspaceState): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(state, null, 2));
  }

  public close(): void {
    // nothing to release
  }
}

// ── SQLite backend ────────────────────────────────────────────────

class SqliteStateStore implements StateStore {
  private dbPath: string;
  private localPath: string;
  private db: BetterSqlite3.Database | null = null;

  public constructor(localPath: string) {
    this.localPath = localPath;
    this.dbPath = path.join(localPath, ".checkpoint", "state.db");
  }

  // Lazy-open so we only create the file when first used.
  private open(): BetterSqlite3.Database {
    if (this.db) return this.db;

    const dir = path.dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const isNew = !existsSync(this.dbPath);
    this.db = new BetterSqlite3(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");

    if (isNew) {
      this.createSchema();
      this.migrateFromJson();
    } else {
      this.ensureSchema();
    }

    return this.db;
  }

  private createSchema(): void {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS workspace_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        path       TEXT PRIMARY KEY,
        file_id    TEXT NOT NULL,
        changelist INTEGER NOT NULL,
        hash       TEXT NOT NULL,
        size       INTEGER NOT NULL,
        mtime      REAL
      );
      CREATE TABLE IF NOT EXISTS artifact_files (
        path       TEXT PRIMARY KEY,
        file_id    TEXT NOT NULL,
        changelist INTEGER NOT NULL,
        hash       TEXT NOT NULL,
        size       INTEGER NOT NULL,
        mtime      REAL
      );
      CREATE TABLE IF NOT EXISTS marked_for_add (
        path TEXT PRIMARY KEY
      );
    `);
  }

  private ensureSchema(): void {
    // Idempotent — IF NOT EXISTS guards prevent errors on re-open.
    this.createSchema();
  }

  /**
   * If a state.json exists next to our DB we import it and rename it
   * so the migration is a one-time operation.
   */
  private migrateFromJson(): void {
    const jsonPath = path.join(this.localPath, ".checkpoint", "state.json");
    if (!existsSync(jsonPath)) return;

    try {
      const raw = readFileSync(jsonPath, "utf-8");
      const state = JSON.parse(raw) as WorkspaceState;
      this.saveSync(state);
      // Keep the old file around with a .bak extension for safety.
      renameSync(jsonPath, jsonPath + ".bak");
    } catch {
      // migration failure is non-fatal — we start with empty state
    }
  }

  // ── load ──

  public async load(): Promise<WorkspaceState> {
    return this.loadSync();
  }

  private loadSync(): WorkspaceState {
    const db = this.open();

    const changelistRow = db
      .prepare(
        "SELECT value FROM workspace_meta WHERE key = 'changelistNumber'",
      )
      .get() as { value: string } | undefined;

    const changelistNumber = changelistRow
      ? parseInt(changelistRow.value, 10)
      : 0;

    const files: Record<string, WorkspaceStateFile> = {};
    const fileRows = db.prepare("SELECT * FROM files").all() as Array<{
      path: string;
      file_id: string;
      changelist: number;
      hash: string;
      size: number;
      mtime: number | null;
    }>;
    for (const r of fileRows) {
      files[r.path] = {
        fileId: r.file_id,
        changelist: r.changelist,
        md5: r.hash,
        size: r.size,
        ...(r.mtime != null && { mtime: r.mtime }),
      };
    }

    const artifactFiles: Record<string, WorkspaceStateFile> = {};
    const artRows = db.prepare("SELECT * FROM artifact_files").all() as Array<{
      path: string;
      file_id: string;
      changelist: number;
      hash: string;
      size: number;
      mtime: number | null;
    }>;
    for (const r of artRows) {
      artifactFiles[r.path] = {
        fileId: r.file_id,
        changelist: r.changelist,
        md5: r.hash,
        size: r.size,
        ...(r.mtime != null && { mtime: r.mtime }),
      };
    }

    const markedRows = db
      .prepare("SELECT path FROM marked_for_add")
      .all() as Array<{ path: string }>;
    const markedForAdd = markedRows.map((r) => r.path);

    return { changelistNumber, files, artifactFiles, markedForAdd };
  }

  // ── save ──

  public async save(state: WorkspaceState): Promise<void> {
    this.saveSync(state);
  }

  private saveSync(state: WorkspaceState): void {
    const db = this.open();

    const upsertMeta = db.prepare(
      "INSERT OR REPLACE INTO workspace_meta (key, value) VALUES (?, ?)",
    );
    const clearFiles = db.prepare("DELETE FROM files");
    const insertFile = db.prepare(
      "INSERT INTO files (path, file_id, changelist, hash, size, mtime) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const clearArtifacts = db.prepare("DELETE FROM artifact_files");
    const insertArtifact = db.prepare(
      "INSERT INTO artifact_files (path, file_id, changelist, hash, size, mtime) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const clearMarked = db.prepare("DELETE FROM marked_for_add");
    const insertMarked = db.prepare(
      "INSERT INTO marked_for_add (path) VALUES (?)",
    );

    const runTransaction = db.transaction(() => {
      upsertMeta.run("changelistNumber", String(state.changelistNumber));

      clearFiles.run();
      for (const [p, f] of Object.entries(state.files)) {
        insertFile.run(
          p,
          f.fileId,
          f.changelist,
          f.md5,
          f.size,
          f.mtime ?? null,
        );
      }

      clearArtifacts.run();
      if (state.artifactFiles) {
        for (const [p, f] of Object.entries(state.artifactFiles)) {
          insertArtifact.run(
            p,
            f.fileId,
            f.changelist,
            f.md5,
            f.size,
            f.mtime ?? null,
          );
        }
      }

      clearMarked.run();
      if (state.markedForAdd) {
        for (const p of state.markedForAdd) {
          insertMarked.run(p);
        }
      }
    });

    runTransaction();
  }

  // ── cleanup ──

  public close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
