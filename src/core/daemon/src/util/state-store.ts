import path from "path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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
import { Logger } from "../logging.js";
import {
  applyDeltaToState,
  deltaRowCount,
  type StateDelta,
} from "./state-delta.js";

// ── public interface ──────────────────────────────────────────────

/** Cumulative counters for a store, for tests and timing logs. */
export interface StateStoreStats {
  loads: number;
  rowsRead: number;
  writes: number;
  rowsWritten: number;
  ms: number;
}

export interface StateStore {
  load(): Promise<WorkspaceState>;
  /**
   * Writes only what `delta` changes, atomically. The persisted state ends up
   * equal to `applyDeltaToState(previous, delta)`.
   */
  apply(delta: StateDelta): Promise<void>;
  /**
   * Replaces the whole state. For imports, tests, and recovery; ordinary
   * changes go through {@link apply} so they cost what they change.
   */
  save(state: WorkspaceState): Promise<void>;
  /**
   * Changes whenever another connection or process writes the state, so a
   * cached copy can tell it is stale. Writes through this store do not count.
   */
  dataVersion(): number;
  close(): void;
  readonly stats: StateStoreStats;
}

function newStats(): StateStoreStats {
  return { loads: 0, rowsRead: 0, writes: 0, rowsWritten: 0, ms: 0 };
}

function countRows(state: WorkspaceState): number {
  return (
    Object.keys(state.files).length +
    Object.keys(state.artifactFiles ?? {}).length +
    (state.markedForAdd?.length ?? 0) +
    (state.staged?.length ?? 0)
  );
}

