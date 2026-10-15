#!/usr/bin/env node
/**
 * Turns the data-loss red team's vitest JSON report into a run summary: which
 * findings reproduce on this OS (failing tests), which protections hold up
 * (passing tests), and which tests do not apply here (skipped, because the
 * filesystem or platform does not have the behavior they cover).
 *
 * It only reports. The test step itself fails the job while any finding
 * reproduces; this runs after it either way (`if: always()`) so a red run
 * says which findings remain. It exits non-zero only when there is nothing to
 * report: no report file, no tests, or a file that errored before its tests
 * could run (an import that broke, say), so a crashed suite is called out as
 * such rather than read as findings.
 *
 * Writes markdown to $GITHUB_STEP_SUMMARY when set, and a plain summary to
 * stdout either way.
 *
 * Usage: node scripts/ci/data-loss-summary.mjs <report.json> [label]
 */
import fs from "node:fs";
import path from "node:path";

const [reportPath, label = process.platform] = process.argv.slice(2);
if (!reportPath) {
  console.error("usage: data-loss-summary.mjs <report.json> [label]");
  process.exit(2);
}

const lines = [];
const out = (line = "") => lines.push(line);
const finish = (code) => {
  const text = lines.join("\n");
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  }
  process.exit(code);
};

out(`## Data-loss red team on ${label}`);
out();

if (!fs.existsSync(reportPath)) {
  out(
    `No report at \`${reportPath}\`: the suite did not run. See the step above.`,
  );
  finish(1);
}

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const cell = (text) =>
  String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 240);
const fileOf = (name) => path.basename(name);

const byStatus = { failed: [], passed: [], skipped: [] };
const brokenFiles = [];
for (const file of report.testResults ?? []) {
  if (file.message) {
    brokenFiles.push({ file: fileOf(file.name), message: file.message });
  }
  for (const test of file.assertionResults ?? []) {
    const status =
      test.status === "pending" || test.status === "todo"
        ? "skipped"
        : test.status;
    (byStatus[status] ?? byStatus.skipped).push({
      file: fileOf(file.name),
      title: [...(test.ancestorTitles ?? []).slice(1), test.title].join(" > "),
      failure: (test.failureMessages ?? [])[0]?.split("\n")[0] ?? "",
    });
  }
}

const total =
  byStatus.failed.length + byStatus.passed.length + byStatus.skipped.length;
out(
  `Reproduced (failing): ${byStatus.failed.length}. ` +
    `Held up (passing): ${byStatus.passed.length}. ` +
    `Not applicable on this OS (skipped): ${byStatus.skipped.length}. ` +
    `Findings and fixes: \`src/tests/src/data-loss/README.md\`.`,
);
out();

if (brokenFiles.length > 0) {
  out("### Files that could not run");
  out();
  for (const broken of brokenFiles) {
    out(`- \`${broken.file}\`: ${cell(broken.message)}`);
  }
  out();
}

const table = (heading, rows, withFailure) => {
  if (rows.length === 0) return;
  out(`### ${heading}`);
  out();
  out(withFailure ? "| File | Test | Failure |" : "| File | Test |");
  out(withFailure ? "| --- | --- | --- |" : "| --- | --- |");
  for (const row of rows) {
    out(
      withFailure
        ? `| ${row.file} | ${cell(row.title)} | ${cell(row.failure)} |`
        : `| ${row.file} | ${cell(row.title)} |`,
    );
  }
  out();
};

table("Reproduced (open bugs)", byStatus.failed, true);
table(
  "Held up (controls, or fixed: move fixed tests into the main suite)",
  byStatus.passed,
  false,
);
table("Not applicable on this OS", byStatus.skipped, false);

finish(total === 0 || brokenFiles.length > 0 ? 1 : 0);
