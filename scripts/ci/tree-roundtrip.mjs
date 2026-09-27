#!/usr/bin/env node

// Realistic-tree round trip driven through the daemon API.
//
// The CLI flow in .github/workflows/test.yaml stages three hand-picked files
// and compares those same three after a pull. That never exercises what a real
// project's first commit looks like: hundreds of files, nested directories,
// the same filename in several directories, an empty file, a file larger than
// a block, and a selection that names whole directories (which the desktop
// client does) rather than individual files. Commit 708b223 shipped a
// silent-data-loss bug through exactly that gap.
//
// This script:
//   1. seeds a project tree into a fresh directory, then `chk init`s it there
//      (the "init commit of an existing project" case);
//   2. stages, through the daemon API, the top-level directory entries plus
//      some explicit children under them and a repeated path, and submits;
//   3. checks the changelist server-side (unique paths, exactly the seeded set);
//   4. pulls into a second workspace and compares the whole tree by hash,
//      failing loudly on any file that was non-empty at the source but came
//      back empty;
//   5. edits, deletes, and adds from the second workspace, submits, pulls back
//      into the first, and compares again.
//
// It talks to the daemon and the app over their tRPC HTTP endpoints so the
// staged set is exactly what the script says, independent of any client's
// expansion logic. Directory expansion and dedupe happen in the daemon,
// which is the code under test.
//
// Usage:
//   node scripts/ci/tree-roundtrip.mjs --chk <path-to-chk> --daemon-id <id> --token <api-token>
//     [--app-url http://localhost:13000] [--daemon-url http://localhost:<port>]
//     [--workdir <dir>] [--keep]
//
// Requires the app, daemon, and server to be running, and ~/.checkpoint/auth.json
// to hold an entry for <id> (the CLI reads it for `chk init`).

import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

// ── Arguments ─────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    chk: { type: "string" },
    "daemon-id": { type: "string" },
    token: { type: "string" },
    "app-url": { type: "string", default: "http://localhost:13000" },
    "daemon-url": { type: "string" },
    workdir: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});

const CHK = args.chk;
const DAEMON_ID = args["daemon-id"] ?? process.env.CHECKPOINT_TEST_DAEMON_ID;
const API_TOKEN = args.token ?? process.env.CHECKPOINT_TEST_API_TOKEN;
const APP_URL = args["app-url"].replace(/\/$/, "");

if (!CHK || !fs.existsSync(CHK)) {
  console.error(`--chk must point at the built CLI (got: ${CHK ?? "nothing"})`);
  process.exit(2);
}
if (!DAEMON_ID || !API_TOKEN) {
  console.error(
    "--daemon-id and --token are required (or CHECKPOINT_TEST_DAEMON_ID / CHECKPOINT_TEST_API_TOKEN)",
  );
  process.exit(2);
}

// The daemon may shift its port if the default is taken; it records the port
// it chose in ~/.checkpoint/daemon.json.
function defaultDaemonUrl() {
  const daemonJson = path.join(os.homedir(), ".checkpoint", "daemon.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(daemonJson, "utf-8"));
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

// ── Helpers ───────────────────────────────────────────────────────

let failures = 0;

function heading(text) {
  console.log(`\n${"═".repeat(64)}\n  ${text}\n${"═".repeat(64)}`);
}

function ok(message) {
  console.log(`✓ ${message}`);
}

function fail(message) {
  failures++;
  console.error(`✗ FAIL: ${message}`);
}

function must(condition, message) {
  if (!condition) {
    fail(message);
    throw new Error(message);
  }
  ok(message);
}

function run(cmd, cwd) {
  console.log(`\n  $ ${cmd}  (cwd: ${cwd})`);
  const out = execSync(cmd, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10 * 60_000,
  });
  const trimmed = out.trim();
  if (trimmed) console.log(trimmed);
  return trimmed;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// tRPC over HTTP with the superjson transformer both services use. Batched
// envelope: request `{ "0": { json } }`, response `[ { result: { data: { json } } } ]`.
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

// Mirrors the daemon's FileType / FileStatus enums (src/core/daemon/src/types).
const FileType = { Directory: 1 };
const FileStatus = { Local: 2, Added: 3, Deleted: 5 };

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Every regular file under root (except .checkpoint), keyed by forward-slash relative path. */
function walkTree(root) {
  const out = new Map();
  const recurse = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".checkpoint") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        recurse(full);
      } else if (entry.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join("/");
        out.set(rel, {
          size: fs.statSync(full).size,
          sha256: sha256File(full),
        });
      }
    }
  };
  recurse(root);
  return out;
}

