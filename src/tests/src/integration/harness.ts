/**
 * Harness for integration tests that drive the real native longtail addon
 * against running services (app, daemon, server).
 *
 * Nothing here goes through the daemon's submit path on purpose. The daemon
 * deduplicates and normalizes paths before the addon sees them, which is
 * exactly the layer these tests must bypass: the addon has to be safe on its
 * own, because it is also called from the server and from tooling that does
 * not run the daemon's expander.
 *
 * Enabled by CHECKPOINT_TEST_DAEMON_ID, which names the entry in
 * ~/.checkpoint/auth.json to authenticate with (the CI workflow writes one).
 * Each test file creates its own org and repo so nothing else in the run can
 * interleave with its changelists.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CreateApiClientAuthManual,
  GetAuthConfigUser,
} from "@checkpointvcs/common";
import {
  freeHandle,
  freeReadFileHandle,
  GetLogLevel,
  pollHandle,
  pollReadFileHandle,
  readFileFromVersionAsync,
  submitAsync,
  type Modification,
  type SubmitAsyncOptions,
} from "@checkpointvcs/longtail-addon";

import {
  resolveStorageEndpoints,
  toStorageOptions,
} from "../../../core/daemon/src/util/storage-options.js";

export const DAEMON_ID = process.env.CHECKPOINT_TEST_DAEMON_ID ?? "";
export const enabled = DAEMON_ID.length > 0;

if (!enabled) {
  console.warn(
    "[integration] CHECKPOINT_TEST_DAEMON_ID is not set; integration tests will be skipped. " +
      "Start the services (yarn dev), log in so ~/.checkpoint/auth.json has an entry, and export the daemon id.",
  );
}

type ApiClient = Awaited<ReturnType<typeof CreateApiClientAuthManual>>;

export interface IntegrationContext {
  client: ApiClient;
  apiToken: string;
  orgId: string;
  repoId: string;
}

export interface LocalWorkspace {
  /** Forward-slash absolute path, the form the addon expects. */
  root: string;
  workspaceId: string;
  cleanup(): Promise<void>;
}

// Same values DaemonConfig defaults to (src/core/daemon/src/daemon-config.ts).
const LONGTAIL_DEFAULTS = {
  targetChunkSize: 32768,
  targetBlockSize: 8388608,
  maxChunksPerBlock: 1024,
  minBlockUsagePercent: 80,
  hashingAlgo: "blake3",
  compressionAlgo: "zstd",
  enableMmapIndexing: false,
  enableMmapBlockStore: false,
};

/** Authenticates from auth.json and creates a private org + repo for a test file. */
export async function createContext(
  label: string,
): Promise<IntegrationContext> {
  const user = await GetAuthConfigUser(DAEMON_ID);
  if (!user?.apiToken || !user.endpoint) {
    throw new Error(
      `No auth.json entry for daemon id "${DAEMON_ID}" with an endpoint and apiToken`,
    );
  }
  const client = await CreateApiClientAuthManual(user.endpoint, user.apiToken);

  const suffix = `${Date.now()}-${process.pid}`;
  const org = await client.org.createOrg.mutate({
    name: `it-${label}-${suffix}`,
  });
  const repo = await client.repo.createRepo.mutate({
    name: `it-${label}-${suffix}`,
    orgId: org.id,
  });

  return { client, apiToken: user.apiToken, orgId: org.id, repoId: repo.id };
}

/**
 * A scratch directory registered server-side as a workspace of the repo. The
 * server refuses a submit for a workspace the caller does not own, so a row
 * has to exist even though the daemon never learns about the directory.
 */
