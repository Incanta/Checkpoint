/**
 * The bug-report bundle (src/core/daemon/src/util/bug-report.ts), its zip
 * writer (util/zip.ts), and the size-capped daemon log it collects
 * (logging.ts). The bundle is read back with a small zip reader here, so a
 * malformed archive fails the tests rather than the user's upload.
 */
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  collectBugReport,
  redactFile,
  MAX_BUNDLES_KEPT,
  type BugReportManagerView,
} from "../../../core/daemon/src/util/bug-report.js";
import { createZip, crc32 } from "../../../core/daemon/src/util/zip.js";
import {
  EphemeralLogFilePath,
  RotatingLogFile,
} from "../../../core/daemon/src/logging.js";
import type { DaemonConfigType } from "../../../core/daemon/src/daemon-config.js";
import type { Job } from "../../../core/daemon/src/job-manager.js";
import type { Workspace } from "../../../core/daemon/src/types/index.js";
import type { WorkspaceState } from "../../../core/daemon/src/util/util.js";

/** Reads every entry of a zip through its central directory. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");

    expect(buf.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const body = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe("the zip writer", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it("round-trips deflated, stored, empty, and UTF-8-named entries", () => {
    const big = "line of a log file\n".repeat(1000);
    const random = Buffer.from(
      Array.from({ length: 256 }, (_, i) => (i * 7919) % 251),
    );
    const zip = createZip([
      { name: "logs/daemon.log", data: big },
      { name: "random.bin", data: random },
      { name: "empty.txt", data: "" },
      { name: "client-logs/ログ.txt", data: "é" },
      { name: "win\\style.txt", data: "x" },
    ]);
    const entries = readZip(zip);
    expect(entries.get("logs/daemon.log")!.toString()).toBe(big);
    expect(entries.get("random.bin")!.equals(random)).toBe(true);
    expect(entries.get("empty.txt")!.length).toBe(0);
    expect(entries.get("client-logs/ログ.txt")!.toString()).toBe("é");
    expect(entries.has("win/style.txt")).toBe(true);
    // The repetitive log compresses.
    expect(zip.length).toBeLessThan(big.length / 4);
  });

  it("writes a valid archive with no entries", () => {
    expect(readZip(createZip([])).size).toBe(0);
  });
});

describe("the daemon's rotating log file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "chk-rotating-log-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("archives the log once it passes the size cap and starts a new one", async () => {
    const file = path.join(dir, "daemon.log");
    const log = new RotatingLogFile(file, 100, 10);
    for (let i = 0; i < 5; i++) log.write(`${"x".repeat(39)}\n`);
    const names = (await readdir(dir)).sort();
    expect(names).toContain("daemon.log");
    const archives = names.filter((n) => n.startsWith("daemon-"));
    expect(archives.length).toBe(1);
    // Rotation happens after the line that crossed the cap, so no line is
    // split between files.
    expect((await readFile(path.join(dir, archives[0]!), "utf8")).length).toBe(
      120,
    );
    expect((await stat(file)).size).toBe(80);
  });

  it("keeps at most maxArchivedFiles archives", async () => {
    const file = path.join(dir, "daemon.log");
    for (let i = 0; i < 4; i++) {
      await writeFile(path.join(dir, `daemon-2020.01.0${i + 1}-00.00.00.log`), "old");
    }
    const log = new RotatingLogFile(file, 10, 2);
    log.write("0123456789\n");
    const archives = (await readdir(dir)).filter((n) => n.startsWith("daemon-"));
    expect(archives.length).toBe(2);
    // The newest (just rotated) archive survives; the oldest go first.
    expect(archives).not.toContain("daemon-2020.01.01-00.00.00.log");
  });

  it("neither counts nor prunes the tray's daemon-process logs as archives", async () => {
    const file = path.join(dir, "daemon.log");
    const siblings = [
      "daemon-process.log",
      "daemon-process-2019.01.01-00.00.00.log",
      "daemon-process-2019.01.02-00.00.00.log",
      "daemon-notes.log",
    ];
    for (const name of siblings) await writeFile(path.join(dir, name), "x");
    await writeFile(path.join(dir, "daemon-2020.01.01-00.00.00.log"), "old");
    await writeFile(path.join(dir, "daemon-2020.01.02-00.00.00.000.log"), "old");

    const log = new RotatingLogFile(file, 10, 2);
    log.write("0123456789\n");

    const names = await readdir(dir);
    for (const name of siblings) expect(names).toContain(name);
    const archives = names.filter((n) => /^daemon-\d/.test(n));
    // Only real archives count toward the cap: the oldest one goes, and the
    // millisecond-suffixed archive is recognised as one.
    expect(archives.length).toBe(2);
    expect(archives).not.toContain("daemon-2020.01.01-00.00.00.log");
    expect(archives).toContain("daemon-2020.01.02-00.00.00.000.log");
  });

  it("never rotates with a cap of 0", async () => {
    const file = path.join(dir, "daemon.log");
    const log = new RotatingLogFile(file, 0, 2);
    for (let i = 0; i < 50; i++) log.write("some log line\n");
    expect(await readdir(dir)).toEqual(["daemon.log"]);
  });

  it("appends to an existing log rather than truncating it", async () => {
    const file = path.join(dir, "daemon.log");
    await writeFile(file, "earlier\n");
    new RotatingLogFile(file, 0, 2).write("later\n");
    expect(await readFile(file, "utf8")).toBe("earlier\nlater\n");
  });

  it("names the ephemeral log so resident archive pruning never matches it", () => {
    const resident = path.join(dir, "daemon.log");
    const ephemeral = EphemeralLogFilePath(resident);
    expect(path.basename(ephemeral)).toBe("ephemeral-daemon.log");
    expect(path.basename(ephemeral).startsWith("daemon-")).toBe(false);
    expect(path.dirname(ephemeral)).toBe(dir);
  });
});

const TOKEN = "a".repeat(20) + "SECRETTOKENVALUE";

function makeConfig(workspaces: Workspace[]): DaemonConfigType {
  return {
    daemonPort: 13010,
    mcp: { enabled: false, port: 13011 },
    workspaces,
    stateBackend: "sqlite",
    updates: { channel: "release" },
    logging: {
      level: "info",
      prettify: {
        enabled: true,
        include: [],
        colorize: true,
        colorizeObjects: true,
        crlf: false,
        levelFirst: false,
        messageFormat: false,
        translateTime: "SYS:standard",
        ignore: [],
        hideObject: false,
        singleLine: false,
      },
      logFile: {
        enabled: false,
        level: "info",
        path: "logs/daemon.log",
        maxArchivedFiles: 10,
        maxFileSizeMB: 20,
      },
    },
  } as unknown as DaemonConfigType;
}

function makeWorkspace(id: string, localPath: string): Workspace {
  return {
    id,
    repoId: `repo-${id}`,
    name: `ws-${id}`,
    domainBranchName: "main",
    activeBranches: [],
    localPath,
    daemonId: "daemon-1",
    userId: "",
    orgId: "",
    createdAt: new Date(0),
    deletedAt: null,
    syncedChangelistNumber: null,
    syncedAt: null,
  } as Workspace;
}

function makeJob(partial: Partial<Job>): Job {
  return {
    id: "job",
    type: "pull",
    status: "completed",
    workspaceId: null,
    steps: [],
    currentStep: null,
    progress: null,
    stepStartedAt: null,
    stepStates: null,
    logs: [],
    logSeq: 0,
    logFilePath: null,
    cancelRequested: false,
    result: null,
    error: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:01Z"),
    ...partial,
  };
}

describe("collectBugReport", () => {
  let root: string;
  let logDir: string;
  let outDir: string;
  let fakeHome: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "chk-bug-report-"));
    logDir = path.join(root, "logs");
    outDir = path.join(root, "bug-reports");
    fakeHome = path.join(root, "home", "alice");
    await mkdir(logDir, { recursive: true });
    await mkdir(fakeHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function collect(
    extra: Partial<Parameters<typeof collectBugReport>[0]> = {},
  ): Promise<{ entries: Map<string, string>; result: Awaited<ReturnType<typeof collectBugReport>> }> {
    const result = await collectBugReport({
      config: makeConfig([]),
      logFilePath: path.join(logDir, "daemon.log"),
      outputDir: outDir,
      homeDirs: [fakeHome],
      secrets: [TOKEN],
      ...extra,
    });
    const entries = new Map<string, string>();
    for (const [name, data] of readZip(await readFile(result.path))) {
      entries.set(name, data.toString("utf8"));
    }
    return { entries, result };
  }

  it("contains the README, versions, config, workspaces, and jobs even with no logs", async () => {
    const { entries, result } = await collect();
    expect([...entries.keys()].sort()).toEqual(
      ["README.txt", "daemon-config.json", "jobs.json", "versions.json", "workspaces.json"].sort(),
    );
    expect(result.files.sort()).toEqual([...entries.keys()].sort());
    expect(path.dirname(result.path)).toBe(outDir);
    expect(path.basename(result.path)).toMatch(
      /^checkpoint-bug-report-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/,
    );
    const versions = JSON.parse(entries.get("versions.json")!);
    expect(versions.node).toBe(process.version);
    expect(versions.os.platform).toBe(process.platform);
    expect(versions).toHaveProperty("checkpoint");
    expect(versions).toHaveProperty("longtailAddon");
    expect(versions).toHaveProperty("daemonApi");
    expect(entries.get("README.txt")).toContain("auth.json");
  });

  it("collects the resident log, its archives, and ephemeral logs, newest first, and nothing else", async () => {
    const write = async (name: string, body: string, ageSec: number) => {
      const p = path.join(logDir, name);
      await writeFile(p, body);
      const t = new Date(Date.now() - ageSec * 1000);
      const { utimes } = await import("node:fs/promises");
      await utimes(p, t, t);
    };
    await write("daemon.log", "current\n", 0);
    await write("daemon-2026.01.01-00.00.00.log", "archived\n", 100);
    await write("ephemeral-daemon.log", "ephemeral\n", 50);
    await write("ephemeral-daemon-2026.01.01-00.00.00.log", "old ephemeral\n", 200);
    await write("checkpoint.log", "someone else's\n", 0);
    await write("daemon.txt", "not a log\n", 0);

    const { entries } = await collect();
    const logs = [...entries.keys()].filter((n) => n.startsWith("logs/"));
    expect(logs).toEqual([
      "logs/daemon.log",
      "logs/ephemeral-daemon.log",
      "logs/daemon-2026.01.01-00.00.00.log",
      "logs/ephemeral-daemon-2026.01.01-00.00.00.log",
    ]);
  });

  it("redacts the logs: known tokens, JSON keys, emails (stable across files), and the home directory", async () => {
    await writeFile(
      path.join(logDir, "daemon.log"),
      [
        JSON.stringify({ level: 30, msg: `using token ${TOKEN}` }),
        JSON.stringify({ level: 30, msg: "login", email: "bob@studio.dev", apiToken: "zzz" }),
        JSON.stringify({ level: 30, msg: `pull in ${path.join(fakeHome, "Game")} Content/Maps/A.umap` }),
        "plain line Authorization: Bearer abcdefghijklmnop",
      ].join("\n") + "\n",
    );
    const { entries } = await collect({
      clientLogs: [{ name: "desktop-main.log", content: "renderer saw bob@studio.dev" }],
    });
    const log = entries.get("logs/daemon.log")!;
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain("zzz");
    expect(log).not.toContain("bob@studio.dev");
    expect(log).not.toContain("abcdefghijklmnop");
    expect(log).not.toContain(fakeHome);
    expect(log).toContain("[email-1]");
    // Repo paths survive.
    expect(log).toContain("Content/Maps/A.umap");
    // Same placeholder in a different file of the same bundle.
    expect(entries.get("client-logs/desktop-main.log")).toBe("renderer saw [email-1]");
  });

  it("keeps the newest logs within the byte budget and tails the one that crosses it", async () => {
    const { utimes } = await import("node:fs/promises");
    const newest = path.join(logDir, "daemon.log");
    const older = path.join(logDir, "daemon-2026.01.01-00.00.00.log");
    const oldest = path.join(logDir, "daemon-2025.01.01-00.00.00.log");
    await writeFile(newest, "n".repeat(59) + "\n");
    await writeFile(older, Array.from({ length: 10 }, (_, i) => `line-${i}-xxxx`).join("\n") + "\n");
    await writeFile(oldest, "o\n");
    await utimes(older, new Date(Date.now() - 100_000), new Date(Date.now() - 100_000));
    await utimes(oldest, new Date(Date.now() - 200_000), new Date(Date.now() - 200_000));

    const { entries, result } = await collect({ maxLogBytes: 100 });
    expect(entries.get("logs/daemon.log")).toBe("n".repeat(59) + "\n");
    const tail = entries.get("logs/daemon-2026.01.01-00.00.00.log")!;
    // Cut to whole lines from the end.
    expect(tail.endsWith("line-9-xxxx\n")).toBe(true);
    expect(tail.startsWith("line-")).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(40);
    expect(entries.has("logs/daemon-2025.01.01-00.00.00.log")).toBe(false);
    expect(result.truncatedLogs.sort()).toEqual(
      ["daemon-2025.01.01-00.00.00.log", "daemon-2026.01.01-00.00.00.log"].sort(),
    );
  });

  it("redacts daemon.json and never includes auth.json", async () => {
    await writeFile(path.join(fakeHome, "auth.json"), JSON.stringify({ users: { d: { apiToken: TOKEN } } }));
    const ws = makeWorkspace("w1", path.join(fakeHome, "Projects", "Game"));
    const config = makeConfig([ws]) as DaemonConfigType & Record<string, unknown>;
    (config as Record<string, unknown>)["someToken"] = "should-not-leak";
    const { entries } = await collect({ config });
    const daemonJson = entries.get("daemon-config.json")!;
    expect(daemonJson).not.toContain("should-not-leak");
    expect(daemonJson).not.toContain("alice");
    expect(daemonJson).toContain("repo-w1");
    expect(daemonJson).toContain("Projects");
    for (const [name, body] of entries) {
      expect(name).not.toMatch(/auth/i);
      expect(body).not.toContain(TOKEN);
    }
  });

  it("summarizes each workspace from the manager's cached state", async () => {
    const wsA = makeWorkspace("a", path.join(fakeHome, "A"));
    const wsB = makeWorkspace("b", path.join(root, "nowhere"));
    await mkdir(wsA.localPath, { recursive: true });
    const state: WorkspaceState = {
      version: 3,
      changelistNumber: 42,
      branchHeads: { "feature/x": 44 },
      files: { "a.txt": {} as never, "b.txt": {} as never, "c/d.txt": {} as never },
      markedForAdd: ["new.txt"],
      staged: ["a.txt", "new.txt"],
      pendingRemovals: ["gone.txt"],
      interruptedPull: {
        changelist: 43,
        backupRoot: path.join(wsA.localPath, ".checkpoint", "pull-backup"),
        pid: 1234,
        startedAt: "2026-01-01T00:00:00Z",
        partial: [{ path: "big.bin", size: 1, mtime: 1 }],
      },
    } as WorkspaceState;
    const manager: BugReportManagerView = {
      workspaces: new Map([["daemon-1", [wsA]]]),
      workspacePendingChanges: new Map([
        ["a", { numChanges: 5, files: {}, unsupported: [{ path: "x\\y", reason: "r" }] }],
      ]),
      getWorkspaceState: (id) => (id === "a" ? state : null),
      getSyncStatus: (id) =>
        id === "a"
          ? {
              upToDate: false,
              localChangelistNumber: 42,
              remoteHeadNumber: 45,
              changelistsBehind: 3,
              changelistsToPull: [43, 44, 45],
              outdatedFiles: [{ path: "secret-plans.txt" }],
              deletedOnRemote: [],
              newOnRemote: ["n1", "n2"],
              checkedAt: new Date("2026-01-01T00:00:00Z"),
            }
          : null,
      isWatching: (id) => id === "a",
    };
    const jobs = [
      makeJob({ id: "j1", type: "pull", status: "failed", workspaceId: "a", error: "ECONNRESET talking to https://h/?token=abc",
        logs: [{ seq: 1, ts: 1, stream: "err", line: "boom for carol@studio.dev" }] }),
      makeJob({ id: "j2", type: "submit", status: "completed", workspaceId: "a",
        logs: [{ seq: 1, ts: 1, stream: "out", line: "fine" }] }),
      makeJob({ id: "j3", type: "submit", status: "failed", workspaceId: "b", error: "refused" }),
    ];

    const { entries } = await collect({ config: makeConfig([wsA, wsB]), manager, jobs });
    const summaries = JSON.parse(entries.get("workspaces.json")!);
    expect(summaries).toHaveLength(2);
    const a = summaries.find((s: { id: string }) => s.id === "a");
    expect(a).toMatchObject({
      repoId: "repo-a",
      exists: true,
      watching: true,
      domainBranchName: "main",
      state: {
        stateVersion: 3,
        changelistNumber: 42,
        branchHeads: { "feature/x": 44 },
        trackedFiles: 3,
        markedForAdd: 1,
        staged: 2,
        pendingRemovals: 1,
        interruptedPull: { changelist: 43, pid: 1234, partialFiles: 1, restoredAt: null },
      },
      pendingChanges: { numChanges: 5, unsupportedNames: 1 },
      syncStatus: { changelistsBehind: 3, outdatedFiles: 1, newOnRemote: 2 },
    });
    expect(a.localPath).not.toContain("alice");
    expect(a.state.interruptedPull.backupRoot).not.toContain("alice");
    expect(a.recentErrors).toEqual([
      { type: "pull", at: "2026-01-01T00:00:01.000Z", error: "ECONNRESET talking to https://h/?token=[REDACTED]" },
    ]);
    // No file lists from the sync status.
    expect(entries.get("workspaces.json")).not.toContain("secret-plans.txt");

    const b = summaries.find((s: { id: string }) => s.id === "b");
    expect(b.exists).toBe(false);
    expect(b.state).toBe("not loaded by this daemon process");
    expect(b.recentErrors).toEqual([{ type: "submit", at: "2026-01-01T00:00:01.000Z", error: "refused" }]);

    const jobsDoc = JSON.parse(entries.get("jobs.json")!);
    expect(jobsDoc.map((j: { id: string }) => j.id)).toEqual(["j1", "j2", "j3"]);
    expect(jobsDoc[0].logTail).toEqual(["[err] boom for [email-1]"]);
    // A successful job's log is left out.
    expect(jobsDoc[1].logTail).toBeUndefined();
  });

  it("includes a workspace only the manager knows (an ephemeral daemon's)", async () => {
    const ws = makeWorkspace("eph", path.join(root, "eph"));
    const manager: BugReportManagerView = {
      workspaces: new Map([["d", [ws]]]),
      workspacePendingChanges: new Map(),
      getWorkspaceState: () => null,
      getSyncStatus: () => {
        throw new Error("no status");
      },
      isWatching: () => false,
    };
    const { entries } = await collect({ manager, ephemeral: true });
    const summaries = JSON.parse(entries.get("workspaces.json")!);
    expect(summaries.map((s: { id: string }) => s.id)).toEqual(["eph"]);
    expect(summaries[0].syncStatus).toBeNull();
    expect(JSON.parse(entries.get("versions.json")!).daemon.ephemeral).toBe(true);
  });

  it("adds status documents and sanitizes client log names", async () => {
    const { entries } = await collect({
      status: { servers: [{ endpoint: "https://u:pw@h", result: "ok" }], "../evil": 1 },
      clientLogs: [
        { name: "../../etc/passwd", content: "a" },
        { name: "main.log", content: "b" },
        { name: "main.log", content: "c" },
        { name: "...", content: "d" },
      ],
    });
    expect(entries.get("status/servers.json")).toContain("https://u:[REDACTED]@h");
    expect(entries.has("status/evil.json")).toBe(true);
    const clientLogs = [...entries.keys()].filter((n) => n.startsWith("client-logs/")).sort();
    expect(clientLogs).toEqual(
      ["client-logs/2-main.log", "client-logs/log.txt", "client-logs/main.log", "client-logs/passwd"].sort(),
    );
  });

  it(`keeps only the newest ${MAX_BUNDLES_KEPT} bundles`, async () => {
    await mkdir(outDir, { recursive: true });
    for (let i = 0; i < MAX_BUNDLES_KEPT + 3; i++) {
      await writeFile(
        path.join(outDir, `checkpoint-bug-report-2020-01-${String(i + 1).padStart(2, "0")}-000000.zip`),
        "",
      );
    }
    await writeFile(path.join(outDir, "unrelated.zip"), "");
    const { result } = await collect();
    const names = await readdir(outDir);
    expect(names.filter((n) => n.startsWith("checkpoint-bug-report-")).length).toBe(MAX_BUNDLES_KEPT);
    expect(names).toContain(path.basename(result.path));
    expect(names).toContain("unrelated.zip");
    expect(names).not.toContain("checkpoint-bug-report-2020-01-01-000000.zip");
  });
});

describe("redactFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "chk-redact-file-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes <name>.redacted<ext> beside the input by default", async () => {
    const input = path.join(dir, "logs.txt");
    await writeFile(
      input,
      "checkpoint-app  | db postgresql://checkpoint:hunter2@postgres:5432/x\ncheckpoint-server | signing-key=abcdefabcdefabcdefabcdef\n",
    );
    const { path: out } = await redactFile(input, undefined, { homeDirs: [] });
    expect(out).toBe(path.join(dir, "logs.redacted.txt"));
    const text = await readFile(out, "utf8");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("abcdefabcdefabcdefabcdef");
    expect(text).toContain("checkpoint-app  |");
    // The input is untouched.
    expect(await readFile(input, "utf8")).toContain("hunter2");
  });

  it("adds .txt to a file with no extension", async () => {
    const input = path.join(dir, "logs");
    await writeFile(input, "x");
    expect((await redactFile(input, undefined, { homeDirs: [] })).path).toBe(
      path.join(dir, "logs.redacted.txt"),
    );
  });

  it("writes to an explicit output path", async () => {
    const input = path.join(dir, "in.log");
    const output = path.join(dir, "out.log");
    await writeFile(input, "token=abc");
    await redactFile(input, output, { homeDirs: [] });
    expect(await readFile(output, "utf8")).toBe("token=[REDACTED]");
  });

  it("refuses to overwrite the input", async () => {
    const input = path.join(dir, "in.log");
    await writeFile(input, "token=abc");
    await expect(redactFile(input, input)).rejects.toThrow(/overwrite/);
    expect(await readFile(input, "utf8")).toBe("token=abc");
  });

  it("fails on a missing input", async () => {
    await expect(redactFile(path.join(dir, "missing.log"))).rejects.toThrow();
  });
});