/**
 * Compares two trees file by file. A file that was non-empty at the source
 * and is empty at the destination is reported separately because that is the
 * exact shape of the bug this scenario exists to catch.
 */
function compareTrees(label, source, dest) {
  const missing = [];
  const emptied = [];
  const mismatched = [];
  for (const [rel, s] of source) {
    const d = dest.get(rel);
    if (!d) {
      missing.push(rel);
    } else if (s.size > 0 && d.size === 0) {
      emptied.push(rel);
    } else if (s.sha256 !== d.sha256) {
      mismatched.push(`${rel} (${s.size} bytes vs ${d.size} bytes)`);
    }
  }
  const extra = [...dest.keys()].filter((rel) => !source.has(rel));

  const report = (name, list) => {
    if (list.length === 0) return;
    fail(`${label}: ${list.length} ${name}`);
    for (const item of list.slice(0, 25)) console.error(`    ${item}`);
    if (list.length > 25) console.error(`    ... and ${list.length - 25} more`);
  };
  report("file(s) missing at the destination", missing);
  report("file(s) came back EMPTY although the source was not", emptied);
  report("file(s) differ in content", mismatched);
  report("unexpected extra file(s) at the destination", extra);

  const clean =
    missing.length + emptied.length + mismatched.length + extra.length === 0;
  if (clean) ok(`${label}: ${source.size} files identical by sha256`);
  return clean;
}

// ── Tree seeding ──────────────────────────────────────────────────

/**
 * A project tree with the shapes that have bitten real submits: several
 * directory levels, the same filename in several directories, an empty file,
 * unicode and spaces in names, a file larger than a longtail block (8 MiB
 * default), and enough files that the batched directory scan matters.
 */
