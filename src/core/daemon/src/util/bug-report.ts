import { existsSync, promises as fs } from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { format } from "date-fns";
import {
  CLIENT_VERSION,
  DAEMON_API,
  MIN_DAEMON_API,
  SERVER_API,
  Redactor,
} from "@checkpointvcs/common";
import type { DaemonConfigType } from "../daemon-config.js";
import type { Job } from "../job-manager.js";
import type { Workspace, WorkspacePendingChanges } from "../types/index.js";
import type { WorkspaceState } from "./util.js";
import { createZip, type ZipEntry } from "./zip.js";

// Builds the redacted log bundle a user attaches to a bug report: the
// daemon's logs, versions, daemon.json, and a summary of each workspace,
// zipped into one file. Every file goes through one Redactor, so an email
// address gets the same placeholder throughout. auth.json is never read into
// the bundle; its tokens are only passed in as values to scrub.

/** Raw log bytes collected at most, newest first; older logs are dropped. */
export const MAX_LOG_BYTES = 30 * 1024 * 1024;
/** Bundles kept in the output folder; older ones are deleted. */
export const MAX_BUNDLES_KEPT = 10;
/** Log lines kept per failed job. */
const JOB_LOG_LINES = 50;

export interface ClientLogFile {
  /** File name inside the bundle's client-logs/ folder. */
  name: string;
  content: string;
}

/** The parts of DaemonManager the bundle reads. */
export interface BugReportManagerView {
  workspaces: Map<string, Workspace[]>;
  workspacePendingChanges: Map<string, WorkspacePendingChanges>;
  getWorkspaceState(workspaceId: string): WorkspaceState | null;
  getSyncStatus(workspaceId: string): unknown;
  isWatching(workspaceId: string): boolean;
}

export interface BugReportOptions {
  config: DaemonConfigType;
  /** The resident daemon's log file; its archives and the ephemeral log sit beside it. */
  logFilePath: string;
  /** Folder the zip is written to. */
  outputDir: string;
  manager?: BugReportManagerView;
  jobs?: Job[];
  /** Exact values to scrub (API tokens from auth.json, env tokens). */
  secrets?: string[];
  /** Defaults to os.homedir(). */
  homeDirs?: string[];
  /** Logs the caller adds, such as the desktop app's own. */
  clientLogs?: ClientLogFile[];
  /** More JSON documents to include as status/<name>.json. */
  status?: Record<string, unknown>;
  /** Whether this is an ephemeral (CLI-spawned) daemon. */
  ephemeral?: boolean;
  /** Defaults to MAX_LOG_BYTES. */
  maxLogBytes?: number;
  now?: Date;
}

export interface BugReportResult {
  path: string;
  /** Paths of the files inside the zip. */
  files: string[];
  /** Log files that were left out or cut short to stay under MAX_LOG_BYTES. */
  truncatedLogs: string[];
}

