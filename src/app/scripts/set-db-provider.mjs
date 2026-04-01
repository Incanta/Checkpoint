/**
 * Generates prisma/datasource.prisma and swaps the active migrations
 * directory based on the DB_PROVIDER environment variable.
 * Defaults to "sqlite" when not set.
 *
 * This keeps prisma/migrations/ as a junction/symlink (gitignored)
 * pointing to the provider-specific directory:
 *   prisma/migrations-sqlite/       (version-controlled)
 *   prisma/migrations-postgresql/   (version-controlled)
 *   prisma/migrations/              (junction/symlink, gitignored)
 *
 * Usage:
 *   DB_PROVIDER=postgresql node scripts/set-db-provider.mjs
 *   node scripts/set-db-provider.mjs            # defaults to sqlite
 */

import { readFileSync, writeFileSync, rmSync, symlinkSync, lstatSync, readlinkSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRISMA_DIR = join(__dirname, "..", "prisma");
const DATASOURCE_PATH = join(PRISMA_DIR, "datasource.prisma");
const MIGRATIONS_LINK = join(PRISMA_DIR, "migrations");

const VALID_PROVIDERS = ["sqlite", "postgresql"];
const provider = process.env.DB_PROVIDER || "sqlite";

if (!VALID_PROVIDERS.includes(provider)) {
  console.error(
    `Invalid DB_PROVIDER: "${provider}". Must be one of: ${VALID_PROVIDERS.join(", ")}`
  );
  process.exit(1);
}

// --- Generate datasource.prisma ---

const content = `// AUTO-GENERATED — do not edit. Controlled by DB_PROVIDER config.
// Regenerate with: npm run db:set-provider

datasource db {
  provider = "${provider}"
  url      = env("DATABASE_URL")
}
`;

let existing = "";
try {
  existing = readFileSync(DATASOURCE_PATH, "utf-8");
} catch {
  // File doesn't exist yet
}

if (existing !== content) {
  writeFileSync(DATASOURCE_PATH, content);
  console.log(`Generated prisma/datasource.prisma (provider: "${provider}")`);
} else {
  console.log(`prisma/datasource.prisma already up to date (provider: "${provider}")`);
}

// --- Swap migrations directory ---

const targetDir = resolve(PRISMA_DIR, `migrations-${provider}`);

/**
 * Check if the current link/junction already points to the right target.
 */
function isAlreadyLinked() {
  try {
    const stat = lstatSync(MIGRATIONS_LINK);
    if (stat.isSymbolicLink()) {
      const dest = resolve(PRISMA_DIR, readlinkSync(MIGRATIONS_LINK));
      return dest === targetDir;
    }
  } catch {
    // Doesn't exist
  }
  return false;
}

if (isAlreadyLinked()) {
  console.log(`prisma/migrations/ already linked to migrations-${provider}/`);
} else {
  // Remove existing link/directory
  try {
    rmSync(MIGRATIONS_LINK, { recursive: true, force: true });
  } catch {
    // Nothing to remove
  }

  // Create junction on Windows, symlink elsewhere
  const isWindows = process.platform === "win32";
  if (isWindows) {
    // Directory junctions don't require admin privileges on Windows
    execSync(`mklink /J "${MIGRATIONS_LINK}" "${targetDir}"`, { stdio: "pipe", shell: "cmd.exe" });
  } else {
    symlinkSync(targetDir, MIGRATIONS_LINK, "dir");
  }

  console.log(`Linked prisma/migrations/ -> migrations-${provider}/`);
}
