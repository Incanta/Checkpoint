#!/usr/bin/env node

// Seeds the Checkpoint repo that the Horde integration job points a Horde stream at
// (.github/workflows/horde-integration.yaml).
//
// Creates the org and repo named in src/clients/horde/tests/ci/horde-data/checkpoint-ci-main.stream.json,
// registers a workspace with the running daemon, and submits a few changelists through the daemon API
// (one touching code, one touching content, one touching both), so Horde has history to ingest.
// Drives the daemon over HTTP rather than through the CLI, so the job doesn't have to build the CLI.
//
// Usage:
//   node scripts/ci/seed-horde-repo.mjs --daemon-id <id> --token <api-token>
//     [--app-url http://localhost:13000] [--daemon-url http://localhost:<port>] [--workdir <dir>]
//
// Requires the app, daemon, and server to be running, and ~/.checkpoint/auth.json to hold an entry
// for <id> (scripts/ci/dev-login.mjs writes it). With GITHUB_OUTPUT set it writes REPO_ID,
// REPO_NAME (org/repo), and HEAD_NUMBER there.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const ORG_NAME = "horde-ci-org";
const REPO_NAME = "horde-ci-repo";
const BRANCH = "main";

const { values: args } = parseArgs({
  options: {
    "daemon-id": { type: "string" },
    token: { type: "string" },
    "app-url": { type: "string", default: "http://localhost:13000" },
    "daemon-url": { type: "string" },
    workdir: { type: "string" },
  },
});

const DAEMON_ID = args["daemon-id"] ?? process.env.CHECKPOINT_TEST_DAEMON_ID;
const API_TOKEN = args.token ?? process.env.CHECKPOINT_TEST_API_TOKEN;
const APP_URL = args["app-url"].replace(/\/$/, "");

if (!DAEMON_ID || !API_TOKEN) {
  console.error(
    "--daemon-id and --token are required (or CHECKPOINT_TEST_DAEMON_ID / CHECKPOINT_TEST_API_TOKEN)",
  );
  process.exit(2);
}

// The daemon records the port it chose in ~/.checkpoint/daemon.json.
function defaultDaemonUrl() {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(
        path.join(os.homedir(), ".checkpoint", "daemon.json"),
        "utf-8",
      ),
    );
    if (typeof parsed.daemonPort === "number") {
      return `http://localhost:${parsed.daemonPort}`;
    }
  } catch {
    // fall through
  }
  return "http://localhost:13010";
}

const DAEMON_URL = (args["daemon-url"] ?? defaultDaemonUrl()).replace(
  /\/$/,
  "",
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// tRPC over HTTP with superjson: request `{ "0": { json } }`, response `[ { result: { data: { json } } } ]`.
async function trpc(
  base,
  procedure,
  input,
  { method = "GET", headers = {} } = {},
) {
  const envelope = JSON.stringify({ 0: { json: input } });
  const url =
    method === "GET"
      ? `${base}/${procedure}?batch=1&input=${encodeURIComponent(envelope)}`
      : `${base}/${procedure}?batch=1`;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: method === "GET" ? undefined : envelope,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `${procedure}: HTTP ${res.status}, non-JSON body: ${text.slice(0, 500)}`,
    );
  }
  const item = Array.isArray(body) ? body[0] : body;
  if (!res.ok || item?.error) {
    const message =
      item?.error?.json?.message ?? item?.error?.message ?? text.slice(0, 500);
    throw new Error(`${procedure}: ${message}`);
  }
  return item?.result?.data?.json;
}

const appHeaders = { Authorization: `Bearer ${API_TOKEN}` };
const app = {
  query: (proc, input) =>
    trpc(`${APP_URL}/api/trpc`, proc, input, { headers: appHeaders }),
  mutate: (proc, input) =>
    trpc(`${APP_URL}/api/trpc`, proc, input, {
      method: "POST",
      headers: appHeaders,
    }),
};
const daemon = {
  query: (proc, input) => trpc(DAEMON_URL, proc, input),
  mutate: (proc, input) => trpc(DAEMON_URL, proc, input, { method: "POST" }),
};

