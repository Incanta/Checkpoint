/**
 * A whole Checkpoint stack in one process, for driving the daemon's own
 * submit, pull, and sync code against the real app routers.
 *
 *   - The app: its real tRPC routers over the per-file SQLite test database
 *     (see ../harness), reached through an adapter shaped like the daemon's
 *     HTTP client (`client.router.procedure.query/mutate`).
 *   - The daemon: its real modules, imported from source.
 *   - The native addon: a fake that moves bytes the way the real one does. A
 *     submit stores each submitted file under a fresh version index name and
 *     records the changelist through the app, exactly as the storage server
 *     would after the upload. A version index holds only the files its own
 *     changelist submitted (the real format is a delta too), so a pull that
 *     applies an index whole writes exactly those files, and a selection pull
 *     writes exactly the selected paths.
 *
 * Only the native layer is fake. Everything that decides what to write, what
 * to protect, and what to record is the code that ships.
 *
 * Test files wire it in with the same four vi.mock calls at their top (they
 * have to be in the test file to be hoisted): the addon,
 * `CreateApiClientAuth` / `GetAuthConfigUser`, the daemon's config (so
 * nothing reads or writes ~/.checkpoint), and its logger.
 */
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import path from "node:path";

import type { PrismaClient } from "@prisma/client";

import type { WorkspaceTeamSyncSettings } from "../../../core/daemon/src/util/util.js";
import { makeAppCaller } from "../harness/caller";
import {
  makeOrg,
  makeRepo,
  makeUser,
  makeWorkspace,
  type TestUser,
} from "../harness/fixtures";

type Caller = Awaited<ReturnType<typeof makeAppCaller>>;
type AnyFn = (input: unknown) => Promise<unknown>;

interface Identity {
  caller: Caller;
  apiToken: string;
}

const identities = new Map<string, Identity>(); // daemonId -> identity
const byToken = new Map<string, Identity>(); // apiToken -> identity
const versions = new Map<string, Map<string, Buffer>>(); // index name -> path -> bytes
let versionCounter = 0;
let seatCounter = 0;

/** Knobs a test can turn to make the fake native layer or the API misbehave. */
export interface StackOverrides {
  /**
   * Answers `teamSync.getConfig`. Defaults to "no repo config". Throw from it
   * to simulate the API being unreachable for that one call.
   */
  teamSyncConfig?: (input: unknown) => Promise<unknown>;
  /**
   * When set, the single-pass selection pull fails with this step text. The
   * real addon fails with "different hashing or chunk sizes" when the source
   * versions were indexed with different settings (two teammates with
   * different daemon configs), and the daemon then applies each changelist's
   * whole index in turn.
   */
  selectionPullFailure?: string;
  /**
   * When set, every file the fake native layer writes, and every `put`, gets
   * this modification time. A filesystem stamps a write with a clock that
   * only moves every so often (2 s on FAT32, 1 s on HFS+ and ext3, a timer
   * tick of a few milliseconds on NTFS and ext4), so writes that land within
   * one tick share an mtime. This puts every write in the same tick.
   */
  writeTime?: Date;
  /**
   * Runs once the fake selection pull has written its files, while the pull
   * is still going: the daemon's delete pass, merges, and state update all
   * come after it. Stands in for someone (or some tool) editing the
   * workspace during a long pull.
   */
  duringPull?: () => Promise<void>;
  /**
   * Answers the native include filter (`filterPaths`), which decides what a
   * Team Sync pull skips. Defaults to including everything. A test that
   * needs the real matcher passes the real addon's function here.
   */
  nativeFilter?: (includeRules: string[], paths: string[]) => boolean[];
}

export const overrides: StackOverrides = {};

/** Warnings and errors the daemon logged, for assertions and debugging. */
export const daemonLog: string[] = [];

