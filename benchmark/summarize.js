#!/usr/bin/env node
// summarize.js: render one or more timings.json files as a Markdown table.
//
// Usage: node summarize.js timings.checkpoint.json [timings.gitea.json ...]
//
// Writes Markdown to stdout, suitable for appending to $GITHUB_STEP_SUMMARY.
// Pure Node, no dependencies (matches the repo's Node-only, no-jq preference).

const fs = require("fs");

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node summarize.js <timings.json> [more.json ...]");
  process.exit(1);
}

const runs = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));

// Ordered phase rows. `null` (e.g. Checkpoint has no separate commit) renders
// as "n/a"; a missing key renders blank.
const VCS_PHASES = [
  ["add_ignore", "Add ignore file"],
  ["submit_ignore", "Submit ignore version"],
  ["add_all", "Add all files"],
  ["commit_all", "Commit all files"],
  ["submit_all", "Submit all files"],
  ["pull_elsewhere", "Pull into fresh workspace"],
];
const PAYLOAD_PHASES = [
  ["payload_download", "Download tarball"],
  ["payload_extract", "Extract tarball"],
];

function fmt(seconds) {
  if (seconds === undefined) return "";
  if (seconds === null) return "n/a";
  const s = Number(seconds);
  if (!Number.isFinite(s)) return String(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (h || m) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return `${parts.join(" ")} (${s}s)`;
}

function table(title, rows, pick) {
  const header = ["Operation", ...runs.map((r) => r.vcs)];
  const sep = header.map(() => "---");
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${sep.join(" | ")} |`,
  ];
  for (const [key, label] of rows) {
    const cells = runs.map((r) => fmt(pick(r)[key]));
    lines.push(`| ${label} | ${cells.join(" | ")} |`);
  }
  return `### ${title}\n\n${lines.join("\n")}\n`;
}

const out = [];
out.push("## VCS Benchmark Results\n");
out.push(table("Versioned operations (timed)", VCS_PHASES, (r) => r.phases || {}));
out.push("");
out.push(table("Payload preparation (untimed against the VCS)", PAYLOAD_PHASES, (r) => r.payload || {}));
out.push("");

const meta = runs[0] && runs[0].meta ? runs[0].meta : {};
out.push("### Run metadata\n");
out.push(`- Region: \`${meta.region || "?"}\``);
out.push(`- Droplet size: \`${meta.droplet_size || "?"}\``);
out.push(`- Run tag: \`${meta.run_tag || "?"}\``);
out.push(`- Recorded: \`${meta.recorded_at || "?"}\``);
out.push("");

process.stdout.write(out.join("\n"));
