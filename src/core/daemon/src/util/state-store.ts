import path from "path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  promises as fs,
} from "fs";
import type { WorkspaceStateFile } from "@checkpointvcs/common";
import BetterSqlite3 from "better-sqlite3";
import {
  WORKSPACE_STATE_VERSION,
  type ArtifactStateFile,
  type BisectVerdict,
  type WorkspaceTeamSyncState,
  type WorkspaceState,
} from "./util.js";
import { DaemonConfig, DaemonConfigType } from "../daemon-config.js";

// ── public interface ──────────────────────────────────────────────

export interface StateStore {
  load(): Promise<WorkspaceState>;
  save(state: WorkspaceState): Promise<void>;
  close(): void;
}

// ── factory ───────────────────────────────────────────────────────

const storeCache = new Map<string, StateStore>();

/**
 * Decides which backend holds the workspace at `localPath`.
 *
 * What is on disk wins over what was asked for. Callers used to pass the
 * configured backend themselves, and the ones that forgot got "json" on a
 * workspace whose state lives in state.db: they read an empty state and wrote
 * a fresh state.json beside it. The preference only matters for a workspace
 * that has no state yet, or one still on state.json that should be imported.
 */
export function resolveStateBackend(
  localPath: string,
  preferred: DaemonConfigType["stateBackend"] | undefined,
): DaemonConfigType["stateBackend"] {
  const dir = path.join(localPath, ".checkpoint");
  const dbPath = path.join(dir, "state.db");
  const jsonPath = path.join(dir, "state.json");

  if (existsSync(dbPath)) {
    if (existsSync(jsonPath)) {
      // Written by a caller that picked the wrong backend. state.db is the
      // real state; keep the stray file for inspection but out of the way.
      try {
        renameSync(jsonPath, `${jsonPath}.stray-${Date.now()}`);
      } catch {
        // Leaving it is harmless now that state.db always wins.
      }
    }
    return "sqlite";
  }

  return preferred ?? DaemonConfig.Ensure().vars.stateBackend ?? "sqlite";
}

/**
 * Return (or create) the StateStore for the workspace at `localPath`.
 * The returned instance is cached per `localPath` so repeated calls
 * are cheap and every caller shares one store.
 *
 * `preferred` is the configured backend. It is only consulted when the
 * workspace has no state.db yet; see {@link resolveStateBackend}.
 */