export function resetStack(): void {
  identities.clear();
  byToken.clear();
  versions.clear();
  daemonLog.length = 0;
  delete overrides.teamSyncConfig;
  delete overrides.selectionPullFailure;
  delete overrides.writeTime;
  delete overrides.duringPull;
  delete overrides.nativeFilter;
}

const normalize = (p: string) => p.replace(/\\/g, "/").replace(/^\/+/, "");

// ── the daemon's API client ──────────────────────────────────────────

const procedureOverrides: Record<string, Record<string, AnyFn>> = {
  storage: {
    // No storage server runs; the fake addon ignores the token anyway.
    getToken: async () => ({
      kind: "gateway",
      token: "fake.storage.jwt",
      expiration: Math.floor(Date.now() / 1000) + 3600,
      serverUrl: "http://fake-storage.invalid",
      gatewayUrl: "http://fake-storage.invalid/gateway",
    }),
  },
  teamSync: {
    getConfig: async (input) =>
      overrides.teamSyncConfig
        ? overrides.teamSyncConfig(input)
        : { config: null },
  },
};

function clientFor(identity: Identity): unknown {
  const routerProxy = (router: string) =>
    new Proxy(
      {},
      {
        get(_target, name) {
          if (typeof name !== "string" || name === "then") return undefined;
          const fn: AnyFn =
            procedureOverrides[router]?.[name] ??
            ((input) =>
              (
                identity.caller as unknown as Record<
                  string,
                  Record<string, AnyFn>
                >
              )[router]![name]!(input));
          return { query: fn, mutate: fn };
        },
      },
    );
  return new Proxy(
    {},
    {
      get(_target, router) {
        if (typeof router !== "string" || router === "then") return undefined;
        return routerProxy(router);
      },
    },
  );
}

/** Stands in for `CreateApiClientAuth` from @checkpointvcs/common. */
export async function createApiClientAuth(daemonId: string): Promise<unknown> {
  const identity = identities.get(daemonId);
  if (!identity) {
    throw new Error(`stack: no identity registered for daemon ${daemonId}`);
  }
  return clientFor(identity);
}

/** Stands in for `GetAuthConfigUser` from @checkpointvcs/common. */
export async function getAuthConfigUser(daemonId: string) {
  const identity = identities.get(daemonId);
  if (!identity) return null;
  return {
    daemonId,
    endpoint: "http://in-process.invalid",
    apiToken: identity.apiToken,
  };
}

// ── the native addon ─────────────────────────────────────────────────

interface Status {
  currentStep: string;
  changingStep: boolean;
  canceled: boolean;
  completed: boolean;
  error: number;
  progressTotal: number;
  progressDone: number;
  needsTokenRefresh: boolean;
}

interface FakeHandle {
  run: () => Promise<{ status: Status; result: unknown }>;
}

const status = (error: number, currentStep: string): Status => ({
  currentStep,
  changingStep: false,
  canceled: false,
  completed: true,
  error,
  progressTotal: 0,
  progressDone: 0,
  needsTokenRefresh: false,
});

const ok = (result: unknown) => ({ status: status(0, "Done"), result });
const failed = (code: number, step: string) => ({
  status: status(code, step),
  result: null,
});

async function writeInto(root: string, relativePath: string, bytes: Buffer) {
  const full = path.join(root, relativePath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, bytes);
  if (overrides.writeTime) {
    await utimes(full, overrides.writeTime, overrides.writeTime);
  }
}

const errnoOf = (e: unknown): number =>
  (osConstants.errno as Record<string, number>)[
    (e as NodeJS.ErrnoException).code ?? ""
  ] ?? 5;

/**
 * Writes every file and then reports the first failure, as the real addon
 * does: its writes run as parallel jobs, so one file that cannot be written
 * (open in another program, say) fails the pull after the others have
 * landed, and the failure comes back as a failed step, not an exception.
 */