function logWrite(op: string, rows: number, ms: number): void {
  // Unset until InitLogger runs (unit tests, early startup).
  Logger?.debug(`[state-store] ${JSON.stringify({ op, rows, ms })}`);
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
  public readonly stats = newStats();
  private statePath: string;

  public constructor(localPath: string) {
    this.statePath = path.join(localPath, ".checkpoint", "state.json");
  }

  public async load(): Promise<WorkspaceState> {
    const state = await this.read();
    this.stats.loads++;
    this.stats.rowsRead += countRows(state);
    return state;
  }

  private async read(): Promise<WorkspaceState> {
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
    const start = Date.now();
    await this.writeFile(state);
    const rows = countRows(state);
    const ms = Date.now() - start;
    this.stats.writes++;
    this.stats.rowsWritten += rows;
    this.stats.ms += ms;
    logWrite("save", rows, ms);
  }

  // JSON has no partial write: the file is rewritten whole. This backend is
  // kept for existing workspaces and is not the default.
  public async apply(delta: StateDelta): Promise<void> {
    const start = Date.now();
    const state = await this.read();
    applyDeltaToState(state, delta);
    await this.writeFile(state);
    const rows = deltaRowCount(delta);
    const ms = Date.now() - start;
    this.stats.writes++;
    this.stats.rowsWritten += rows;
    this.stats.ms += ms;
    logWrite("apply", rows, ms);
  }

  private knownMtime = 0;
  private version = 0;

  public dataVersion(): number {
    let mtime = 0;
    try {
      mtime = statSync(this.statePath).mtimeMs;
    } catch {
      // No file yet.
    }
    if (mtime !== this.knownMtime) {
      this.knownMtime = mtime;
      this.version++;
    }
    return this.version;
  }

  private rememberOwnWrite(): void {
    try {
      this.knownMtime = statSync(this.statePath).mtimeMs;
    } catch {
      // see dataVersion
    }
  }

  private async writeFile(state: WorkspaceState): Promise<void> {
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
      this.rememberOwnWrite();
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
  public readonly stats = newStats();
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
    this.stmts = null;
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

    this.stats.loads++;
    this.stats.rowsRead +=
      fileRows.length + artRows.length + markedRows.length + stagedRows.length;

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
    const start = Date.now();
    this.saveSync(state);
    const rows = countRows(state);
    const ms = Date.now() - start;
    this.stats.writes++;
    this.stats.rowsWritten += rows;
    this.stats.ms += ms;
    logWrite("save", rows, ms);
  }

  public async apply(delta: StateDelta): Promise<void> {
    const start = Date.now();
    this.applySync(delta);
    const rows = deltaRowCount(delta);
    const ms = Date.now() - start;
    this.stats.writes++;
    this.stats.rowsWritten += rows;
    this.stats.ms += ms;
    logWrite("apply", rows, ms);
  }

  public dataVersion(): number {
    // Changes only when another connection commits, which is exactly
    // "someone else wrote the state".
    return this.open().pragma("data_version", { simple: true }) as number;
  }

  private stmts: ReturnType<SqliteStateStore["prepare"]> | null = null;

  // Prepared once per connection rather than on every write.
  private statements(): ReturnType<SqliteStateStore["prepare"]> {
    const db = this.open();
    if (!this.stmts) this.stmts = this.prepare(db);
    return this.stmts;
  }

  private prepare(db: BetterSqlite3.Database) {
    return {
      upsertMeta: db.prepare(
        "INSERT OR REPLACE INTO workspace_meta (key, value) VALUES (?, ?)",
      ),
      deleteMeta: db.prepare("DELETE FROM workspace_meta WHERE key = ?"),
      clearFiles: db.prepare("DELETE FROM files"),
      upsertFile: db.prepare(
        "INSERT OR REPLACE INTO files (path, file_id, changelist, hash, size, mtime, branch) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ),
      deleteFile: db.prepare("DELETE FROM files WHERE path = ?"),
      clearArtifacts: db.prepare("DELETE FROM artifact_files"),
      upsertArtifact: db.prepare(
        "INSERT OR REPLACE INTO artifact_files (path, file_id, changelist, hash, size, mtime, artifact_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ),
      deleteArtifact: db.prepare("DELETE FROM artifact_files WHERE path = ?"),
      clearMarked: db.prepare("DELETE FROM marked_for_add"),
      addMarked: db.prepare(
        "INSERT OR IGNORE INTO marked_for_add (path) VALUES (?)",
      ),
      removeMarked: db.prepare("DELETE FROM marked_for_add WHERE path = ?"),
      clearStaged: db.prepare("DELETE FROM staged"),
      addStaged: db.prepare("INSERT OR IGNORE INTO staged (path) VALUES (?)"),
      removeStaged: db.prepare("DELETE FROM staged WHERE path = ?"),
      clearBisect: db.prepare("DELETE FROM bisect"),
      setBisect: db.prepare(
        "INSERT OR REPLACE INTO bisect (changelist, verdict) VALUES (?, ?)",
      ),
      removeBisect: db.prepare("DELETE FROM bisect WHERE changelist = ?"),
    };
  }

  private applySync(delta: StateDelta): void {
    const db = this.open();
    const s = this.statements();

    const fileRow = (p: string, f: WorkspaceStateFile) =>
      s.upsertFile.run(
        p,
        f.fileId,
        f.changelist,
        f.md5,
        f.size,
        f.mtime ?? null,
        f.branch ?? null,
      );
    const artifactRow = (p: string, f: ArtifactStateFile) =>
      s.upsertArtifact.run(
        p,
        f.fileId,
        f.changelist,
        f.md5,
        f.size,
        f.mtime ?? null,
        f.artifactType ?? null,
      );
    const setScalar = (key: string, value: string | null | undefined) => {
      if (value === undefined) return;
      if (value === null) s.deleteMeta.run(key);
      else s.upsertMeta.run(key, value);
    };
    const json = (value: unknown) =>
      value === undefined ? undefined : value === null ? null : JSON.stringify(value);

    db.transaction(() => {
      if (delta.files) {
        if (delta.files.replaceAll) {
          s.clearFiles.run();
          for (const [p, f] of Object.entries(delta.files.replaceAll)) fileRow(p, f);
        }
        for (const p of delta.files.delete ?? []) s.deleteFile.run(p);
        for (const [p, f] of Object.entries(delta.files.upsert ?? {})) fileRow(p, f);
      }

      if (delta.artifactFiles) {
        if (delta.artifactFiles.replaceAll) {
          s.clearArtifacts.run();
          for (const [p, f] of Object.entries(delta.artifactFiles.replaceAll)) {
            artifactRow(p, f);
          }
        }
        for (const p of delta.artifactFiles.delete ?? []) s.deleteArtifact.run(p);
        for (const [p, f] of Object.entries(delta.artifactFiles.upsert ?? {})) {
          artifactRow(p, f);
        }
      }

      if (delta.markedForAdd) {
        if (delta.markedForAdd.clear) s.clearMarked.run();
        for (const p of delta.markedForAdd.remove ?? []) s.removeMarked.run(p);
        for (const p of delta.markedForAdd.add ?? []) s.addMarked.run(p);
      }

      if (delta.staged) {
        if (delta.staged.clear) s.clearStaged.run();
        for (const p of delta.staged.remove ?? []) s.removeStaged.run(p);
        for (const p of delta.staged.add ?? []) s.addStaged.run(p);
      }

      if (delta.bisect) {
        if (delta.bisect.clear) s.clearBisect.run();
        for (const cl of delta.bisect.remove ?? []) s.removeBisect.run(cl);
        for (const [cl, verdict] of Object.entries(delta.bisect.set ?? {})) {
          s.setBisect.run(parseInt(cl, 10), verdict);
        }
      }

      const meta = delta.meta;
      if (meta) {
        if (meta.changelistNumber !== undefined) {
          s.upsertMeta.run("changelistNumber", String(meta.changelistNumber));
        }
        setScalar("branchHeads", json(meta.branchHeads));
        setScalar("syncFilterHash", meta.syncFilterHash);
        setScalar(
          "lastBuiltChangelist",
          meta.lastBuiltChangelist === undefined || meta.lastBuiltChangelist === null
            ? meta.lastBuiltChangelist
            : String(meta.lastBuiltChangelist),
        );
        setScalar("lastScheduledSyncAt", meta.lastScheduledSyncAt);
        setScalar("appliedArtifacts", json(meta.appliedArtifacts));
      }
    })();
  }

  private saveSync(state: WorkspaceState): void {
    const db = this.open();
    const {
      upsertMeta,
      clearFiles,
      upsertFile: insertFile,
      clearArtifacts,
      upsertArtifact: insertArtifact,
      clearMarked,
      addMarked: insertMarked,
      clearStaged,
      addStaged: insertStaged,
      deleteMeta,
      clearBisect,
      setBisect: insertBisect,
    } = this.statements();

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
      this.stmts = null;
    }
  }
}
