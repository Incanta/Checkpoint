/**
 * Inputs the native submit must REJECT, rather than commit as something wrong.
 *
 * Separate from native-submit.test.ts on purpose. These cases feed the addon
 * paths a caller should never send, so they are the ones most likely to crash
 * it, and a native crash takes down the whole vitest worker: the first CI run
 * of this suite segfaulted here and took the results of five later tests with
 * it. Each vitest file gets its own fork, so keeping the adversarial cases
 * apart means a crash costs visibility into these three and nothing else.
 *
 * The contract: a path the addon cannot honestly size fails the submit, naming
 * the path, and leaves the branch head where it was. Committing a 0-byte asset
 * (or a directory's inode size) is silent data loss, which is the bug 708b223
 * fixed and these tests exist to keep fixed.
 *
 * Calls the addon directly, so the daemon's own dedupe and directory expansion
 * are not in the way. See harness.ts for why that matters.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Modification } from "@checkpointvcs/longtail-addon";

import {
  createContext,
  createWorkspace,
  enabled,
  headChangelistNumber,
  nativeSubmit,
  write,
  type IntegrationContext,
  type LocalWorkspace,
} from "./harness.js";

const add = (filePath: string): Modification => ({
  path: filePath,
  delete: false,
});

describe.skipIf(!enabled)("native submit: inputs that must be rejected", () => {
  let ctx: IntegrationContext;
  let ws: LocalWorkspace | undefined;

  beforeAll(async () => {
    ctx = await createContext("native-rejects");
  });

  afterEach(async () => {
    await ws?.cleanup();
    ws = undefined;
  });

  afterAll(async () => {
    await ws?.cleanup();
  });

  it("fails the submit when a listed file is missing from disk instead of committing it empty", async () => {
    ws = await createWorkspace(ctx, "missing");
    await write(ws, "Exists.txt", "present\n");
    const before = await headChangelistNumber(ctx);

    const outcome = await nativeSubmit(ctx, ws, [
      add("Exists.txt"),
      add("Missing.txt"),
    ]);

    expect(
      outcome.error,
      "a file that cannot be sized must fail the submit",
    ).not.toBe(0);
    expect(outcome.step).toContain("Missing.txt");
    expect(await headChangelistNumber(ctx)).toBe(before);
  });

  it.skipIf(process.platform === "win32")(
    "fails rather than committing empty when a path uses backslashes on POSIX",
    async () => {
      // The daemon normalizes separators before the addon sees a path. If a
      // caller skips that, the addon must not resolve "Source\\Game.cpp" to
      // nothing and commit a 0-byte asset under that name.
      ws = await createWorkspace(ctx, "backslash");
      await write(ws, "Source/Game.cpp", "// game\n");
      const before = await headChangelistNumber(ctx);

      const outcome = await nativeSubmit(ctx, ws, [
        add("Source/Game.cpp"),
        add("Source\\Game.cpp"),
      ]);

      expect(outcome.error).not.toBe(0);
      expect(await headChangelistNumber(ctx)).toBe(before);
    },
  );

  it("fails rather than committing when a directory is listed as if it were a file", async () => {
    // Directory expansion is the caller's job, and every in-tree caller goes
    // through DaemonManager.expandDirectoriesForSubmit. This is about what
    // happens when one does not.
    //
    // This is the case that segfaulted the first CI run. On POSIX, fopen() on a
    // directory succeeds and fseek/ftell reports the inode size, so the addon's
    // size fallback accepted it as a real asset and Longtail later pread() it,
    // got EISDIR, and crashed. Windows never showed it: CreateFileW fails on a
    // directory without FILE_FLAG_BACKUP_SEMANTICS. submit.cpp now checks IsDir
    // before sizing.
    ws = await createWorkspace(ctx, "dirpath");
    await write(ws, "Dir/file.txt", "inside\n");
    const before = await headChangelistNumber(ctx);

    const outcome = await nativeSubmit(ctx, ws, [
      add("Dir"),
      add("Dir/file.txt"),
    ]);

    expect(
      outcome.error,
      "a directory path must not be committed as a file",
    ).not.toBe(0);
    expect(outcome.step).toContain("Dir");
    expect(await headChangelistNumber(ctx)).toBe(before);
  });
});
