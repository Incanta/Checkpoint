/**
 * A submit must not replace a change its author never saw.
 *
 * Each modification can carry the changelist the submitter's copy of the file
 * came from. The server compares it with what the branch head holds and
 * refuses the whole submit on a mismatch. These tests drive that through the
 * real path (addon, storage server, app) with two workspaces editing the same
 * file, which is the case that used to end with the second submit silently
 * winning.
 *
 * The rule itself is covered exhaustively, without services, in
 * src/api/changelist-submit.test.ts. This file is about the value surviving
 * the trip: addon option, native payload, submit route, tRPC input.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Modification } from "@checkpointvcs/longtail-addon";

import {
  createContext,
  createWorkspace,
  enabled,
  headChangelistNumber,
  nativeSubmit,
  readCommitted,
  write,
  type IntegrationContext,
  type LocalWorkspace,
} from "./harness.js";

/**
 * A modification with a base. Built through a variable so it type-checks
 * against an installed addon whose types predate `baseChangelist`.
 */
function edit(
  path: string,
  baseChangelist: number | null,
  remove = false,
): Modification {
  const mod = { path, delete: remove, baseChangelist };
  return mod;
}

describe.skipIf(!enabled)("native submit: base changelist", () => {
  let ctx: IntegrationContext;
  let alice: LocalWorkspace;
  let bob: LocalWorkspace;

  beforeAll(async () => {
    ctx = await createContext("native-submit-base");
    alice = await createWorkspace(ctx, "alice");
    bob = await createWorkspace(ctx, "bob");
  });

  afterAll(async () => {
    await alice?.cleanup();
    await bob?.cleanup();
  });

  it("refuses the second of two edits made from the same version, and keeps the first", async () => {
    const original = randomBytes(4096);
    await write(alice, "shared.bin", original);
    const added = await nativeSubmit(ctx, alice, [edit("shared.bin", null)]);
    expect(added.error).toBe(0);
    const base = added.changelistNumber!;

    // Both start from `base`. Alice lands first.
    const alices = randomBytes(4096);
    const bobs = randomBytes(4096);
    await write(alice, "shared.bin", alices);
    await write(bob, "shared.bin", bobs);

    const first = await nativeSubmit(ctx, alice, [edit("shared.bin", base)]);
    expect(first.error).toBe(0);
    const head = await headChangelistNumber(ctx);

    const second = await nativeSubmit(ctx, bob, [edit("shared.bin", base)]);
    expect(second.error).toBe(409);
    expect(second.step).toContain("Cannot submit");
    expect(second.changelistNumber).toBeNull();

    expect(await headChangelistNumber(ctx)).toBe(head);
    const stored = await readCommitted(ctx, first.changelistNumber!, "shared.bin");
    expect(stored.equals(alices)).toBe(true);

    // Once Bob has taken Alice's version as his base, his edit goes in.
    const retried = await nativeSubmit(ctx, bob, [
      edit("shared.bin", first.changelistNumber!),
    ]);
    expect(retried.error).toBe(0);
    const bobStored = await readCommitted(ctx, retried.changelistNumber!, "shared.bin");
    expect(bobStored.equals(bobs)).toBe(true);
  });

  it("refuses a file added as new when the branch already has it", async () => {
    await write(alice, "both-add.bin", randomBytes(2048));
    await write(bob, "both-add.bin", randomBytes(2048));

    const first = await nativeSubmit(ctx, alice, [edit("both-add.bin", null)]);
    expect(first.error).toBe(0);
    const head = await headChangelistNumber(ctx);

    const second = await nativeSubmit(ctx, bob, [edit("both-add.bin", null)]);
    expect(second.error).toBe(409);
    expect(second.step).toContain("Cannot submit");
    expect(await headChangelistNumber(ctx)).toBe(head);
  });

  it("refuses the whole submit when one file of several is stale", async () => {
    await write(alice, "moving.bin", randomBytes(2048));
    const added = await nativeSubmit(ctx, alice, [edit("moving.bin", null)]);
    const base = added.changelistNumber!;
    await write(alice, "moving.bin", randomBytes(2048));
    expect((await nativeSubmit(ctx, alice, [edit("moving.bin", base)])).error).toBe(0);
    const head = await headChangelistNumber(ctx);

    await write(bob, "moving.bin", randomBytes(2048));
    await write(bob, "innocent.bin", randomBytes(2048));
    const outcome = await nativeSubmit(ctx, bob, [
      edit("innocent.bin", null),
      edit("moving.bin", base),
    ]);

    expect(outcome.error).toBe(409);
    expect(await headChangelistNumber(ctx)).toBe(head);
  });

  it("refuses a delete of a version the branch has moved past", async () => {
    await write(alice, "doomed.bin", randomBytes(2048));
    const added = await nativeSubmit(ctx, alice, [edit("doomed.bin", null)]);
    const base = added.changelistNumber!;
    const changed = randomBytes(2048);
    await write(alice, "doomed.bin", changed);
    const updated = await nativeSubmit(ctx, alice, [edit("doomed.bin", base)]);
    expect(updated.error).toBe(0);
    const head = await headChangelistNumber(ctx);

    const outcome = await nativeSubmit(ctx, bob, [edit("doomed.bin", base, true)]);
    expect(outcome.error).toBe(409);
    expect(await headChangelistNumber(ctx)).toBe(head);

    const stored = await readCommitted(ctx, updated.changelistNumber!, "doomed.bin");
    expect(stored.equals(changed)).toBe(true);
  });

  it("still accepts a submit that names no base", async () => {
    await write(alice, "legacy.bin", randomBytes(2048));
    const first = await nativeSubmit(ctx, alice, [
      { path: "legacy.bin", delete: false },
    ]);
    expect(first.error).toBe(0);

    await write(bob, "legacy.bin", randomBytes(2048));
    const second = await nativeSubmit(ctx, bob, [
      { path: "legacy.bin", delete: false },
    ]);
    expect(second.error).toBe(0);
  });
});
