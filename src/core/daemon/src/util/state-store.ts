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
import {
  WORKSPACE_STATE_VERSION,
  type ArtifactStateFile,
  type BisectVerdict,
  type WorkspaceGameSyncState,
  type WorkspaceState,
} from "./util.js";
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
      // v1 files simply lack the optional v2 fields (version, gameSync,
      // artifactType); no structural migration is needed for JSON.
      return JSON.parse(raw) as WorkspaceState;
    } catch {
      return { changelistNumber: 0, files: {}, markedForAdd: [] };
    }
  }

  public async save(state: WorkspaceState): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(
      this.statePath,
      JSON.stringify({ ...state, version: WORKSPACE_STATE_VERSION }, null, 2),
    );
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
      this.setSchemaVersion(WORKSPACE_STATE_VERSION);
      this.migrateFromJson();
    } else {
      this.runMigrations();
    }

    return this.db;
  }

  // Creates the CURRENT (v2) schema. Older databases are upgraded stepwise
  // via runMigrations instead.
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
        path          TEXT PRIMARY KEY,
        file_id       TEXT NOT NULL,
        changelist    INTEGER NOT NULL,
        hash          TEXT NOT NULL,
        size          INTEGER NOT NULL,
        mtime         REAL,
        artifact_type TEXT
      );
      CREATE TABLE IF NOT EXISTS marked_for_add (
        path TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS bisect (
        changelist INTEGER PRIMARY KEY,
        verdict    TEXT NOT NULL
      );
    `);
  }

  private getSchemaVersion(): number {
    const row = this.db!.prepare(
      "SELECT value FROM workspace_meta WHERE key = 'schemaVersion'",
    ).get() as { value: string } | undefined;
    // Pre-versioning databases are schema version 1.
    return row ? parseInt(row.value, 10) : 1;
  }

  private setSchemaVersion(version: number): void {
    this.db!.prepare(
      "INSERT OR REPLACE INTO workspace_meta (key, value) VALUES ('schemaVersion', ?)",
    ).run(String(version));
  }

  // Ordered, stepwise migrations keyed by TARGET schema version. Each entry
  // upgrades from (version - 1) to version.
  private static readonly MIGRATIONS: Record<number, string[]> = {
    2: [
      "ALTER TABLE artifact_files ADD COLUMN artifact_type TEXT",
      `CREATE TABLE IF NOT EXISTS bisect (
        changelist INTEGER PRIMARY KEY,
        verdict    TEXT NOT NULL
      )`,
    ],
  };

  private runMigrations(): void {
    const db = this.db!;
    let version = this.getSchemaVersion();

    while (version < WORKSPACE_STATE_VERSION) {
      const target = version + 1;
      const statements = SqliteStateStore.MIGRATIONS[target];
      if (!statements) {
        throw new Error(
          `No state-store migration path from schema version ${version} to ${target}`,
        );
      }

      const migrate = db.transaction(() => {
        for (const statement of statements) {
          db.exec(statement);
        }
        this.setSchemaVersion(target);
      });
      migrate();

      version = target;
    }
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
      // migration failure is non-fatal; we start with empty state
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

    const artifactFiles: Record<string, ArtifactStateFile> = {};
    const artRows = db.prepare("SELECT * FROM artifact_files").all() as Array<{
      path: string;
      file_id: string;
      changelist: number;
      hash: string;
      size: number;
      mtime: number | null;
      artifact_type: string | null;
    }>;
    for (const r of artRows) {
      artifactFiles[r.path] = {
        fileId: r.file_id,
        changelist: r.changelist,
        md5: r.hash,
        size: r.size,
        ...(r.mtime != null && { mtime: r.mtime }),
        ...(r.artifact_type != null && { artifactType: r.artifact_type }),
      };
    }

    const markedRows = db
      .prepare("SELECT path FROM marked_for_add")
      .all() as Array<{ path: string }>;
    const markedForAdd = markedRows.map((r) => r.path);

    const gameSync = this.loadGameSync(db);

    return {
      version: WORKSPACE_STATE_VERSION,
      changelistNumber,
      files,
      artifactFiles,
      markedForAdd,
      ...(gameSync !== undefined && { gameSync }),
    };
  }

  private loadGameSync(
    db: BetterSqlite3.Database,
  ): WorkspaceGameSyncState | undefined {
    const metaRows = db
      .prepare(
        `SELECT key, value FROM workspace_meta
         WHERE key IN ('syncFilterHash', 'lastBuiltChangelist',
                       'lastScheduledSyncAt', 'appliedArtifacts')`,
      )
      .all() as Array<{ key: string; value: string }>;
    const meta = new Map(metaRows.map((r) => [r.key, r.value]));

    const bisectRows = db.prepare("SELECT * FROM bisect").all() as Array<{
      changelist: number;
      verdict: BisectVerdict;
    }>;

    const gameSync: WorkspaceGameSyncState = {};
    let hasValue = false;

    const syncFilterHash = meta.get("syncFilterHash");
    if (syncFilterHash !== undefined) {
      gameSync.syncFilterHash = syncFilterHash;
      hasValue = true;
    }

    const lastBuiltChangelist = meta.get("lastBuiltChangelist");
    if (lastBuiltChangelist !== undefined) {
      gameSync.lastBuiltChangelist = parseInt(lastBuiltChangelist, 10);
      hasValue = true;
    }

    const lastScheduledSyncAt = meta.get("lastScheduledSyncAt");
    if (lastScheduledSyncAt !== undefined) {
      gameSync.lastScheduledSyncAt = lastScheduledSyncAt;
      hasValue = true;
    }

    const appliedArtifacts = meta.get("appliedArtifacts");
    if (appliedArtifacts !== undefined) {
      try {
        gameSync.appliedArtifacts = JSON.parse(
          appliedArtifacts,
        ) as WorkspaceGameSyncState["appliedArtifacts"];
        hasValue = true;
      } catch {
        // corrupted JSON: treat as unset
      }
    }

    if (bisectRows.length > 0) {
      gameSync.bisect = {};
      for (const row of bisectRows) {
        gameSync.bisect[row.changelist] = row.verdict;
      }
      hasValue = true;
    }

    return hasValue ? gameSync : undefined;
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
      "INSERT INTO artifact_files (path, file_id, changelist, hash, size, mtime, artifact_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const clearMarked = db.prepare("DELETE FROM marked_for_add");
    const insertMarked = db.prepare(
      "INSERT INTO marked_for_add (path) VALUES (?)",
    );
    const deleteMeta = db.prepare("DELETE FROM workspace_meta WHERE key = ?");
    const clearBisect = db.prepare("DELETE FROM bisect");
    const insertBisect = db.prepare(
      "INSERT INTO bisect (changelist, verdict) VALUES (?, ?)",
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
            f.artifactType ?? null,
          );
        }
      }

      clearMarked.run();
      if (state.markedForAdd) {
        for (const p of state.markedForAdd) {
          insertMarked.run(p);
        }
      }

      const gameSync = state.gameSync;
      const scalars: [string, string | undefined][] = [
        ["syncFilterHash", gameSync?.syncFilterHash],
        [
          "lastBuiltChangelist",
          gameSync?.lastBuiltChangelist !== undefined
            ? String(gameSync.lastBuiltChangelist)
            : undefined,
        ],
        ["lastScheduledSyncAt", gameSync?.lastScheduledSyncAt],
        [
          "appliedArtifacts",
          gameSync?.appliedArtifacts !== undefined
            ? JSON.stringify(gameSync.appliedArtifacts)
            : undefined,
        ],
      ];
      for (const [key, value] of scalars) {
        if (value === undefined) {
          deleteMeta.run(key);
        } else {
          upsertMeta.run(key, value);
        }
      }

      clearBisect.run();
      if (gameSync?.bisect) {
        for (const [changelist, verdict] of Object.entries(gameSync.bisect)) {
          insertBisect.run(parseInt(changelist, 10), verdict);
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