const README = `Checkpoint bug report bundle
============================

This archive was made by "Collect logs for a bug report" (or \`chk bug-report\`)
to attach to a bug report. Look through it before you share it.

Contents
--------
README.txt              this file
versions.json           Checkpoint, daemon API, addon, Node.js, and OS versions
daemon-config.json      ~/.checkpoint/daemon.json, redacted
workspaces.json         per workspace: path, repo, branch, synced changelist,
                        whether a pull was interrupted, counts of tracked,
                        staged, and pending files, and recent pull/submit errors
jobs.json               recent daemon jobs (pulls, submits, cleans) with errors
status/                 updater and server-compatibility status
logs/                   the daemon's log files, redacted
client-logs/            the desktop app's own log, redacted (when collected
                        from the desktop app)

What is never included
----------------------
- ~/.checkpoint/auth.json, or any API or device token
- the contents of your files

What is redacted
----------------
- bearer tokens, Authorization and Cookie headers, and JWTs
- Checkpoint API tokens and any 64+ character hex string (signing keys made
  with \`openssl rand -hex 32\`), except content hashes used as file names
  such as <sha256>.lvi
- S3/R2 access keys, secret keys, and session tokens, and GitHub, Slack, and
  Stripe token formats
- passwords in URLs (user:password@host), and the query parameters token,
  key, secret, signature, sig, code, and any whose name contains one of the
  words below
- the value of any JSON, YAML, env, or command-line key whose name contains
  password, passphrase, secret, token, apiKey, accessKey, privateKey,
  signingKey, credential, authorization, cookie, signature, or sessionId
  (an empty value is kept, since "not set" is often the clue)
- PEM private keys
- email addresses, each replaced with a placeholder ([email-1], [email-2],
  and so on) that stays the same across the bundle, so people can still be
  told apart
- your OS username in home-directory paths (C:\\Users\\[user],
  /home/[user], /Users/[user])

What is kept
------------
Repo file paths and workspace-relative paths are kept, as are workspace
locations outside your home directory, server URLs, changelist numbers,
branch names, and repo and workspace ids, because those are what a bug is
debugged from. If any of them is sensitive for you, edit it out before
sharing. Hostnames and IP addresses are not redacted.
`;

function addonVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("@checkpointvcs/longtail-addon/package.json") as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    // The packaged daemon bundles the addon wrapper, so there is no
    // package.json to read; the addon ships with this daemon version.
    return `bundled with ${CLIENT_VERSION || "dev"}`;
  }
}

function versionsDoc(now: Date, ephemeral: boolean): Record<string, unknown> {
  return {
    collectedAt: now.toISOString(),
    checkpoint: CLIENT_VERSION || "dev",
    daemonApi: DAEMON_API,
    minDaemonApi: MIN_DAEMON_API,
    serverApi: SERVER_API,
    longtailAddon: addonVersion(),
    node: process.version,
    v8: process.versions.v8,
    os: {
      platform: process.platform,
      release: os.release(),
      version: typeof os.version === "function" ? os.version() : undefined,
      arch: process.arch,
      cpus: os.cpus().length,
      totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
      freeMemoryMB: Math.round(os.freemem() / 1024 / 1024),
    },
    daemon: {
      ephemeral,
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
    },
  };
}

function summarizeJob(job: Job): Record<string, unknown> {
  const failed = job.status === "failed" || job.status === "cancelled";
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    workspaceId: job.workspaceId,
    currentStep: job.currentStep,
    progress: job.progress,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    // The tail of a failed job's log is usually the most useful thing in the
    // bundle; a successful one's is noise.
    logTail: failed
      ? job.logs.slice(-JOB_LOG_LINES).map((l) => `[${l.stream}] ${l.line}`)
      : undefined,
  };
}

function summarizeState(state: WorkspaceState): Record<string, unknown> {
  const pull = state.interruptedPull;
  return {
    stateVersion: state.version ?? 1,
    changelistNumber: state.changelistNumber,
    branchHeads: state.branchHeads ?? {},
    trackedFiles: Object.keys(state.files ?? {}).length,
    artifactFiles: Object.keys(state.artifactFiles ?? {}).length,
    staged: state.staged?.length ?? 0,
    pendingRemovals: state.pendingRemovals?.length ?? 0,
    pendingDirRenames: state.pendingDirRenames?.length ?? 0,
    pendingModes: Object.keys(state.pendingModes ?? {}).length,
    interruptedPull: pull
      ? {
          changelist: pull.changelist,
          startedAt: pull.startedAt,
          restoredAt: pull.restoredAt ?? null,
          pid: pull.pid,
          backupRoot: pull.backupRoot,
          partialFiles: pull.partial?.length ?? 0,
        }
      : null,
    teamSyncConfigured: state.teamSync !== undefined,
  };
}

