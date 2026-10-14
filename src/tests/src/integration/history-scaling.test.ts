/**
 * Long-history scenario: does the cost of an operation grow with the change
 * or with the repo's history?
 *
 * The droplet benchmark (benchmark/) submits one large version and pulls it,
 * so its history is two changelists long and cannot show costs that grow with
 * history. This builds a history of HISTORY_CHANGELISTS (default 100)
 * changelists, each a small change over a shared tree (edits rotating over
 * existing files, one add, an occasional delete, one large rename), and
 * measures at checkpoints along the way:
 *
 *   - wall time of a small submit, and the store index size it has to merge;
 *   - an incremental pull of one changelist at the end of the history;
 *   - a fresh clone of the whole history;
 *   - a single-file read.
 *
 * It also checks the clone matches the submitter's tree, so it doubles as a
 * correctness test for long histories (deletes, re-adds, a rename).
 *
 * Opt-in on top of the integration switch: set CHECKPOINT_HISTORY_BENCH=1.
 * Results print as one `[history-scaling]` JSON line and, when
 * HISTORY_BENCH_OUT names a file, are written there too.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { pull } from "../../../core/daemon/src/util/pull.js";
import { readFileFromChangelist } from "../../../core/daemon/src/util/read-file.js";
import { closeAllStateStores } from "../../../core/daemon/src/util/state-store.js";
import { submit } from "../../../core/daemon/src/util/submit.js";
import type { Workspace } from "../../../core/daemon/src/util/util.js";

import {
  DAEMON_ID,
  createContext,
  enabled,
  gatewayRequest,
  headChangelistNumber,
  type IntegrationContext,
} from "./harness.js";

const run = enabled && !!process.env.CHECKPOINT_HISTORY_BENCH;
const HISTORY = Number(process.env.HISTORY_CHANGELISTS ?? 100);
const CHECKPOINTS = new Set([10, 25, 50, 100, 200, 300, HISTORY]);

interface Seat {
  workspace: Workspace;
  root: string;
}

interface Sample {
  changelists: number;
  submitMs: number;
  storeIndexBytes: number | null;
}

describe.skipIf(!run)("history scaling", () => {
  let ctx: IntegrationContext;
  const seats: Seat[] = [];
  const timingLines: string[] = [];

  beforeAll(async () => {
    ctx = await createContext("history-scaling");
    const original = console.log.bind(console);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (/^\[(pull|submit|read)-timing\]/.test(line)) timingLines.push(line);
      original(...args);
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    closeAllStateStores();
    await Promise.all(
      seats.map((s) => rm(s.root, { recursive: true, force: true })),
    );
  });

  async function seat(name: string): Promise<Seat> {
    const root = (
      await mkdtemp(path.join(tmpdir(), `chk-history-${name}-`))
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

  async function put(s: Seat, relativePath: string, content: string | Buffer) {
    const full = path.join(s.root, relativePath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }

  function send(s: Seat, mods: Record<string, "write" | "delete">) {
    return submit(
      s.workspace,
      ctx.orgId,
      "history",
      Object.entries(mods).map(([p, kind]) => ({
        path: p,
        delete: kind === "delete",
      })),
      s.workspace.id,
    );
  }

  async function storeIndexBytes(): Promise<number | null> {
    try {
      const response = await gatewayRequest(ctx, "GET", "store.lsi");
      return response.status === 200 ? response.body.length : null;
    } catch {
      // r2 mode has no gateway; the index size is not observable from here.
      return null;
    }
  }

  const lastTiming = (tag: string) =>
    [...timingLines].reverse().find((line) => line.startsWith(`[${tag}]`)) ??
    null;

  it(`builds ${HISTORY} changelists and measures each operation`, async () => {
    const alice = await seat("alice");
    // What alice's tree holds, so the clone can be checked against it.
    const tree = new Map<string, Buffer>();

    // Base tree: 20 directories of text files plus a few larger binaries.
    const base: Record<string, "write"> = {};
    for (let d = 0; d < 20; d++) {
      for (let f = 0; f < 15; f++) {
        const p = `src/dir${d}/file${f}.txt`;
        const content = Buffer.from(`${p}\n${randomBytes(512).toString("hex")}\n`);
        await put(alice, p, content);
        tree.set(p, content);
        base[p] = "write";
      }
    }
    for (let b = 0; b < 5; b++) {
      const p = `content/asset${b}.uasset`;
      const content = randomBytes(512 * 1024);
      await put(alice, p, content);
      tree.set(p, content);
      base[p] = "write";
    }
    await send(alice, base);

    const samples: Sample[] = [];
    const textPaths = [...tree.keys()].filter((p) => p.endsWith(".txt"));
    const added: string[] = [];

    for (let i = 1; i <= HISTORY; i++) {
      const mods: Record<string, "write" | "delete"> = {};

      for (let k = 0; k < 3; k++) {
        const p = textPaths[(i * 3 + k) % textPaths.length]!;
        const content = Buffer.from(`${p} rev ${i}\n${randomBytes(256).toString("hex")}\n`);
        await put(alice, p, content);
        tree.set(p, content);
        mods[p] = "write";
      }

      const newPath = `added/a${i % 7}/new-${i}.txt`;
      const newContent = Buffer.from(`added at ${i}\n`);
      await put(alice, newPath, newContent);
      tree.set(newPath, newContent);
      added.push(newPath);
      mods[newPath] = "write";

      // Every tenth changelist deletes an earlier add; every fifteenth puts
      // one back under the same name (delete then re-add across history).
      if (i % 10 === 0 && added.length > 3) {
        const victim = added.splice(0, 1)[0]!;
        await rm(path.join(alice.root, victim), { force: true });
        tree.delete(victim);
        mods[victim] = "delete";
      }
      if (i % 15 === 0) {
        const revived = `added/a${(i - 10) % 7}/new-${i - 10}.txt`;
        if (!tree.has(revived) && !mods[revived]) {
          const content = Buffer.from(`revived at ${i}\n`);
          await put(alice, revived, content);
          tree.set(revived, content);
          mods[revived] = "write";
        }
      }

      // One large rename halfway through: same bytes, new path.
      if (i === Math.floor(HISTORY / 2)) {
        const from = "content/asset0.uasset";
        const to = "content/moved/asset0-renamed.uasset";
        const bytes = tree.get(from)!;
        await put(alice, to, bytes);
        await rm(path.join(alice.root, from), { force: true });
        tree.delete(from);
        tree.set(to, bytes);
        mods[from] = "delete";
        mods[to] = "write";
      }

      const started = Date.now();
      await send(alice, mods);
      const submitMs = Date.now() - started;

      if (CHECKPOINTS.has(i)) {
        samples.push({
          changelists: i,
          submitMs,
          storeIndexBytes: await storeIndexBytes(),
        });
      }
    }

    const head = await headChangelistNumber(ctx);

    // Incremental pull of exactly one changelist at the end of the history.
    const bob = await seat("bob");
    await pull(bob.workspace, ctx.orgId, head - 1);
    let started = Date.now();
    await pull(bob.workspace, ctx.orgId, head);
    const pullOneMs = Date.now() - started;
    const pullOneTiming = lastTiming("pull-timing");

    // Fresh clone of the whole history.
    const carol = await seat("carol");
    started = Date.now();
    await pull(carol.workspace, ctx.orgId, head);
    const cloneMs = Date.now() - started;
    const cloneTiming = lastTiming("pull-timing");

    // One file read at the head. A read names the changelist that wrote the
    // file, so take one the last changelist modified.
    const readPath = textPaths[(HISTORY * 3) % textPaths.length]!;
    started = Date.now();
    const read = await readFileFromChangelist({
      workspace: carol.workspace,
      filePath: readPath,
      changelistNumber: head,
    });
    const readOneMs = Date.now() - started;

    const result = {
      changelists: HISTORY,
      files: tree.size,
      samples,
      pullOneMs,
      pullOneTiming,
      cloneMs,
      cloneTiming,
      readOneMs,
    };
    console.info(`[history-scaling] ${JSON.stringify(result)}`);
    if (process.env.HISTORY_BENCH_OUT) {
      await writeFile(process.env.HISTORY_BENCH_OUT, JSON.stringify(result, null, 2));
    }

    // The clone holds exactly alice's tree, and the read returned the bytes.
    const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    expect(digest(await readFile(read.cachePath))).toBe(digest(tree.get(readPath)!));
    for (const [p, content] of tree) {
      const cloned = await readFile(path.join(carol.root, p));
      expect(digest(cloned), p).toBe(digest(content));
    }
    for (const gone of ["content/asset0.uasset"]) {
      await expect(readFile(path.join(carol.root, gone))).rejects.toThrow();
    }
  });
});
