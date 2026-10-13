/**
 * Two people, one repo: what each sees after the other submits.
 *
 * These drive the daemon's own submit() and pull() (the functions its API
 * calls), not just the addon, with two workspace directories on the same
 * repo. That is the layer that decides what happens to a file with local
 * changes when a pull wants to overwrite or delete it, what a workspace
 * believes it has after a submit, and what base a submit claims for each file.
 *
 * Each of those used to be able to lose work without an error:
 *
 *   - a pull overwrote a locally edited binary, deleted a locally edited file
 *     that was removed upstream, and replaced an untracked file with a newly
 *     added one of the same name;
 *   - a text merge recorded the merged file as the pristine baseline, so the
 *     local edit inside it stopped showing as a pending change;
 *   - a submit moved the workspace to the new changelist even when other
 *     people's changelists sat in between, so the next pull skipped them;
 *   - a submit of a stale file replaced whatever had landed since.
 *
 * The guard's own rules are covered case by case, without services, in
 * src/daemon/pull-local-changes.test.ts.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DaemonConfig } from "../../../core/daemon/src/daemon-config.js";
import { pull } from "../../../core/daemon/src/util/pull.js";
import { hasLocalChanges } from "../../../core/daemon/src/util/pull-local-changes.js";
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

describe.skipIf(!enabled)("daemon: submit and pull between two workspaces", () => {
  let ctx: IntegrationContext;
  const seats: Seat[] = [];
  let counter = 0;

  beforeAll(async () => {
    ctx = await createContext("daemon-pull");
  });

  afterAll(async () => {
    // The SQLite state store keeps each workspace's database open.
    closeAllStateStores();
    await Promise.all(
      seats.map((seat) => rm(seat.root, { recursive: true, force: true })),
    );
  });

  /** A fresh workspace directory registered with the server. */
  async function seat(name: string): Promise<Seat> {
    const root = (
      await mkdtemp(path.join(tmpdir(), `chk-daemon-${name}-`))
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

  const file = (s: Seat, relativePath: string) => path.join(s.root, relativePath);

  async function put(s: Seat, relativePath: string, content: string | Buffer) {
    await mkdir(path.dirname(file(s, relativePath)), { recursive: true });
    await writeFile(file(s, relativePath), content);
  }

  const read = (s: Seat, relativePath: string) => readFile(file(s, relativePath));

  function send(s: Seat, mods: Record<string, "write" | "delete">, message = "test") {
    return submit(
      s.workspace,
      ctx.orgId,
      message,
      Object.entries(mods).map(([p, kind]) => ({
        path: p,
        delete: kind === "delete",
      })),
      s.workspace.id,
    );
  }

  const sync = (s: Seat) => pull(s.workspace, ctx.orgId, null);
  // Read through the same backend the daemon functions wrote with.
  const stateOf = async (s: Seat) =>
    getWorkspaceState(s.root, (await DaemonConfig.Get()).stateBackend);

  async function changedLocally(s: Seat, relativePath: string) {
    const state = await stateOf(s);
    return hasLocalChanges(file(s, relativePath), state.files[relativePath]);
  }

  /** A unique file name, so tests in this file cannot collide. */
  const name = (stem: string, ext: string) => `${stem}-${++counter}${ext}`;

  it("delivers a submit to the other workspace, and the pulled files read as unchanged", async () => {
    const alice = await seat("alice");
    const bob = await seat("bob");
    const text = name("notes", ".txt");
    const asset = name("mesh", ".uasset");
    const textContent = "first line\nsecond line\n";
    const assetContent = randomBytes(50_000);

    await put(alice, text, textContent);
    await put(alice, `deep/dir/${asset}`, assetContent);
    await send(alice, { [text]: "write", [`deep/dir/${asset}`]: "write" });

    const result = await sync(bob);

    expect(result.cleanMerges).toEqual([]);
    expect(result.conflictMerges).toEqual([]);
    expect((await read(bob, text)).toString()).toBe(textContent);
    expect((await read(bob, `deep/dir/${asset}`)).equals(assetContent)).toBe(true);

    // A file exactly as the pull wrote it must not look modified. If the
    // recorded baseline disagreed with the file system here, every pull would
    // leave the whole workspace showing as changed.
    expect(await changedLocally(bob, text)).toBe(false);
    expect(await changedLocally(bob, `deep/dir/${asset}`)).toBe(false);
    // And the same for the submitter's own copies.
    expect(await changedLocally(alice, text)).toBe(false);

    const state = await stateOf(bob);
    expect(state.changelistNumber).toBe(await headChangelistNumber(ctx));
    expect(existsSync(path.join(bob.root, ".checkpoint", "pull-backups"))).toBe(false);
  });

  it("merges text edited on both sides, keeps the local edit pending, and lets it be submitted", async () => {
    const alice = await seat("alice");
    const bob = await seat("bob");
    const text = name("shared", ".txt");
    await put(alice, text, "one\ntwo\nthree\nfour\nfive\n");
    await send(alice, { [text]: "write" });
    await sync(bob);

    await put(alice, text, "ONE\ntwo\nthree\nfour\nfive\n");
    await send(alice, { [text]: "write" });
    await put(bob, text, "one\ntwo\nthree\nfour\nFIVE\n");

    const result = await sync(bob);

    expect(result.cleanMerges).toEqual([text]);
    expect(result.conflictMerges).toEqual([]);
    expect((await read(bob, text)).toString()).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
    // Bob's edit is still his to submit.
    expect(await changedLocally(bob, text)).toBe(true);

    await send(bob, { [text]: "write" });
    await sync(alice);
    expect((await read(alice, text)).toString()).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
    expect(await changedLocally(bob, text)).toBe(false);
  });

  it("leaves conflict markers and a backup when both edited the same line", async () => {
    const alice = await seat("alice");
    const bob = await seat("bob");
    const text = name("clash", ".txt");
    await put(alice, text, "the line\n");
    await send(alice, { [text]: "write" });
    await sync(bob);

    await put(alice, text, "alice's line\n");
    await send(alice, { [text]: "write" });
    await put(bob, text, "bob's line\n");

    const result = await sync(bob);

    expect(result.conflictMerges).toEqual([text]);
    const merged = (await read(bob, text)).toString();
    expect(merged).toContain("<<<<<<<");
    expect(merged).toContain("alice's line");
    expect(merged).toContain("bob's line");
    expect(await changedLocally(bob, text)).toBe(true);
  });

  it("does not destroy a locally edited binary the server also changed", async () => {
    const alice = await seat("alice");
    const bob = await seat("bob");
    const asset = name("texture", ".uasset");
    await put(alice, asset, randomBytes(20_000));
    await send(alice, { [asset]: "write" });
    await sync(bob);

    const alices = randomBytes(20_000);
    const bobs = randomBytes(20_000); // same size: the edit that used to be invisible
    await put(alice, asset, alices);
    await send(alice, { [asset]: "write" });
    await put(bob, asset, bobs);

    const result = await sync(bob);

    // The workspace has the server's version; Bob's is kept and reported.
    expect((await read(bob, asset)).equals(alices)).toBe(true);
    expect(result.localChangesSetAside.map((f) => [f.relativePath, f.reason])).toEqual([
      [asset, "binary"],
    ]);
    expect(result.conflictMerges).toContain(asset);
    const kept = await readFile(result.localChangesSetAside[0]!.backupPath);
    expect(kept.equals(bobs)).toBe(true);
    expect(await changedLocally(bob, asset)).toBe(false);
  });

  it("keeps a local edit to a file that was deleted on the server", async () => {
    const alice = await seat("alice");
    const bob = await seat("bob");
    const text = name("retired", ".txt");
    await put(alice, text, "original\n");
    await send(alice, { [text]: "write" });
    await sync(bob);

    await rm(file(alice, text));
    await send(alice, { [text]: "delete" });
    await put(bob, text, "original\nplus bob's unsubmitted work\n");

    const result = await sync(bob);

    expect(existsSync(file(bob, text))).toBe(false);
    expect(result.localChangesSetAside.map((f) => [f.relativePath, f.reason])).toEqual([
      [text, "deleted-on-server"],
    ]);
    expect(
      (await readFile(result.localChangesSetAside[0]!.backupPath)).toString(),
    ).toBe("original\nplus bob's unsubmitted work\n");
    expect((await stateOf(bob)).files[text]).toBeUndefined();
  });

  it("keeps an untracked local file when the server adds one with the same name", async () => {
    const alice = await seat("alice");
    const bob = await seat("bob");
    await sync(bob);
    const text = name("todo", ".txt");

    await put(bob, text, "bob's private notes\n");
    await put(alice, text, "alice's committed file\n");
    await send(alice, { [text]: "write" });

    const result = await sync(bob);

    expect((await read(bob, text)).toString()).toBe("alice's committed file\n");
    expect(result.localChangesSetAside.map((f) => [f.relativePath, f.reason])).toEqual([
      [text, "no-common-base"],
    ]);
    expect(
      (await readFile(result.localChangesSetAside[0]!.backupPath)).toString(),
    ).toBe("bob's private notes\n");
  });

  it("leaves unrelated local changes alone", async () => {
    const alice = await seat("alice");
    const bob = await seat("bob");
    const theirs = name("theirs", ".txt");
    const mine = name("mine", ".uasset");
    const untracked = name("scratch", ".txt");
    await put(alice, theirs, "v1\n");
    await put(alice, mine, randomBytes(4096));
    await send(alice, { [theirs]: "write", [mine]: "write" });
    await sync(bob);

    const bobsEdit = randomBytes(4096);
    await put(bob, mine, bobsEdit);
    await put(bob, untracked, "not submitted\n");
    await put(alice, theirs, "v2\n");
    await send(alice, { [theirs]: "write" });

    const result = await sync(bob);

    expect(result.localChangesSetAside).toEqual([]);
    expect((await read(bob, theirs)).toString()).toBe("v2\n");
    expect((await read(bob, mine)).equals(bobsEdit)).toBe(true);
    expect((await read(bob, untracked)).toString()).toBe("not submitted\n");
    expect(await changedLocally(bob, mine)).toBe(true);
    expect(existsSync(path.join(bob.root, ".checkpoint", "pull-backups"))).toBe(false);
  });

  it("refuses to submit a file that changed on the server since it was pulled", async () => {
    const alice = await seat("alice");
    const bob = await seat("bob");
    const asset = name("level", ".uasset");
    await put(alice, asset, randomBytes(8192));
    await send(alice, { [asset]: "write" });
    await sync(bob);

    const alices = randomBytes(8192);
    await put(alice, asset, alices);
    await send(alice, { [asset]: "write" });
    const head = await headChangelistNumber(ctx);

    // Bob edits his now-stale copy and submits without pulling.
    const bobs = randomBytes(8192);
    await put(bob, asset, bobs);
    await expect(send(bob, { [asset]: "write" })).rejects.toThrow(/Cannot submit/);

    expect(await headChangelistNumber(ctx)).toBe(head);
    // His file is untouched, and still shows as his change.
    expect((await read(bob, asset)).equals(bobs)).toBe(true);
    expect(await changedLocally(bob, asset)).toBe(true);
    // Alice's version is what the repo holds.
    const carol = await seat("carol");
    await sync(carol);
    expect((await read(carol, asset)).equals(alices)).toBe(true);
  });

  it("refuses to add a file someone else already added", async () => {
    const alice = await seat("alice");
    const bob = await seat("bob");
    await sync(bob);
    const text = name("both", ".txt");

    await put(alice, text, "alice\n");
    await send(alice, { [text]: "write" });
    const head = await headChangelistNumber(ctx);

    await put(bob, text, "bob\n");
    await expect(send(bob, { [text]: "write" })).rejects.toThrow(/Cannot submit/);
    expect(await headChangelistNumber(ctx)).toBe(head);
  });

  describe("what a workspace believes it has after a submit", () => {
    it("moves to the new changelist when nothing else landed in between", async () => {
      const alice = await seat("alice");
      await sync(alice);
      const text = name("solo", ".txt");
      await put(alice, text, "v1\n");

      await send(alice, { [text]: "write" });

      const head = await headChangelistNumber(ctx);
      expect((await stateOf(alice)).changelistNumber).toBe(head);
      expect((await stateOf(alice)).files[text]!.changelist).toBe(head);
    });

    it("does not skip a changelist that landed while the workspace was behind", async () => {
      const alice = await seat("alice");
      const bob = await seat("bob");
      await sync(bob);
      const bobBefore = (await stateOf(bob)).changelistNumber;

      // Alice lands a file Bob does not have.
      const alices = name("from-alice", ".txt");
      await put(alice, alices, "bob needs this\n");
      await send(alice, { [alices]: "write" });

      // Bob, still behind, submits something unrelated.
      const bobs = name("from-bob", ".txt");
      await put(bob, bobs, "unrelated\n");
      await send(bob, { [bobs]: "write" });

      // His workspace must not claim to be at his new changelist: it does not
      // have Alice's.
      const after = await stateOf(bob);
      expect(after.changelistNumber).toBe(bobBefore);
      expect(after.files[bobs]!.changelist).toBe(await headChangelistNumber(ctx));

      // So the next pull brings it in.
      await sync(bob);
      expect((await read(bob, alices)).toString()).toBe("bob needs this\n");
      expect((await read(bob, bobs)).toString()).toBe("unrelated\n");
      expect(await changedLocally(bob, bobs)).toBe(false);
      expect((await stateOf(bob)).changelistNumber).toBe(await headChangelistNumber(ctx));
    });
  });

  it("does not leave behind a file that was added and then deleted upstream", async () => {
    // Pulling keep.txt means applying the index of the changelist that added
    // it, and that index also holds gone.txt, which was deleted later. It used
    // to appear in the workspace as an untracked file, one "submit all" away
    // from being added back.
    const alice = await seat("alice");
    const keep = name("keep", ".txt");
    const gone = name("gone", ".txt");
    await put(alice, keep, "stays\n");
    await put(alice, gone, "was deleted\n");
    await send(alice, { [keep]: "write", [gone]: "write" });
    await rm(file(alice, gone));
    await send(alice, { [gone]: "delete" });

    const bob = await seat("bob");
    await sync(bob);

    expect((await read(bob, keep)).toString()).toBe("stays\n");
    expect(existsSync(file(bob, gone))).toBe(false);
    expect((await stateOf(bob)).files[gone]).toBeUndefined();
  });

  it("leaves an untracked local file alone when a pulled index would write over it", async () => {
    const alice = await seat("alice");
    const keep = name("keep", ".txt");
    const gone = name("gone", ".txt");
    await put(alice, keep, "stays\n");
    await put(alice, gone, "was deleted\n");
    await send(alice, { [keep]: "write", [gone]: "write" });
    await rm(file(alice, gone));
    await send(alice, { [gone]: "delete" });

    // Bob has his own untracked file at the deleted file's path.
    const bob = await seat("bob");
    await put(bob, gone, "bob's own file, nothing to do with the repo\n");
    const result = await sync(bob);

    expect((await read(bob, gone)).toString()).toBe(
      "bob's own file, nothing to do with the repo\n",
    );
    expect(result.localChangesSetAside).toEqual([]);
    expect((await read(bob, keep)).toString()).toBe("stays\n");
  });

  it("is a no-op to pull twice", async () => {
    const alice = await seat("alice");
    const bob = await seat("bob");
    const text = name("twice", ".txt");
    await put(alice, text, "content\n");
    await send(alice, { [text]: "write" });

    await sync(bob);
    const first = await stateOf(bob);
    const second = await sync(bob);

    expect(second).toEqual({
      cleanMerges: [],
      conflictMerges: [],
      localChangesSetAside: [],
    });
    expect((await stateOf(bob)).changelistNumber).toBe(first.changelistNumber);
    expect(await changedLocally(bob, text)).toBe(false);
  });
});