async function writeAll(
  root: string,
  files: Iterable<[string, Buffer]>,
): Promise<{ code: number; step: string } | null> {
  let failure: { code: number; step: string } | null = null;
  for (const [rel, bytes] of files) {
    try {
      await writeInto(root, rel, bytes);
    } catch (e) {
      failure ??= {
        code: errnoOf(e),
        step: `Could not write ${rel}: ${(e as Error).message}`,
      };
    }
  }
  return failure;
}

interface SubmitOptions {
  branchName: string;
  message: string;
  localRootPath: string;
  remoteBasePath: string;
  apiJwt: string;
  keepCheckedOut: boolean;
  workspaceId: string;
  modifications: {
    path: string;
    delete: boolean;
    oldPath?: string;
    baseChangelist?: number | null;
  }[];
}

/** The modifications the most recent fake submit sent to the app. */
export const lastSubmit: {
  modifications: SubmitOptions["modifications"] | null;
} = {
  modifications: null,
};

export const fakeAddon = {
  GetLogLevel: () => 0,
  freeHandle: () => undefined,
  freeReadFileHandle: () => undefined,
  // Including everything is what the daemon expects of the real matcher: no
  // narrower than its own filter, which it re-applies after the pull. (The
  // real one can be narrower; see overrides.nativeFilter.)
  filterPaths: (rules: string[], paths: string[]) =>
    overrides.nativeFilter
      ? overrides.nativeFilter(rules, paths)
      : paths.map(() => true),

  submitAsync(options: SubmitOptions): FakeHandle {
    return {
      run: async () => {
        const identity = byToken.get(options.apiJwt);
        if (!identity) return failed(1, "Not authenticated");

        const files = new Map<string, Buffer>();
        for (const mod of options.modifications) {
          if (mod.delete) continue;
          const rel = normalize(mod.path);
          try {
            files.set(
              rel,
              await readFile(path.join(options.localRootPath, rel)),
            );
          } catch (e) {
            return failed(2, `Could not read ${rel}: ${(e as Error).message}`);
          }
        }
        // A delete-only submit uploads nothing and names no version index.
        const versionIndex =
          files.size > 0 ? `fake-${++versionCounter}.lvi` : "";
        if (versionIndex) versions.set(versionIndex, files);

        lastSubmit.modifications = options.modifications;
        try {
          const created = await identity.caller.changelist.createChangelist({
            message: options.message,
            repoId: options.remoteBasePath.split("/")[2]!,
            versionIndex,
            branchName: options.branchName,
            modifications: options.modifications,
            keepCheckedOut: options.keepCheckedOut,
            workspaceId: options.workspaceId,
          });
          return ok({ changelistNumber: created.number });
        } catch (e) {
          // The real addon reports the server's refusal as a failed step.
          return failed(409, (e as Error).message);
        }
      },
    };
  },

  pullSelectionAsync(options: {
    sources: string[];
    selectionPaths: string[];
    selectionSources: number[];
    localRootPath: string;
  }): FakeHandle {
    return {
      run: async () => {
        if (overrides.selectionPullFailure) {
          return failed(129, overrides.selectionPullFailure);
        }
        const files: [string, Buffer][] = [];
        for (let i = 0; i < options.selectionPaths.length; i++) {
          const name = options.sources[options.selectionSources[i]!]!;
          const rel = normalize(options.selectionPaths[i]!);
          const bytes = versions.get(name)?.get(rel);
          if (!bytes) return failed(2, `${rel} is not in ${name}`);
          files.push([rel, bytes]);
        }
        const failure = await writeAll(options.localRootPath, files);
        if (failure) return failed(failure.code, failure.step);
        if (overrides.duringPull) await overrides.duringPull();
        return ok({
          assets: options.selectionPaths.length,
          written: options.selectionPaths.length,
        });
      },
    };
  },

  pullAsync(options: {
    versionIndex: string;
    localRootPath: string;
  }): FakeHandle {
    return {
      run: async () => {
        const files = versions.get(options.versionIndex);
        if (!files)
          return failed(2, `Unknown version index ${options.versionIndex}`);
        // A version index holds what its changelist submitted, and applying
        // it brings every one of those files to that content.
        const failure = await writeAll(options.localRootPath, files);
        if (failure) return failed(failure.code, failure.step);
        return ok({ written: files.size });
      },
    };
  },

  async pollHandle(handle: FakeHandle) {
    return handle.run();
  },

  readFileFromVersionAsync(options: {
    filePath: string;
    versionIndexName: string;
  }) {
    return {
      filePath: normalize(options.filePath),
      name: options.versionIndexName,
    };
  },

  async pollReadFileHandle(handle: { filePath: string; name: string }) {
    const bytes = versions.get(handle.name)?.get(handle.filePath);
    if (!bytes) {
      throw new Error(`${handle.filePath} is not in version ${handle.name}`);
    }
    return { data: bytes, size: bytes.length };
  },
};

