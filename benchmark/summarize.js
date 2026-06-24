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

// Checkpoint is the comparison baseline: other columns show how Checkpoint's
// time compares per row. Undefined if this set has no checkpoint run.
const baseline = runs.find((r) => r.vcs === "checkpoint");

// Ordered phase rows. `null` (e.g. Checkpoint has no separate commit) renders
// as "n/a"; a missing key renders blank.
const SUBMIT_PHASES = [
  ["add_ignore", "Add ignore file"],
  ["submit_ignore", "Submit ignore version"],
  ["add_all", "Add all files"],
  ["commit_all", "Commit all files"],
  ["submit_all", "Submit all files"],
];
// Synthetic row: sum of the SUBMIT_PHASES above (the full write path). Rendered
// right below "Submit all files".
const TOTAL_ROW = ["__submit_total__", "Total (through submit)"];
const POST_PHASES = [["pull_elsewhere", "Pull into fresh workspace"]];

const PAYLOAD_PHASES = [
  ["payload_download", "Download tarball"],
  ["payload_extract", "Extract tarball"],
];
const STORAGE_ROWS = [
  ["update_delta_bytes", "Server storage delta (small update)"],
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

// Value for a (run, key), where the synthetic total key sums the submit phases
// (null/missing phases count as 0 so the elapsed total stays comparable).
function fmtBytes(bytes) {
  if (bytes === undefined) return "";
  if (bytes === null) return "n/a";
  const n = Number(bytes);
  if (!Number.isFinite(n)) return String(bytes);
  const neg = n < 0 ? "-" : "";
  let x = Math.abs(n);
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  const human = i === 0 ? `${x} B` : `${x.toFixed(1)} ${units[i]}`;
  return `${neg}${human} (${n} B)`;
}

function phaseValue(run, key) {
  const phases = run.phases || {};
  if (key === "__submit_total__") {
    let sum = 0;
    for (const [k] of SUBMIT_PHASES) {
      const v = phases[k];
      if (typeof v === "number" && Number.isFinite(v)) sum += v;
    }
    return sum;
  }
  return phases[key];
}

// "(N%)" comparing Checkpoint (base) to another column's value: N = how much
// faster Checkpoint was, as a percentage of the other column's time. Positive
// means Checkpoint was faster, negative means slower. Empty when either side is
// missing/non-numeric (e.g. a phase one VCS does not have).
function pctVsCheckpoint(baseVal, otherVal) {
  if (baseVal === null || baseVal === undefined) return "";
  if (otherVal === null || otherVal === undefined) return "";
  const b = Number(baseVal);
  const o = Number(otherVal);
  if (!Number.isFinite(b) || !Number.isFinite(o) || o === 0) return "";
  return ` (${Math.round(((o - b) / o) * 100)}%)`;
}

// Render the versioned-operations table: per-phase rows, the synthetic total,
// then the pull row, each non-baseline cell annotated with the percentage.
function vcsTable() {
  const header = ["Operation", ...runs.map((r) => (r === baseline ? `${r.vcs} (baseline)` : r.vcs))];
  const sep = header.map(() => "---");
  const lines = [`| ${header.join(" | ")} |`, `| ${sep.join(" | ")} |`];

  const rows = [...SUBMIT_PHASES, TOTAL_ROW, ...POST_PHASES];
  for (const [key, label] of rows) {
    const isTotal = key === "__submit_total__";
    const cells = runs.map((r) => {
      let s = fmt(phaseValue(r, key));
      if (r !== baseline && baseline) {
        s += pctVsCheckpoint(phaseValue(baseline, key), phaseValue(r, key));
      }
      return isTotal ? `**${s}**` : s;
    });
    const lbl = isTotal ? `**${label}**` : label;
    lines.push(`| ${lbl} | ${cells.join(" | ")} |`);
  }
  return `### Versioned operations (timed)\n\n${lines.join("\n")}\n`;
}

function payloadTable() {
  const header = ["Operation", ...runs.map((r) => r.vcs)];
  const sep = header.map(() => "---");
  const lines = [`| ${header.join(" | ")} |`, `| ${sep.join(" | ")} |`];
  for (const [key, label] of PAYLOAD_PHASES) {
    const cells = runs.map((r) => fmt((r.payload || {})[key]));
    lines.push(`| ${label} | ${cells.join(" | ")} |`);
  }
  return `### Payload preparation (untimed against the VCS)\n\n${lines.join("\n")}\n`;
}

// Server-side storage growth from a tiny (~100-byte) change to one file, in
// bytes, with the Checkpoint comparison. Lower is better (smaller = more
// efficient delta/dedup). Not a timing measurement.
function storageTable() {
  const header = ["Metric", ...runs.map((r) => (r === baseline ? `${r.vcs} (baseline)` : r.vcs))];
  const sep = header.map(() => "---");
  const lines = [`| ${header.join(" | ")} |`, `| ${sep.join(" | ")} |`];
  for (const [key, label] of STORAGE_ROWS) {
    const cells = runs.map((r) => {
      const v = (r.storage || {})[key];
      let s = fmtBytes(v);
      if (r !== baseline && baseline) s += pctVsCheckpoint((baseline.storage || {})[key], v);
      return s;
    });
    lines.push(`| ${label} | ${cells.join(" | ")} |`);
  }
  return `### Server storage delta (small update)\n\n${lines.join("\n")}\n`;
}

const hasStorage = runs.some((r) => r.storage && Object.keys(r.storage).length > 0);

const out = [];
out.push("## VCS Benchmark Results\n");
out.push(vcsTable());
if (baseline && runs.length > 1) {
  out.push(
    "_Percent vs Checkpoint: `(N%)` means Checkpoint was N% faster than that " +
      "column for that row (negative = slower)._",
  );
}
out.push("");
out.push(payloadTable());
out.push("");
if (hasStorage) {
  out.push(storageTable());
  if (baseline && runs.length > 1) {
    out.push(
      "_Percent vs Checkpoint: `(N%)` means Checkpoint stored N% less than that " +
        "column (negative = more)._",
    );
  }
  out.push("");
}

const meta = runs[0] && runs[0].meta ? runs[0].meta : {};
out.push("### Run metadata\n");
out.push(`- Region: \`${meta.region || "?"}\``);
out.push(`- Droplet size: \`${meta.droplet_size || "?"}\``);
out.push(`- Run tag: \`${meta.run_tag || "?"}\``);
out.push(`- Recorded: \`${meta.recorded_at || "?"}\``);
out.push("");

process.stdout.write(out.join("\n"));
