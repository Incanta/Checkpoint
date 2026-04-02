#!/usr/bin/env node

/**
 * Post-build obfuscation script.
 *
 * Scans the Next.js standalone output for .js files that contain a
 * `// @obfuscate` marker in their **source** (.ts/.tsx) counterpart,
 * then runs javascript-obfuscator on the compiled .js output.
 *
 * Usage:  node scripts/obfuscate.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const CONFIG_PATH = join(ROOT, "obfuscate.config.json");
const MARKER = "// @obfuscate";

const dryRun = process.argv.includes("--dry-run");

// Directories to scan in the build output
const SCAN_DIRS = [
  join(ROOT, ".next", "standalone"),
  join(ROOT, ".next", "server"),
];

/**
 * Collect source files (.ts, .tsx, .js, .jsx) that contain the marker.
 * Returns a Set of relative paths (from src/app root, without extension).
 */
function collectMarkedSources() {
  const marked = new Set();
  const srcDir = join(ROOT, "src");

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (entry === "node_modules" || entry === ".next") continue;
        walk(full);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
        try {
          const content = readFileSync(full, "utf8");
          if (content.includes(MARKER)) {
            // Store relative path from ROOT without extension
            const rel = full
              .slice(ROOT.length + 1)
              .replace(/\\/g, "/")
              .replace(/\.(ts|tsx|js|jsx)$/, "");
            marked.add(rel);
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walk(srcDir);
  return marked;
}

/**
 * Walk a build output directory and collect all .js files.
 */
function collectJsFiles(dir) {
  const files = [];

  function walk(d) {
    let entries;
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".js")) {
        files.push(full);
      }
    }
  }

  walk(dir);
  return files;
}

/**
 * Check if a built .js file corresponds to a marked source file.
 * We match by checking if the built file's path contains any of the
 * marked source relative paths (without extension).
 */
function shouldObfuscate(jsFilePath, markedSources) {
  const normalized = jsFilePath.replace(/\\/g, "/");
  for (const src of markedSources) {
    // The built file path often contains the source path structure
    if (normalized.includes(src.replace(/\.(ts|tsx|js|jsx)$/, ""))) {
      return true;
    }
  }

  // Also check if the .js file itself contains the marker (sometimes
  // comments survive the build, especially in server components)
  try {
    const content = readFileSync(jsFilePath, "utf8");
    if (content.includes(MARKER)) {
      return true;
    }
  } catch {
    // skip
  }

  return false;
}

async function main() {
  console.log("🔒 Obfuscation script started");
  console.log(`   Config: ${CONFIG_PATH}`);
  console.log(`   Dry run: ${dryRun}`);

  const markedSources = collectMarkedSources();
  console.log(
    `   Found ${markedSources.size} source file(s) with @obfuscate marker`,
  );

  if (markedSources.size === 0) {
    console.log("   No files marked for obfuscation. Done.");
    return;
  }

  for (const src of markedSources) {
    console.log(`     - ${src}`);
  }

  let obfuscatedCount = 0;

  for (const scanDir of SCAN_DIRS) {
    const jsFiles = collectJsFiles(scanDir);
    console.log(`\n   Scanning ${scanDir} (${jsFiles.length} .js files)`);

    for (const jsFile of jsFiles) {
      if (shouldObfuscate(jsFile, markedSources)) {
        const relPath = jsFile.slice(ROOT.length + 1);
        if (dryRun) {
          console.log(`   [DRY RUN] Would obfuscate: ${relPath}`);
        } else {
          console.log(`   Obfuscating: ${relPath}`);
          try {
            execSync(
              `npx javascript-obfuscator "${jsFile}" --output "${jsFile}" --config "${CONFIG_PATH}"`,
              { stdio: "pipe" },
            );
            obfuscatedCount++;
          } catch (err) {
            console.error(
              `   ❌ Failed to obfuscate ${relPath}: ${err.message}`,
            );
            process.exit(1);
          }
        }
      }
    }
  }

  console.log(
    `\n🔒 Obfuscation complete. ${obfuscatedCount} file(s) processed.`,
  );
}

main().catch((err) => {
  console.error("Obfuscation failed:", err);
  process.exit(1);
});
