/**
 * Pulls write each changed path from its own source changelist in one native
 * pass, through block maps, and touch nothing else.
 *
 * Before, a pull applied every source changelist's whole version index in
 * turn, so it walked the workspace once per source, wrote paths the target
 * did not want (files later deleted, files later replaced), and repaired them
 * afterwards. These cover the histories where that went wrong and the
 * single pass has to get right by construction.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

const digest = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

describe.skipIf(!enabled)("single-pass pull", () => {
  let ctx: IntegrationContext;
  const seats: Seat[] = [];
  const timings: string[] = [];
  let counter = 0;

  beforeAll(async () => {
    ctx = await createContext("single-pass");
    const original = console.log.bind(console);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.startsWith("[pull-timing]")) timings.push(line);
      original(...args);
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    closeAllStateStores();
    await Promise.all(seats.map((s) => rm(s.root, { recursive: true, force: true })));
  });

  async function seat(name: string): Promise<Seat> {
    const root = (await mkdtemp(path.join(tmpdir(), `chk-sp-${name}-`))).replace(/\\/g, "/");
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

  async function put(s: Seat, relativePath: string, content: string | Buffer) {
    const full = path.join(s.root, relativePath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }

  const send = (s: Seat, mods: Record<string, "write" | "delete">) =>
    submit(
      s.workspace,
      ctx.orgId,
      "single-pass",
      Object.entries(mods).map(([p, kind]) => ({ path: p, delete: kind === "delete" })),
      s.workspace.id,
    );

  const lastTiming = () => JSON.parse(timings[timings.length - 1]!.replace("[pull-timing] ", ""));
  const unique = (stem: string) => `${stem}-${++counter}`;

  it("handles a path deleted and later added back, from every starting point", async () => {
    const alice = await seat("alice");
    const dir = unique("readd");
    const p = `${dir}/file.txt`;
    const other = `${dir}/other.bin`;

    await put(alice, p, "v1\n");
    await put(alice, other, randomBytes(200_000));
    await send(alice, { [p]: "write", [other]: "write" });
    const cl1 = await headChangelistNumber(ctx);

    await rm(path.join(alice.root, p));
    await send(alice, { [p]: "delete" });
    const cl2 = await headChangelistNumber(ctx);

    await put(alice, p, "v3 back again\n");
    await send(alice, { [p]: "write" });
    const cl3 = await headChangelistNumber(ctx);

    await rm(path.join(alice.root, p));
    await send(alice, { [p]: "delete" });
    const cl4 = await headChangelistNumber(ctx);

    // Fresh workspace to each point in that history.
    for (const [target, expected] of [
      [cl1, "v1\n"],
      [cl2, null],
      [cl3, "v3 back again\n"],
      [cl4, null],
    ] as const) {
      const bob = await seat(`bob${target}`);
      await pull(bob.workspace, ctx.orgId, target);
      const full = path.join(bob.root, p);
      if (expected === null) {
        expect(existsSync(full), `at ${target}`).toBe(false);
      } else {
        expect(await readFile(full, "utf8"), `at ${target}`).toBe(expected);
      }
      expect(lastTiming().nativePasses).toBeLessThanOrEqual(1);
      expect(lastTiming().stray).toBe(0);
    }

    // And moving one workspace through it: forward from 1 to 3, back to 1.
    const carol = await seat("carol");
    await pull(carol.workspace, ctx.orgId, cl1);
    await pull(carol.workspace, ctx.orgId, cl3);
    expect(await readFile(path.join(carol.root, p), "utf8")).toBe("v3 back again\n");
    await pull(carol.workspace, ctx.orgId, cl1);
    expect(await readFile(path.join(carol.root, p), "utf8")).toBe("v1\n");
    expect((await getWorkspaceState(carol.root)).files[p]?.changelist).toBe(cl1);
  });

  it("writes a long history in one native pass, each file from its own changelist", async () => {
    const alice = await seat("alice2");
    const dir = unique("many");
    const expected = new Map<string, Buffer>();
    for (let i = 0; i < 25; i++) {
      // Every changelist rewrites one shared file and adds its own.
      const shared = `${dir}/shared.txt`;
      const own = `${dir}/cl${i}.bin`;
      const sharedBytes = Buffer.from(`shared at ${i}\n`);
      const ownBytes = randomBytes(10_000 + i);
      await put(alice, shared, sharedBytes);
      await put(alice, own, ownBytes);
      await send(alice, { [shared]: "write", [own]: "write" });
      expected.set(shared, sharedBytes);
      expected.set(own, ownBytes);
    }

    const bob = await seat("bob2");
    await pull(bob.workspace, ctx.orgId, null);
    const timing = lastTiming();
    expect(timing.nativePasses).toBe(1);
    expect(timing.stale).toBe(0);
    for (const [p, bytes] of expected) {
      expect(digest(await readFile(path.join(bob.root, p))), p).toBe(digest(bytes));
    }
  });

  it("leaves untouched a file the workspace already has at its source changelist", async () => {
    const alice = await seat("alice3");
    const p = `${unique("kept")}/notes.txt`;
    await put(alice, p, "base\n");
    await send(alice, { [p]: "write" });

    const bob = await seat("bob3");
    await pull(bob.workspace, ctx.orgId, null);
    // Bob edits locally; Alice changes an unrelated file.
    await put(bob, p, "base\nbob's local edit\n");
    const q = `${unique("other")}/x.txt`;
    await put(alice, q, "x\n");
    await send(alice, { [q]: "write" });

    await pull(bob.workspace, ctx.orgId, null);
    expect(await readFile(path.join(bob.root, p), "utf8")).toBe("base\nbob's local edit\n");
    expect(await readFile(path.join(bob.root, q), "utf8")).toBe("x\n");
  });

  it("records in the workspace state only the paths an include filter let through", async () => {
    const alice = await seat("alice4");
    const dir = unique("filtered");
    await put(alice, `${dir}/Source/a.cpp`, "a\n");
    await put(alice, `${dir}/Content/b.uasset`, randomBytes(5000));
    await send(alice, { [`${dir}/Source/a.cpp`]: "write", [`${dir}/Content/b.uasset`]: "write" });

    const bob = await seat("bob4");
    await pull(bob.workspace, ctx.orgId, null, null, undefined, undefined, undefined, async () => [
      `${dir}/Source/`,
    ]);
    const state = await getWorkspaceState(bob.root);
    expect(existsSync(path.join(bob.root, dir, "Source", "a.cpp"))).toBe(true);
    expect(existsSync(path.join(bob.root, dir, "Content", "b.uasset"))).toBe(false);
    expect(state.files[`${dir}/Source/a.cpp`]).toBeDefined();
    expect(state.files[`${dir}/Content/b.uasset`]).toBeUndefined();
  });

  it("is a no-op with nothing to pull", async () => {
    const bob = await seat("bob5");
    await pull(bob.workspace, ctx.orgId, null);
    const result = await pull(bob.workspace, ctx.orgId, null);
    expect(result.conflictMerges).toEqual([]);
    expect(lastTiming().nativePasses).toBe(0);
  });
});
