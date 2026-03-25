#!/usr/bin/env node

// ⚠️  IMPORTANT: When modifying this workflow, also update the corresponding
// YAML test script at .github/workflows/test.yaml to keep them in sync.

/**
 * CLI Integration Test — Node.js equivalent of test.yaml
 *
 * Mirrors the GitHub Actions workflow step-by-step so the same scenarios
 * can be exercised locally without CI.  Assumes services are already
 * running (`yarn dev`) and the CLI has been built.
 *
 * Usage:
 *   node .github/workflows/test.js [--chk <path-to-chk>]
 *
 * Defaults:
 *   --chk   src/clients/cli/build/chk   (or .exe on Windows)
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";

// ── Helpers ──────────────────────────────────────────────────────

const isWin = process.platform === "win32";

function run(cmd, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  console.log(`\n  $ ${cmd}  (cwd: ${cwd})`);
  const out = execSync(cmd, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...opts.env },
    timeout: opts.timeout ?? 60_000,
  });
  const trimmed = out.trim();
  if (trimmed) console.log(trimmed);
  return trimmed;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function heading(text) {
  console.log(`\n${"═".repeat(64)}`);
  console.log(`  ${text}`);
  console.log(`${"═".repeat(64)}`);
}

function assert(condition, message) {
  if (!condition) {
    console.error(`\n✗ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`✓ OK: ${message}`);
}

async function retryFetch(url, options, { retries = 10, delay = 3000 } = {}) {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if (i === retries)
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (i === retries) throw err;
    }
    console.log(`  Retry ${i}/${retries}...`);
    await sleep(delay);
  }
}

// ── Arg parsing ──────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    chk: { type: "string", default: "" },
  },
  strict: false,
});

const defaultChk = path.resolve(
  "src/clients/cli/build",
  isWin ? "chk.exe" : "chk",
);
const CHK = args.chk || defaultChk;

if (!fs.existsSync(CHK)) {
  console.error(`CLI binary not found at ${CHK}`);
  console.error(
    "Build it first:  cd src/clients/cli && mkdir build && cd build && cmake .. && cmake --build . --parallel",
  );
  process.exit(1);
}

// ── Temp workspace directories ───────────────────────────────────

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "chk-test-"));
const WS1 = path.join(tmpBase, "workspace-1");
const WS2 = path.join(tmpBase, "workspace-2");

function cleanup() {
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch {}
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(1);
});

// ── Main ─────────────────────────────────────────────────────────

const APP_URL = "http://localhost:13000";
const DAEMON_URL = "http://localhost:13010";

async function main() {
  // ----------------------------------------------------------------
  // Wait for services
  // ----------------------------------------------------------------
  heading("Waiting for services");

  const daemonProbe = `${DAEMON_URL}/workspaces.ops.list.local?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: { daemonId: "probe" } } }))}`;

  for (const [name, url] of [
    ["App", APP_URL],
    ["Daemon", daemonProbe],
    ["Server", "http://localhost:13001"],
  ]) {
    await retryFetch(url, {}, { retries: 30, delay: 2000 });
    console.log(`  ${name} is reachable`);
  }

  // ----------------------------------------------------------------
  // Authenticate
  // ----------------------------------------------------------------
  heading("Authenticating");

  const daemonId = `test-daemon-${Date.now()}`;

  const loginRes = await retryFetch(
    `${APP_URL}/api/trpc/auth.devLogin?batch=1`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        0: {
          json: {
            email: "test@checkpoint.dev",
            deviceCode: daemonId,
            tokenName: "test-token",
          },
        },
      }),
    },
    { retries: 10, delay: 5000 },
  );

  const loginData = await loginRes.json();
  const apiToken = loginData[0]?.result?.data?.json?.apiToken;
  const userId = loginData[0]?.result?.data?.json?.user?.id;
  assert(apiToken, "Got API token");
  console.log(`  User ID: ${userId}`);

  // Write auth.json
  const checkpointDir = path.join(os.homedir(), ".checkpoint");
  fs.mkdirSync(checkpointDir, { recursive: true });
  fs.writeFileSync(
    path.join(checkpointDir, "auth.json"),
    JSON.stringify(
      {
        users: {
          [daemonId]: {
            endpoint: APP_URL,
            apiToken,
          },
        },
      },
      null,
      2,
    ),
  );

  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiToken}`,
  };

  // Warm up user.me
  await retryFetch(
    `${APP_URL}/api/trpc/user.me?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: null } }))}`,
    { headers: authHeaders },
    { retries: 10, delay: 3000 },
  );

  // ----------------------------------------------------------------
  // Create org & repo
  // ----------------------------------------------------------------
  heading("Creating org & repo");

  const uniqueSuffix = Date.now();

  const orgRes = await (
    await fetch(`${APP_URL}/api/trpc/org.createOrg?batch=1`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        0: { json: { name: `test-org-${uniqueSuffix}` } },
      }),
    })
  ).json();

  const orgId = orgRes[0]?.result?.data?.json?.id;
  assert(orgId, `Created org: ${orgId}`);

  const repoRes = await (
    await fetch(`${APP_URL}/api/trpc/repo.createRepo?batch=1`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        0: { json: { name: `test-repo-${uniqueSuffix}`, orgId } },
      }),
    })
  ).json();

  const repoId = repoRes[0]?.result?.data?.json?.id;
  assert(repoId, `Created repo: ${repoId}`);

  // ----------------------------------------------------------------
  // Create workspace 1, add files, submit
  // ----------------------------------------------------------------
  heading("Workspace 1: init, add files, submit");

  fs.mkdirSync(WS1, { recursive: true });
  run(`"${CHK}" init test-org-${uniqueSuffix}/test-repo-${uniqueSuffix}`, {
    cwd: WS1,
  });

  // Create test files
  fs.writeFileSync(path.join(WS1, "readme.txt"), "Hello from Checkpoint CI!\n");
  fs.mkdirSync(path.join(WS1, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(WS1, "src", "main.cpp"),
    "int main() { return 0; }\n",
  );
  fs.writeFileSync(path.join(WS1, "src", "notes.md"), "# Build\nrun make\n");
  console.log("  Created test files: readme.txt, src/main.cpp, src/notes.md");

  // Wait for daemon to detect
  await sleep(3000);

  run(`"${CHK}" status`, { cwd: WS1 });
  run(`"${CHK}" add readme.txt src/main.cpp src/notes.md`, { cwd: WS1 });
  run(`"${CHK}" status`, { cwd: WS1 });
  run(`"${CHK}" submit --message "Test: initial submit with 3 files"`, {
    cwd: WS1,
  });

  // ----------------------------------------------------------------
  // Verify submission via API
  // ----------------------------------------------------------------
  heading("Verifying submission via API");

  await sleep(2000);

  const clInput = encodeURIComponent(
    JSON.stringify({
      0: {
        json: {
          repoId,
          branchName: "main",
          start: { number: null, timestamp: null },
          count: 100,
        },
      },
    }),
  );

  const historyRes = await (
    await fetch(
      `${APP_URL}/api/trpc/changelist.getChangelists?batch=1&input=${clInput}`,
      { headers: authHeaders },
    )
  ).json();

  const clCount = historyRes[0]?.result?.data?.json?.length ?? 0;
  assert(clCount >= 2, `Expected ≥2 changelists, got ${clCount}`);

  // ----------------------------------------------------------------
  // Create workspace 2, pull, verify
  // ----------------------------------------------------------------
  heading("Workspace 2: init, pull, verify");

  fs.mkdirSync(WS2, { recursive: true });
  run(`"${CHK}" init test-org-${uniqueSuffix}/test-repo-${uniqueSuffix}`, {
    cwd: WS2,
  });
  run(`"${CHK}" pull`, { cwd: WS2 });

  for (const file of ["readme.txt", "src/main.cpp", "src/notes.md"]) {
    const ws1Content = fs.readFileSync(path.join(WS1, file), "utf-8");
    const ws2File = path.join(WS2, file);
    assert(fs.existsSync(ws2File), `${file} exists in workspace 2`);
    const ws2Content = fs.readFileSync(ws2File, "utf-8");
    assert(ws1Content === ws2Content, `${file} content matches`);
  }

  run(`"${CHK}" status`, { cwd: WS2 });

  // ----------------------------------------------------------------
  // Workspace 2 modifies a file, submits; workspace 1 pulls
  // ----------------------------------------------------------------
  heading("Workspace 2: checkout, modify, submit");

  run(`"${CHK}" checkout readme.txt`, { cwd: WS2 });
  fs.writeFileSync(
    path.join(WS2, "readme.txt"),
    "Hello from workspace 2 — modified!\n",
  );
  console.log("  Wrote updated readme.txt");

  await sleep(3000);

  run(`"${CHK}" add readme.txt`, { cwd: WS2 });
  run(`"${CHK}" status`, { cwd: WS2 });
  run(`"${CHK}" submit --message "Test: workspace 2 modifies readme.txt"`, {
    cwd: WS2,
  });

  heading("Workspace 1: pull modified file");

  run(`"${CHK}" pull`, { cwd: WS1 });

  const ws1Readme = fs.readFileSync(path.join(WS1, "readme.txt"), "utf-8");
  const ws2Readme = fs.readFileSync(path.join(WS2, "readme.txt"), "utf-8");
  assert(ws1Readme === ws2Readme, "readme.txt matches after round-trip modify");
  assert(
    ws1Readme.trim() === "Hello from workspace 2 — modified!",
    "readme.txt has expected content",
  );

  // ----------------------------------------------------------------
  // Done
  // ----------------------------------------------------------------
  heading("All tests passed ✓");
}

main().catch((err) => {
  console.error("\n✗ Test failed:", err);
  process.exit(1);
});