// ── the daemon's config and logger ───────────────────────────────────

const daemonConfigVars = {
  daemonPort: 0,
  mcp: { enabled: false, port: 0 },
  workspaces: [] as unknown[],
  stateBackend: "sqlite" as const,
  updates: { channel: "release" as const },
  logging: {
    level: "error",
    prettify: {
      enabled: false,
      include: [],
      colorize: false,
      colorizeObjects: false,
      crlf: false,
      levelFirst: false,
      messageFormat: false,
      translateTime: "SYS:standard",
      ignore: [],
      hideObject: false,
      singleLine: false,
    },
    logFile: { enabled: false, level: "error", path: "", maxArchivedFiles: 0 },
  },
  longtail: {
    targetChunkSize: 32768,
    targetBlockSize: 8388608,
    maxChunksPerBlock: 1024,
    minBlockUsagePercent: 80,
    hashingAlgo: "blake3",
    compressionAlgo: "zstd",
    enableMmapIndexing: false,
    enableMmapBlockStore: false,
    enableBlockCache: false,
    logLevel: "off",
  },
};

/** Replaces the daemon's daemon-config module: never touches ~/.checkpoint. */
export const fakeDaemonConfigModule = {
  DaemonConfig: {
    Get: async () => daemonConfigVars,
    Ensure: () => ({ vars: daemonConfigVars }),
    Load: async () => undefined,
    Save: async () => undefined,
  },
  fillMissing: () => false,
};

const record =
  (level: string) =>
  (...args: unknown[]) => {
    daemonLog.push(`[${level}] ${args.map(String).join(" ")}`);
  };
const quiet = () => undefined;

/** Replaces the daemon's logging module. */
export const fakeLoggingModule = {
  Logger: {
    fatal: record("fatal"),
    error: record("error"),
    warn: record("warn"),
    info: quiet,
    debug: quiet,
    trace: quiet,
    log: quiet,
  },
  SetLogger: quiet,
  InitLogger: async () => undefined,
  CustomLevels: { log: 100 },
  CustomColors: {},
};

// ── workspaces ───────────────────────────────────────────────────────

/**
 * A workspace as the daemon's manager holds it. The daemon's endpoints look it
 * up by id and change it in place (a branch switch rewrites its domain and
 * overlays), so a seat keeps the one object the manager has.
 */
export interface ManagedWorkspace {
  id: string;
  repoId: string;
  name: string;
  domainBranchName: string;
  activeBranches: string[];
  localPath: string;
  daemonId: string;
  userId: string;
  orgId: string;
  createdAt: Date;
  deletedAt: null;
  syncedChangelistNumber: null;
  syncedAt: null;
}

export interface Seat {
  name: string;
  user: TestUser;
  orgId: string;
  root: string;
  workspace: ManagedWorkspace;
}

/**
 * The same workspace in the shape the daemon's util functions take (what its
 * endpoints build before calling pull, submit, or the sync pipeline).
 */
