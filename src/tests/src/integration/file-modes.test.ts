/**
 * File modes on Linux and macOS: the native submit records each file's real
 * mode, and the pull applies it, so a script or binary made executable stays
 * executable for teammates, and a local chmod survives an upstream change
 * that did not touch the mode. Uses the real addon against running services,
 * so it is skipped unless CHECKPOINT_TEST_DAEMON_ID is set (see harness.ts),
 * and on Windows, which has no executable bit. Moved here from the data-loss
 * red team (DL-24).
 */
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pull } from "../../../core/daemon/src/util/pull.js";
import { closeAllStateStores } from "../../../core/daemon/src/util/state-store.js";
import { submit } from "../../../core/daemon/src/util/submit.js";
import type { Workspace } from "../../../core/daemon/src/util/util.js";
import {
  DAEMON_ID,
  createContext,
  enabled,
  headChangelistNumber,
  type IntegrationContext,
} from "./harness.js";

interface Seat {
  workspace: Workspace;
  root: string;
}

const posix = process.platform !== "win32";

describe.skipIf(!enabled || !posix)("file modes (native)", () => {
  let ctx: IntegrationContext;
  const seats: Seat[] = [];

  beforeAll(async () => {
    ctx = await createContext("file-modes");
  });

  afterAll(async () => {
    closeAllStateStores();
    await Promise.all(
      seats.map((s) => rm(s.root, { recursive: true, force: true })),
    );
  });

  async function seat(name: string): Promise<Seat> {
    const root = (
      await mkdtemp(path.join(tmpdir(), `chk-modes-${name}-`))
    ).replace(/\\/g, "/");
    const row = await ctx.client.workspace.create.mutate({
      name: `${name}-${path.basename(root)}`,
      repoId: ctx.repoId,
      defaultBranchName: "main",
    });
    const workspace = {
      id: row.id,
      repoId: ctx.repoId,
      domainBranchName: "main",
      activeBranches: [],
      workspaceName: row.name,
      localPath: root,
      daemonId: DAEMON_ID,
    } as unknown as Workspace;
    const created = { workspace, root };
    seats.push(created);
    return created;
  }

  async function put(
    s: Seat,
    relativePath: string,
    content: string,
    mode: number,
  ) {
    const full = path.join(s.root, relativePath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
    await chmod(full, mode);
  }

  const send = (s: Seat, paths: string[]) =>
    submit(
      s.workspace,
      ctx.orgId,
      "file modes",
      paths.map((p) => ({ path: p, delete: false })),
      s.workspace.id,
    );

  const modeOf = async (s: Seat, relativePath: string) =>
    (await stat(path.join(s.root, relativePath))).mode & 0o777;

  it("gives a teammate a script the submitter made executable, still executable", async () => {
    // Setup.sh, GenerateProjectFiles.sh, RunUAT.sh, and the binaries under
    // Engine/Binaries/Linux all need it; without it, every Linux build agent
    // and Mac or Linux developer has to chmod after each sync.
    const alice = await seat("alice");
    await put(alice, "Scripts/setup.sh", "#!/bin/sh\necho setting up\n", 0o755);
    await send(alice, ["Scripts/setup.sh"]);

    const bob = await seat("bob");
    await pull(bob.workspace, ctx.orgId, await headChangelistNumber(ctx));

    expect((await modeOf(bob, "Scripts/setup.sh")).toString(8)).toBe("755");
  });

  it("keeps a teammate's executable executable when it changes upstream", async () => {
    // Even if every copy were fixed by hand, the next change to the file
    // would undo it: the pull writes the new content and applies the
    // recorded 0644 on top.
    const alice = await seat("alice2");
    await put(alice, "Tools/build.sh", "#!/bin/sh\necho v1\n", 0o755);
    await send(alice, ["Tools/build.sh"]);
    const bob = await seat("bob2");
    await pull(bob.workspace, ctx.orgId, await headChangelistNumber(ctx));
    await chmod(path.join(bob.root, "Tools/build.sh"), 0o755);

    await put(alice, "Tools/build.sh", "#!/bin/sh\necho v2\n", 0o755);
    await send(alice, ["Tools/build.sh"]);
    await pull(bob.workspace, ctx.orgId, await headChangelistNumber(ctx));

    expect((await modeOf(bob, "Tools/build.sh")).toString(8)).toBe("755");
  });

  it("submits a mode-only change", async () => {
    const alice = await seat("alice3");
    await put(alice, "Tools/run.sh", "#!/bin/sh\necho run\n", 0o644);
    await send(alice, ["Tools/run.sh"]);
    await chmod(path.join(alice.root, "Tools/run.sh"), 0o755);
    await send(alice, ["Tools/run.sh"]);

    const bob = await seat("bob3");
    await pull(bob.workspace, ctx.orgId, await headChangelistNumber(ctx));

    expect((await modeOf(bob, "Tools/run.sh")).toString(8)).toBe("755");
  });

  it("keeps a local chmod when upstream changes the content but not the mode", async () => {
    const alice = await seat("alice4");
    await put(alice, "Tools/lint.sh", "#!/bin/sh\necho v1\n", 0o644);
    await send(alice, ["Tools/lint.sh"]);
    const bob = await seat("bob4");
    await pull(bob.workspace, ctx.orgId, await headChangelistNumber(ctx));
    await chmod(path.join(bob.root, "Tools/lint.sh"), 0o755);

    await put(alice, "Tools/lint.sh", "#!/bin/sh\necho v2\n", 0o644);
    await send(alice, ["Tools/lint.sh"]);
    await pull(bob.workspace, ctx.orgId, await headChangelistNumber(ctx));

    expect((await modeOf(bob, "Tools/lint.sh")).toString(8)).toBe("755");
  });

  it("keeps a file executable by its owner only as it is", async () => {
    const alice = await seat("alice5");
    await put(alice, "Tools/private.sh", "#!/bin/sh\n", 0o700);
    await send(alice, ["Tools/private.sh"]);
    const bob = await seat("bob5");
    await pull(bob.workspace, ctx.orgId, await headChangelistNumber(ctx));

    expect((await modeOf(bob, "Tools/private.sh")).toString(8)).toBe("700");
  });
});
