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
  ["update_large_submit", "Small-change submit (large file)"],
  ["update_small_submit", "Small-change submit (small file)"],
  // Back-compat: runs produced before the large/small split used update_submit.
  ["update_submit", "Small-change submit"],
];

const PAYLOAD_PHASES = [
  ["payload_download", "Download tarball"],
  ["payload_extract", "Extract tarball"],
];
// Friendly labels + preferred order for the storage-delta component SUFFIXES
// (the part after the update_<variant>_delta_ prefix). The first is the
// whole-data-root number (noisy: includes Docker logs, the app DB, and overlay
// churn). The rest are an optional per-component breakdown an adapter may emit
// (Checkpoint does); any suffix not listed here is still shown, appended and
// sorted, so new components need no change to this file.
const STORAGE_SUFFIX_LABELS = {
  bytes: "Server storage delta (whole Docker data-root)",
  content_store_total: "content store total (excl. logs, DB, overlay)",
  chunks: "content blocks (Longtail chunks)",
  versions: "version indexes (.lvi)",
  tree: "state-tree blocks",
  "store.lsi": "store.lsi (global store index)",
};
const STORAGE_SUFFIX_ORDER = [
  "bytes",
  "content_store_total",
  "chunks",
  "versions",
  "tree",
  "store.lsi",
];

// The small-update variants, each namespaced by a key prefix. The run harness
// measures a large-file and a small-file update; older runs used a single
// unprefixed update_delta_* set (kept for back-compat). Each present variant
// renders its own storage-delta table.
const UPDATE_VARIANTS = [
  { prefix: "update_large_delta_", title: "large file" },
  { prefix: "update_small_delta_", title: "small file" },
  { prefix: "update_delta_", title: "" },
];

// Rows for one variant: the known suffixes (in preferred order) any run has for
// this prefix, then any other suffixes present, sorted. Returns [key, label].
function storageRowsFor(prefix) {
  const present = (suffix) =>
    runs.some((r) => r.storage && prefix + suffix in r.storage);
  const seen = new Set();
  const rows = [];
  for (const suffix of STORAGE_SUFFIX_ORDER) {
    if (present(suffix)) {
      rows.push([prefix + suffix, STORAGE_SUFFIX_LABELS[suffix] || suffix]);
      seen.add(suffix);
    }
  }
  const extra = new Set();
  for (const r of runs) {
    for (const k of Object.keys(r.storage || {})) {
      if (k.startsWith(prefix)) {
        const suffix = k.slice(prefix.length);
        if (!seen.has(suffix)) extra.add(suffix);
      }
    }
  }
  for (const suffix of [...extra].sort()) {
    rows.push([prefix + suffix, STORAGE_SUFFIX_LABELS[suffix] || suffix]);
  }
  return rows;
}

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

  // Drop rows no run has at all (undefined everywhere), so the mutually
  // exclusive update variants (large/small vs the legacy update_submit) don't
  // leave always-empty rows. A `null` value (e.g. Checkpoint's commit) is a
  // real "n/a" and is kept.
  const rows = [...SUBMIT_PHASES, TOTAL_ROW, ...POST_PHASES].filter(
    ([key]) =>
      key === "__submit_total__" ||
      runs.some((r) => phaseValue(r, key) !== undefined),
  );
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
function storageTableFor(prefix, title) {
  const rows = storageRowsFor(prefix);
  if (rows.length === 0) return "";
  const header = ["Metric", ...runs.map((r) => (r === baseline ? `${r.vcs} (baseline)` : r.vcs))];
  const sep = header.map(() => "---");
  const lines = [`| ${header.join(" | ")} |`, `| ${sep.join(" | ")} |`];
  for (const [key, label] of rows) {
    const cells = runs.map((r) => {
      const v = (r.storage || {})[key];
      let s = fmtBytes(v);
      if (r !== baseline && baseline) s += pctVsCheckpoint((baseline.storage || {})[key], v);
      return s;
    });
    lines.push(`| ${label} | ${cells.join(" | ")} |`);
  }
  const heading = title
    ? `Server storage delta (${title} small update)`
    : "Server storage delta (small update)";
  return `### ${heading}\n\n${lines.join("\n")}\n`;
}

const hasStorage = runs.some((r) => r.storage && Object.keys(r.storage).length > 0);