function seedTree(root) {
  const files = new Map();
  const add = (rel, content) => {
    files.set(
      rel,
      typeof content === "string" ? Buffer.from(content, "utf8") : content,
    );
  };
  const ini = (section, n) =>
    `[${section}]\n${Array.from({ length: n }, (_, i) => `Key${i}=Value${i}`).join("\n")}\n`;
  const cpp = (name) =>
    `#include "${name}.h"\n\nvoid ${name}::Tick(float DeltaSeconds) {\n  Elapsed += DeltaSeconds;\n}\n`;
  const header = (name) =>
    `#pragma once\n\nclass ${name} {\npublic:\n  void Tick(float DeltaSeconds);\nprivate:\n  float Elapsed = 0.f;\n};\n`;

  add(
    "Game.uproject",
    JSON.stringify({ FileVersion: 3, Modules: [{ Name: "Game" }] }, null, 2),
  );
  add("README.md", "# Game\n\nRoot readme.\n");

  add("Config/DefaultEngine.ini", ini("/Script/Engine.Engine", 40));
  add(
    "Config/DefaultGame.ini",
    ini("/Script/EngineSettings.GeneralProjectSettings", 12),
  );
  add(
    "Config/Windows/WindowsEngine.ini",
    ini("/Script/WindowsTargetPlatform", 6),
  );
  add("Config/README.md", "# Config\n");

  add("Source/Game.Target.cs", "public class GameTarget : TargetRules { }\n");
  add(
    "Source/GameEditor.Target.cs",
    "public class GameEditorTarget : TargetRules { }\n",
  );
  add("Source/README.md", "# Source\n");
  add("Source/Game/Game.Build.cs", "public class Game : ModuleRules { }\n");
  add("Source/Game/Game.cpp", cpp("Game"));
  add("Source/Game/Game.h", header("Game"));
  add(
    "Source/GameEditor/GameEditor.Build.cs",
    "public class GameEditor : ModuleRules { }\n",
  );
  add("Source/GameEditor/Game.cpp", cpp("GameEditorShim"));
  add("Source/GameEditor/Game.h", header("GameEditorShim"));
  for (let i = 0; i < 80; i++) {
    add(`Source/Game/Private/Systems/System${i}.cpp`, cpp(`System${i}`));
    add(`Source/Game/Public/Systems/System${i}.h`, header(`System${i}`));
  }
  add("Source/Game/Private/Deep/A/B/C/D/Leaf.cpp", cpp("Leaf"));

  add("Content/README.md", "# Content\n");
  add("Content/Empty.txt", Buffer.alloc(0));
  add("Content/Art/Näme with spaces.png", randomBytes(3_000));
  add("Content/Art/日本語.txt", "日本語のテキスト\n");
  for (let i = 0; i < 60; i++) {
    add(`Content/Maps/Level${i}.umap`, randomBytes(2_000 + i * 600));
    add(`Content/Blueprints/BP_Actor${i}.uasset`, randomBytes(1_000 + i * 300));
    add(`Content/Textures/T_${i}.uasset`, randomBytes(4_000 + i * 100));
  }
  // Larger than the default 8 MiB target block so the content spans blocks.
  add("Content/Movies/Intro.bin", randomBytes(12 * 1024 * 1024));

  add(
    "Plugins/MyPlugin/MyPlugin.uplugin",
    JSON.stringify({ FileVersion: 3 }, null, 2),
  );
  add("Plugins/MyPlugin/README.md", "# MyPlugin\n");
  add(
    "Plugins/MyPlugin/Config/DefaultMyPlugin.ini",
    ini("/Script/MyPlugin", 3),
  );
  add(
    "Plugins/MyPlugin/Source/MyPlugin/MyPlugin.Build.cs",
    "public class MyPlugin : ModuleRules { }\n",
  );
  add("Plugins/MyPlugin/Source/MyPlugin/Private/MyPlugin.cpp", cpp("MyPlugin"));
  add("Plugins/MyPlugin/Source/MyPlugin/Public/MyPlugin.h", header("MyPlugin"));
  add("Plugins/MyPlugin/Content/README.md", "# MyPlugin content\n");

  for (const [rel, content] of files) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return files;
}

// ── Daemon helpers ────────────────────────────────────────────────

function readWorkspaceJson(root) {
  const file = path.join(root, ".checkpoint", "workspace.json");
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

async function refresh(ws) {
  const pending = await daemon.query("workspaces.pending.refresh", {
    daemonId: DAEMON_ID,
    workspaceId: ws.id,
  });
  if (!pending)
    throw new Error(
      "pending.refresh returned nothing (workspace not registered?)",
    );
  return pending;
}

async function stage(ws, paths) {
  await daemon.mutate("workspaces.pending.stage", {
    daemonId: DAEMON_ID,
    workspaceId: ws.id,
    paths,
  });
}

async function submit(ws, message) {
  const { jobId } = await daemon.mutate("workspaces.pending.submit", {
    daemonId: DAEMON_ID,
    workspaceId: ws.id,
    message,
    noProgress: true,
  });
  console.log(`  submit job ${jobId}`);
  const deadline = Date.now() + 10 * 60_000;
  let lastStep = "";
  while (Date.now() < deadline) {
    const job = await daemon.query("jobs.getStatus", { jobId });
    if (job.step && job.step !== lastStep) {
      lastStep = job.step;
      console.log(`  step: ${lastStep}`);
    }
    if (job.status === "completed") return;
    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(
        `submit job ${job.status}: ${job.error ?? "(no error text)"}`,
      );
    }
    await sleep(500);
  }
  throw new Error("submit job did not finish within 10 minutes");
}

async function headChangelist(repoId) {
  const list = await app.query("changelist.getChangelists", {
    repoId,
    branchName: "main",
    start: { number: null, timestamp: null },
    count: 20,
  });
  return Math.max(...list.map((cl) => cl.number));
}

async function changelistFiles(repoId, number) {
  return app.query("changelist.getChangelistFiles", {
    repoId,
    changelistNumber: number,
  });
}