export function utilWorkspace(seat: Seat) {
  return {
    id: seat.workspace.id,
    repoId: seat.workspace.repoId,
    domainBranchName: seat.workspace.domainBranchName,
    activeBranches: [...seat.workspace.activeBranches],
    workspaceName: seat.workspace.name,
    localPath: seat.root,
    daemonId: seat.workspace.daemonId,
  };
}

async function daemonModules() {
  const [{ createCaller }, { DaemonManager }, { JobManager }] =
    await Promise.all([
      import("../../../core/daemon/src/api/index.js"),
      import("../../../core/daemon/src/daemon-manager.js"),
      import("../../../core/daemon/src/job-manager.js"),
    ]);
  const manager = DaemonManager.Get();
  return { daemon: createCaller({ manager }), manager, jobs: JobManager.Get() };
}

/**
 * A person at a machine: their own daemon identity, a workspace row on the
 * server, an empty workspace directory, and that workspace registered with
 * the daemon's manager (without a filesystem watcher, so every pending-change
 * refresh is a full scan).
 */
export async function makeSeat(
  db: PrismaClient,
  opts: { name: string; user: TestUser; repoId: string; orgId: string },
): Promise<Seat> {
  const daemonId = `daemon-${opts.name}-${++seatCounter}`;
  const caller = await makeAppCaller({ asUser: opts.user, db });
  const identity: Identity = { caller, apiToken: `token-${daemonId}` };
  identities.set(daemonId, identity);
  byToken.set(identity.apiToken, identity);

  const row = await makeWorkspace(db, opts.repoId, opts.orgId, opts.user.id, {
    name: `${opts.name}-${seatCounter}`,
  });
  const root = (
    await mkdtemp(path.join(tmpdir(), `chk-dataloss-${opts.name}-`))
  ).replace(/\\/g, "/");
  await mkdir(path.join(root, ".checkpoint"), { recursive: true });

  const workspace: ManagedWorkspace = {
    id: row.id,
    repoId: opts.repoId,
    name: row.name,
    domainBranchName: "main",
    activeBranches: [],
    localPath: root,
    daemonId,
    userId: opts.user.id,
    orgId: opts.orgId,
    createdAt: new Date(),
    deletedAt: null,
    syncedChangelistNumber: null,
    syncedAt: null,
  };
  const { manager } = await daemonModules();
  await manager.registerWorkspace(workspace as never, { watch: false });

  return {
    name: opts.name,
    user: opts.user,
    orgId: opts.orgId,
    root,
    workspace,
  };
}

/** Unregisters a seat from the daemon's manager (its directory is the caller's). */
export async function detachSeat(seat: Seat): Promise<void> {
  const { manager } = await daemonModules();
  manager.unlinkWorkspace(seat.workspace.id, seat.workspace.daemonId);
}

