#!/usr/bin/env node
// Report GitHub Actions progress for a commit, branch, or run, using a PAT.
//
// The token comes from GITHUB_TOKEN or GH_TOKEN (preferred, keeps it out of
// shell history) or --token. A fine-grained PAT needs read access to
// "Actions" and "Metadata" on the repo; a classic PAT needs `repo`.
//
// Usage:
//   node scripts/ci/ci-status.mjs                    # runs for local HEAD
//   node scripts/ci/ci-status.mjs --branch main      # latest commit on a branch
//   node scripts/ci/ci-status.mjs --sha 3d9fd73      # a specific commit (short ok)
//   node scripts/ci/ci-status.mjs --run 123456789    # one run by id
//   node scripts/ci/ci-status.mjs --watch            # poll until everything finishes
//   node scripts/ci/ci-status.mjs --logs             # tail logs of failed jobs
//   node scripts/ci/ci-status.mjs --json             # machine-readable output
//
// Options:
//   --repo owner/name   default: parsed from the `origin` remote (see --remote)
//   --remote <name>     git remote to derive the repo from (default: origin)
//   --workflow <name>   only runs whose workflow name or file matches (substring)
//   --interval <sec>    poll interval for --watch (default: 30)
//   --log-lines <n>     lines of each failed job's log to print (default: 80)
//   --steps             always list steps, not only for running/failed jobs
//
// Exit codes: 0 all runs succeeded, 1 a run failed or was cancelled,
// 2 runs still in progress (only without --watch), 3 no runs found,
// 4 usage or API error.

import { execFileSync } from "node:child_process";

const API = "https://api.github.com";

function parseArgs(argv) {
  const opts = {
    remote: "origin",
    interval: 30,
    logLines: 80,
    watch: false,
    logs: false,
    json: false,
    steps: false,
  };
  const valued = {
    "--repo": "repo",
    "--remote": "remote",
    "--branch": "branch",
    "--sha": "sha",
    "--run": "run",
    "--workflow": "workflow",
    "--token": "token",
    "--interval": "interval",
    "--log-lines": "logLines",
  };
  const flags = {
    "--watch": "watch",
    "--logs": "logs",
    "--json": "json",
    "--steps": "steps",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (flags[arg]) {
      opts[flags[arg]] = true;
    } else if (valued[arg]) {
      const value = argv[++i];
      if (value === undefined) fail(`${arg} needs a value`);
      opts[valued[arg]] = value;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  opts.interval = Number(opts.interval);
  opts.logLines = Number(opts.logLines);
  return opts;
}

// Throws rather than calling process.exit(): exiting while fetch's sockets are
// still closing trips a libuv assertion on Windows (exit 127, not ours).
function fail(message) {
  throw new Error(message);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function repoFromRemote(remote) {
  let url;
  try {
    url = git("remote", "get-url", remote);
  } catch {
    fail(`could not read git remote "${remote}"; pass --repo owner/name`);
  }
  // git@github.com:Owner/Name.git, https://github.com/Owner/Name(.git), ssh://git@github.com/Owner/Name
  const match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!match) fail(`remote "${remote}" is not a GitHub URL: ${url}`);
  return `${match[1]}/${match[2]}`;
}

function makeClient(token) {
  let rateRemaining;
  async function request(path, { raw = false } = {}) {
    const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "checkpoint-ci-status",
      },
    });
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining !== null) rateRemaining = Number(remaining);
    if (!res.ok) {
      const body = await res.text();
      let detail = body;
      try {
        detail = JSON.parse(body).message ?? body;
      } catch {}
      const err = new Error(`GitHub API ${res.status} for ${path}: ${detail}`);
      err.status = res.status;
      throw err;
    }
    return raw ? res.text() : res.json();
  }
  async function paginate(path, key) {
    const items = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; ; page++) {
      const data = await request(`${path}${sep}per_page=100&page=${page}`);
      items.push(...data[key]);
      if (data[key].length < 100 || items.length >= data.total_count) break;
    }
    return items;
  }
  return { request, paginate, rateRemaining: () => rateRemaining };
}

async function resolveSha(client, repo, opts) {
  if (opts.branch) {
    const commit = await client.request(`/repos/${repo}/commits/${encodeURIComponent(opts.branch)}`);
    return commit.sha;
  }
  let sha = opts.sha;
  if (!sha) {
    try {
      sha = git("rev-parse", "HEAD");
    } catch {
      fail("not in a git repo; pass --sha, --branch, or --run");
    }
  }
  if (sha.length < 40) {
    // The runs endpoint only matches full SHAs; let GitHub expand a short one.
    const commit = await client.request(`/repos/${repo}/commits/${sha}`);
    sha = commit.sha;
  }
  return sha;
}

async function loadRuns(client, repo, opts, sha) {
  let runs;
  if (opts.run) {
    runs = [await client.request(`/repos/${repo}/actions/runs/${opts.run}`)];
  } else {
    runs = await client.paginate(`/repos/${repo}/actions/runs?head_sha=${sha}`, "workflow_runs");
    // Re-runs keep the same id, so this only drops older runs of the same
    // workflow triggered by different events on the same commit.
    const latest = new Map();
    for (const run of runs) {
      const key = `${run.workflow_id}:${run.event}`;
      const prev = latest.get(key);
      if (!prev || new Date(run.created_at) > new Date(prev.created_at)) latest.set(key, run);
    }
    runs = [...latest.values()];
  }
  if (opts.workflow) {
    const needle = opts.workflow.toLowerCase();
    runs = runs.filter(
      (r) => r.name.toLowerCase().includes(needle) || (r.path ?? "").toLowerCase().includes(needle),
    );
  }
  runs.sort((a, b) => a.name.localeCompare(b.name));
  for (const run of runs) {
    run.jobs = await client.paginate(`/repos/${repo}/actions/runs/${run.id}/jobs`, "jobs");
  }
  return runs;
}

