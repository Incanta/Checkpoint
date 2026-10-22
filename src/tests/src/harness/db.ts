// Per-test-file SQLite database.
//
// Each test *file* calls `createTestDb()` once in `beforeAll`, then `reset()`
// between tests and `teardown()` in `afterAll`. The DB lives under
// `os.tmpdir()/checkpoint-tests/` and is wiped on teardown.
//
// The Prisma schema is applied with `prisma db push` (no migrations, no
// history) once per run, into a template file that global-setup.ts creates;
// each file then copies the template. Spawning `yarn prisma` costs a few
// seconds, which across ~90 files added minutes to a run (more on Windows,
// where starting processes is slow). Without a template (a config that does
// not load the global setup) each file pushes the schema itself.
//
// We deliberately do NOT import `db` from `~/server/db` here, as that
// instantiates a singleton against the dev DATABASE_URL. The harness's
// PrismaClient is plumbed into the app's `db` import via the global
// `__checkpointTestDb` setter (see vitest-setup.ts).

import { PrismaClient } from "@prisma/client";
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inject } from "vitest";

const repoRoot = path.resolve(__dirname, "../../../..");
const appDir = path.resolve(repoRoot, "src/app");
const schemaDir = path.join(appDir, "prisma");

export interface TestDb {
  /** PrismaClient bound to the temp SQLite file. */
  client: PrismaClient;
  /** Wipe all rows from every table the app reads/writes. */
  reset: () => Promise<void>;
  /** Disconnect and remove the temp directory. */
  teardown: () => Promise<void>;
}

// Order matters: leaf tables (those with no incoming FKs) first. If you add
// a new model to the schema and tests start failing with FK violations,
// insert it ahead of its parents here.
//
// This list is the *union* of tables across main and premium. On a branch
// where a given table doesn't exist (e.g. Invoice on main, OrgStoragePeak
// on main), the `DELETE FROM …` throws and the try/catch around each one
// silently moves on.
const tableOrder = [
  "TreeBlock",
  "FileChange",
  // FileClaimEvent references FileClaim, so it has to go first.
  "FileClaimEvent",
  "FileClaim",
  "WorkspaceBranch",
  "Notification",
  "IssueSubscription",
  "MergeRequestSubscription",
  "IssueAssignee",
  "IssueComment",
  "Issue",
  "MergeRequestReview",
  "MergeRequestComment",
  "MergeRequest",
  "MergePermission",
  "ApiToken",
  "OrgUserActivity",
  "OrgStoragePeak",
  "InvoiceItem",
  "Invoice",
  "CardExpiryNotification",
  "License",
  "Workspace",
  "Changelist",
  "Branch",
  "RepoRole",
  "Repo",
  "File",
  "OrgUser",
  "Org",
  "Session",
  "Account",
  "TwoFactor",
  "Passkey",
  "Verification",
  "User",
];

const sqliteUrl = (file: string) => `file:${file.replace(/\\/g, "/")}`;

/** Applies the app's Prisma schema to a fresh SQLite file. */
export function pushSchema(dbFile: string): void {
  // Use `execSync` (string form) instead of `execFileSync` + `shell: true`:
  // the latter is DEP0190'd because args get concatenated into the shell
  // command unescaped. The string form picks the shell up correctly on
  // Windows (where `yarn` is a `.cmd` shim, unreachable via execFileSync
  // without a shell) without that footgun. Our args here are all known
  // literals plus `schemaDir`, which we double-quote.
  execSync(
    `yarn prisma db push --schema "${schemaDir}" --skip-generate --accept-data-loss`,
    {
      cwd: appDir,
      env: {
        ...process.env,
        DATABASE_URL: sqliteUrl(dbFile),
        DB_PROVIDER: "sqlite",
      },
      stdio: "pipe",
    },
  );
}

export async function createTestDb(): Promise<TestDb> {
  const baseDir = path.join(os.tmpdir(), "checkpoint-tests");
  mkdirSync(baseDir, { recursive: true });
  const dir = mkdtempSync(path.join(baseDir, "db-"));
  const dbFile = path.join(dir, "test.db");
  const url = sqliteUrl(dbFile);

  const template = inject("testDbTemplate");
  if (template) {
    copyFileSync(template, dbFile);
  } else {
    pushSchema(dbFile);
  }

  const client = new PrismaClient({
    datasources: { db: { url } },
    log: ["error"],
  });

  return {
    client,
    reset: async () => {
      // Disable FK checks for the duration of the wipe so self-referencing
      // tables (Branch has a parentBranch FK to itself) and parent/child
      // pairs don't trip CASCADE constraints. SQLite scopes PRAGMA to the
      // connection (Prisma reuses one per client), so this is safe.
      await client.$executeRawUnsafe(`PRAGMA foreign_keys = OFF`);
      try {
        for (const table of tableOrder) {
          try {
            await client.$executeRawUnsafe(`DELETE FROM "${table}"`);
          } catch {
            // Table may not exist in this schema; ignore.
          }
        }
      } finally {
        await client.$executeRawUnsafe(`PRAGMA foreign_keys = ON`);
      }
    },
    teardown: async () => {
      await client.$disconnect();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; Windows occasionally holds SQLite file locks.
      }
    },
  };
}
