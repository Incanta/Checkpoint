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
import {
  createServer,
  request as httpRequest,
  type RequestOptions,
} from "node:http";
import type { AddressInfo } from "node:net";
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
  /**
   * Applied last, over everything the harness derives. The fault tests use it
   * to point the addon's storage traffic at a proxy.
   */
  overrides: Partial<SubmitAsyncOptions> = {},
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
    ...overrides,
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

/** What a fault proxy does with one request. */
export type FaultAction =
  /** Forward it to the real gateway and relay the answer. */
  | "pass"
  /** Answer with this status without forwarding. */
  | { status: number }
  /** Drop the connection without answering, as a network failure would. */
  | "reset"
  /**
   * Answer 200 without forwarding: the client is told the upload worked and
   * the store never sees it. This is what a client that skips or botches an
   * upload looks like from the server, so it is how the server-side checks are
   * reached now that the addon no longer ignores a failed upload itself.
   */
  | "swallow"
  /**
   * Answer 200 with these bytes without forwarding: what a reader sees when
   * the object in storage is not the one that was written.
   */
  | { respond: Buffer };

export interface FaultRequest {
  method: string;
  /** Request path, e.g. "/storage/{org}/{repo}/chunks/ab12/0x....lrb". */
  path: string;
  /** 1 for the first time this method and path were seen, 2 for the next. */
  attempt: number;
}

export interface FaultProxy {
  /** Pass as `gatewayUrl` to route the addon's storage traffic through here. */
  gatewayUrl: string;
  /** Every request seen, in arrival order. */
  requests: FaultRequest[];
  close(): Promise<void>;
}

/**
 * An HTTP proxy in front of the storage gateway that can fail chosen requests.
 * Only storage traffic goes through it: the /submit POST uses `backendUrl`,
 * which the tests leave pointing at the real server.
 */