async function waitForJob(jobId: string): Promise<unknown> {
  const { jobs } = await daemonModules();
  const deadline = Date.now() + 60_000;
  for (;;) {
    const job = jobs.getJob(jobId);
    if (job?.status === "completed") return job.result;
    if (job?.status === "failed" || job?.status === "cancelled") {
      throw new Error(`${job.type} failed: ${job.error ?? job.status}`);
    }
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const ids = (seat: Seat) => ({
  daemonId: seat.workspace.daemonId,
  workspaceId: seat.workspace.id,
});

/**
 * What the desktop app and CLI do to submit: stage the entries the pending
 * list shows for these paths (a new file inside a new directory shows as that
 * directory), which claims each on the target branch, then submit that bucket
 * and wait for the background job the daemon runs it in.
 */
export async function stageAndSubmit(
  seat: Seat,
  paths: string[],
  opts: { branch?: string; message?: string } = {},
): Promise<void> {
  const { daemon } = await daemonModules();
  const pending = await pendingChanges(seat);
  const entries = new Set<string>();
  for (const p of paths) {
    let entry = normalize(p);
    while (!(entry in pending) && entry.includes("/")) {
      entry = entry.slice(0, entry.lastIndexOf("/"));
    }
    if (!(entry in pending)) {
      throw new Error(`stack: ${p} is not in ${seat.name}'s pending changes`);
    }
    entries.add(entry);
  }
  await daemon.workspaces.pending.stage({
    ...ids(seat),
    paths: [...entries],
    ...(opts.branch !== undefined && { branchName: opts.branch }),
  });
  const { jobId } = await daemon.workspaces.pending.submit({
    ...ids(seat),
    message: opts.message ?? `${seat.name}: ${paths.join(", ")}`,
    ...(opts.branch !== undefined && { branchName: opts.branch }),
    noProgress: true,
  });
  await waitForJob(jobId);
}

/** "Pull" in the desktop app or `chk pull`: sync to the latest changelist. */
export async function syncLatest(seat: Seat): Promise<unknown> {
  const { daemon } = await daemonModules();
  const { jobId } = await daemon.workspaces.sync.pull({
    ...ids(seat),
    changelistId: null,
    filePaths: null,
    noProgress: true,
  });
  return waitForJob(jobId);
}

/** Switching branches, or activating a feature branch as an overlay. */
export async function switchBranch(
  seat: Seat,
  branchName: string,
): Promise<void> {
  const { daemon } = await daemonModules();
  await daemon.workspaces.branches.switch({ ...ids(seat), branchName });
}

/** The daemon's pending-changes view: path -> status name. */
export async function pendingChanges(
  seat: Seat,
): Promise<Record<string, string>> {
  const { daemon } = await daemonModules();
  const { FileStatus } =
    await import("../../../core/daemon/src/types/index.js");
  const result = await daemon.workspaces.pending.refresh(ids(seat));
  const out: Record<string, string> = {};
  for (const [p, f] of Object.entries(result?.files ?? {})) {
    out[p] = FileStatus[(f as { status: number }).status] ?? String(f);
  }
  return out;
}

/** Registers a version index directly, for tests that call the app API themselves. */
export function storeVersion(files: Record<string, string | Buffer>): string {
  const name = `fake-${++versionCounter}.lvi`;
  versions.set(
    name,
    new Map(
      Object.entries(files).map(([p, c]) => [normalize(p), Buffer.from(c)]),
    ),
  );
  return name;
}

/** The app API as a seat's user, called directly rather than through the daemon. */
export function apiAs(seat: Seat): Caller {
  return identities.get(seat.workspace.daemonId)!.caller;
}

/**
 * Records a changelist on the seat's branch straight through the app API,
 * the way another client does: a teammate on an OS whose filesystem allows
 * names this one does not, a script, a tool. `write` maps each path to its
 * new content; `remove` lists paths to delete. Returns the changelist number.
 */
export async function submitDirect(
  seat: Seat,
  changes: { write?: Record<string, string | Buffer>; remove?: string[] },
  message = "recorded through the API by another client",
): Promise<number> {
  const write = changes.write ?? {};
  const created = await apiAs(seat).changelist.createChangelist({
    message,
    repoId: seat.workspace.repoId,
    versionIndex: Object.keys(write).length > 0 ? storeVersion(write) : "",
    branchName: seat.workspace.domainBranchName,
    modifications: [
      ...Object.keys(write).map((p) => ({ path: p, delete: false })),
      ...(changes.remove ?? []).map((p) => ({ path: p, delete: true })),
    ],
    keepCheckedOut: false,
    workspaceId: seat.workspace.id,
  });
  return created.number;
}

/** Team Sync's "Clean Workspace" dialog: what it offers to delete. */
export async function cleanPreview(seat: Seat) {
  const { daemon } = await daemonModules();
  return daemon.workspaces.teamSync.cleanPreview(ids(seat));
}

/** Team Sync's "Clean Workspace" dialog: deleting the selected paths. */
export async function cleanExecute(seat: Seat, paths: string[]) {
  const { daemon } = await daemonModules();
  return daemon.workspaces.teamSync.cleanExecute({ ...ids(seat), paths });
}

/** Alice and Bob, both able to write to one fresh repo, each with a workspace. */
export interface Scene {
  orgId: string;
  repoId: string;
  alice: Seat;
  bob: Seat;
}

export async function makeScene(db: PrismaClient): Promise<Scene> {
  const aliceUser = await makeUser(db, { name: "alice" });
  const bobUser = await makeUser(db, { name: "bob" });
  const org = await makeOrg(db, {
    ownerId: aliceUser.id,
    ownerRole: "ADMIN",
    defaultRepoAccess: "WRITE",
  });
  await db.orgUser.create({
    data: { orgId: org.id, userId: bobUser.id, role: "MEMBER" },
  });
  const repo = await makeRepo(db, org.id, aliceUser.id);
  const alice = await makeSeat(db, {
    name: "alice",
    user: aliceUser,
    repoId: repo.id,
    orgId: org.id,
  });
  const bob = await makeSeat(db, {
    name: "bob",
    user: bobUser,
    repoId: repo.id,
    orgId: org.id,
  });
  return { orgId: org.id, repoId: repo.id, alice, bob };
}

/** Unregisters both seats and removes their directories. */
export async function tearDownScene(scene: Scene | undefined): Promise<void> {
  if (!scene) return;
  for (const seat of [scene.alice, scene.bob]) {
    await detachSeat(seat);
    await rm(seat.root, { recursive: true, force: true });
  }
}

/** A branch's head changelist number. */
export async function headOf(
  db: PrismaClient,
  repoId: string,
  branchName: string,
) {
  const branch = await db.branch.findFirstOrThrow({
    where: { repoId, name: branchName },
  });
  return branch.headNumber;
}

/** Every path a branch's head has. */
export async function pathsAtHead(
  db: PrismaClient,
  repoId: string,
  branchName: string,
): Promise<string[]> {
  const { getStateTreePaths } = await import("~/server/state-tree");
  const tree = await getStateTreePaths(
    db,
    repoId,
    await headOf(db, repoId, branchName),
  );
  return [...tree.keys()];
}

/** The content a branch's head has for a path, read the way every reader resolves it. */
export async function contentAtHead(
  db: PrismaClient,
  repoId: string,
  branchName: string,
  relativePath: string,
): Promise<string | undefined> {
  const { resolveFileSource } =
    await import("~/server/read-file-at-changelist");
  const source = await resolveFileSource(
    db,
    repoId,
    relativePath,
    await headOf(db, repoId, branchName),
  );
  return source
    ? contentOfVersion(source.versionIndex, relativePath)
    : undefined;
}

/**
 * Every file a pull kept aside in this workspace's backup folder whose content
 * includes `text`. A pull that cannot merge a local change keeps it there.
 */
export async function backupsContaining(
  seat: Seat,
  text: string,
): Promise<string[]> {
  const root = path.join(seat.root, ".checkpoint", "pull-backups");
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if ((await readFile(full, "utf8")).includes(text)) found.push(full);
    }
  };
  await walk(root);
  return found;
}