// Per-stage breakdown of the full-tree submit (Checkpoint emits this; other
// adapters may not). Stage names are dynamic (they come from the native submit),
// so rows are ordered by the baseline's most expensive stage first to make the
// bottleneck obvious. Cells are blank for a VCS missing a given stage.
function submitStagesTable() {
  const names = new Set();
  for (const r of runs) {
    for (const k of Object.keys(r.submit_stages || {})) names.add(k);
  }
  if (names.size === 0) return "";
  const base = (baseline && baseline.submit_stages) || {};
  const order = [...names].sort(
    (a, b) => (Number(base[b]) || 0) - (Number(base[a]) || 0) || a.localeCompare(b),
  );
  const header = [
    "Submit stage",
    ...runs.map((r) => (r === baseline ? `${r.vcs} (baseline)` : r.vcs)),
  ];
  const sep = header.map(() => "---");
  const lines = [`| ${header.join(" | ")} |`, `| ${sep.join(" | ")} |`];
  for (const name of order) {
    const cells = runs.map((r) => {
      const v = (r.submit_stages || {})[name];
      return v === undefined ? "" : fmt(v);
    });
    lines.push(`| ${name} | ${cells.join(" | ")} |`);
  }
  return `### Submit stage breakdown (full tree)\n\n${lines.join("\n")}\n`;
}

