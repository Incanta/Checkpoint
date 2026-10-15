/**
 * Red team, native layer: what a submit and a pull do to file modes on Linux
 * and macOS. Uses the real longtail addon against running services, like
 * src/integration, so it is skipped unless CHECKPOINT_TEST_DAEMON_ID is set
 * (see that harness), and on Windows, which has no executable bit.
 *
 * The native submit records every file as 0644 (submit.cpp, where it builds
 * the file infos), and both native pulls apply the recorded permissions to
 * each file they write (retain_permissions), so the executable bit of a
 * script or a binary is dropped when it is submitted and stripped from a
 * teammate's copy whenever it changes. See ../README.md.
 */
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pull } from "../../../../core/daemon/src/util/pull.js";
import { closeAllStateStores } from "../../../../core/daemon/src/util/state-store.js";
import { submit } from "../../../../core/daemon/src/util/submit.js";
import type { Workspace } from "../../../../core/daemon/src/util/util.js";
import {
  DAEMON_ID,
  createContext,
  enabled,
  headChangelistNumber,
  type IntegrationContext,
} from "../../integration/harness.js";

interface Seat {
  workspace: Workspace;
  root: string;
}

const posix = process.platform !== "win32";

describe.skipIf(!enabled || !posix)("data loss (native): file modes", () => {
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
});
