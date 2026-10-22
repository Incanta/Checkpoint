// Vitest global setup. Runs once per run, in the main process, before any
// test file.
//
// Pushes the app's Prisma schema into one template SQLite file, which every
// test file's createTestDb() copies instead of pushing the schema itself (see
// db.ts). The path reaches the workers through vitest's provide/inject.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";

import { pushSchema } from "./db";

declare module "vitest" {
  export interface ProvidedContext {
    /** A SQLite file with the app's schema applied and no rows. */
    testDbTemplate: string;
  }
}

export default function setup(project: TestProject) {
  const baseDir = path.join(os.tmpdir(), "checkpoint-tests");
  mkdirSync(baseDir, { recursive: true });
  const dir = mkdtempSync(path.join(baseDir, "template-"));
  const template = path.join(dir, "template.db");

  pushSchema(template);
  project.provide("testDbTemplate", template);

  return () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; Windows occasionally holds SQLite file locks.
    }
  };
}