const hasSubmitStages = runs.some(
  (r) => r.submit_stages && Object.keys(r.submit_stages).length > 0,
);

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
// in minutes; labeling follows the run's resources.label_every (see below).
// Returns "" if the run has no resource samples.
function resourceCharts(run) {
  const r = run.resources;
  if (!r || !Array.isArray(r.client) || !Array.isArray(r.server)) return "";
  const n = Math.min(r.client.length, r.server.length);
  if (n === 0) return "";
  const step = Number(r.interval_s) || 30;
  const labelEvery = r.label_every === "sample" ? "sample" : "minute";
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const cCpu = r.client.slice(0, n).map((s) => num(s.cpu_pct));
  const sCpu = r.server.slice(0, n).map((s) => num(s.cpu_pct));
  const cRam = r.client.slice(0, n).map((s) => num(s.ram_gb));
  const sRam = r.server.slice(0, n).map((s) => num(s.ram_gb));
  const ramMax = Math.max(1, Math.ceil(Math.max(...cRam, ...sRam)));
  // The x-axis spec depends on the label mode:
  // - "sample": a CATEGORICAL axis with one label per sample (minutes, trailing
  //   zeros trimmed). Every sample gets its own labeled tick, which is the point
  //   of this mode.
  // - "minute": a NUMERIC axis 0 --> <total minutes>. Mermaid then auto-labels
  //   at round marks and spreads the n points evenly (point i lands at
  //   i*step/60 min, its true time). A categorical axis cannot do this: it draws
  //   a tick per entry, so blank in-between labels still render as stray points.
  let xaxis;
  if (labelEvery === "sample") {
    const xlabels = Array.from(
      { length: n },
      (_, i) => `"${parseFloat(((i * step) / 60).toFixed(2))}"`,
    );
    xaxis = `[${xlabels.join(", ")}]`;
  } else {
    const maxMin = parseFloat((((n - 1) * step) / 60).toFixed(2)) ||
      parseFloat((step / 60).toFixed(2));
    xaxis = `0 --> ${maxMin}`;
  }
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

// Fixed per-VCS colors for the combined (one-series-per-VCS) charts, each with
// an emoji dot so the legend is readable in Markdown (mermaid xychart has no
// built-in legend). A VCS not listed here falls back to COMBINED_PALETTE below,
// assigned in run order.
const VCS_COLORS = {
  lore: { hex: "#2ca02c", dot: "🟢" }, // green
  checkpoint: { hex: "#9467bd", dot: "🟣" }, // purple
  ark: { hex: "#8c564b", dot: "🟤" }, // brown
  perforce: { hex: "#1f77b4", dot: "🔵" }, // blue
  gitea: { hex: "#f1c40f", dot: "🟡" }, // yellow
};
const COMBINED_PALETTE = [
  { hex: "#ff7f0e", dot: "🟠" }, // orange
  { hex: "#d62728", dot: "🔴" }, // red
  { hex: "#17becf", dot: "🩵" }, // cyan
  { hex: "#e377c2", dot: "🩷" }, // pink
];

// Linearly resample `values` (samples evenly spaced in time across the whole
// full-submit window) onto a grid of `g` points spanning 0%..100% of that
// window. This normalizes runs of different durations onto a common x-axis where
// the last point is "task complete". n==1 -> flat; n==0 -> [].
function resampleSeries(values, g) {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return Array.from({ length: g }, () => values[0]);
  const out = [];
  for (let i = 0; i < g; i++) {
    const f = (i / (g - 1)) * (n - 1); // fractional source index
    const lo = Math.floor(f);
    const hi = Math.ceil(f);
    out.push(values[lo] + (values[hi] - values[lo]) * (f - lo));
  }
  return out;
}

// Four combined charts (client CPU, client RAM, server CPU, server RAM), each
// overlaying one line per VCS against "% of task complete" so durations align.
// Returns "" unless at least two runs have resource samples (it is a comparison
// view; single runs are already covered by the per-VCS charts above).
function combinedResourceCharts(runs) {
  const withRes = runs.filter((r) => {
    const x = r.resources;
    return (
      x &&
      Array.isArray(x.client) &&
      Array.isArray(x.server) &&
      Math.min(x.client.length, x.server.length) > 0
    );
  });
  if (withRes.length < 2) return "";

  const G = 21; // 0%, 5%, ... 100%
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  let fb = 0;
  const palette = withRes.map(
    (r) => VCS_COLORS[r.vcs] || COMBINED_PALETTE[fb++ % COMBINED_PALETTE.length],
  );
  const init =
    '%%{init: {"themeVariables": {"xyChart": {"plotColorPalette": "' +
    palette.map((p) => p.hex).join(", ") +
    '"}}}}%%';
  const legend = withRes.map((r, i) => `${palette[i].dot} ${r.vcs}`).join(", ");

  const metrics = [
    { title: "Client CPU %", side: "client", field: "cpu_pct", unit: "CPU %", max: 100 },
    { title: "Client RAM GB", side: "client", field: "ram_gb", unit: "GB", max: null },
    { title: "Server CPU %", side: "server", field: "cpu_pct", unit: "CPU %", max: 100 },
    { title: "Server RAM GB", side: "server", field: "ram_gb", unit: "GB", max: null },
  ];

  const blocks = metrics.map((m) => {
    const series = withRes.map((r) => {
      const n = Math.min(r.resources.client.length, r.resources.server.length);
      const vals = r.resources[m.side].slice(0, n).map((s) => num(s[m.field]));
      return resampleSeries(vals, G);
    });
    let yMax = m.max;
    if (yMax == null) yMax = Math.max(1, Math.ceil(Math.max(...series.flat())));
    const lines = series
      .map((s) => `    line [${s.map((v) => parseFloat(v.toFixed(2))).join(", ")}]`)
      .join("\n");
    return [
      "```mermaid",
      init,
      "xychart-beta",
      `    title "${m.title} vs % of task complete (all VCS)"`,
      '    x-axis "% of task complete" 0 --> 100',
      `    y-axis "${m.unit}" 0 --> ${yMax}`,
      lines,
      "```",
    ].join("\n");
  });

  return (
    "## Resource usage, normalized by task progress (all VCS)\n\n" +
    `_Series: ${legend}. The x-axis is the percentage of each VCS's full-submit ` +
    "elapsed time (100% = submit complete), so runs of different durations line " +
    "up for comparison._\n\n" +
    blocks.join("\n\n") +
    "\n"
  );
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
  for (const { prefix, title } of UPDATE_VARIANTS) {
    const table = storageTableFor(prefix, title);
    if (!table) continue;
    out.push(table);
    if (baseline && runs.length > 1) {
      out.push(
        "_Percent vs Checkpoint: `(N%)` means Checkpoint stored N% less than that " +
          "column (negative = more)._",
      );
    }
    out.push("");
  }
}

if (hasSubmitStages) {
  out.push(submitStagesTable());
  out.push(
    "_Per-stage wall-clock of the native full-tree submit (where its time goes: " +
      "indexing/hashing vs writing+compressing+uploading blocks vs finalizing). " +
      "Pair with the resource charts to tell CPU-bound from I/O/network-bound._",
  );
  out.push("");
}

const verify = verifyTable();
if (verify) {
  out.push(verify);
  out.push("");
}

const combined = combinedResourceCharts(runs);
if (combined) {
  out.push(combined);
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