export async function startFaultProxy(
  ctx: IntegrationContext,
  decide: (request: FaultRequest) => FaultAction,
): Promise<FaultProxy> {
  const rawToken = await ctx.client.storage.getToken.query({
    repoId: ctx.repoId,
    write: true,
  });
  const token = await resolveStorageEndpoints(rawToken);
  if (!token.gatewayUrl) {
    throw new Error(
      "The fault proxy needs a gateway storage mode (local or s3)",
    );
  }
  const target = new URL(token.gatewayUrl);

  const requests: FaultRequest[] = [];
  const attempts = new Map<string, number>();

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const method = req.method ?? "GET";
        const requestPath = (req.url ?? "/").split("?")[0]!;
        const key = `${method} ${requestPath}`;
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);
        const request: FaultRequest = { method, path: requestPath, attempt };
        requests.push(request);

        const action = decide(request);
        if (action === "reset") {
          req.socket.destroy();
          return;
        }
        if (action === "swallow") {
          res.writeHead(200).end();
          return;
        }
        if (action !== "pass" && "respond" in action) {
          res.writeHead(200, {
            "content-length": String(action.respond.length),
          });
          res.end(method === "HEAD" ? undefined : action.respond);
          return;
        }
        if (action !== "pass") {
          res.writeHead(action.status).end("injected fault");
          return;
        }

        const headers: Record<string, string> = {};
        for (const name of ["authorization", "content-type"]) {
          const value = req.headers[name];
          if (typeof value === "string") headers[name] = value;
        }
        const hasBody = method !== "GET" && method !== "HEAD";
        const requestBody = hasBody ? Buffer.concat(chunks) : undefined;
        if (requestBody) {
          headers["content-length"] = String(requestBody.length);
        }
        // node:http rather than fetch, with address family selection off. On
        // Windows, Node 24 intermittently dies with a stack cookie failure
        // inside libuv's TCP connect (exit 0xC0000409, main thread, no addon
        // frame anywhere near it) when fetch races IPv6 and IPv4 attempts to
        // "localhost" while the server is busy. One plain connection per
        // request avoids that path.
        const upstream = await new Promise<{
          status: number;
          contentLength: string | undefined;
          body: Buffer;
        }>((resolve, reject) => {
          const forward = httpRequest(
            {
              host: target.hostname,
              port: target.port,
              method,
              path: req.url ?? "/",
              headers,
              agent: false,
              // Passed through to net.connect; not in http's option types.
              autoSelectFamily: false,
            } as RequestOptions,
            (upstreamRes) => {
              const parts: Buffer[] = [];
              upstreamRes.on("data", (part: Buffer) => parts.push(part));
              upstreamRes.on("end", () =>
                resolve({
                  status: upstreamRes.statusCode ?? 502,
                  contentLength: upstreamRes.headers["content-length"],
                  body: Buffer.concat(parts),
                }),
              );
              upstreamRes.on("error", reject);
            },
          );
          forward.on("error", reject);
          forward.end(requestBody);
        });
        // A HEAD carries the object's size in Content-Length with no body, and
        // the addon's GetSize reads it, so it has to be relayed as given.
        const contentLength =
          method === "HEAD"
            ? upstream.contentLength
            : String(upstream.body.length);
        res.writeHead(
          upstream.status,
          contentLength === undefined ? {} : { "content-length": contentLength },
        );
        res.end(method === "HEAD" ? undefined : upstream.body);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    gatewayUrl: `http://127.0.0.1:${port}${target.pathname.replace(/\/$/, "")}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
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
  pollIntervalMs = 20,
  /** Applied last; lets a test route the read through a fault proxy. */
  overrides: { gatewayUrl?: string } = {},
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
    ...overrides,
  });
  if (!handle) {
    throw new Error("readFileFromVersionAsync returned no handle");
  }
  try {
    const { data, size } = await pollReadFileHandle(handle, {
      intervalMs: pollIntervalMs,
    });
    if (!data || size === 0) {
      return Buffer.alloc(0);
    }
    return Buffer.from(data.subarray(0, size));
  } finally {
    freeReadFileHandle(handle);
  }
}

/** One request to the storage gateway for an object in the context's repo. */
export async function gatewayRequest(
  ctx: IntegrationContext,
  method: "HEAD" | "GET" | "PUT" | "DELETE",
  key: string,
  body?: Buffer,
): Promise<{ status: number; body: Buffer }> {
  const rawToken = await ctx.client.storage.getToken.query({
    repoId: ctx.repoId,
    write: true,
  });
  const token = await resolveStorageEndpoints(rawToken);
  if (!token.gatewayUrl) {
    throw new Error("gatewayRequest needs a gateway storage mode (local or s3)");
  }
  const base = token.gatewayUrl.replace(/\/$/, "");
  const response = await fetch(
    `${base}/${ctx.orgId}/${ctx.repoId}/${key}`,
    {
      method,
      headers: { authorization: `Bearer ${token.token}` },
      ...(body && { body: new Uint8Array(body) }),
    },
  );
  return {
    status: response.status,
    body: Buffer.from(await response.arrayBuffer()),
  };
}

/**
 * One request to the storage gateway with the path sent exactly as given.
 * `fetch` and `new URL` both collapse "." and ".." segments before anything
 * leaves the process, which makes them useless for testing how the server
 * handles such a path; node:http sends it verbatim.
 *
 * `rawPath` is everything after the gateway base, starting with "/".
 */
export async function rawGatewayRequest(
  ctx: IntegrationContext,
  method: "HEAD" | "GET" | "PUT" | "DELETE",
  rawPath: string,
  options: { body?: Buffer; write?: boolean; bearer?: string } = {},
): Promise<{ status: number; body: Buffer }> {
  const rawToken = await ctx.client.storage.getToken.query({
    repoId: ctx.repoId,
    write: options.write ?? true,
  });
  const token = await resolveStorageEndpoints(rawToken);
  if (!token.gatewayUrl) {
    throw new Error(
      "rawGatewayRequest needs a gateway storage mode (local or s3)",
    );
  }
  const base = new URL(token.gatewayUrl);
  const prefix = base.pathname.replace(/\/$/, "");

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: base.hostname,
        port: base.port,
        method,
        path: `${prefix}${rawPath}`,
        headers: {
          authorization: `Bearer ${options.bearer ?? token.token}`,
          ...(options.body && { "content-length": options.body.length }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

/** The server URL and a storage token for the context's repo. */
export async function storageToken(
  ctx: IntegrationContext,
  write: boolean,
): Promise<{ serverUrl: string; token: string }> {
  const rawToken = await ctx.client.storage.getToken.query({
    repoId: ctx.repoId,
    write,
  });
  const token = await resolveStorageEndpoints(rawToken);
  return { serverUrl: token.serverUrl, token: token.token };
}

/** The version index name a changelist recorded. */
export async function versionIndexOf(
  ctx: IntegrationContext,
  changelistNumber: number,
): Promise<string> {
  const changelist = await ctx.client.changelist.getChangelist.query({
    repoId: ctx.repoId,
    changelistNumber,
  });
  return changelist?.versionIndex ?? "";
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
