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
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { WrittenFile } from "../../../core/daemon/src/util/pull-record.js";

// Every record a native pass leaves, as the daemon read it, one map per
// pass: the pull consumes the record file, and the state alone cannot tell a
// hash the addon reported from one the daemon took when recording (it hashes
// racily clean files itself when the addon reports none).
const passRecords: Map<string, WrittenFile>[] = [];
vi.mock(
  "../../../core/daemon/src/util/pull-record.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../core/daemon/src/util/pull-record.js")
      >();
    return {
      ...actual,
      takePullRecord: async (root: string, into: Map<string, WrittenFile>) => {
        const pass = new Map<string, WrittenFile>();
        const found = await actual.takePullRecord(root, pass);
        passRecords.push(pass);
        for (const [p, w] of pass) into.set(p, w);
        return found;
      },
    };
  },
);

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
  nativeSubmit,
  type IntegrationContext,
} from "./harness.js";

const md5 = (bytes: Buffer) => createHash("md5").update(bytes).digest("hex");

/** Bytes that do not repeat, so every chunk of a large file is distinct. */
function noise(size: number, seed: number): Buffer {
  const out = Buffer.alloc(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

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

  async function put(
    s: Seat,
    relativePath: string,
    content: string | Buffer,
  ) {
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

  /**
   * That each path the passes wrote was reported with the md5 of the bytes
   * now on disk, and that the state recorded it as the baseline.
   */
  async function expectReportedHashes(s: Seat, paths: string[]) {
    const reported = new Map<string, WrittenFile>();
    for (const pass of passRecords) {
      for (const [p, w] of pass) reported.set(p, w);
    }
    const state = await getWorkspaceState(s.root, "sqlite");
    for (const f of paths) {
      const bytes = await readFile(path.join(s.root, f));
      expect(reported.get(f)?.md5, `${f} as the addon reported it`).toBe(
        md5(bytes),
      );
      expect(state.files[f]?.md5, `${f} in the workspace state`).toBe(
        md5(bytes),
      );
    }
  }

  it("reports the md5 of each file a single-pass pull wrote, small, empty, and spanning blocks", async () => {
    const alice = await seat("hash-alice");
    const files: Record<string, Buffer> = {
      // Paths of their own: the earlier test's changelist shares the repo.
      "Hashed/small.txt": Buffer.from("small\n".repeat(20)),
      "Hashed/empty.txt": Buffer.alloc(0),
      "Hashed/naïve.txt": Buffer.from("accented\n"),
      // Past the 8 MiB block size: written from several blocks, in partial
      // writes from separate jobs.
      "Hashed/Content/big.bin": noise(20 * 1024 * 1024 + 123, 7),
    };
    for (const [f, bytes] of Object.entries(files)) await put(alice, f, bytes);
    await send(alice, Object.keys(files));

    const bob = await seat("hash-bob");
    passRecords.length = 0;
    await pull(bob.workspace, ctx.orgId, await headChangelistNumber(ctx));

    expect(passRecords.length).toBe(1);
    await expectReportedHashes(bob, Object.keys(files));
  });

  it("reports the md5 of each file whole-index pulls wrote, including a path two indexes write", async () => {
    const alice = await seat("whole-alice");
    await put(alice, "first.txt", "only in the first changelist\n");
    await put(alice, "shared.bin", noise(3 * 1024 * 1024, 1));
    await send(alice, ["first.txt", "shared.bin"]);

    // Chunked differently from the first, so the two cannot share one
    // selection index: the daemon applies each changelist's whole index in
    // turn, and both write shared.bin.
    await put(alice, "shared.bin", noise(3 * 1024 * 1024 + 17, 2));
    await put(alice, "second.txt", "only in the second changelist\n");
    const outcome = await nativeSubmit(
      ctx,
      { root: alice.root, workspaceId: alice.workspace.id, cleanup: async () => {} },
      [
        { path: "shared.bin", delete: false },
        { path: "second.txt", delete: false },
      ],
      "chunked differently",
      { targetChunkSize: 65536 },
    );
    expect(outcome.error, outcome.step).toBe(0);

    const bob = await seat("whole-bob");
    passRecords.length = 0;
    await pull(bob.workspace, ctx.orgId, await headChangelistNumber(ctx));

    // The declined selection pass reports nothing; then one record per index
    // (the repo also holds the earlier tests' changelists), and exactly two
    // of them wrote shared.bin, each its own version.
    const written = passRecords.filter((r) => r.has("shared.bin"));
    expect(written.length).toBe(2);
    expect(written[0]!.get("shared.bin")?.md5).toMatch(/^[0-9a-f]{32}$/);
    expect(written[0]!.get("shared.bin")?.md5).not.toBe(
      written[1]!.get("shared.bin")?.md5,
    );
    await expectReportedHashes(bob, ["first.txt", "shared.bin", "second.txt"]);
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