function summarizeWorkspaces(
  config: DaemonConfigType,
  manager: BugReportManagerView | undefined,
  jobs: Job[],
): Record<string, unknown>[] {
  // Workspaces from daemon.json, plus any the manager registered that are not
  // there (an ephemeral daemon's).
  const byId = new Map<string, Workspace>();
  for (const ws of config.workspaces ?? []) byId.set(ws.id, ws);
  for (const list of manager?.workspaces.values() ?? []) {
    for (const ws of list) if (!byId.has(ws.id)) byId.set(ws.id, ws);
  }

  return [...byId.values()].map((ws) => {
    const state = manager?.getWorkspaceState(ws.id) ?? null;
    const pending = manager?.workspacePendingChanges.get(ws.id);
    let syncStatus: unknown = null;
    try {
      syncStatus = manager?.getSyncStatus(ws.id) ?? null;
    } catch {
      // Leave it out.
    }
    const sync = syncStatus as {
      upToDate?: boolean;
      localChangelistNumber?: number;
      remoteHeadNumber?: number;
      changelistsBehind?: number;
      outdatedFiles?: unknown[];
      deletedOnRemote?: unknown[];
      newOnRemote?: unknown[];
      checkedAt?: unknown;
    } | null;
    const wsJobs = jobs.filter((j) => j.workspaceId === ws.id);

    return {
      id: ws.id,
      name: ws.name,
      repoId: ws.repoId,
      localPath: ws.localPath,
      exists: ws.localPath ? existsSync(ws.localPath) : false,
      domainBranchName: ws.domainBranchName,
      activeBranches: ws.activeBranches ?? [],
      daemonId: ws.daemonId,
      watching: manager?.isWatching(ws.id) ?? false,
      state: state
        ? summarizeState(state)
        : "not loaded by this daemon process",
      pendingChanges: pending
        ? {
            numChanges: pending.numChanges,
            unsupportedNames: pending.unsupported?.length ?? 0,
          }
        : null,
      // Counts only: the lists hold file paths, which workspaces.json does
      // not need to repeat.
      syncStatus: sync
        ? {
            upToDate: sync.upToDate,
            localChangelistNumber: sync.localChangelistNumber,
            remoteHeadNumber: sync.remoteHeadNumber,
            changelistsBehind: sync.changelistsBehind,
            outdatedFiles: sync.outdatedFiles?.length ?? 0,
            deletedOnRemote: sync.deletedOnRemote?.length ?? 0,
            newOnRemote: sync.newOnRemote?.length ?? 0,
            checkedAt: sync.checkedAt,
          }
        : null,
      recentErrors: wsJobs
        .filter((j) => j.status === "failed" && j.error)
        .slice(0, 10)
        .map((j) => ({
          type: j.type,
          at: j.updatedAt,
          error: j.error,
        })),
    };
  });
}

interface LogFile {
  name: string;
  fullPath: string;
  size: number;
  mtimeMs: number;
}