// Collapse a run (or job) into one of: success, failure, running, queued.
function outcome(item) {
  if (item.status !== "completed") return item.status === "in_progress" ? "running" : "queued";
  if (["success", "skipped", "neutral"].includes(item.conclusion)) return "success";
  return "failure";
}

const ICON = { success: "✔", failure: "✘", running: "●", queued: "○" };
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const COLOR = { success: 32, failure: 31, running: 33, queued: 90 };
function paint(state, text) {
  return useColor ? `\x1b[${COLOR[state]}m${text}\x1b[0m` : text;
}

function duration(start, end) {
  if (!start) return "";
  const secs = Math.max(0, Math.round(((end ? new Date(end) : new Date()) - new Date(start)) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

function label(item) {
  const state = outcome(item);
  if (item.status === "completed") return item.conclusion;
  return state === "running" ? "in progress" : item.status;
}

function printReport(repo, sha, runs, opts) {
  console.log(`${repo} @ ${sha.slice(0, 10)}  (${new Date().toLocaleTimeString()})`);
  for (const run of runs) {
    const state = outcome(run);
    const done = run.jobs.filter((j) => j.status === "completed").length;
    console.log();
    console.log(
      `${paint(state, ICON[state])} ${run.name}  ${paint(state, label(run))}  ` +
        `[${done}/${run.jobs.length} jobs, ${duration(run.run_started_at, run.status === "completed" ? run.updated_at : null)}]` +
        `${run.run_attempt > 1 ? `  attempt ${run.run_attempt}` : ""}`,
    );
    console.log(`  ${run.html_url}`);
    for (const job of run.jobs) {
      const js = outcome(job);
      console.log(
        `  ${paint(js, ICON[js])} ${job.name}  ${paint(js, label(job))}  ${duration(job.started_at, job.completed_at)}`,
      );
      const showSteps = opts.steps || js === "running" || js === "failure";
      if (!showSteps) continue;
      for (const step of job.steps ?? []) {
        const ss = outcome(step);
        if (!opts.steps && ss === "success") continue;
        if (!opts.steps && ss === "queued" && js === "failure") continue;
        console.log(`      ${paint(ss, ICON[ss])} ${step.name}  ${paint(ss, label(step))}`);
      }
    }
  }
}

async function printFailedLogs(client, repo, runs, lines) {
  for (const run of runs) {
    for (const job of run.jobs) {
      if (job.status !== "completed" || outcome(job) !== "failure") continue;
      console.log();
      console.log(paint("failure", `── ${run.name} / ${job.name}: last ${lines} log lines ──`));
      try {
        const log = await client.request(`/repos/${repo}/actions/jobs/${job.id}/logs`, { raw: true });
        const all = log.replace(/\r/g, "").split("\n");
        console.log(all.slice(-lines).join("\n"));
      } catch (err) {
        console.log(`  (could not fetch log: ${err.message})`);
      }
    }
  }
}

function summarize(runs) {
  const states = runs.map(outcome);
  if (states.includes("failure")) return "failure";
  if (states.some((s) => s === "running" || s === "queued")) return "pending";
  return "success";
}

function toJson(repo, sha, runs) {
  return {
    repo,
    sha,
    overall: summarize(runs),
    runs: runs.map((run) => ({
      id: run.id,
      name: run.name,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
      attempt: run.run_attempt,
      url: run.html_url,
      jobs: run.jobs.map((job) => ({
        id: job.id,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        url: job.html_url,
        failedSteps: (job.steps ?? [])
          .filter((s) => s.status === "completed" && outcome(s) === "failure")
          .map((s) => s.name),
        currentStep: (job.steps ?? []).find((s) => s.status === "in_progress")?.name ?? null,
      })),
    })),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL(import.meta.url), "utf8").split("\n");
    console.log(src.slice(1, src.findIndex((l) => l.startsWith("import"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    return 0;
  }
  const token = opts.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) fail("no token; set GITHUB_TOKEN or GH_TOKEN, or pass --token");

  const repo = opts.repo ?? repoFromRemote(opts.remote);
  const client = makeClient(token);
  const sha = opts.run ? null : await resolveSha(client, repo, opts);

  for (;;) {
    const runs = await loadRuns(client, repo, opts, sha);
    const headSha = sha ?? runs[0]?.head_sha ?? "";
    if (runs.length === 0) {
      if (opts.json) console.log(JSON.stringify({ repo, sha: headSha, overall: "none", runs: [] }, null, 2));
      else console.log(`No workflow runs for ${repo} @ ${headSha.slice(0, 10)}. Has the commit been pushed?`);
      if (!opts.watch) return 3;
    } else {
      const overall = summarize(runs);
      if (opts.json) {
        console.log(JSON.stringify(toJson(repo, headSha, runs), null, 2));
      } else {
        if (opts.watch && useColor) process.stdout.write("\x1b[2J\x1b[H");
        printReport(repo, headSha, runs, opts);
      }
      const finished = overall !== "pending";
      if (finished || !opts.watch) {
        if (opts.logs && !opts.json) await printFailedLogs(client, repo, runs, opts.logLines);
        const remaining = client.rateRemaining();
        if (!opts.json && remaining !== undefined && remaining < 200) {
          console.log(`\n(GitHub API rate limit: ${remaining} requests left this hour)`);
        }
        if (!opts.json) console.log(`\nOverall: ${paint(overall === "pending" ? "running" : overall, overall)}`);
        return overall === "success" ? 0 : overall === "failure" ? 1 : 2;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, opts.interval * 1000));
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`ci-status: ${err.message}`);
    process.exitCode = 4;
  },
);