/** What a workspace file holds now, for failure messages. */
export async function describeFile(
  seat: Seat,
  relativePath: string,
): Promise<string> {
  return exists(seat, relativePath)
    ? `${relativePath} holds ${JSON.stringify(await read(seat, relativePath))}`
    : `${relativePath} is gone from the workspace`;
}

/**
 * True when a local change survived: it is still in the workspace file (as
 * is, or merged), or the pull kept it aside where the user can find it.
 */
export async function survives(seat: Seat, relativePath: string, text: string) {
  const inWorkspace = exists(seat, relativePath)
    ? (await read(seat, relativePath)).includes(text)
    : false;
  return inWorkspace || (await backupsContaining(seat, text)).length > 0;
}

/** Writes the workspace's Team Sync settings into its workspace.json. */
export async function setTeamSync(
  seat: Seat,
  teamSync: WorkspaceTeamSyncSettings,
) {
  const { saveWorkspaceConfig } =
    await import("../../../core/daemon/src/util/util.js");
  await saveWorkspaceConfig({
    id: seat.workspace.id,
    repoId: seat.workspace.repoId,
    domainBranchName: seat.workspace.domainBranchName,
    activeBranches: [...seat.workspace.activeBranches],
    workspaceName: seat.workspace.name,
    localPath: seat.root,
    daemonId: seat.workspace.daemonId,
    teamSync,
  });
}