export function getStateStore(
  localPath: string,
  preferred?: DaemonConfigType["stateBackend"],
): StateStore {
  let store = storeCache.get(localPath);
  if (!store) {
    store =
      resolveStateBackend(localPath, preferred) === "sqlite"
        ? new SqliteStateStore(localPath)
        : new JsonStateStore(localPath);
    storeCache.set(localPath, store);
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
    let raw: string;
    try {
      raw = await fs.readFile(this.statePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // A workspace that has never saved state.
        return { changelistNumber: 0, files: {}, markedForAdd: [], staged: [] };
      }
      throw err;
    }
    try {
      // v1 files simply lack the optional v2 fields (version, teamSync,
      // artifactType); no structural migration is needed for JSON.
      return JSON.parse(raw) as WorkspaceState;
    } catch (err) {
      // Not "no state": a state that cannot be read. Answering with an empty
      // one would tell the daemon the workspace tracks nothing and has synced
      // nothing, and everything it did next would be built on that.
      throw new Error(
        `Workspace state at ${this.statePath} is unreadable (${
          (err as Error).message
        }). Restore the file or re-sync the workspace.`,
      );
    }
  }

  public async save(state: WorkspaceState): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    // Write beside the file and rename over it, so a crash or a full disk
    // partway through leaves the previous state, not half of the new one.
    const tmpPath = `${this.statePath}.tmp-${process.pid}`;
    try {
      await fs.writeFile(
        tmpPath,
        JSON.stringify({ ...state, version: WORKSPACE_STATE_VERSION }, null, 2),
      );
      await fs.rename(tmpPath, this.statePath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true });
      throw err;
    }
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
      try {
        this.migrateFromJson();
      } catch (err) {
        // An existing state.db is taken as the workspace's state, so a DB
        // left behind by a failed import would read as "tracks nothing" on
        // every later open. Remove it so the next open tries the import again.
        this.discardDatabase();
        throw err;
      }
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
        mtime      REAL,
        branch     TEXT
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
      CREATE TABLE IF NOT EXISTS staged (
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
    // Multi-branch workspaces and staging: per-file branch attribution, the
    // staged set, and overlay branch heads (kept in workspace_meta as JSON,
    // alongside the teamSync scalars).
    3: [
      "ALTER TABLE files ADD COLUMN branch TEXT",
      `CREATE TABLE IF NOT EXISTS staged (
        path TEXT PRIMARY KEY
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
   *
   * A state.json that cannot be imported is an error, not an empty
   * workspace: starting from nothing would tell the daemon the workspace
   * tracks no files and has synced no changelist.
   */
  private migrateFromJson(): void {
    const jsonPath = path.join(this.localPath, ".checkpoint", "state.json");
    if (!existsSync(jsonPath)) return;

    let state: WorkspaceState;
    try {
      state = JSON.parse(readFileSync(jsonPath, "utf-8")) as WorkspaceState;
    } catch (err) {
      throw new Error(
        `Workspace state at ${jsonPath} is unreadable (${
          (err as Error).message
        }). Restore the file or re-sync the workspace.`,
      );
    }
    this.saveSync(state);
    // Keep the old file around with a .bak extension for safety. If the
    // rename fails, state.db still wins on the next open.
    try {
      renameSync(jsonPath, jsonPath + ".bak");
    } catch {
      // see above
    }
  }

  private discardDatabase(): void {
    this.db?.close();
    this.db = null;
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(this.dbPath + suffix, { force: true });
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
      branch: string | null;
    }>;
    for (const r of fileRows) {
      files[r.path] = {
        fileId: r.file_id,
        changelist: r.changelist,
        md5: r.hash,
        size: r.size,
        ...(r.mtime != null && { mtime: r.mtime }),
        ...(r.branch != null && { branch: r.branch }),
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

    const stagedRows = db.prepare("SELECT path FROM staged").all() as Array<{
      path: string;
    }>;
    const staged = stagedRows.map((r) => r.path);

    const branchHeadsRow = db
      .prepare("SELECT value FROM workspace_meta WHERE key = 'branchHeads'")
      .get() as { value: string } | undefined;
    let branchHeads: Record<string, number> | undefined;
    if (branchHeadsRow) {
      try {
        branchHeads = JSON.parse(branchHeadsRow.value) as Record<
          string,
          number
        >;
      } catch {
        // Corrupt overlay heads are recoverable: the next sync recomputes
        // them. Losing the tree over a bad JSON blob is not.
        branchHeads = undefined;
      }
    }

    const teamSync = this.loadTeamSync(db);

    return {
      version: WORKSPACE_STATE_VERSION,
      changelistNumber,
      files,
      artifactFiles,
      markedForAdd,
      staged,
      ...(branchHeads !== undefined && { branchHeads }),
      ...(teamSync !== undefined && { teamSync }),
    };
  }

  private loadTeamSync(
    db: BetterSqlite3.Database,
  ): WorkspaceTeamSyncState | undefined {
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

    const teamSync: WorkspaceTeamSyncState = {};
    let hasValue = false;

    const syncFilterHash = meta.get("syncFilterHash");
    if (syncFilterHash !== undefined) {
      teamSync.syncFilterHash = syncFilterHash;
      hasValue = true;
    }

    const lastBuiltChangelist = meta.get("lastBuiltChangelist");
    if (lastBuiltChangelist !== undefined) {
      teamSync.lastBuiltChangelist = parseInt(lastBuiltChangelist, 10);
      hasValue = true;
    }

    const lastScheduledSyncAt = meta.get("lastScheduledSyncAt");
    if (lastScheduledSyncAt !== undefined) {
      teamSync.lastScheduledSyncAt = lastScheduledSyncAt;
      hasValue = true;
    }

    const appliedArtifacts = meta.get("appliedArtifacts");
    if (appliedArtifacts !== undefined) {
      try {
        teamSync.appliedArtifacts = JSON.parse(
          appliedArtifacts,
        ) as WorkspaceTeamSyncState["appliedArtifacts"];
        hasValue = true;
      } catch {
        // corrupted JSON: treat as unset
      }
    }

    if (bisectRows.length > 0) {
      teamSync.bisect = {};
      for (const row of bisectRows) {
        teamSync.bisect[row.changelist] = row.verdict;
      }
      hasValue = true;
    }

    return hasValue ? teamSync : undefined;
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
      "INSERT INTO files (path, file_id, changelist, hash, size, mtime, branch) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const clearArtifacts = db.prepare("DELETE FROM artifact_files");
    const insertArtifact = db.prepare(
      "INSERT INTO artifact_files (path, file_id, changelist, hash, size, mtime, artifact_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const clearMarked = db.prepare("DELETE FROM marked_for_add");
    const insertMarked = db.prepare(
      "INSERT INTO marked_for_add (path) VALUES (?)",
    );
    const clearStaged = db.prepare("DELETE FROM staged");
    const insertStaged = db.prepare("INSERT INTO staged (path) VALUES (?)");
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
          f.branch ?? null,
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

      clearStaged.run();
      if (state.staged) {
        for (const p of state.staged) {
          insertStaged.run(p);
        }
      }

      const teamSync = state.teamSync;
      const scalars: [string, string | undefined][] = [
        [
          "branchHeads",
          state.branchHeads !== undefined
            ? JSON.stringify(state.branchHeads)
            : undefined,
        ],
        ["syncFilterHash", teamSync?.syncFilterHash],
        [
          "lastBuiltChangelist",
          teamSync?.lastBuiltChangelist !== undefined
            ? String(teamSync.lastBuiltChangelist)
            : undefined,
        ],
        ["lastScheduledSyncAt", teamSync?.lastScheduledSyncAt],
        [
          "appliedArtifacts",
          teamSync?.appliedArtifacts !== undefined
            ? JSON.stringify(teamSync.appliedArtifacts)
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
      if (teamSync?.bisect) {
        for (const [changelist, verdict] of Object.entries(teamSync.bisect)) {
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