/** The resident log, its archives, and the ephemeral daemons' logs. */
async function findLogFiles(logFilePath: string): Promise<LogFile[]> {
  const dir = path.dirname(logFilePath);
  const ext = path.extname(logFilePath);
  const stem = path.basename(logFilePath, ext);
  const isLog = (name: string): boolean => {
    for (const s of [stem, `ephemeral-${stem}`]) {
      if (name === `${s}${ext}`) return true;
      if (name.startsWith(`${s}-`) && name.endsWith(ext)) return true;
    }
    return false;
  };

  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }

  const files: LogFile[] = [];
  for (const name of names.filter(isLog)) {
    const fullPath = path.join(dir, name);
    try {
      const st = await fs.stat(fullPath);
      if (st.isFile()) {
        files.push({ name, fullPath, size: st.size, mtimeMs: st.mtimeMs });
      }
    } catch {
      // Rotated away while listing.
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Reads the last `bytes` of a file, starting at a line boundary. */
async function readTail(fullPath: string, bytes: number): Promise<string> {
  const handle = await fs.open(fullPath, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline >= 0 ? text.slice(newline + 1) : "";
    }
    return text;
  } finally {
    await handle.close();
  }
}

function safeName(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/"));
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned || "log.txt";
}

async function pruneBundles(outputDir: string, keep: number): Promise<void> {
  try {
    const names = (await fs.readdir(outputDir))
      .filter(
        (n) => n.startsWith("checkpoint-bug-report-") && n.endsWith(".zip"),
      )
      .sort();
    for (const name of names.slice(0, Math.max(0, names.length - keep))) {
      await fs.rm(path.join(outputDir, name), { force: true });
    }
  } catch {
    // Nothing to prune.
  }
}

export async function collectBugReport(
  options: BugReportOptions,
): Promise<BugReportResult> {
  const now = options.now ?? new Date();
  const redactor = new Redactor({
    secrets: options.secrets ?? [],
    homeDirs: options.homeDirs ?? [os.homedir()],
  });
  const json = (value: unknown): string =>
    `${JSON.stringify(redactor.redactValue(value), null, 2)}\n`;

  const entries: ZipEntry[] = [];
  const add = (name: string, data: string): void => {
    entries.push({ name, data, modified: now });
  };

  add("README.txt", README);
  add("versions.json", json(versionsDoc(now, options.ephemeral ?? false)));
  add("daemon-config.json", json(options.config));

  const jobs = options.jobs ?? [];
  add(
    "workspaces.json",
    json(summarizeWorkspaces(options.config, options.manager, jobs)),
  );
  add("jobs.json", json(jobs.slice(0, 100).map(summarizeJob)));

  for (const [name, value] of Object.entries(options.status ?? {})) {
    add(`status/${safeName(name)}.json`, json(value));
  }

  const truncatedLogs: string[] = [];
  let budget = options.maxLogBytes ?? MAX_LOG_BYTES;
  for (const file of await findLogFiles(options.logFilePath)) {
    if (budget <= 0) {
      truncatedLogs.push(file.name);
      continue;
    }
    let text: string;
    try {
      if (file.size > budget) {
        text = await readTail(file.fullPath, budget);
        truncatedLogs.push(file.name);
      } else {
        text = await fs.readFile(file.fullPath, "utf8");
      }
    } catch {
      continue;
    }
    budget -= Math.min(file.size, budget);
    add(`logs/${file.name}`, redactor.redactLog(text));
  }

  const usedNames = new Set<string>();
  for (const log of options.clientLogs ?? []) {
    let name = safeName(log.name);
    for (let i = 2; usedNames.has(name); i++)
      name = `${i}-${safeName(log.name)}`;
    usedNames.add(name);
    add(`client-logs/${name}`, redactor.redactLog(log.content));
  }

  await fs.mkdir(options.outputDir, { recursive: true });
  const fileName = `checkpoint-bug-report-${format(now, "yyyy-MM-dd-HHmmss")}.zip`;
  const zipPath = path.join(options.outputDir, fileName);
  await fs.writeFile(zipPath, createZip(entries));
  await pruneBundles(options.outputDir, MAX_BUNDLES_KEPT);

  return {
    path: zipPath,
    files: entries.map((e) => e.name),
    truncatedLogs,
  };
}

/**
 * Redacts one file (for example `docker compose logs` output from a
 * self-hosted server) to `<name>.redacted<ext>` beside it, or `outputPath`.
 */
export async function redactFile(
  inputPath: string,
  outputPath?: string,
  options: { secrets?: string[]; homeDirs?: string[] } = {},
): Promise<{ path: string }> {
  const text = await fs.readFile(inputPath, "utf8");
  const ext = path.extname(inputPath);
  const target =
    outputPath ??
    path.join(
      path.dirname(inputPath),
      `${path.basename(inputPath, ext)}.redacted${ext || ".txt"}`,
    );
  if (path.resolve(target) === path.resolve(inputPath)) {
    throw new Error("the redacted copy cannot overwrite the input file");
  }
  const redactor = new Redactor({
    secrets: options.secrets ?? [],
    homeDirs: options.homeDirs ?? [os.homedir()],
  });
  await fs.writeFile(target, redactor.redactLog(text));
  return { path: target };
}
