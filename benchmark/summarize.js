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
const POST_PHASES = [
  ["status", "Status (clean workspace)"],
  ["pull_elsewhere", "Pull into fresh workspace"],
  ["update_submit", "Small-change submit"],
];

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

// Pull-verification table: the manifest fingerprint of each pulled tree. The
// hashes should be identical across VCS (same payload); a mismatch or a smaller
// file count/byte total flags a VCS that did not materialize the full content.
function verifyTable() {
  if (!runs.some((r) => r.verify && r.verify.pull_manifest_sha256)) return "";
  const header = ["Pulled content", ...runs.map((r) => r.vcs)];
  const sep = header.map(() => "---");
  const lines = [`| ${header.join(" | ")} |`, `| ${sep.join(" | ")} |`];
  const short = (h) => (h ? "`" + String(h).slice(0, 16) + "`" : "");
  lines.push(
    `| Manifest SHA-256 | ${runs.map((r) => short(r.verify && r.verify.pull_manifest_sha256)).join(" | ")} |`,
  );
  lines.push(
    `| Files | ${runs.map((r) => (r.verify && r.verify.pull_file_count != null ? r.verify.pull_file_count : "")).join(" | ")} |`,
  );
  lines.push(
    `| Bytes | ${runs.map((r) => fmtBytes(r.verify && r.verify.pull_bytes)).join(" | ")} |`,
  );
  let note = "";
  if (runs.length > 1) {
    const hashes = runs.map((r) => r.verify && r.verify.pull_manifest_sha256);
    const allMatch =
      hashes.every(Boolean) && hashes.every((h) => h === hashes[0]);
    note = allMatch
      ? "\n_All VCS pulled identical content (manifest hashes match)._"
      : "\n_Manifest hashes differ: the pulled content is NOT identical across VCS._";
  }
  return `### Pull verification (manifest of paths + sizes; VCS metadata excluded)\n\n${lines.join("\n")}\n${note}`;
}

// Render CPU and RAM full-submit charts for one run as Mermaid xychart-beta
// blocks, each with two line series (client = blue, server = green). The init
// directive pins those colors so the title's legend is accurate. The x-axis is
// in minutes, labeled only at whole-minute marks (blank in between). Returns ""
// if the run has no resource samples.
function resourceCharts(run) {
  const r = run.resources;
  if (!r || !Array.isArray(r.client) || !Array.isArray(r.server)) return "";
  const n = Math.min(r.client.length, r.server.length);
  if (n === 0) return "";
  const step = Number(r.interval_s) || 30;
  // One x label per sample; show the minute number only at whole-minute marks.
  // Non-mark ticks use a single space, not "": mermaid's xychart string token
  // requires at least one character, so an empty "" fails to parse on GitHub
  // ("Expecting 'STR' ... got 'COMMA'"). A space renders blank but parses.
  const xlabels = Array.from({ length: n }, (_, i) => {
    const sec = i * step;
    return sec % 60 === 0 ? `"${sec / 60}"` : '" "';
  });
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const cCpu = r.client.slice(0, n).map((s) => num(s.cpu_pct));
  const sCpu = r.server.slice(0, n).map((s) => num(s.cpu_pct));
  const cRam = r.client.slice(0, n).map((s) => num(s.ram_gb));
  const sRam = r.server.slice(0, n).map((s) => num(s.ram_gb));
  const ramMax = Math.max(1, Math.ceil(Math.max(...cRam, ...sRam)));
  const xaxis = `[${xlabels.join(", ")}]`;
  // Pin series colors: line 1 (client) blue, line 2 (server) green.
  const init =
    '%%{init: {"themeVariables": {"xyChart": {"plotColorPalette": "#1f77b4, #2ca02c"}}}}%%';

  const chart = (metric, yLabel, yMax, a, b) =>
    [
      "```mermaid",
      init,
      "xychart-beta",
      `    title "${metric} during full submit, ${run.vcs} (blue: client, green: server)"`,
      `    x-axis "time (min)" ${xaxis}`,
      `    y-axis "${yLabel}" 0 --> ${yMax}`,
      `    line [${a.join(", ")}]`,
      `    line [${b.join(", ")}]`,
      "```",
    ].join("\n");

  const cpu = chart("CPU %", "CPU %", 100, cCpu, sCpu);
  const ram = chart("RAM used GB", "GB", ramMax, cRam, sRam);
  return `#### ${run.vcs}\n\n${cpu}\n\n${ram}\n`;
}

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

const verify = verifyTable();
if (verify) {
  out.push(verify);
  out.push("");
}

const charts = runs.map(resourceCharts).filter(Boolean);
if (charts.length) {
  out.push("## Resource usage during full submit\n");
  out.push(charts.join("\n"));
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