export async function createWorkspace(
  ctx: IntegrationContext,
  name: string,
): Promise<LocalWorkspace> {
  const dir = await mkdtemp(path.join(tmpdir(), `chk-native-${name}-`));
  const root = dir.replace(/\\/g, "/");
  const workspace = await ctx.client.workspace.create.mutate({
    name: `${name}-${path.basename(dir)}`,
    repoId: ctx.repoId,
    defaultBranchName: "main",
  });
  return {
    root,
    workspaceId: workspace.id,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export async function write(
  ws: LocalWorkspace,
  relativePath: string,
  content: string | Buffer,
): Promise<void> {
  const full = path.join(ws.root, relativePath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}

export interface SubmitOutcome {
  /** 0 on success, otherwise the errno-style code the addon reported. */
  error: number;
  /** The addon's last step, which carries the error text on failure. */
  step: string;
  changelistNumber: number | null;
}

/**
 * Calls the addon's submit directly with the modification list as given: no
 * dedupe, no normalization, no directory expansion.
 */
export async function nativeSubmit(
  ctx: IntegrationContext,
  ws: LocalWorkspace,
  modifications: Modification[],
  message = "native submit test",
): Promise<SubmitOutcome> {
  const rawToken = await ctx.client.storage.getToken.query({
    repoId: ctx.repoId,
    write: true,
  });
  if (!rawToken?.expiration) {
    throw new Error("Could not get a write storage token");
  }
  const token = await resolveStorageEndpoints(rawToken);

  const options: SubmitAsyncOptions = {
    branchName: "main",
    message,
    ...LONGTAIL_DEFAULTS,
    localRootPath: ws.root,
    remoteBasePath: `/${ctx.orgId}/${ctx.repoId}`,
    backendUrl: token.serverUrl,
    ...toStorageOptions(token),
    apiJwt: ctx.apiToken,
    keepCheckedOut: false,
    workspaceId: ws.workspaceId,
    modifications,
    logLevel: GetLogLevel("off"),
  };

  const handle = submitAsync(options);
  if (!handle) {
    throw new Error("submitAsync returned no handle");
  }
  try {
    const { status, result } = await pollHandle(handle, {
      intervalMs: 50,
      onTokenRefresh: async () => {
        const refreshed = await ctx.client.storage.getToken.query({
          repoId: ctx.repoId,
          write: true,
        });
        return {
          jwt: refreshed.token,
          jwtExpirationMs: (refreshed.expiration ?? 0) * 1000,
          ...(refreshed.r2 && {
            s3AccessKeyId: refreshed.r2.accessKeyId,
            s3SecretAccessKey: refreshed.r2.secretAccessKey,
            s3SessionToken: refreshed.r2.sessionToken,
          }),
        };
      },
    });
    const changelistNumber =
      status.error === 0 && typeof result?.changelistNumber === "number"
        ? (result.changelistNumber as number)
        : null;
    return { error: status.error, step: status.currentStep, changelistNumber };
  } finally {
    freeHandle(handle);
  }
}

/**
 * Reads a file straight out of one changelist's version index, which is the
 * read path a pull resolves through, so it sees exactly the bytes a teammate
 * would receive.
 *
 * IMPORTANT: a version index contains ONLY that changelist's own
 * modifications, not a snapshot of the tree. Pass the changelist that actually
 * wrote the path, or this rejects with "File not found in version" even though
 * the file is perfectly alive at that point in history. A delete-only
 * changelist has an index with zero assets.
 *
 * Reading a path "as of" an arbitrary changelist means first finding the most
 * recent change to it at or before that number, which is what the app's
 * file.readFileContent does server-side. Nothing here needs that yet, so this
 * stays the narrow primitive.
 */
export async function readCommitted(
  ctx: IntegrationContext,
  changelistNumber: number,
  filePath: string,
): Promise<Buffer> {
  const changelist = await ctx.client.changelist.getChangelist.query({
    repoId: ctx.repoId,
    changelistNumber,
  });
  if (!changelist?.versionIndex) {
    throw new Error(`Changelist ${changelistNumber} has no version index`);
  }

  const rawToken = await ctx.client.storage.getToken.query({
    repoId: ctx.repoId,
    write: false,
  });
  if (!rawToken?.expiration) {
    throw new Error("Could not get a read storage token");
  }
  const token = await resolveStorageEndpoints(rawToken);

  const handle = readFileFromVersionAsync({
    filePath,
    versionIndexName: changelist.versionIndex,
    remoteBasePath: `/${ctx.orgId}/${ctx.repoId}`,
    ...toStorageOptions(token),
    logLevel: GetLogLevel("off"),
  });
  if (!handle) {
    throw new Error("readFileFromVersionAsync returned no handle");
  }
  try {
    const { data, size } = await pollReadFileHandle(handle, { intervalMs: 20 });
    if (!data || size === 0) {
      return Buffer.alloc(0);
    }
    return Buffer.from(data.subarray(0, size));
  } finally {
    freeReadFileHandle(handle);
  }
}

/** Highest changelist number on main. */
export async function headChangelistNumber(
  ctx: IntegrationContext,
): Promise<number> {
  const list = await ctx.client.changelist.getChangelists.query({
    repoId: ctx.repoId,
    branchName: "main",
    start: { number: null, timestamp: null },
    count: 10,
  });
  return list.reduce((max, cl) => Math.max(max, cl.number), 0);
}

export interface CommittedPath {
  path: string;
  changeType: string;
}

/** The paths a changelist recorded, in the order the server returns them. */
export async function changelistPaths(
  ctx: IntegrationContext,
  changelistNumber: number,
): Promise<CommittedPath[]> {
  const files = await ctx.client.changelist.getChangelistFiles.query({
    repoId: ctx.repoId,
    changelistNumber,
  });
  return files.map((f) => ({ path: f.path, changeType: String(f.changeType) }));
}