/** Asserts a changelist carries exactly `expectedPaths`, once each, all as MODIFY. */
async function verifyChangelist(repoId, number, expectedPaths, label) {
  const files = await changelistFiles(repoId, number);
  const paths = files.map((f) => f.path);
  const unique = new Set(paths);
  must(
    unique.size === paths.length,
    `${label}: changelist ${number} has no duplicate paths`,
  );
  const expected = new Set(expectedPaths);
  const missing = [...expected].filter((p) => !unique.has(p));
  const extra = [...unique].filter((p) => !expected.has(p));
  if (missing.length)
    console.error(`    missing: ${missing.slice(0, 20).join(", ")}`);
  if (extra.length)
    console.error(`    extra: ${extra.slice(0, 20).join(", ")}`);
  must(
    missing.length === 0 && extra.length === 0,
    `${label}: changelist ${number} lists exactly the ${expected.size} expected paths`,
  );
  const deletes = files.filter(
    (f) => String(f.changeType).toUpperCase() === "DELETE",
  );
  must(deletes.length === 0, `${label}: changelist ${number} has no deletes`);
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const base = args.workdir
    ? fs.mkdtempSync(path.join(args.workdir, "tree-roundtrip-"))
    : fs.mkdtempSync(path.join(os.tmpdir(), "tree-roundtrip-"));
  const WS_A = path.join(base, "a");
  const WS_B = path.join(base, "b");
  if (!args.keep) {
    process.on("exit", () => {
      try {
        fs.rmSync(base, { recursive: true, force: true });
      } catch {
        // best effort
      }
    });
  }
  console.log(`Working under ${base}`);
  console.log(`App: ${APP_URL}`);
  console.log(`Daemon: ${DAEMON_URL}`);

  // Own org + repo so the first submit is changelist 1 and nothing else in the
  // CI run can interleave with these paths.
  heading("Creating org & repo");
  const suffix = `${Date.now()}`;
  const orgName = `tree-org-${suffix}`;
  const repoName = `tree-repo-${suffix}`;
  const org = await app.mutate("org.createOrg", { name: orgName });
  const repo = await app.mutate("repo.createRepo", {
    name: repoName,
    orgId: org.id,
  });
  must(Boolean(repo?.id), `created ${orgName}/${repoName}`);

  // ── Phase 1: init an existing tree, stage dirs + children, submit ──
  heading("Workspace A: seed tree, init, stage through the daemon API, submit");
  fs.mkdirSync(WS_A, { recursive: true });
  const seeded = seedTree(WS_A);
  console.log(`  seeded ${seeded.size} files`);
  run(`"${CHK}" init ${orgName}/${repoName}`, WS_A);
  const wsA = readWorkspaceJson(WS_A);
  console.log(`  workspace A id: ${wsA.id}`);

  const pendingA = await refresh(wsA);
  const topLevel = Object.values(pendingA.files).filter(
    (f) => !f.path.includes("/"),
  );
  const topDirs = topLevel
    .filter((f) => f.type === FileType.Directory)
    .map((f) => f.path);
  const topFiles = topLevel
    .filter((f) => f.type !== FileType.Directory)
    .map((f) => f.path);
  console.log(`  top-level directories: ${topDirs.join(", ")}`);
  console.log(`  top-level files: ${topFiles.join(", ")}`);
  must(
    ["Config", "Content", "Plugins", "Source"].every((d) =>
      topDirs.includes(d),
    ),
    "daemon reports each top-level untracked directory as one entry",
  );
  must(
    ["Game.uproject", "README.md"].every((f) => topFiles.includes(f)),
    "daemon reports the top-level files individually",
  );

  // What a "select everything" in the desktop client hands over: the
  // directory entries and the loose files. On top of that, name files under
  // those directories explicitly, and name one directory twice, so the same
  // path reaches the daemon in more than one form. The daemon must hand the
  // native submit each file exactly once whatever it was given.
  const explicitChildren = [
    "Source/Game.Target.cs",
    "Source/GameEditor.Target.cs",
    "Config/DefaultEngine.ini",
    "Content/Empty.txt",
    "Content/Movies/Intro.bin",
  ];
  const stagedA = [
    ...topDirs,
    ...topFiles,
    ...explicitChildren,
    "Source",
    "Content/Empty.txt",
  ];
  await stage(wsA, stagedA);
  ok(
    `staged ${stagedA.length} entries (${topDirs.length} directories, with repeats)`,
  );

  await submit(wsA, "tree round trip: initial import");
  const cl1 = await headChangelist(repo.id);
  must(cl1 === 1, `first submit produced changelist 1 (got ${cl1})`);
  await verifyChangelist(repo.id, cl1, [...seeded.keys()], "initial import");

  // ── Phase 2: pull into B and compare the whole tree ──
  heading("Workspace B: init, pull, compare whole tree");
  fs.mkdirSync(WS_B, { recursive: true });
  run(`"${CHK}" init ${orgName}/${repoName}`, WS_B);
  const wsB = readWorkspaceJson(WS_B);
  run(`"${CHK}" pull`, WS_B);
  const treeA1 = walkTree(WS_A);
  const treeB1 = walkTree(WS_B);
  must(
    treeA1.size === seeded.size,
    `workspace A still has all ${seeded.size} seeded files`,
  );
  if (!compareTrees("after initial pull", treeA1, treeB1)) {
    throw new Error("tree mismatch after initial pull");
  }

  // ── Phase 3: edit, delete, add from B; pull into A ──
  heading("Workspace B: modify, delete, add; submit; pull into A");
  const modified = [
    "README.md",
    "Source/Game/Game.cpp",
    "Content/Maps/Level0.umap",
  ];
  const deleted = "Content/Blueprints/BP_Actor1.uasset";
  const added = "Source/Game/Private/Systems/NewSystem.cpp";

  for (const rel of modified) {
    run(`"${CHK}" checkout ${rel}`, WS_B);
  }
  fs.writeFileSync(
    path.join(WS_B, "README.md"),
    "# Game\n\nEdited from workspace B.\n",
  );
  fs.appendFileSync(
    path.join(WS_B, "Source/Game/Game.cpp"),
    "\n// edited from B\n",
  );
  fs.writeFileSync(
    path.join(WS_B, "Content/Maps/Level0.umap"),
    randomBytes(9_000),
  );
  fs.rmSync(path.join(WS_B, deleted));
  fs.writeFileSync(path.join(WS_B, added), "// new file from B\n");

  // Give the watcher a moment, then refresh; a refresh always reflects the disk.
  await sleep(3_000);
  const pendingB = await refresh(wsB);
  const deletedEntry = pendingB.files[deleted];
  must(
    deletedEntry && deletedEntry.status === FileStatus.Deleted,
    `daemon reports ${deleted} as deleted`,
  );
  must(Boolean(pendingB.files[added]), `daemon reports ${added} as pending`);
  for (const rel of modified) {
    must(Boolean(pendingB.files[rel]), `daemon reports ${rel} as pending`);
  }

  await stage(wsB, [...modified, deleted, added]);
  await submit(wsB, "tree round trip: edit, delete, add");
  const cl2 = await headChangelist(repo.id);
  must(cl2 === 2, `second submit produced changelist 2 (got ${cl2})`);
  const files2 = await changelistFiles(repo.id, cl2);
  const paths2 = files2.map((f) => f.path).sort();
  const expected2 = [...modified, deleted, added].sort();
  must(
    JSON.stringify(paths2) === JSON.stringify(expected2),
    `changelist 2 lists exactly the edited, deleted, and added paths`,
  );
  const deleteRows = files2.filter(
    (f) => String(f.changeType).toUpperCase() === "DELETE",
  );
  must(
    deleteRows.length === 1 && deleteRows[0].path === deleted,
    `changelist 2 records ${deleted} as a delete`,
  );

  run(`"${CHK}" pull`, WS_A);
  const treeA2 = walkTree(WS_A);
  const treeB2 = walkTree(WS_B);
  must(
    !treeA2.has(deleted),
    `${deleted} is gone from workspace A after the pull`,
  );
  must(treeA2.has(added), `${added} arrived in workspace A after the pull`);
  if (!compareTrees("after edit/delete/add round trip", treeB2, treeA2)) {
    throw new Error("tree mismatch after second round trip");
  }

  heading("Tree round trip passed");
}

main().catch((err) => {
  console.error(`\n✗ Tree round trip failed: ${err?.message ?? err}`);
  process.exit(1);
});