export const fileIn = (seat: Seat, relativePath: string) =>
  path.join(seat.root, relativePath);

export async function put(
  seat: Seat,
  relativePath: string,
  content: string | Buffer,
) {
  await writeInto(seat.root, relativePath, Buffer.from(content));
}

export async function read(seat: Seat, relativePath: string): Promise<string> {
  return (await readFile(fileIn(seat, relativePath))).toString("utf8");
}

export const exists = (seat: Seat, relativePath: string) =>
  existsSync(fileIn(seat, relativePath));

/** The content a changelist's own version index holds for a path. */
export function contentOfVersion(
  versionIndex: string,
  relativePath: string,
): string | undefined {
  return versions
    .get(versionIndex)
    ?.get(normalize(relativePath))
    ?.toString("utf8");
}

// ── the filesystem the seats live on ─────────────────────────────────
//
// Probed where makeSeat puts workspaces, not inferred from the OS: macOS can
// be formatted case-sensitive, Windows directories can be made case-sensitive
// (WSL does it), and Linux has case-folding directories.

/** True when this filesystem treats "a" and "A" as the same name (Windows, macOS). */
export async function filesystemIsCaseInsensitive(): Promise<boolean> {
  const dir = await mkdtemp(path.join(tmpdir(), "chk-case-"));
  try {
    await writeFile(path.join(dir, "probe"), "x");
    return existsSync(path.join(dir, "PROBE"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * True when this filesystem treats the composed ("é", U+00E9) and decomposed
 * ("e" + U+0301) spellings of a name as the same name (APFS and HFS+ on
 * macOS). Text typed on Windows and Linux is almost always composed; names
 * that came through older macOS tools are often decomposed.
 */
export async function filesystemIsNormalizationInsensitive(): Promise<boolean> {
  const dir = await mkdtemp(path.join(tmpdir(), "chk-nfd-"));
  try {
    await writeFile(path.join(dir, "café"), "x");
    return existsSync(path.join(dir, "café"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * True when this volume gives names an 8.3 short name, a second name for the
 * same file (on by default for many Windows system drives). `.checkpoint`
 * then also answers to `CHECKP~1`.
 */
export async function filesystemKeepsShortNames(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const dir = await mkdtemp(path.join(tmpdir(), "chk-8dot3-"));
  try {
    await mkdir(path.join(dir, ".checkpoint"));
    return existsSync(path.join(dir, "CHECKP~1"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Has another process hold a file open until released, the way Windows
 * programs do. "read" is how the Unreal Editor holds a package it has loaded:
 * others may read the file, but nobody may write, rename, or delete it.
 * "none" is how Office and many editors hold a document: nobody else may even
 * read it. Windows only.
 */
export async function holdOpen(
  fullPath: string,
  share: "read" | "none",
): Promise<() => Promise<void>> {
  if (process.platform !== "win32") {
    throw new Error("holdOpen: Windows file sharing modes only");
  }
  const target = path.resolve(fullPath).replace(/'/g, "''");
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$f = [System.IO.File]::Open('${target}', 'Open', 'Read', '${share === "read" ? "Read" : "None"}'); ` +
        "[Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Seconds 600",
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  await new Promise<void>((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("held")) resolve();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(
        new Error(
          `holdOpen: could not hold ${fullPath} open (exit ${code}): ${err.trim()}`,
        ),
      ),
    );
  });
  return async () => {
    if (child.exitCode === null) child.kill();
    await exited;
  };
}
