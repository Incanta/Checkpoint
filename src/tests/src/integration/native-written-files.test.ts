/**
 * What the native layer writes and refuses to touch, with the real addon
 * against running services (skipped unless CHECKPOINT_TEST_DAEMON_ID is set;
 * see harness.ts).
 *
 * - The pull reports each file's size and mtime as its write finished
 *   (tracking-storage.h), and the daemon records those as the baselines, so
 *   they must equal what fs.stat reports for an untouched file (DL-21).
 * - The submit never reads (and uploads) a path that climbs out of the
 *   workspace or names its .checkpoint directory (DL-03, DL-23).
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pull } from "../../../core/daemon/src/util/pull.js";
import { closeAllStateStores } from "../../../core/daemon/src/util/state-store.js";
import { submit } from "../../../core/daemon/src/util/submit.js";
import {
  getWorkspaceState,
  type Workspace,
} from "../../../core/daemon/src/util/util.js";
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

describe.skipIf(!enabled)("what the native layer writes", () => {
  let ctx: IntegrationContext;
  const seats: Seat[] = [];

  beforeAll(async () => {
    ctx = await createContext("native-written");
  });

  afterAll(async () => {
    closeAllStateStores();
    await Promise.all(
      seats.map((s) => rm(s.root, { recursive: true, force: true })),
    );
  });

  async function seat(name: string): Promise<Seat> {
    const root = (
      await mkdtemp(path.join(tmpdir(), `chk-written-${name}-`))
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

  async function put(s: Seat, relativePath: string, content: string) {
    const full = path.join(s.root, relativePath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }

  const send = (s: Seat, paths: string[]) =>
    submit(
      s.workspace,
      ctx.orgId,
      "native written files",
      paths.map((p) => ({ path: p, delete: false })),
      s.workspace.id,
    );

  it("records each pulled file's size and mtime exactly as fs.stat reports them", async () => {
    const alice = await seat("alice");
    const files = ["a.txt", "Docs/b.txt", "Docs/Deep/c.bin", "Docs/café.txt"];
    for (const f of files) await put(alice, f, `content of ${f}\n`.repeat(50));
    await send(alice, files);

    const bob = await seat("bob");
    await pull(bob.workspace, ctx.orgId, await headChangelistNumber(ctx));

    const state = await getWorkspaceState(bob.root, "sqlite");
    for (const f of files) {
      const st = await stat(path.join(bob.root, f));
      expect(state.files[f], f).toMatchObject({
        size: st.size,
        mtime: st.mtimeMs,
      });
    }
  });

  it.each(["../outside.txt", ".checkpoint/workspace.json"])(
    "refuses to submit %s",
    async (unsafe) => {
      const alice = await seat(`unsafe-${unsafe.length}`);
      await put(alice, "fine.txt", "fine\n");
      await mkdir(path.join(alice.root, ".checkpoint"), { recursive: true });
      await writeFile(path.join(alice.root, unsafe), "should never upload\n");

      await expect(send(alice, ["fine.txt", unsafe])).rejects.toThrow(
        /Refusing to submit|cannot be stored/,
      );
    },
  );
});
