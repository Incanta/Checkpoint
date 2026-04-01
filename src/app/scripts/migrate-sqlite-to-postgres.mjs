#!/usr/bin/env node

/**
 * Migrates data from a SQLite database to PostgreSQL.
 *
 * Prerequisites:
 *   npm install better-sqlite3 pg
 *
 * Before running, ensure the Postgres database has the schema applied:
 *   1. Update config/default/db.yaml with provider: "postgresql" and the Postgres URL
 *   2. Run: npm run db:push   (applies the schema to Postgres)
 *   3. Run: node scripts/migrate-sqlite-to-postgres.mjs <sqlite-path> [postgres-url]
 *
 * Usage:
 *   node scripts/migrate-sqlite-to-postgres.mjs ./prisma/db.sqlite postgresql://user:pass@host:5432/dbname
 *   node scripts/migrate-sqlite-to-postgres.mjs ./prisma/db.sqlite  # reads POSTGRES_URL or DATABASE_URL from env
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "..", "prisma", "schema.prisma");

// ---------------------------------------------------------------------------
// Dependency loading with helpful error messages
// ---------------------------------------------------------------------------

let Database;
try {
  Database = (await import("better-sqlite3")).default;
} catch {
  console.error(
    "Missing dependency: better-sqlite3\n" +
      "Install it with: npm install better-sqlite3"
  );
  process.exit(1);
}

let pg;
try {
  pg = await import("pg");
} catch {
  console.error(
    "Missing dependency: pg\n" +
      "Install it with: npm install pg"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Prisma schema parser — extracts scalar field types per model
// ---------------------------------------------------------------------------

function parsePrismaSchema(schemaPath) {
  const schema = readFileSync(schemaPath, "utf-8");

  // Collect enum and model names
  const enumNames = new Set();
  const modelNames = new Set();
  for (const m of schema.matchAll(/^enum\s+(\w+)/gm)) enumNames.add(m[1]);
  for (const m of schema.matchAll(/^model\s+(\w+)/gm)) modelNames.add(m[1]);

  const SCALAR_TYPES = new Set([
    "String", "Int", "Float", "Boolean", "DateTime",
    "Json", "BigInt", "Bytes", "Decimal",
  ]);

  // Parse models
  const models = {};
  const modelRegex = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let match;
  while ((match = modelRegex.exec(schema)) !== null) {
    const modelName = match[1];
    const body = match[2];
    const fields = {};

    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("@@")) {
        continue;
      }

      const fieldMatch = trimmed.match(/^(\w+)\s+(\w+)(\?|\[\])?/);
      if (!fieldMatch) continue;

      const [, fieldName, rawType, modifier] = fieldMatch;

      // Skip relation fields (type is another model name)
      if (modelNames.has(rawType) && !enumNames.has(rawType)) continue;
      // Skip list relations
      if (modifier === "[]") continue;

      // Determine if this is a scalar or enum field
      if (SCALAR_TYPES.has(rawType) || enumNames.has(rawType)) {
        fields[fieldName] = {
          type: enumNames.has(rawType) ? "Enum" : rawType,
          optional: modifier === "?",
        };
      }
    }

    models[modelName] = fields;
  }

  return models;
}

// ---------------------------------------------------------------------------
// Table insertion order (topological, respecting foreign keys)
// ---------------------------------------------------------------------------

const TABLE_ORDER = [
  "User",
  "Verification",
  "Account",
  "Session",
  "EmailPreferences",
  "Org",
  "OrgUser",
  "License",
  "LicenseUsageReport",
  "Repo",
  "RepoRole",
  "Branch",
  "File",
  "Changelist",
  "ChangelistLabel",
  "FileChange",
  "ArtifactFile",
  "Workspace",
  "FileCheckout",
  "ApiToken",
  "OrgUserActivity",
  "PullRequest",
  "PullRequestComment",
  "PullRequestReview",
  "MergePermission",
  "Shelf",
  "ShelfFileChange",
  "Issue",
  "IssueComment",
  "IssueLabel",
  "IssueLabelLink",
  "IssueAssignee",
  "Notification",
  "IssueSubscription",
  "PullRequestSubscription",
];

// ---------------------------------------------------------------------------
// Type conversion helpers (SQLite → Postgres)
// ---------------------------------------------------------------------------

function convertValue(value, prismaType) {
  if (value === null || value === undefined) return null;

  switch (prismaType) {
    case "Boolean":
      // SQLite stores booleans as 0/1
      if (typeof value === "number") return value !== 0;
      if (typeof value === "boolean") return value;
      return Boolean(value);

    case "DateTime":
      // SQLite stores dates as ISO strings or epoch ms
      if (typeof value === "number") return new Date(value).toISOString();
      if (typeof value === "string") return new Date(value).toISOString();
      return value;

    case "Json":
      // SQLite stores JSON as text strings
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      return value;

    case "BigInt":
      // Ensure it's a string representation for pg
      return typeof value === "bigint" ? value.toString() : String(value);

    case "Int":
    case "Float":
    case "Decimal":
    case "String":
    case "Enum":
    default:
      return value;
  }
}

// ---------------------------------------------------------------------------
// Batch INSERT helper
// ---------------------------------------------------------------------------

function buildInsertQuery(tableName, columns, rowCount) {
  const quotedCols = columns.map((c) => `"${c}"`).join(", ");
  const placeholders = [];
  for (let r = 0; r < rowCount; r++) {
    const row = columns.map((_, i) => `$${r * columns.length + i + 1}`);
    placeholders.push(`(${row.join(", ")})`);
  }
  return `INSERT INTO "${tableName}" (${quotedCols}) VALUES ${placeholders.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Main migration logic
// ---------------------------------------------------------------------------

async function migrate(sqlitePath, postgresUrl) {
  console.log("Parsing Prisma schema...");
  const models = parsePrismaSchema(SCHEMA_PATH);

  console.log(`Opening SQLite database: ${sqlitePath}`);
  const sqlite = new Database(sqlitePath, { readonly: true });

  console.log(`Connecting to PostgreSQL: ${postgresUrl.replace(/\/\/.*@/, "//***@")}`);
  const pgClient = new pg.default.Client({ connectionString: postgresUrl });
  await pgClient.connect();

  // Get list of tables that actually exist in SQLite
  const sqliteTables = new Set(
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations'")
      .all()
      .map((r) => r.name)
  );

  // Filter TABLE_ORDER to only include tables that exist in both SQLite and schema
  const tablesToMigrate = TABLE_ORDER.filter(
    (t) => sqliteTables.has(t) && models[t]
  );

  // Also check for any SQLite tables not in our ordered list
  for (const t of sqliteTables) {
    if (!TABLE_ORDER.includes(t) && models[t]) {
      console.warn(`Warning: Table "${t}" exists in SQLite but is not in the migration order. It will be migrated last.`);
      tablesToMigrate.push(t);
    }
  }

  console.log(`\nMigrating ${tablesToMigrate.length} tables...\n`);

  const BATCH_SIZE = 500;
  let totalRows = 0;

  try {
    // Disable FK checks for the duration of the migration
    await pgClient.query("SET session_replication_role = 'replica'");
  } catch (err) {
    console.warn(
      "Warning: Could not disable FK triggers (requires sufficient privileges).\n" +
        "  Falling back to ordered insertion. Self-referencing tables may need a second pass.\n" +
        `  Error: ${err.message}\n`
    );
  }

  await pgClient.query("BEGIN");

  try {
    for (const table of tablesToMigrate) {
      const modelFields = models[table];
      const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all();

      if (rows.length === 0) {
        console.log(`  ${table}: 0 rows (skipped)`);
        continue;
      }

      // Use actual SQLite columns (intersection with schema fields)
      const sqliteColumns = Object.keys(rows[0]);
      const columns = sqliteColumns.filter((c) => c in modelFields);

      if (columns.length === 0) {
        console.warn(`  ${table}: no matching columns found, skipping`);
        continue;
      }

      let inserted = 0;

      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const values = [];

        for (const row of batch) {
          for (const col of columns) {
            const fieldInfo = modelFields[col];
            values.push(
              fieldInfo ? convertValue(row[col], fieldInfo.type) : row[col]
            );
          }
        }

        const query = buildInsertQuery(table, columns, batch.length);
        await pgClient.query(query, values);
        inserted += batch.length;
      }

      console.log(`  ${table}: ${inserted} rows`);
      totalRows += inserted;
    }

    await pgClient.query("COMMIT");
  } catch (err) {
    await pgClient.query("ROLLBACK");
    throw err;
  }

  // Re-enable FK checks
  try {
    await pgClient.query("SET session_replication_role = 'DEFAULT'");
  } catch {
    // Ignore if it wasn't set
  }

  sqlite.close();
  await pgClient.end();

  console.log(`\nMigration complete: ${totalRows} total rows across ${tablesToMigrate.length} tables.`);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Usage: node scripts/migrate-sqlite-to-postgres.mjs <sqlite-path> [postgres-url]

Arguments:
  sqlite-path   Path to the SQLite database file (e.g. ./prisma/db.sqlite)
  postgres-url  PostgreSQL connection URL (or set POSTGRES_URL / DATABASE_URL env var)

Before running:
  1. Set db.provider to "postgresql" in config and run: npm run db:push
  2. Ensure the Postgres database has the schema applied
  3. Install dependencies: npm install better-sqlite3 pg
`);
  process.exit(0);
}

const sqlitePath = args[0];
const postgresUrl = args[1] || process.env.POSTGRES_URL || process.env.DATABASE_URL;

if (!sqlitePath) {
  console.error("Error: SQLite database path is required.\nUsage: node scripts/migrate-sqlite-to-postgres.mjs <sqlite-path> [postgres-url]");
  process.exit(1);
}

if (!postgresUrl) {
  console.error("Error: PostgreSQL URL is required.\nProvide as second argument or set POSTGRES_URL / DATABASE_URL env var.");
  process.exit(1);
}

if (!postgresUrl.startsWith("postgresql://") && !postgresUrl.startsWith("postgres://")) {
  console.error(`Error: "${postgresUrl}" does not look like a PostgreSQL connection URL.`);
  process.exit(1);
}

migrate(sqlitePath, postgresUrl).catch((err) => {
  console.error("\nMigration failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});