function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

async function submit(workspaceId, paths, message) {
  // Let the daemon see the new files before staging them.
  await daemon.query("workspaces.pending.refresh", {
    daemonId: DAEMON_ID,
    workspaceId,
  });
  await daemon.mutate("workspaces.pending.stage", {
    daemonId: DAEMON_ID,
    workspaceId,
    paths,
  });
  const { jobId } = await daemon.mutate("workspaces.pending.submit", {
    daemonId: DAEMON_ID,
    workspaceId,
    message,
    noProgress: true,
  });
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const job = await daemon.query("jobs.getStatus", { jobId });
    if (job.status === "completed") {
      console.log(`✓ submitted: ${message}`);
      return;
    }
    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(
        `submit "${message}" ${job.status}: ${job.error ?? "(no error text)"}`,
      );
    }
    await sleep(500);
  }
  throw new Error(`submit "${message}" did not finish within 5 minutes`);
}

async function main() {
  const base = fs.mkdtempSync(
    path.join(args.workdir ?? os.tmpdir(), "horde-seed-"),
  );
  const wsPath = path.join(base, "ws");
  fs.mkdirSync(wsPath, { recursive: true });
  console.log(`App: ${APP_URL}`);
  console.log(`Daemon: ${DAEMON_URL}`);
  console.log(`Workspace: ${wsPath}`);

  const org = await app.mutate("org.createOrg", { name: ORG_NAME });
  const repo = await app.mutate("repo.createRepo", {
    name: REPO_NAME,
    orgId: org.id,
  });
  if (!repo?.id) throw new Error("repo.createRepo returned no id");
  console.log(`✓ created ${ORG_NAME}/${REPO_NAME} (${repo.id})`);

  const { workspace } = await daemon.mutate("workspaces.ops.create", {
    daemonId: DAEMON_ID,
    name: "horde-seed",
    repoId: repo.id,
    path: wsPath,
    defaultBranchName: BRANCH,
  });
  if (!workspace?.id) throw new Error("workspaces.ops.create returned no id");
  console.log(`✓ registered workspace ${workspace.id}`);

  // Distinct messages so the tests can match Horde's descriptions to Checkpoint's.
  writeFiles(wsPath, {
    "Source/Game/Game.cpp": "int main() { return 0; }\n",
    "Source/Game/Game.h": "#pragma once\n",
  });
  await submit(
    workspace.id,
    ["Source/Game/Game.cpp", "Source/Game/Game.h"],
    "Horde CI: add game source",
  );

  writeFiles(wsPath, {
    "Content/Maps/Level0.umap": Buffer.from("level zero"),
  });
  await submit(
    workspace.id,
    ["Content/Maps/Level0.umap"],
    "Horde CI: add a map",
  );

  writeFiles(wsPath, {
    "Source/Game/System.cpp": "void Tick() {}\n",
    "Content/Textures/T_0.uasset": Buffer.from("texture"),
  });
  await submit(
    workspace.id,
    ["Source/Game/System.cpp", "Content/Textures/T_0.uasset"],
    "Horde CI: code and content together",
  );

  const latest = await app.query("changelist.getChangelists", {
    repoId: repo.id,
    branchName: BRANCH,
    start: { number: null, timestamp: null },
    count: 10,
  });
  const head = Math.max(...latest.map((cl) => cl.number));
  console.log(`✓ branch ${BRANCH} head is changelist ${head}`);

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `REPO_ID=${repo.id}\nREPO_NAME=${ORG_NAME}/${REPO_NAME}\nHEAD_NUMBER=${head}\n`,
    );
  }
}

main().catch((error) => {
  console.error(`✗ ${error.stack ?? error}`);
  process.exit(1);
});
