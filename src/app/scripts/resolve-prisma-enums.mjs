/**
 * Post-build script that replaces `import("@prisma/client").$Enums.X`
 * references in generated .d.ts files with resolved string union types.
 *
 * This allows other packages (e.g. the daemon) to consume the tRPC types
 * without needing @prisma/client installed.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRISMA_SCHEMA_PATH = join(__dirname, "..", "prisma", "schema.prisma");
const DIST_DIR = join(__dirname, "..", "dist");

/**
 * Parse enum definitions from the Prisma schema file.
 * Returns a map of enum name -> array of string values.
 */
function parsePrismaEnums(schemaPath) {
  const schema = readFileSync(schemaPath, "utf-8");
  const enumRegex = /enum\s+(\w+)\s*\{([^}]+)\}/g;
  const enums = {};

  let match;
  while ((match = enumRegex.exec(schema)) !== null) {
    const name = match[1];
    const values = match[2]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("//"));
    enums[name] = values;
  }

  return enums;
}

/**
 * Recursively collect all .d.ts files under a directory.
 */
function getDtsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...getDtsFiles(fullPath));
    } else if (entry.endsWith(".d.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

// Main
const enums = parsePrismaEnums(PRISMA_SCHEMA_PATH);
console.log(
  "Parsed Prisma enums:",
  Object.entries(enums)
    .map(([k, v]) => `${k}(${v.join(", ")})`)
    .join("; "),
);

const dtsFiles = getDtsFiles(DIST_DIR);
let totalReplacements = 0;
let filesModified = 0;

for (const file of dtsFiles) {
  let content = readFileSync(file, "utf-8");
  let fileReplacements = 0;

  for (const [enumName, values] of Object.entries(enums)) {
    const pattern = `import("@prisma/client").$Enums.${enumName}`;
    if (content.includes(pattern)) {
      const union = values.map((v) => `"${v}"`).join(" | ");
      const count = content.split(pattern).length - 1;
      content = content.replaceAll(pattern, union);
      fileReplacements += count;
    }
  }

  {
    const pattern = `import("@prisma/client/runtime/library").JsonValue`;
    const count = content.split(pattern).length - 1;
    content = content.replaceAll(pattern, "any");
    fileReplacements += count;
  }

  if (fileReplacements > 0) {
    writeFileSync(file, content, "utf-8");
    const relPath = relative(DIST_DIR, file);
    console.log(`  Updated ${relPath} (${fileReplacements} replacements)`);
    totalReplacements += fileReplacements;
    filesModified++;
  }
}

console.log(
  `Resolved ${totalReplacements} import reference(s) across ${filesModified} file(s).`,
);
